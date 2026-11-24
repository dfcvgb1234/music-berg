import { NextResponse } from "next/server";
import {
  assertUploadAuthorized,
  assertUploadedAudioFile,
  detectAudioMime,
  formatBytes,
  isSupportedAudioBuffer,
  uploadLimits,
} from "@/lib/audioValidate";
import {
  deleteBlobQuiet,
  fetchPrivateBlobAudio,
} from "@/lib/blobAudio";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";
import {
  formatTrackLabel,
  getTrack,
  getTracks,
  trackFingerprint,
} from "@/lib/itunes";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
/** Allow ffmpeg/iTunes work during multi-MP3 create on Vercel. */
export const maxDuration = 60;

type TemplateRow = {
  id: string;
  name: string;
  created_at: string;
  song_count: string;
};

/** Public list: track-list id/name/count only — never song titles or IDs (answers). */
export async function GET() {
  const templates = await sql<TemplateRow>(
    `select t.id, t.name, t.created_at,
            (select count(*)::text from songs s where s.template_id = t.id) as song_count
     from templates t
     order by t.created_at desc`,
  );

  return NextResponse.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.created_at,
      songCount: Number(t.song_count),
    })),
  });
}

function parseAnswerIds(raw: unknown, primaryId: string): string[] {
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

type SongInput = {
  itunesTrackId: string;
  answerIds: string[];
  /** Private Vercel Blob URL (Hobby-safe path). */
  blobUrl?: string;
  /** Multipart file (local / small direct uploads). */
  file?: File;
};

type Validated = {
  displayName: string;
  artist: string;
  itunesTrackId: string;
  answerIds: string[];
  fingerprints: string[];
  coverArtUrl: string | null;
  buf: Buffer;
  mimeType: string;
  blobUrl?: string;
};

async function validateSongs(inputs: SongInput[]): Promise<Validated[] | Response> {
  if (inputs.length === 0) {
    return NextResponse.json(
      { error: "Add at least one track pick + audio file" },
      { status: 400 },
    );
  }
  if (inputs.length > uploadLimits.maxSongsPerTemplate) {
    return NextResponse.json(
      {
        error: `At most ${uploadLimits.maxSongsPerTemplate} songs per track list`,
      },
      { status: 400 },
    );
  }

  const validated: Validated[] = [];
  let totalBytes = 0;

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

    let buf: Buffer;
    let blobUrl: string | undefined;

    if (input.blobUrl) {
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
    } else {
      return NextResponse.json(
        { error: "Each song needs an audio upload" },
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

    const mimeType = detectAudioMime(buf, "audio/ogg");

    totalBytes += buf.length;
    if (totalBytes > uploadLimits.maxRequestBytes) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
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
      blobUrl,
    });
  }

  return validated;
}

async function insertTemplate(
  name: string,
  validated: Validated[],
): Promise<{ id: string; name: string; songCount: number }> {
  const templateId = newId();
  await sql(`insert into templates (id, name) values ($1, $2)`, [
    templateId,
    name,
  ]);

  for (let i = 0; i < validated.length; i++) {
    const song = validated[i];
    await sql(
      `insert into songs (id, template_id, display_name, mime_type, audio_data, sort_order, itunes_track_id, cover_art_url, artist_credit, itunes_answer_ids, answer_fingerprint)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      ],
    );
    if (song.blobUrl) await deleteBlobQuiet(song.blobUrl);
  }

  return { id: templateId, name, songCount: validated.length };
}

export async function POST(request: Request) {
  const authError = assertUploadAuthorized(request);
  if (authError) return authError;

  const ip = clientKey(request);
  if (!rateLimit(`templates-post:${ip}`, { limit: 8, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many uploads" }, { status: 429 });
  }

  const existing = await sql<{ count: string }>(
    `select count(*)::text as count from templates`,
  );
  if (Number(existing[0]?.count ?? 0) >= uploadLimits.maxTemplates) {
    return NextResponse.json(
      { error: "Track list limit reached" },
      { status: 400 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";

  // Hobby-safe path: small JSON with private Blob URLs (files already uploaded).
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      songs?: Array<{
        itunesTrackId?: string;
        answerIds?: unknown;
        blobUrl?: string;
      }>;
    } | null;
    const name = String(body?.name ?? "").trim().slice(0, 80);
    if (!name) {
      return NextResponse.json(
        { error: "Track list name is required" },
        { status: 400 },
      );
    }
    const inputs: SongInput[] = (body?.songs ?? []).map((s) => ({
      itunesTrackId: String(s.itunesTrackId ?? "").trim(),
      answerIds: Array.isArray(s.answerIds)
        ? s.answerIds.map((v) => String(v))
        : [],
      blobUrl: String(s.blobUrl ?? "").trim() || undefined,
    }));
    const validated = await validateSongs(inputs);
    if (validated instanceof Response) return validated;
    const created = await insertTemplate(name, validated);
    return NextResponse.json(created);
  }

  // Local / legacy multipart path (request body carries audio bytes).
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > uploadLimits.maxRequestBytes
  ) {
    return NextResponse.json(
      {
        error: `Upload too large (max ${formatBytes(uploadLimits.maxRequestBytes)} total). Use shorter clips.`,
      },
      { status: 413 },
    );
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 80);
  if (!name) {
    return NextResponse.json(
      { error: "Track list name is required" },
      { status: 400 },
    );
  }

  const itunesIds = form.getAll("itunesTrackIds").map((v) => String(v).trim());
  const answerIdBlobs = form.getAll("itunesAnswerIds");
  const files = form.getAll("songFiles");

  if (itunesIds.length === 0 || files.length === 0) {
    return NextResponse.json(
      { error: "Add at least one track pick + audio file" },
      { status: 400 },
    );
  }
  if (itunesIds.length !== files.length) {
    return NextResponse.json(
      { error: "Each song needs a track pick and an audio file" },
      { status: 400 },
    );
  }

  const inputs: SongInput[] = itunesIds.map((itunesTrackId, i) => ({
    itunesTrackId,
    answerIds: parseAnswerIds(answerIdBlobs[i], itunesTrackId),
    file: files[i] instanceof File ? files[i] : undefined,
  }));

  const validated = await validateSongs(inputs);
  if (validated instanceof Response) return validated;
  const created = await insertTemplate(name, validated);
  return NextResponse.json(created);
}
