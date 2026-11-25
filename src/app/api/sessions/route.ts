import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newId, newSessionCode, newToken } from "@/lib/ids";
import { broadcastSession } from "@/lib/quiz";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

const MAX_SESSIONS = 200;

export async function POST(request: Request) {
  const ip = clientKey(request);
  if (!rateLimit(`sessions-create:${ip}`, { limit: 10, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many rooms" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const templateId = String(body?.templateId ?? "").trim();
  if (!templateId) {
    return NextResponse.json({ error: "Pick a track list" }, { status: 400 });
  }

  const sessionCount = await sql<{ count: string }>(
    `select count(*)::text as count from sessions where status <> 'finished'`,
  );
  if (Number(sessionCount[0]?.count ?? 0) >= MAX_SESSIONS) {
    return NextResponse.json(
      { error: "Too many active rooms — try again later" },
      { status: 503 },
    );
  }

  const templates = await sql<{ id: string; name: string }>(
    `select id, name from templates where id = $1`,
    [templateId],
  );
  if (!templates[0]) {
    return NextResponse.json({ error: "Track list not found" }, { status: 404 });
  }

  const songs = await sql<{ id: string }>(
    `select id from songs where template_id = $1`,
    [templateId],
  );
  if (songs.length === 0) {
    return NextResponse.json(
      { error: "Track list has no songs" },
      { status: 400 },
    );
  }

  let code = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = newSessionCode();
    const existing = await sql<{ id: string }>(
      `select id from sessions where code = $1`,
      [candidate],
    );
    if (!existing[0]) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return NextResponse.json({ error: "Could not allocate a code" }, { status: 500 });
  }

  const id = newId();
  const hostToken = newToken();
  await sql(
    `insert into sessions (id, code, template_id, host_token, status)
     values ($1, $2, $3, $4, 'lobby')`,
    [id, code, templateId, hostToken],
  );

  await broadcastSession(code);

  return NextResponse.json({
    id,
    code,
    hostToken,
    templateName: templates[0].name,
  });
}
