/** Client-safe YouTube URL helpers (no yt-dlp). */

const WATCH =
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]{11})/i;
const SHORT = /^(?:https?:\/\/)?(?:www\.)?youtu\.be\/([\w-]{11})/i;
const SHORTS =
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/shorts\/([\w-]{11})/i;
const EMBED =
  /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([\w-]{11})/i;
const PLAYLIST =
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:playlist\?list=|watch\?(?:[^#]*&)?list=)([\w-]+)/i;

export type YoutubeUrlKind = "video" | "playlist" | "invalid";

export function normalizeYoutubeUrl(raw: string): string {
  return raw.trim();
}

export function extractYoutubeVideoId(raw: string): string | null {
  const url = normalizeYoutubeUrl(raw);
  if (!url) return null;
  for (const re of [WATCH, SHORT, SHORTS, EMBED]) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function extractYoutubePlaylistId(raw: string): string | null {
  const url = normalizeYoutubeUrl(raw);
  if (!url) return null;
  const m = url.match(PLAYLIST);
  return m?.[1] ?? null;
}

export function classifyYoutubeUrl(raw: string): YoutubeUrlKind {
  const url = normalizeYoutubeUrl(raw);
  if (!url) return "invalid";
  if (extractYoutubePlaylistId(url)) return "playlist";
  if (extractYoutubeVideoId(url)) return "video";
  return "invalid";
}

export function canonicalYoutubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function canonicalYoutubePlaylistUrl(listId: string): string {
  return `https://www.youtube.com/playlist?list=${listId}`;
}

/**
 * Strip common YouTube noise so Deezer search ranks better.
 * Host still reviews / changes the first hit.
 */
export function youtubeTitleToSearchQuery(title: string): string {
  let q = title.trim();
  q = q.replace(/\[[^\]]*]/g, " ");
  q = q.replace(/\([^)]*\)/g, " ");
  q = q.replace(
    /\b(official\s*(music\s*)?video|official\s*audio|lyrics?\s*video|lyric\s*video|visuali[sz]er|audio|hd|4k|remaster(ed)?|music\s*video)\b/gi,
    " ",
  );
  q = q.replace(/[|/_]+/g, " ");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}
