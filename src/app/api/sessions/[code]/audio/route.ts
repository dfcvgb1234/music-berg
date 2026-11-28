import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSessionByCode } from "@/lib/quiz";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import { respondWithSongAudio } from "@/lib/songAudio";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Host-only session audio. Serves the full durable file for the current song
 * from Cloudflare R2 (presigned redirect or stream), with legacy bytea fallback.
 * Clip length is enforced on the host client (stop timer).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const ip = clientKey(request);
  if (!rateLimit(`audio:${ip}`, { limit: 30, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many audio requests" }, { status: 429 });
  }
  if (!rateLimit(`audio-global`, { limit: 80, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Server busy" }, { status: 503 });
  }

  const session = await getSessionByCode(code);
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const hostToken = request.headers.get("x-host-token") ?? "";
  if (!hostToken || hostToken !== session.host_token) {
    return NextResponse.json(
      { error: "Audio is host-only" },
      { status: 403 },
    );
  }

  if (session.status !== "playing" && session.status !== "revealed") {
    return NextResponse.json({ error: "No clip yet" }, { status: 403 });
  }

  const meta = await sql<{ id: string }>(
    `select id from songs where template_id = $1
     order by sort_order asc, created_at asc
     offset $2 limit 1`,
    [session.template_id, session.current_song_index],
  );
  const songMeta = meta[0];
  if (!songMeta) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await sql<{
    mime_type: string | null;
    r2_object_key: string | null;
    r2_object_url: string | null;
    audio_data: Uint8Array | Buffer | null;
  }>(
    `select mime_type, r2_object_key, r2_object_url, audio_data
     from songs where id = $1`,
    [songMeta.id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return respondWithSongAudio(song);
}
