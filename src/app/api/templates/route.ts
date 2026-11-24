import { NextResponse } from "next/server";
import {
  assertUploadAuthorized,
  formatBytes,
  isMp3Buffer,
  uploadLimits,
} from "@/lib/audioValidate";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";
import { formatTrackLabel, getTrack, getTracks, trackFingerprint } from "@/lib/itunes";
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
  }
  if (!ids.includes(primaryId)) ids.unshift(primaryId);
  return [...new Set(ids)].slice(0, 20);
}

export async function POST(request: Request) {
  const authError = assertUploadAuthorized(request);
  if (authError) return authError;

  const ip = clientKey(request);
  if (!rateLimit(`templates-post:${ip}`, { limit: 8, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many uploads" }, { status: 429 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > uploadLimits.maxRequestBytes
  ) {
    return NextResponse.json(
      {
        error: `Upload too large (max ${formatBytes(uploadLimits.maxRequestBytes)} total). Use shorter MP3s.`,
      },
      { status: 413 },
    );
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
      { error: "Add at least one track pick + MP3" },
      { status: 400 },
    );
  }
  if (itunesIds.length !== files.length) {
    return NextResponse.json(
      { error: "Each song needs a track pick and an MP3" },
      { status: 400 },
    );
  }
  if (itunesIds.length > uploadLimits.maxSongsPerTemplate) {
    return NextResponse.json(
      {
        error: `At most ${uploadLimits.maxSongsPerTemplate} songs per track list`,
      },
      { status: 400 },
    );
  }

  type Validated = {
    displayName: string;
    artist: string;
    itunesTrackId: string;
    answerIds: string[];
    /** JSON array of normalized artist|title fingerprints. */
    fingerprints: string[];
    coverArtUrl: string | null;
    buf: Buffer;
  };
  const validated: Validated[] = [];
  let totalBytes = 0;

  for (let i = 0; i < itunesIds.length; i++) {
    const itunesId = itunesIds[i];
    const file = files[i];
    if (!itunesId || !/^\d+$/.test(itunesId)) {
      return NextResponse.json(
        { error: "Each song must be picked from search results" },
        { status: 400 },
      );
    }
    const answerIds = parseAnswerIds(answerIdBlobs[i], itunesId);
    const lookedUp = await getTracks(answerIds);
    const primary = lookedUp.get(itunesId) ?? (await getTrack(itunesId));
    if (!primary) {
      return NextResponse.json(
        { error: "Invalid track selection" },
        { status: 400 },
      );
    }
    // Keep only ids that resolve; always include primary.
    const confirmed = answerIds.filter(
      (id) => id === itunesId || lookedUp.has(id),
    );
    if (!confirmed.includes(itunesId)) confirmed.unshift(itunesId);

    // Fingerprints for every allowed answer so remasters of extras also match.
    const fingerprints = new Set<string>([
      trackFingerprint(primary.artist, primary.title),
    ]);
    for (const id of confirmed) {
      const hit = lookedUp.get(id);
      if (hit) fingerprints.add(trackFingerprint(hit.artist, hit.title));
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Invalid audio file" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > uploadLimits.maxFileBytes) {
      return NextResponse.json(
        {
          error: `Each MP3 must be under ${formatBytes(uploadLimits.maxFileBytes)}`,
        },
        { status: 400 },
      );
    }
    totalBytes += file.size;
    if (totalBytes > uploadLimits.maxRequestBytes) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }

    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".mp3")) {
      return NextResponse.json(
        { error: "Only .mp3 files are allowed" },
        { status: 400 },
      );
    }
    const reported = (file.type || "").toLowerCase();
    if (
      reported &&
      reported !== "application/octet-stream" &&
      !reported.includes("audio/mpeg") &&
      !reported.includes("audio/mp3") &&
      reported !== "audio/mpeg3"
    ) {
      return NextResponse.json(
        { error: "Only MP3 audio is allowed" },
        { status: 400 },
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (!isMp3Buffer(buf)) {
      return NextResponse.json(
        { error: "File content is not a valid MP3" },
        { status: 400 },
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
    });
  }

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
        "audio/mpeg",
        song.buf,
        i,
        song.itunesTrackId,
        song.coverArtUrl,
        song.artist,
        JSON.stringify(song.answerIds),
        JSON.stringify(song.fingerprints),
      ],
    );
  }

  return NextResponse.json({
    id: templateId,
    name,
    songCount: validated.length,
  });
}
