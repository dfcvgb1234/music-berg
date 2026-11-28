import {
  blobUploadsEnabled,
  deleteBlobQuiet,
  fetchPrivateBlobAudio,
  isVercelBlobUrl,
} from "@/lib/blobAudio";
import {
  deleteR2Quiet,
  fetchR2Audio,
  isR2StagingUrl,
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
  if (isR2StagingUrl(url) || isVercelBlobUrl(url)) return true;
  const config = readR2Config();
  if (config && parseR2PublicUrl(url, config)) return true;
  return false;
}

/** Download a private staging object (R2 or Vercel Blob) into a Buffer. */
export async function fetchStagingAudio(url: string): Promise<Buffer> {
  if (isR2StagingUrl(url)) {
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

export async function deleteStagingQuiet(url: string): Promise<void> {
  if (isR2StagingUrl(url)) {
    await deleteR2Quiet(url);
    return;
  }
  const config = readR2Config();
  if (config && parseR2PublicUrl(url, config)) {
    await deleteR2Quiet(url);
    return;
  }
  await deleteBlobQuiet(url);
}
