import { NextResponse } from "next/server";
import { uploadModePayload } from "@/lib/audioStorage";

export const runtime = "nodejs";

/** Lets the host UI choose Blob client uploads vs multipart POST (+ storage hint). */
export async function GET() {
  return NextResponse.json(uploadModePayload());
}
