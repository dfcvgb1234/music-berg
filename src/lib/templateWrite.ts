import { NextResponse } from "next/server";
import {
  assertUploadedAudioFile,
  detectAudioMime,
  formatBytes,
  isSupportedAudioBuffer,
  uploadLimits,
} from "@/lib/audioValidate";
import { isVercelBlobUrl } from "@/lib/blobAudio";
import { normalizeSegmentPointsMs } from "@/lib/clipRules";
import { sql } from "@/lib/db";
import {
  formatTrackLabel,
  getTrack,
  getTracks,
  trackFingerprint,
} from "@/lib/deezer";
import { newId } from "@/lib/ids";
import {
  deleteR2Quiet,
  durableSongKey,
  putR2Object,
  readR2Config,
  r2UploadsEnabled,
  toR2Locator,
} from "@/lib/r2";
import {
  deleteStagingQuiet,
  fetchStagingAudio,
  verifyR2Upload,
} from "@/lib/stagingAudio";

export function parseAnswerIds(raw: unknown, primaryId: string): string[] {
  let ids: string[] = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
      }
    } catch {
      ids = [];
    }
  } else if (Array.isArray(raw)) {
    ids = raw.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
  }
  if (!ids.includes(primaryId)) ids.unshift(primaryId);
  return [...new Set(ids)].slice(0, 20);
}

export type SongInput = {
  itunesTrackId: string;
  answerIds: string[];
  segmentPointsMs?: unknown;
  /** Cropped clip length in ms (from client encode / probe). */
  durationMs?: unknown;
  /** Keep audio from an existing song on this template (edit). */
  keepSongId?: string;
  /**
   * Client upload locator:
   * durable R2 `r2://bucket/key` (kept) or legacy Vercel Blob HTTPS URL (copied to R2).
   */
  stagingUrl?: string;
  /** Multipart file (local / small direct uploads). */
  file?: File;
};

export type ValidatedSong = {
  displayName: string;
  artist: string;
  itunesTrackId: string;
  answerIds: string[];
  fingerprints: string[];
  coverArtUrl: string | null;
  mimeType: string;
  segmentPointsMs: number[];
  durationMs: number | null;
  byteLength: number;
  /** Durable R2 object key (preferred). */
  r2ObjectKey?: string;
  r2ObjectUrl?: string;
  /**
   * Bytes only when we still need to upload to R2 (Blob/direct) or
   * local PGlite fallback without R2.
   */
  buf?: Buffer;
  /** Transient Blob URL to delete after copying into R2. */
  deleteBlobUrl?: string;
  /** Existing R2 key retained across edit replace (do not delete). */
  reusedR2Key?: boolean;
};

function parseDurationMs(raw: unknown): number | null {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 500) return null;
  return Math.min(n, 30 * 60 * 1000);
}

function requireR2(): Response | null {
  if (!r2UploadsEnabled()) {
    return NextResponse.json(
      {
        error:
          "Cloudflare R2 is required for durable audio storage. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
      },
      { status: 503 },
    );
  }
  return null;
}

