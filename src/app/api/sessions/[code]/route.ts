import { NextResponse } from "next/server";
import { buildSessionState, getSessionByCode, publicState } from "@/lib/quiz";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const session = await getSessionByCode(code);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const hostToken = request.headers.get("x-host-token") ?? "";
  const isHost = Boolean(hostToken && hostToken === session.host_token);
  const state = await buildSessionState(code);
  if (!state) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({
    state: isHost ? state : publicState(state),
    isHost,
  });
}
