import { NextResponse } from "next/server";
import {
  canExtendClip,
  MAX_EXTENDS,
  nextClipMs,
  normalizeSegmentPointsMs,
} from "@/lib/clipRules";
import { sql } from "@/lib/db";
import { broadcastSession, getSessionByCode } from "@/lib/quiz";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const session = await getSessionByCode(code);
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const hostToken = request.headers.get("x-host-token") ?? "";
  if (!hostToken || hostToken !== session.host_token) {
    return NextResponse.json({ error: "Host only" }, { status: 403 });
  }
  if (session.status !== "playing") {
    return NextResponse.json({ error: "Start playback first" }, { status: 400 });
  }

  const songs = await sql<{
    segment_points_ms: string | null;
    duration_ms: number | null;
  }>(
    `select segment_points_ms, duration_ms from songs
     where template_id = $1
     order by sort_order asc, created_at asc`,
    [session.template_id],
  );
  const current = songs[session.current_song_index];
  const segmentPointsMs = normalizeSegmentPointsMs(
    current?.segment_points_ms ?? null,
  );
  const durationMs =
    current?.duration_ms != null && Number.isFinite(Number(current.duration_ms))
      ? Math.max(0, Number(current.duration_ms))
      : null;
  const extendCount =
    session.extend_count != null ? Number(session.extend_count) : 0;

  if (
    !canExtendClip(session.clip_ms, {
      segmentPointsMs,
      durationMs,
      extendCount,
    })
  ) {
    return NextResponse.json(
      { error: "Clip already fully unlocked" },
      { status: 400 },
    );
  }

  const targetMs = nextClipMs(session.clip_ms, {
    segmentPointsMs,
    durationMs,
    extendCount,
  });
  const nextExtendCount = Math.min(MAX_EXTENDS, extendCount + 1);

  await sql(
    `update sessions
     set clip_ms = $2,
         extend_count = $3,
         play_token = play_token + 1,
         play_started_at = now()
     where id = $1`,
    [session.id, targetMs, nextExtendCount],
  );

  const state = await broadcastSession(code);
  return NextResponse.json({ state });
}
