import { NextResponse } from "next/server";
import {
  assertUploadedAudioFile,
  detectAudioMime,
  formatBytes,
  isSupportedAudioBuffer,
  uploadLimits,
} from "@/lib/audioValidate";
import { deleteBlobQuiet, fetchPrivateBlobAudio } from "@/lib/blobAudio";
import { normalizeSegmentPointsMs } from "@/lib/clipRules";
import { sql } from "@/lib/db";
import {
  formatTrackLabel,
  getTrack,
  getTracks,
  trackFingerprint,
} from "@/lib/deezer";
import { newId } from "@/lib/ids";

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
  /** Keep audio from an existing song on this template (edit). */
  keepSongId?: string;
  /** Private Vercel Blob URL (Hobby-safe path). */
  blobUrl?: string;
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
  buf: Buffer;
  mimeType: string;
  segmentPointsMs: number[];
  blobUrl?: string;
};

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

  const validated: ValidatedSong[] = [];
  let totalBytes = 0;
  const templateId = opts.templateId;

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

    let buf: Buffer;
    let blobUrl: string | undefined;
    let mimeType: string;

    if (input.keepSongId && templateId) {
      const existing = await sql<{
        id: string;
        audio_data: Buffer;
        mime_type: string;
      }>(
        `select id, audio_data, mime_type from songs
         where id = $1 and template_id = $2`,
        [input.keepSongId, templateId],
      );
      const row = existing[0];
      if (!row) {
        return NextResponse.json(
          { error: "Could not keep audio for an unknown song" },
          { status: 400 },
        );
      }
      buf = Buffer.isBuffer(row.audio_data)
        ? row.audio_data
        : Buffer.from(row.audio_data as unknown as ArrayBuffer);
      mimeType = row.mime_type || "audio/ogg";
    } else if (input.blobUrl) {
      try {
        buf = await fetchPrivateBlobAudio(input.blobUrl);
        blobUrl = input.blobUrl;
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
    } else {
      return NextResponse.json(
        { error: "Each song needs an audio upload" },
        { status: 400 },
      );
    }

    totalBytes += buf.length;
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
      buf,
      mimeType,
      segmentPointsMs,
      blobUrl,
    });
  }

  return validated;
}

export async function insertSongsForTemplate(
  templateId: string,
  validated: ValidatedSong[],
): Promise<void> {
  for (let i = 0; i < validated.length; i++) {
    const song = validated[i];
    await sql(
      `insert into songs (id, template_id, display_name, mime_type, audio_data, sort_order, itunes_track_id, cover_art_url, artist_credit, itunes_answer_ids, answer_fingerprint, segment_points_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        newId(),
        templateId,
        song.displayName,
        song.mimeType,
        song.buf,
        i,
        song.itunesTrackId,
        song.coverArtUrl,
        song.artist,
        JSON.stringify(song.answerIds),
        JSON.stringify(song.fingerprints),
        JSON.stringify(song.segmentPointsMs),
      ],
    );
    if (song.blobUrl) await deleteBlobQuiet(song.blobUrl);
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
  await sql(`update templates set name = $2 where id = $1`, [templateId, name]);
  await sql(`delete from songs where template_id = $1`, [templateId]);
  await insertSongsForTemplate(templateId, validated);
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
  await sql(`delete from songs where template_id = $1`, [templateId]);
  const gone = await sql<{ id: string }>(
    `delete from templates where id = $1 returning id`,
    [templateId],
  );
  return {
    deleted: Boolean(gone[0]),
    sessionsRemoved: sessions.length,
  };
}
