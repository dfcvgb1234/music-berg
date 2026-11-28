import { NextResponse } from "next/server";
import { assertUploadAuthorized } from "@/lib/audioValidate";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import {
  YtdlpImportDisabledError,
  downloadYoutubeAudio,
} from "@/lib/ytdlpLocal";

export const runtime = "nodejs";
/** Local-only; ignored on Vercel because we refuse before spawn. */
export const maxDuration = 300;

/**
 * Downloads one YouTube video as ~196k MP3 via system yt-dlp + ffmpeg,
 * searches Deezer with the cleaned title, and returns audio bytes plus
 * metadata headers. Hard-refuses when process.env.VERCEL is set.
 */
export async function POST(request: Request) {
  const denied = assertUploadAuthorized(request);
  if (denied) return denied;

  const ip = clientKey(request);
  if (!rateLimit(`yt-download:${ip}`, { limit: 6, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many downloads" }, { status: 429 });
  }

  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  try {
    const result = await downloadYoutubeAudio(url);
    const meta = {
      videoId: result.videoId,
      title: result.title,
      searchQuery: result.searchQuery,
      filename: result.filename,
      deezerHit: result.deezerHit,
    };
    // Binary body + JSON meta header (avoids base64 bloat for multi-MB MP3s).
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": result.mimeType,
        "Content-Disposition": `attachment; filename="${result.filename.replace(/"/g, "")}"`,
        "X-Youtube-Meta": Buffer.from(JSON.stringify(meta), "utf8").toString(
          "base64url",
        ),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof YtdlpImportDisabledError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Download failed" },
      { status: 502 },
    );
  }
}
