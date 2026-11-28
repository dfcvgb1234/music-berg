import { NextResponse } from "next/server";
import { assertUploadAuthorized } from "@/lib/audioValidate";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import {
  YtdlpImportDisabledError,
  resolveYoutubePlaylist,
} from "@/lib/ytdlpLocal";

export const runtime = "nodejs";
/** Local-only; ignored on Vercel because we refuse before spawn. */
export const maxDuration = 120;

export async function POST(request: Request) {
  const denied = assertUploadAuthorized(request);
  if (denied) return denied;

  const ip = clientKey(request);
  if (!rateLimit(`yt-resolve:${ip}`, { limit: 10, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many resolve requests" }, { status: 429 });
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
    const entries = await resolveYoutubePlaylist(url);
    return NextResponse.json({
      entries: entries.map((e) => ({
        id: e.id,
        title: e.title,
        url: e.url,
        duration: e.duration,
      })),
    });
  } catch (err) {
    if (err instanceof YtdlpImportDisabledError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Resolve failed" },
      { status: 502 },
    );
  }
}
