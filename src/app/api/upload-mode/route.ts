import { NextResponse } from "next/server";
import { resolveUploadMode } from "@/lib/stagingAudio";

export const runtime = "nodejs";

/** Lets the host UI choose R2 / Blob client uploads vs multipart POST. */
export async function GET() {
  return NextResponse.json({
    mode: resolveUploadMode(),
  });
}
