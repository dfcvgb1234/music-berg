import { spawn } from "node:child_process";

const MAX_CONCURRENT_FFMPEG = 2;
let activeFfmpeg = 0;
const waitQueue: Array<() => void> = [];

async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeFfmpeg >= MAX_CONCURRENT_FFMPEG) {
    await new Promise<void>((resolve) => waitQueue.push(resolve));
  }
  activeFfmpeg += 1;
  try {
    return await fn();
  } finally {
    activeFfmpeg -= 1;
    const next = waitQueue.shift();
    if (next) next();
  }
}

type CacheEntry = { buf: Buffer; expiresAt: number };
const clipCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 32;

function cacheGet(key: string): Buffer | null {
  const hit = clipCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    clipCache.delete(key);
    return null;
  }
  return hit.buf;
}

function cacheSet(key: string, buf: Buffer) {
  if (clipCache.size >= CACHE_MAX) {
    const first = clipCache.keys().next().value;
    if (first) clipCache.delete(first);
  }
  clipCache.set(key, { buf, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Re-encode the first `seconds` of an MP3. Falls back to raw bytes if ffmpeg fails. */
export async function clipMp3(
  input: Buffer,
  seconds: number,
  cacheKey?: string,
): Promise<Buffer> {
  const duration = Math.max(0.2, Math.min(30, seconds));
  const key = cacheKey ? `${cacheKey}:${duration.toFixed(1)}` : "";
  if (key) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  const out = await withFfmpegSlot(async () => {
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const ff = spawn(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-t",
            String(duration),
            "-f",
            "mp3",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "5",
            "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        ff.stdout.on("data", (c: Buffer) => chunks.push(c));
        ff.stderr.on("data", (c: Buffer) => errChunks.push(c));
        ff.on("error", reject);
        ff.on("close", (code) => {
          if (code === 0 && chunks.length) {
            resolve(Buffer.concat(chunks));
          } else {
            const errText = Buffer.concat(errChunks).toString("utf8");
            reject(new Error(errText || `ffmpeg exited ${code ?? "?"}`));
          }
        });
        ff.stdin.write(input);
        ff.stdin.end();
      });
    } catch {
      // Approximate byte trim if ffmpeg is unavailable (~128kbps).
      const approxBytes = Math.ceil(duration * 16000);
      return input.subarray(
        0,
        Math.min(input.length, Math.max(2048, approxBytes)),
      );
    }
  });

  if (key) cacheSet(key, out);
  return out;
}
