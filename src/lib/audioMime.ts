/** Shared MIME / extension rules for quiz audio (Opus preferred, MP3 legacy). */

export const OPUS_MIME = "audio/ogg" as const;
export const OPUS_EXT = ".ogg" as const;
export const OPUS_BITRATE = "96k" as const;

/** Content types accepted for new template uploads (encoded Opus or legacy MP3). */
export const ALLOWED_AUDIO_CONTENT_TYPES = [
  "audio/ogg",
  "audio/opus",
  "application/ogg",
  "audio/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "application/octet-stream",
] as const;

export const ALLOWED_AUDIO_EXTENSIONS = [
  ".ogg",
  ".opus",
  ".webm",
  ".mp3",
] as const;

export function isAllowedAudioExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isAllowedAudioContentType(type: string): boolean {
  const reported = (type || "").toLowerCase().trim();
  if (!reported || reported === "application/octet-stream") return true;
  return (ALLOWED_AUDIO_CONTENT_TYPES as readonly string[]).includes(reported);
}

/** OggS magic (Ogg container used for Opus). */
export function isOggBuffer(buf: Buffer | Uint8Array): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x4f &&
    buf[1] === 0x67 &&
    buf[2] === 0x67 &&
    buf[3] === 0x53
  );
}

/** WebM / Matroska EBML header (optional Opus-in-WebM uploads). */
export function isWebmBuffer(buf: Buffer | Uint8Array): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  );
}

export function detectAudioMime(
  buf: Buffer | Uint8Array,
  fallback = "application/octet-stream",
): string {
  if (isOggBuffer(buf)) return "audio/ogg";
  if (isWebmBuffer(buf)) return "audio/webm";
  // MP3: ID3 or frame sync — keep lightweight here; callers may use isMp3Buffer.
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return "audio/mpeg";
  }
  if (
    buf.length >= 2 &&
    buf[0] === 0xff &&
    (buf[1] & 0xe0) === 0xe0
  ) {
    return "audio/mpeg";
  }
  return fallback;
}

export function filenameForAudioMime(mime: string, index: number): string {
  if (mime === "audio/ogg" || mime === "audio/opus" || mime === "application/ogg") {
    return `song-${index + 1}.ogg`;
  }
  if (mime === "audio/webm") return `song-${index + 1}.webm`;
  return `song-${index + 1}.mp3`;
}

export function contentDispositionForMime(mime: string): string {
  if (mime.startsWith("audio/ogg") || mime === "audio/opus" || mime === "application/ogg") {
    return 'inline; filename="clip.ogg"';
  }
  if (mime === "audio/webm") return 'inline; filename="clip.webm"';
  return 'inline; filename="clip.mp3"';
}