export async function validateSongs(
  inputs: SongInput[],
  opts: { templateId?: string } = {},
): Promise<ValidatedSong[] | Response> {
  if (inputs.length === 0) {
    return NextResponse.json(
      { error: "Add at least one track pick + audio file" },
      { status: 400 },
    );
  }

  const r2Missing = requireR2();
  if (r2Missing) return r2Missing;

  const validated: ValidatedSong[] = [];
  let totalBytes = 0;
  const templateId = opts.templateId;
  const config = readR2Config();

  for (const input of inputs) {
    const itunesId = input.itunesTrackId;
    if (!itunesId || !/^\d+$/.test(itunesId)) {
      return NextResponse.json(
        { error: "Each song must be picked from search results" },
        { status: 400 },
      );
    }
    const answerIds = parseAnswerIds(input.answerIds, itunesId);
    const lookedUp = await getTracks(answerIds);
    const primary = lookedUp.get(itunesId) ?? (await getTrack(itunesId));
    if (!primary) {
      return NextResponse.json(
        { error: "Invalid track selection" },
        { status: 400 },
      );
    }
    const confirmed = answerIds.filter(
      (id) => id === itunesId || lookedUp.has(id),
    );
    if (!confirmed.includes(itunesId)) confirmed.unshift(itunesId);

    const fingerprints = new Set<string>([
      trackFingerprint(primary.artist, primary.title),
    ]);
    for (const id of confirmed) {
      const hit = lookedUp.get(id);
      if (hit) fingerprints.add(trackFingerprint(hit.artist, hit.title));
    }

    const segmentPointsMs = normalizeSegmentPointsMs(input.segmentPointsMs);
    let durationMs = parseDurationMs(input.durationMs);

    let mimeType: string;
    let byteLength: number;
    let r2ObjectKey: string | undefined;
    let r2ObjectUrl: string | undefined;
    let buf: Buffer | undefined;
    let deleteBlobUrl: string | undefined;
    let reusedR2Key = false;

    if (input.keepSongId && templateId) {
      const existing = await sql<{
        id: string;
        mime_type: string;
        duration_ms: number | null;
        r2_object_key: string | null;
        r2_object_url: string | null;
      }>(
        `select id, mime_type, duration_ms, r2_object_key, r2_object_url
         from songs where id = $1 and template_id = $2`,
        [input.keepSongId, templateId],
      );
      const row = existing[0];
      if (!row) {
        return NextResponse.json(
          { error: "Could not keep audio for an unknown song" },
          { status: 400 },
        );
      }
      mimeType = row.mime_type || "audio/ogg";
      if (durationMs == null && row.duration_ms != null) {
        durationMs = parseDurationMs(row.duration_ms);
      }
      if (row.r2_object_key?.trim()) {
        r2ObjectKey = row.r2_object_key.trim();
        r2ObjectUrl =
          row.r2_object_url?.trim() ||
          (config ? toR2Locator(config.bucket, r2ObjectKey) : undefined);
        reusedR2Key = true;
        try {
          const head = await verifyR2Upload(r2ObjectKey);
          byteLength = head.contentLength;
        } catch {
          byteLength = 1; // keep song even if head fails transiently
        }
      } else {
        return NextResponse.json(
          { error: "Existing song has no durable audio" },
          { status: 400 },
        );
      }
    } else if (input.stagingUrl) {
      const stagingUrl = input.stagingUrl;
      if (isVercelBlobUrl(stagingUrl)) {
        // Legacy Blob: copy into R2, then delete Blob.
        try {
          buf = await fetchStagingAudio(stagingUrl);
        } catch (err) {
          return NextResponse.json(
            {
              error:
                err instanceof Error
                  ? err.message
                  : "Could not read uploaded audio",
            },
            { status: 400 },
          );
        }
        if (!isSupportedAudioBuffer(buf)) {
          return NextResponse.json(
            {
              error:
                "File content is not valid Opus (Ogg/WebM) or MP3. Convert on the client before upload.",
            },
            { status: 400 },
          );
        }
        mimeType = detectAudioMime(buf, "audio/ogg");
        byteLength = buf.byteLength;
        deleteBlobUrl = stagingUrl;
      } else {
        // Durable R2 upload — verify object, keep it (do not delete).
        try {
          const head = await verifyR2Upload(stagingUrl);
          r2ObjectKey = head.key;
          r2ObjectUrl =
            (config ? toR2Locator(config.bucket, head.key) : stagingUrl) ||
            stagingUrl;
          byteLength = head.contentLength;
          mimeType =
            head.contentType && head.contentType !== "application/octet-stream"
              ? head.contentType
              : "audio/ogg";
          // Spot-check magic bytes without keeping a long-lived buffer in DB.
          const probe = await fetchStagingAudio(stagingUrl);
          if (!isSupportedAudioBuffer(probe)) {
            await deleteR2Quiet(r2ObjectKey);
            return NextResponse.json(
              {
                error:
                  "File content is not valid Opus (Ogg/WebM) or MP3. Convert on the client before upload.",
              },
              { status: 400 },
            );
          }
          mimeType = detectAudioMime(probe, mimeType);
        } catch (err) {
          return NextResponse.json(
            {
              error:
                err instanceof Error
                  ? err.message
                  : "Could not read uploaded audio",
            },
            { status: 400 },
          );
        }
      }
    } else if (input.file instanceof File) {
      const file = input.file;
      if (file.size <= 0 || file.size > uploadLimits.maxFileBytes) {
        return NextResponse.json(
          {
            error: `Each audio file must be under ${formatBytes(uploadLimits.maxFileBytes)}`,
          },
          { status: 400 },
        );
      }
      const fileErr = assertUploadedAudioFile(file);
      if (fileErr) {
        return NextResponse.json({ error: fileErr }, { status: 400 });
      }
      buf = Buffer.from(await file.arrayBuffer());
      if (!isSupportedAudioBuffer(buf)) {
        return NextResponse.json(
          {
            error:
              "File content is not valid Opus (Ogg/WebM) or MP3. Convert on the client before upload.",
          },
          { status: 400 },
        );
      }
      mimeType = detectAudioMime(buf, "audio/ogg");
      byteLength = buf.byteLength;
    } else {
      return NextResponse.json(
        { error: "Each song needs an audio upload" },
        { status: 400 },
      );
    }

    totalBytes += byteLength;
    if (totalBytes > uploadLimits.maxTemplateAudioBytes) {
      return NextResponse.json(
        {
          error: `Track list audio too large (max ${formatBytes(uploadLimits.maxTemplateAudioBytes)} total)`,
        },
        { status: 413 },
      );
    }

    validated.push({
      displayName: formatTrackLabel(primary),
      artist: primary.artist,
      itunesTrackId: primary.id,
      answerIds: confirmed,
      fingerprints: [...fingerprints],
      coverArtUrl: primary.coverArtUrl,
      mimeType,
      segmentPointsMs,
      durationMs,
      byteLength,
      r2ObjectKey,
      r2ObjectUrl,
      buf,
      deleteBlobUrl,
      reusedR2Key,
    });
  }

  return validated;
}

