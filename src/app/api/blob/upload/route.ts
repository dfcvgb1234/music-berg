import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import {
  ALLOWED_AUDIO_CONTENT_TYPES,
  assertUploadAuthorized,
  isAllowedAudioExtension,
} from "@/lib/audioValidate";
import { blobUploadsEnabled } from "@/lib/blobAudio";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import { uploadLimits } from "@/lib/uploadLimits";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Client-upload token exchange for Vercel Blob.
 * Browser uploads encoded Opus (or legacy MP3) directly to Blob.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!blobUploadsEnabled()) {
    return NextResponse.json(
      { error: "Blob uploads are not configured" },
      { status: 503 },
    );
  }

  const authError = assertUploadAuthorized(request);
  if (authError) {
    const body = await authError.json().catch(() => ({ error: "Unauthorized" }));
    return NextResponse.json(body, { status: authError.status });
  }

  const ip = clientKey(request);
  if (!rateLimit(`blob-upload:${ip}`, { limit: 40, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many uploads" }, { status: 429 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!isAllowedAudioExtension(pathname)) {
          throw new Error("Only .ogg / .opus / .webm / .mp3 uploads are allowed");
        }
        return {
          allowedContentTypes: [...ALLOWED_AUDIO_CONTENT_TYPES],
          maximumSizeInBytes: uploadLimits.maxFileBytes,
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ kind: "template-audio" }),
        };
      },
      onUploadCompleted: async () => {
        // Template create pulls the blob by URL; nothing to persist here.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
