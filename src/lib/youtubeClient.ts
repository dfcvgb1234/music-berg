import type { DeezerTrackHit } from "@/lib/deezer";
import { readApiJson } from "@/lib/readApiJson";

export type YoutubeImportStatus = {
  available: boolean;
  reason: string | null;
  onVercel: boolean;
  hasYtdlp: boolean;
  hasFfmpeg: boolean;
};

export type YoutubePlaylistEntry = {
  id: string;
  title: string;
  url: string;
  duration: number | null;
};

export type YoutubeDownloadMeta = {
  videoId: string;
  title: string;
  searchQuery: string;
  filename: string;
  deezerHit: DeezerTrackHit | null;
};

export type YoutubeDownloadResult = {
  file: File;
  meta: YoutubeDownloadMeta;
};

function decodeMetaHeader(metaHeader: string): YoutubeDownloadMeta {
  const padded = metaHeader.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padLen);
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as YoutubeDownloadMeta;
}

function authHeaders(uploadSecret: string): HeadersInit {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  const secret = uploadSecret.trim();
  if (secret) headers["x-upload-secret"] = secret;
  return headers;
}

export async function fetchYoutubeImportStatus(): Promise<YoutubeImportStatus> {
  const res = await fetch("/api/youtube/status", { cache: "no-store" });
  const data = await readApiJson<
    Partial<YoutubeImportStatus> & { error?: string }
  >(res);
  if (!res.ok) {
    return {
      available: false,
      reason: data.error || "Could not check YouTube import status",
      onVercel: false,
      hasYtdlp: false,
      hasFfmpeg: false,
    };
  }
  return {
    available: Boolean(data.available),
    reason: data.reason ?? null,
    onVercel: Boolean(data.onVercel),
    hasYtdlp: Boolean(data.hasYtdlp),
    hasFfmpeg: Boolean(data.hasFfmpeg),
  };
}

export async function resolveYoutubePlaylistClient(
  url: string,
  uploadSecret: string,
): Promise<YoutubePlaylistEntry[]> {
  const res = await fetch("/api/youtube/resolve", {
    method: "POST",
    headers: authHeaders(uploadSecret),
    body: JSON.stringify({ url }),
  });
  const data = await readApiJson<{
    entries?: YoutubePlaylistEntry[];
    error?: string;
  }>(res);
  if (!res.ok) throw new Error(data.error || "Could not resolve playlist");
  return data.entries ?? [];
}

export async function downloadYoutubeAudioClient(
  url: string,
  uploadSecret: string,
): Promise<YoutubeDownloadResult> {
  const res = await fetch("/api/youtube/download", {
    method: "POST",
    headers: authHeaders(uploadSecret),
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const data = await readApiJson<{ error?: string }>(res);
    throw new Error(data.error || `Download failed (${res.status})`);
  }

  const metaHeader = res.headers.get("X-Youtube-Meta");
  if (!metaHeader) throw new Error("Download missing metadata header");
  const meta = decodeMetaHeader(metaHeader);

  const blob = await res.blob();
  const file = new File([blob], meta.filename || "youtube.mp3", {
    type: blob.type || "audio/mpeg",
  });
  return { file, meta };
}
