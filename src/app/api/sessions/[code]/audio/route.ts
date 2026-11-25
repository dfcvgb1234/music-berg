import { NextResponse } from "next/server";
import { contentDispositionForMime, detectAudioMime } from "@/lib/audioMime";
import { sql } from "@/lib/db";
import { fetchDriveAudio } from "@/lib/driveAudio";
import { getSessionByCode } from "@/lib/quiz";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Host-only session audio. Always returns the full stored file for the current song.
 * Clip length is enforced on the host client (stop timer) so we don't depend
 * on ffmpeg byte-trimming — which is unavailable on Vercel Hobby and produces
 * invalid MP3s that appear silent until Reveal sends the untouched file.
 *
 * Bytes come from Postgres `audio_data` (default) or Google Drive via
 * `drive_file_id` when AUDIO_STORAGE=drive (server proxies with Drive auth).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const ip = clientKey(request);
  if (!rateLimit(`audio:${ip}`, { limit: 30, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many audio requests" }, { status: 429 });
  }
  if (!rateLimit(`audio-global`, { limit: 80, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Server busy" }, { status: 503 });
  }

  const session = await getSessionByCode(code);
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const hostToken = request.headers.get("x-host-token") ?? "";
  if (!hostToken || hostToken !== session.host_token) {
    return NextResponse.json(
      { error: "Audio is host-only" },
      { status: 403 },
    );
  }

  if (session.status !== "playing" && session.status !== "revealed") {
    return NextResponse.json({ error: "No clip yet" }, { status: 403 });
  }

  const meta = await sql<{ id: string }>(
    `select id from songs where template_id = $1
     order by sort_order asc, created_at asc
     offset $2 limit 1`,
    [session.template_id, session.current_song_index],
  );
  const songMeta = meta[0];
  if (!songMeta) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await sql<{
    id: string;
    mime_type: string;
    audio_data: Uint8Array | Buffer | null;
    drive_file_id: string | null;
  }>(
    `select id, mime_type, audio_data, drive_file_id from songs where id = $1`,
    [songMeta.id],
  );
  const song = rows[0];
  if (!song) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let audioBuf: Buffer;
  if (song.drive_file_id?.trim()) {
    try {
      audioBuf = await fetchDriveAudio(song.drive_file_id);
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? `Could not load Drive audio: ${err.message}`
              : "Could not load Drive audio",
        },
        { status: 502 },
      );
    }
  } else if (song.audio_data != null) {
    audioBuf = Buffer.from(song.audio_data);
  } else {
    return NextResponse.json({ error: "Audio missing" }, { status: 404 });
  }

  const bytes = new Uint8Array(audioBuf);
  const mime =
    song.mime_type?.trim() ||
    detectAudioMime(bytes, "audio/mpeg");

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": contentDispositionForMime(mime),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
