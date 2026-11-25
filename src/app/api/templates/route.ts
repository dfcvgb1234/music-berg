import { NextResponse } from "next/server";
import {
  assertUploadAuthorized,
  formatBytes,
  uploadLimits,
} from "@/lib/audioValidate";
import { sql } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import {
  insertTemplate,
  parseAnswerIds,
  validateSongs,
  type SongInput,
} from "@/lib/templateWrite";

export const runtime = "nodejs";
/** Allow Deezer work during multi-file create on Vercel. */
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
        segmentPointsMs?: unknown;
        durationMs?: unknown;
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
      segmentPointsMs: s.segmentPointsMs,
      durationMs: s.durationMs,
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
        error: `Upload too large (max ${formatBytes(uploadLimits.maxTemplateAudioBytes)} audio total). Use shorter clips.`,
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
  const segmentBlobs = form.getAll("segmentPointsMs");
  const durationBlobs = form.getAll("durationMs");
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
    segmentPointsMs: segmentBlobs[i],
    durationMs: durationBlobs[i],
  }));

  const validated = await validateSongs(inputs);
  if (validated instanceof Response) return validated;
  const created = await insertTemplate(name, validated);
  return NextResponse.json(created);
}
