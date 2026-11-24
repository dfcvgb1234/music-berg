import { NextResponse } from "next/server";
import {
  assertUploadAuthorized,
  formatBytes,
  isMp3Buffer,
  uploadLimits,
} from "@/lib/audioValidate";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";
import { formatMbLabel, getRecording } from "@/lib/musicbrainz";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

type TemplateRow = {
  id: string;
  name: string;
  created_at: string;
  song_count: string;
};

/** Public list: template id/name/count only — never song titles or IDs (answers). */
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
      { error: "Template limit reached" },
      { status: 400 },
    );
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 80);
  if (!name) {
    return NextResponse.json({ error: "Template name is required" }, { status: 400 });
  }

  const mbIds = form.getAll("musicbrainzIds").map((v) => String(v).trim());
  const files = form.getAll("songFiles");

  if (mbIds.length === 0 || files.length === 0) {
    return NextResponse.json(
      { error: "Add at least one MusicBrainz track + MP3" },
      { status: 400 },
    );
  }
  if (mbIds.length !== files.length) {
    return NextResponse.json(
      { error: "Each song needs a MusicBrainz pick and an MP3" },
      { status: 400 },
    );
  }
  if (mbIds.length > uploadLimits.maxSongsPerTemplate) {
    return NextResponse.json(
      {
        error: `At most ${uploadLimits.maxSongsPerTemplate} songs per template`,
      },
      { status: 400 },
    );
  }

  type Validated = {
    displayName: string;
    artist: string;
    musicbrainzId: string;
    coverArtUrl: string | null;
    buf: Buffer;
  };
  const validated: Validated[] = [];
  let totalBytes = 0;

  for (let i = 0; i < mbIds.length; i++) {
    const mbId = mbIds[i];
    const file = files[i];
    if (!mbId) {
      return NextResponse.json(
        { error: "Each song must be picked from MusicBrainz" },
        { status: 400 },
      );
    }
    const recording = await getRecording(mbId);
    if (!recording) {
      return NextResponse.json(
        { error: "Invalid MusicBrainz recording" },
        { status: 400 },
      );
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
      displayName: formatMbLabel(recording),
      artist: recording.artist,
      musicbrainzId: recording.id,
      coverArtUrl: recording.coverArtUrl,
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
      `insert into songs (id, template_id, display_name, mime_type, audio_data, sort_order, musicbrainz_id, cover_art_url, artist_credit)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newId(),
        templateId,
        song.displayName,
        "audio/mpeg",
        song.buf,
        i,
        song.musicbrainzId,
        song.coverArtUrl,
        song.artist,
      ],
    );
  }

  return NextResponse.json({
    id: templateId,
    name,
    songCount: validated.length,
  });
}
