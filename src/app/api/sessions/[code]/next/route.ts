import { NextResponse } from "next/server";
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

  const songs = await sql<{ id: string }>(
    `select id from songs where template_id = $1 order by sort_order asc, created_at asc`,
    [session.template_id],
  );
  const nextIndex = session.current_song_index + 1;

  if (nextIndex >= songs.length) {
    await sql(
      `update sessions
       set status = 'finished',
           play_started_at = null
       where id = $1`,
      [session.id],
    );
  } else {
    await sql(
      `update sessions
       set status = 'lobby',
           current_song_index = $2,
           clip_ms = 1000,
           play_started_at = null
       where id = $1`,
      [session.id, nextIndex],
    );
  }

  const state = await broadcastSession(code);
  return NextResponse.json({ state });
}
