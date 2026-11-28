import { NextResponse } from "next/server";
import {
  assertUploadAuthorized,
  isAllowedAudioContentType,
  isAllowedAudioExtension,
} from "@/lib/audioValidate";
import { createR2PresignedUpload, r2UploadsEnabled } from "@/lib/r2";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import { uploadLimits } from "@/lib/uploadLimits";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  pathname?: string;
  contentType?: string;
  contentLength?: number;
};

/**
 * Issue a short-lived R2 presigned PUT URL for client Opus uploads.
 * Browser uploads directly to R2; `/api/templates` then pulls by staging URL.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!r2UploadsEnabled()) {
    return NextResponse.json(
      { error: "R2 uploads are not configured" },
      { status: 503 },
    );
  }

  const authError = assertUploadAuthorized(request);
  if (authError) {
    const body = await authError.json().catch(() => ({ error: "Unauthorized" }));
    return NextResponse.json(body, { status: authError.status });
  }

  const ip = clientKey(request);
  if (!rateLimit(`r2-upload:${ip}`, { limit: 40, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many uploads" }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as Body | null;
  const pathname = String(body?.pathname ?? "").trim();
  const contentType = String(body?.contentType ?? "").trim().toLowerCase();
  const contentLength = Number(body?.contentLength ?? 0);

  if (!pathname || pathname.includes("..") || pathname.startsWith("/")) {
    return NextResponse.json({ error: "Invalid pathname" }, { status: 400 });
  }
  if (!isAllowedAudioExtension(pathname)) {
    return NextResponse.json(
      { error: "Only .ogg / .opus / .webm / .mp3 uploads are allowed" },
      { status: 400 },
    );
  }
  const resolvedType = contentType || "audio/ogg";
  if (!isAllowedAudioContentType(resolvedType)) {
    return NextResponse.json(
      { error: "Unsupported audio content type" },
      { status: 400 },
    );
  }
  if (
    !Number.isFinite(contentLength) ||
    contentLength <= 0 ||
    contentLength > uploadLimits.maxFileBytes
  ) {
    return NextResponse.json(
      { error: `Each audio file must be under ${uploadLimits.maxFileBytes} bytes` },
      { status: 400 },
    );
  }

  // Namespace under templates/ with a random suffix (no overwrite).
  const safeBase = pathname
    .replace(/^templates\//, "")
    .replace(/[^\w.\-/]+/g, "_")
    .slice(0, 160);
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = `templates/${rand}-${safeBase}`.slice(0, 200);

  try {
    const signed = await createR2PresignedUpload({
      key,
      contentType: resolvedType,
      contentLength,
    });
    return NextResponse.json({
      uploadUrl: signed.uploadUrl,
      stagingUrl: signed.stagingUrl,
      key: signed.key,
      bucket: signed.bucket,
      contentType: resolvedType,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
