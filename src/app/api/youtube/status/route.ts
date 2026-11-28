import { NextResponse } from "next/server";
import { getYtdlpStatus } from "@/lib/ytdlpLocal";

export const runtime = "nodejs";

/**
 * Reports whether local yt-dlp import can run on this process.
 * Always safe on Vercel — returns available:false, never spawns yt-dlp.
 */
export async function GET() {
  const status = await getYtdlpStatus();
  return NextResponse.json({
    available: status.available,
    reason: status.reason,
    onVercel: status.onVercel,
    hasYtdlp: Boolean(status.ytdlpPath),
    hasFfmpeg: Boolean(status.ffmpegPath),
  });
}
