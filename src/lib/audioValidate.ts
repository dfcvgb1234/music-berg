import { uploadLimits } from "@/lib/uploadLimits";

export { formatBytes, uploadLimits } from "@/lib/uploadLimits";

/** True if buffer looks like MP3 (ID3 tag or MPEG frame sync). */
export function isMp3Buffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  for (let i = 0; i < Math.min(buf.length - 1, 8192); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const layer = (buf[i + 1] >> 1) & 0x3;
      if (layer !== 0) return true;
    }
  }
  return false;
}

export function assertUploadAuthorized(request: Request): Response | null {
  const expected = process.env.RIFFRUSH_UPLOAD_SECRET?.trim() ?? "";
  const isPublished = Boolean(process.env.DATABASE_URL?.trim());
  const secret = expected || (isPublished ? "" : "local-dev-upload");
  if (!secret) {
    return Response.json(
      { error: "Upload secret not configured" },
      { status: 503 },
    );
  }
  const provided = request.headers.get("x-upload-secret")?.trim() ?? "";
  if (!provided || provided !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

void uploadLimits;
