import {
  blobUploadsEnabled,
  deleteBlobQuiet,
  fetchPrivateBlobAudio,
  isVercelBlobUrl,
} from "@/lib/blobAudio";
import {
  deleteR2Quiet,
  fetchR2Audio,
  headR2Object,
  isR2Locator,
  parseR2PublicUrl,
  readR2Config,
  r2UploadsEnabled,
} from "@/lib/r2";

export type UploadMode = "r2" | "blob" | "direct";

/** Prefer R2 when configured; else Vercel Blob; else multipart direct. */
export function resolveUploadMode(): UploadMode {
  if (r2UploadsEnabled()) return "r2";
  if (blobUploadsEnabled()) return "blob";
  return "direct";
}

export function isStagingAudioUrl(url: string): boolean {
  if (isR2Locator(url) || isVercelBlobUrl(url)) return true;
  const config = readR2Config();
  if (config && parseR2PublicUrl(url, config)) return true;
  return false;
}

/** Download a private staging/transient object (R2 or Vercel Blob) into a Buffer. */
export async function fetchStagingAudio(url: string): Promise<Buffer> {
  if (isR2Locator(url)) {
    return fetchR2Audio(url);
  }
  const config = readR2Config();
  if (config && parseR2PublicUrl(url, config)) {
    return fetchR2Audio(url);
  }
  if (isVercelBlobUrl(url)) {
    return fetchPrivateBlobAudio(url);
  }
  throw new Error("Invalid audio staging URL");
}

/**
 * Delete a *transient* upload only (Vercel Blob).
 * Durable R2 objects are kept and must not be deleted after template create.
 */
export async function deleteStagingQuiet(url: string): Promise<void> {
  if (isVercelBlobUrl(url)) {
    await deleteBlobQuiet(url);
    return;
  }
  // R2 uploads are durable — do not delete.
}

export async function verifyR2Upload(
  url: string,
): Promise<{ key: string; contentLength: number; contentType: string | null }> {
  const meta = await headR2Object(url);
  return {
    key: meta.key,
    contentLength: meta.contentLength,
    contentType: meta.contentType,
  };
}

export { deleteR2Quiet };
