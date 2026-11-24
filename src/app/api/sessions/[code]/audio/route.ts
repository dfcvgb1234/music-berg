import { NextResponse } from "next/server";
import { clipMp3 } from "@/lib/clipAudio";
import { sql } from "@/lib/db";
import { getSessionByCode } from "@/lib/quiz";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Session-gated clip audio. Requires host or participant token.
 * Loads only the current song blob. Full track only after reveal.
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
  const participantToken = request.headers.get("x-participant-token") ?? "";
  const isHost = Boolean(hostToken && hostToken === session.host_token);

  if (!isHost) {
    if (!participantToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const members = await sql<{ id: string }>(
      `select id from participants where session_id = $1 and token = $2`,
      [session.id, participantToken],
    );
    if (!members[0]) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (session.status !== "playing" && session.status !== "revealed") {
    return NextResponse.json({ error: "No clip yet" }, { status: 403 });
  }

  // Light query for id only, then load a single blob.
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

  const rows = await sql<{ id: string; audio_data: Uint8Array | Buffer }>(
    `select id, audio_data from songs where id = $1`,
    [songMeta.id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const full = Buffer.from(song.audio_data);
  const revealed = session.status === "revealed";
  const body = revealed
    ? full
    : await clipMp3(full, session.clip_ms / 1000, song.id);

  const bytes = new Uint8Array(body);
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": 'inline; filename="clip.mp3"',
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
