import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { broadcastSession, getSessionByCode } from "@/lib/quiz";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const session = await getSessionByCode(code);
  if (!session) {
    return NextResponse.json({ error: "No quiz with that code" }, { status: 404 });
  }
  if (session.status === "finished") {
    return NextResponse.json({ error: "This quiz has finished" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const displayName = String(body?.displayName ?? "").trim().slice(0, 24);
  if (!displayName) {
    return NextResponse.json({ error: "Enter a display name" }, { status: 400 });
  }

  const id = newId();
  const token = newToken();
  await sql(
    `insert into participants (id, session_id, display_name, token)
     values ($1, $2, $3, $4)`,
    [id, session.id, displayName, token],
  );

  await broadcastSession(code);

  return NextResponse.json({
    participantId: id,
    token,
    displayName,
    code: session.code,
  });
}
