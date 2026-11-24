import { NextResponse } from "next/server";
import { EXTEND_CLIP_MS } from "@/lib/clipRules";
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

  await sql(
    `update sessions
     set clip_ms = clip_ms + $2,
         play_token = play_token + 1,
         play_started_at = now()
     where id = $1`,
    [session.id, EXTEND_CLIP_MS],
  );

  const state = await broadcastSession(code);
  return NextResponse.json({ state });
}
