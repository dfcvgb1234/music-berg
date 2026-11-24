import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

type SongAudio = { mime_type: string; audio_data: Uint8Array | Buffer };

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const rows = await sql<SongAudio>(
    `select mime_type, audio_data from songs where id = $1`,
    [id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = Buffer.from(song.audio_data);
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": song.mime_type || "audio/mpeg",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    },
  });
}
