import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Direct song-by-id audio is disabled — use session-gated /api/sessions/[code]/audio. */
export async function GET() {
  return NextResponse.json(
    { error: "Use the session audio endpoint" },
    { status: 410 },
  );
}
