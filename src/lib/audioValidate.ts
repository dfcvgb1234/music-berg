export { formatBytes, uploadLimits } from "@/lib/uploadLimits";
export {
  ALLOWED_AUDIO_CONTENT_TYPES,
  ALLOWED_AUDIO_EXTENSIONS,
  detectAudioMime,
  isAllowedAudioContentType,
  isAllowedAudioExtension,
  isOggBuffer,
  isWebmBuffer,
} from "@/lib/audioMime";
import {
  isAllowedAudioContentType,
  isAllowedAudioExtension,
  isOggBuffer,
  isWebmBuffer,
} from "@/lib/audioMime";

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

/** Opus-in-Ogg (preferred), Opus-in-WebM, or legacy MP3. */
export function isSupportedAudioBuffer(buf: Buffer): boolean {
  return isOggBuffer(buf) || isWebmBuffer(buf) || isMp3Buffer(buf);
}

export function assertUploadedAudioFile(file: File): string | null {
  if (file.size <= 0) return "Empty audio file";
  if (!isAllowedAudioExtension(file.name)) {
    return "Only .ogg / .opus / .webm / .mp3 audio is allowed";
  }
  if (!isAllowedAudioContentType(file.type)) {
    return "Unsupported audio content type";
  }
  return null;
}

export function assertUploadAuthorized(request: Request): Response | null {
  // Prefer Bergs Music name; keep RIFFRUSH_* for existing hosted secrets.
  const expected =
    process.env.BERGS_MUSIC_UPLOAD_SECRET?.trim() ||
    process.env.RIFFRUSH_UPLOAD_SECRET?.trim() ||
    "";
  const provided = request.headers.get("x-upload-secret")?.trim() ?? "";

  if (expected) {
    if (!provided || provided !== expected) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  }

  // Hosted apps always have DATABASE_URL — require a configured secret there.
  if (process.env.DATABASE_URL?.trim()) {
    return Response.json(
      { error: "Upload secret not configured" },
      { status: 503 },
    );
  }

  // Local / PGlite (no DATABASE_URL): allow without a shared secret.
  return null;
}
