import { NextResponse } from "next/server";
import { clipMp3 } from "@/lib/clipAudio";
import { sql } from "@/lib/db";
import { getSessionByCode } from "@/lib/quiz";

export const runtime = "nodejs";

/**
 * Session-gated clip audio. Requires host or participant token.
 * Non-hosts only receive up to the current clip length (not the full track).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
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

  const songs = await sql<{ id: string; audio_data: Uint8Array | Buffer }>(
    `select id, audio_data from songs where template_id = $1
     order by sort_order asc, created_at asc`,
    [session.template_id],
  );
  const song = songs[session.current_song_index];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const full = Buffer.from(song.audio_data);
  const seconds = session.clip_ms / 1000;
  // Always clip to the active window so full tracks are not handed out by ID.
  const body =
    session.status === "revealed" && isHost
      ? full
      : await clipMp3(full, seconds);

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
