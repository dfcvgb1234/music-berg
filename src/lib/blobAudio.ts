import { del, get } from "@vercel/blob";
import { uploadLimits } from "@/lib/uploadLimits";

/** True when client→Blob uploads are configured (Vercel Hobby-safe path). */
export function blobUploadsEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

const BLOB_HOST =
  /\.blob\.vercel-storage\.com$/i;

export function isVercelBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && BLOB_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** Download a private Blob object into a Buffer (server-side, not via request body). */
export async function fetchPrivateBlobMp3(url: string): Promise<Buffer> {
  if (!isVercelBlobUrl(url)) {
    throw new Error("Invalid audio blob URL");
  }
  const result = await get(url, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error("Audio blob not found");
  }
  if (result.blob.size != null && result.blob.size > uploadLimits.maxFileBytes) {
    throw new Error("Audio blob exceeds size limit");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = result.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > uploadLimits.maxFileBytes) {
        throw new Error("Audio blob exceeds size limit");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export async function deleteBlobQuiet(url: string): Promise<void> {
  try {
    if (isVercelBlobUrl(url)) {
      await del(url);
    }
  } catch {
    // best-effort cleanup after ingest
  }
}
