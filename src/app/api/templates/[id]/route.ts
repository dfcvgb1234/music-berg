import { NextResponse } from "next/server";
import {
  assertUploadAuthorized,
  formatBytes,
  uploadLimits,
} from "@/lib/audioValidate";
import { normalizeSegmentPointsMs } from "@/lib/clipRules";
import { sql } from "@/lib/db";
import { getTrack, getTracks } from "@/lib/deezer";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import {
  deleteTemplateCascade,
  parseAnswerIds,
  replaceTemplateSongs,
  validateSongs,
  type SongInput,
} from "@/lib/templateWrite";

export const runtime = "nodejs";
export const maxDuration = 60;

type SongRow = {
  id: string;
  display_name: string;
  sort_order: number;
  itunes_track_id: string | null;
  itunes_answer_ids: string | null;
  cover_art_url: string | null;
  artist_credit: string | null;
  segment_points_ms: string | null;
  duration_ms: number | null;
  mime_type: string;
};

async function loadTemplate(id: string) {
  const rows = await sql<{ id: string; name: string; created_at: string }>(
    `select id, name, created_at from templates where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Host edit payload — requires upload secret (answers are included). */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authError = assertUploadAuthorized(request);
  if (authError) return authError;

  const { id } = await context.params;
  const template = await loadTemplate(id);
  if (!template) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const songs = await sql<SongRow>(
    `select id, display_name, sort_order, itunes_track_id, itunes_answer_ids,
            cover_art_url, artist_credit, segment_points_ms, duration_ms, mime_type
     from songs where template_id = $1
     order by sort_order asc, created_at asc`,
    [id],
  );

  const detailed = [];
  for (const song of songs) {
    const primaryId = String(song.itunes_track_id ?? "").trim();
    let answerIds = parseAnswerIds(song.itunes_answer_ids, primaryId || "0");
    if (!primaryId) answerIds = [];
    else answerIds = parseAnswerIds(song.itunes_answer_ids, primaryId);

    let title = song.display_name;
    let artist = song.artist_credit ?? "";
    let coverArtUrl = song.cover_art_url;
    let previewUrl: string | null = null;
    const extras: Array<{
      itunesTrackId: string;
      title: string;
      artist: string;
      coverArtUrl: string | null;
      previewUrl: string | null;
      label: string;
      answerIds: string[];
    }> = [];

    if (primaryId) {
      const looked = await getTracks(answerIds.length ? answerIds : [primaryId]);
      const primary = looked.get(primaryId) ?? (await getTrack(primaryId));
      if (primary) {
        title = primary.title;
        artist = primary.artist;
        coverArtUrl = primary.coverArtUrl;
        previewUrl = primary.previewUrl;
      }
      for (const aid of answerIds) {
        if (aid === primaryId) continue;
        const hit = looked.get(aid);
        if (!hit) continue;
        extras.push({
          itunesTrackId: hit.id,
          title: hit.title,
          artist: hit.artist,
          coverArtUrl: hit.coverArtUrl,
          previewUrl: hit.previewUrl,
          label: `${hit.artist} — ${hit.title}`,
          answerIds: [hit.id],
        });
      }
    }

    detailed.push({
      id: song.id,
      displayName: song.display_name,
      sortOrder: song.sort_order,
      mimeType: song.mime_type,
      segmentPointsMs: normalizeSegmentPointsMs(song.segment_points_ms),
      durationMs:
        song.duration_ms != null && Number.isFinite(Number(song.duration_ms))
          ? Number(song.duration_ms)
          : null,
      pick: primaryId
        ? {
            itunesTrackId: primaryId,
            answerIds: answerIds.length ? answerIds : [primaryId],
            title,
            artist,
            coverArtUrl,
            previewUrl,
            label: artist ? `${artist} — ${title}` : title,
          }
        : null,
      extraAnswers: extras,
    });
  }

  return NextResponse.json({
    id: template.id,
    name: template.name,
    createdAt: template.created_at,
    songs: detailed,
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authError = assertUploadAuthorized(request);
  if (authError) return authError;

  const ip = clientKey(request);
  if (!rateLimit(`templates-put:${ip}`, { limit: 8, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many uploads" }, { status: 429 });
  }

  const { id } = await context.params;
  const template = await loadTemplate(id);
  if (!template) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      songs?: Array<{
        itunesTrackId?: string;
        answerIds?: unknown;
        blobUrl?: string;
        keepSongId?: string;
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
      keepSongId: String(s.keepSongId ?? "").trim() || undefined,
      segmentPointsMs: s.segmentPointsMs,
      durationMs: s.durationMs,
    }));
    const validated = await validateSongs(inputs, { templateId: id });
    if (validated instanceof Response) return validated;
    const updated = await replaceTemplateSongs(id, name, validated);
    return NextResponse.json(updated);
  }

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
  const keepIds = form.getAll("keepSongIds").map((v) => String(v).trim());
  const files = form.getAll("songFiles");

  if (itunesIds.length === 0) {
    return NextResponse.json(
      { error: "Add at least one track pick + audio file" },
      { status: 400 },
    );
  }

  const inputs: SongInput[] = itunesIds.map((itunesTrackId, i) => {
    const keepSongId = keepIds[i] || undefined;
    const file = files[i] instanceof File && (files[i] as File).size > 0
      ? (files[i] as File)
      : undefined;
    return {
      itunesTrackId,
      answerIds: parseAnswerIds(answerIdBlobs[i], itunesTrackId),
      file,
      keepSongId: file ? undefined : keepSongId,
      segmentPointsMs: segmentBlobs[i],
      durationMs: durationBlobs[i],
    };
  });

  const validated = await validateSongs(inputs, { templateId: id });
  if (validated instanceof Response) return validated;
  const updated = await replaceTemplateSongs(id, name, validated);
  return NextResponse.json(updated);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authError = assertUploadAuthorized(request);
  if (authError) return authError;

  const ip = clientKey(request);
  if (!rateLimit(`templates-delete:${ip}`, { limit: 20, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await context.params;
  const template = await loadTemplate(id);
  if (!template) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await deleteTemplateCascade(id);
  if (!result.deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    id,
    sessionsRemoved: result.sessionsRemoved,
  });
}
