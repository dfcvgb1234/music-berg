import { NextResponse } from "next/server";
import { blobUploadsEnabled } from "@/lib/blobAudio";

export const runtime = "nodejs";

/** Lets the host UI choose Blob client uploads vs multipart POST. */
export async function GET() {
  return NextResponse.json({
    mode: blobUploadsEnabled() ? "blob" : "direct",
  });
}
