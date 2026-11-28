import { NextResponse } from "next/server";
import { assertUploadAuthorized } from "@/lib/audioValidate";
import { sql } from "@/lib/db";
import { respondWithSongAudio } from "@/lib/songAudio";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    mime_type: string | null;
    r2_object_key: string | null;
    r2_object_url: string | null;
  }>(
    `select mime_type, r2_object_key, r2_object_url from songs
     where id = $1 and template_id = $2`,
    [songId, id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return respondWithSongAudio(song);
}
