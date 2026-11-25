import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { broadcastSession, getSessionByCode } from "@/lib/quiz";

export const runtime = "nodejs";

/** Host reveals the current song and bumps play_token so clients load the full track. */
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

  await sql(
    `update sessions
     set status = 'revealed',
         play_token = play_token + 1,
         play_started_at = now()
     where id = $1`,
    [session.id],
  );

  const state = await broadcastSession(code);
  return NextResponse.json({ state });
}