async function ensureDurableR2(
  song: ValidatedSong,
  songId: string,
): Promise<{ key: string; url: string | null }> {
  if (song.r2ObjectKey) {
    return {
      key: song.r2ObjectKey,
      url: song.r2ObjectUrl ?? null,
    };
  }

  if (song.buf && r2UploadsEnabled()) {
    const put = await putR2Object({
      key: durableSongKey({
        songId,
        filename: `clip.${song.mimeType.includes("mpeg") ? "mp3" : "ogg"}`,
      }),
      body: song.buf,
      contentType: song.mimeType,
    });
    if (song.deleteBlobUrl) await deleteStagingQuiet(song.deleteBlobUrl);
    return { key: put.key, url: put.objectUrl };
  }

  throw new Error(
    "Cloudflare R2 is required for durable audio storage (no Postgres bytea)",
  );
}

export async function insertSongsForTemplate(
  templateId: string,
  validated: ValidatedSong[],
): Promise<void> {
  for (let i = 0; i < validated.length; i++) {
    const song = validated[i];
    const songId = newId();
    const durable = await ensureDurableR2(song, songId);
    await sql(
      `insert into songs (
         id, template_id, display_name, mime_type, sort_order,
         itunes_track_id, cover_art_url, artist_credit, itunes_answer_ids,
         answer_fingerprint, segment_points_ms, duration_ms,
         r2_object_key, r2_object_url
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        songId,
        templateId,
        song.displayName,
        song.mimeType,
        i,
        song.itunesTrackId,
        song.coverArtUrl,
        song.artist,
        JSON.stringify(song.answerIds),
        JSON.stringify(song.fingerprints),
        JSON.stringify(song.segmentPointsMs),
        song.durationMs,
        durable.key,
        durable.url,
      ],
    );
  }
}

export async function insertTemplate(
  name: string,
  validated: ValidatedSong[],
): Promise<{ id: string; name: string; songCount: number }> {
  const templateId = newId();
  await sql(`insert into templates (id, name) values ($1, $2)`, [
    templateId,
    name,
  ]);
  await insertSongsForTemplate(templateId, validated);
  return { id: templateId, name, songCount: validated.length };
}

export async function replaceTemplateSongs(
  templateId: string,
  name: string,
  validated: ValidatedSong[],
): Promise<{ id: string; name: string; songCount: number }> {
  const previous = await sql<{
    r2_object_key: string | null;
  }>(`select r2_object_key from songs where template_id = $1`, [templateId]);

  const keepKeys = new Set(
    validated
      .filter((s) => s.reusedR2Key && s.r2ObjectKey)
      .map((s) => s.r2ObjectKey!),
  );

  await sql(`update templates set name = $2 where id = $1`, [templateId, name]);
  await sql(`delete from songs where template_id = $1`, [templateId]);
  await insertSongsForTemplate(templateId, validated);

  // Drop R2 objects that were not retained across the replace.
  for (const row of previous) {
    const key = row.r2_object_key?.trim();
    if (key && !keepKeys.has(key)) {
      await deleteR2Quiet(key);
    }
  }

  return { id: templateId, name, songCount: validated.length };
}

export async function deleteTemplateCascade(
  templateId: string,
): Promise<{ deleted: boolean; sessionsRemoved: number }> {
  const sessions = await sql<{ id: string }>(
    `select id from sessions where template_id = $1`,
    [templateId],
  );
  for (const session of sessions) {
    await sql(`delete from guesses where session_id = $1`, [session.id]);
    await sql(`delete from participants where session_id = $1`, [session.id]);
    await sql(`delete from sessions where id = $1`, [session.id]);
  }

  const songKeys = await sql<{ r2_object_key: string | null }>(
    `select r2_object_key from songs where template_id = $1`,
    [templateId],
  );
  await sql(`delete from songs where template_id = $1`, [templateId]);
  for (const row of songKeys) {
    if (row.r2_object_key?.trim()) await deleteR2Quiet(row.r2_object_key.trim());
  }

  const gone = await sql<{ id: string }>(
    `delete from templates where id = $1 returning id`,
    [templateId],
  );
  return {
    deleted: Boolean(gone[0]),
    sessionsRemoved: sessions.length,
  };
}
