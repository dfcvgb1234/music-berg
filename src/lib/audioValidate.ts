const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SONGS_PER_TEMPLATE = 12;
const MAX_TEMPLATES = 40;
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

export const uploadLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxSongsPerTemplate: MAX_SONGS_PER_TEMPLATE,
  maxTemplates: MAX_TEMPLATES,
  maxRequestBytes: MAX_REQUEST_BYTES,
} as const;

/** True if buffer looks like MP3 (ID3 tag or MPEG frame sync). */
export function isMp3Buffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // ID3v2 header
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // MPEG audio frame sync: 11 set bits
  for (let i = 0; i < Math.min(buf.length - 1, 8192); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const layer = (buf[i + 1] >> 1) & 0x3;
      // Layer bits 01/10/11 are valid MPEG audio; 00 is reserved
      if (layer !== 0) return true;
    }
  }
  return false;
}

export function assertUploadAuthorized(request: Request): Response | null {
  const expected = process.env.RIFFRUSH_UPLOAD_SECRET?.trim() ?? "";
  // Local / unpublished: allow a fixed fallback so the app is usable without secrets.
  // Published apps must set RIFFRUSH_UPLOAD_SECRET — empty production secret rejects.
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
