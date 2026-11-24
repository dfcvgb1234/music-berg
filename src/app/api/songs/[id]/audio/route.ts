import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

type SongAudio = { audio_data: Uint8Array | Buffer };

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await sql<SongAudio>(
    `select audio_data from songs where id = $1`,
    [id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = Buffer.from(song.audio_data);
  return new NextResponse(bytes, {
    headers: {
      // Always force audio/mpeg — never trust stored client MIME types.
      "Content-Type": "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": 'inline; filename="clip.mp3"',
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
