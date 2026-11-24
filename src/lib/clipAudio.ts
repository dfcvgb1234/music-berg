import { spawn } from "node:child_process";

/** Re-encode the first `seconds` of an MP3. Falls back to raw bytes if ffmpeg fails. */
export async function clipMp3(
  input: Buffer,
  seconds: number,
): Promise<Buffer> {
  const duration = Math.max(0.2, Math.min(30, seconds));
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
    const approxBytes = Math.ceil((duration * 16000) / 1);
    return input.subarray(0, Math.min(input.length, Math.max(2048, approxBytes)));
  }
}
