import { NextResponse } from "next/server";
import { assertUploadAuthorized } from "@/lib/audioValidate";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Host-only: fetch a stored song clip for edit / segment marking.
 * Requires the same upload secret as create/edit.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authError = assertUploadAuthorized(request);
  if (authError) return authError;

  const { id } = await context.params;
  const songId = new URL(request.url).searchParams.get("songId")?.trim() ?? "";
  if (!songId) {
    return NextResponse.json({ error: "songId required" }, { status: 400 });
  }

  const rows = await sql<{
    mime_type: string;
    audio_data: Buffer;
  }>(
    `select mime_type, audio_data from songs
     where id = $1 and template_id = $2`,
    [songId, id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const buf = Buffer.isBuffer(song.audio_data)
    ? song.audio_data
    : Buffer.from(song.audio_data as unknown as ArrayBuffer);

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": song.mime_type || "audio/ogg",
      "Cache-Control": "no-store",
      "Content-Length": String(buf.length),
    },
  });
}
