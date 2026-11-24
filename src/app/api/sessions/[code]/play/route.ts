import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { broadcastSession, getSessionByCode } from "@/lib/quiz";

export const runtime = "nodejs";

async function requireHost(code: string, request: Request) {
  const session = await getSessionByCode(code);
  if (!session) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  const hostToken = request.headers.get("x-host-token") ?? "";
  if (!hostToken || hostToken !== session.host_token) {
    return { error: NextResponse.json({ error: "Host only" }, { status: 403 }) };
  }
  return { session };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const auth = await requireHost(code, request);
  if ("error" in auth && auth.error) return auth.error;
  const session = auth.session!;

  if (session.status === "finished") {
    return NextResponse.json({ error: "Quiz finished" }, { status: 400 });
  }

  // First unlock is 1s; later Play replays the full unlocked segment.
  const nextClip =
    session.status === "lobby" || session.clip_ms < 1000
      ? 1000
      : session.clip_ms;

  await sql(
    `update sessions
     set status = 'playing',
         clip_ms = $2,
         play_token = play_token + 1,
         play_started_at = now()
     where id = $1`,
    [session.id, nextClip],
  );

  const state = await broadcastSession(code);
  return NextResponse.json({ state });
}
