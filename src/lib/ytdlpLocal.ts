import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import {
  canonicalYoutubePlaylistUrl,
  canonicalYoutubeWatchUrl,
  classifyYoutubeUrl,
  extractYoutubePlaylistId,
  extractYoutubeVideoId,
  youtubeTitleToSearchQuery,
} from "@/lib/youtubeUrl";
import { searchSongs, type DeezerTrackHit } from "@/lib/deezer";

export class YtdlpImportDisabledError extends Error {
  status = 501;
  constructor(message: string) {
    super(message);
    this.name = "YtdlpImportDisabledError";
  }
}

export type YtdlpStatus = {
  available: boolean;
  reason: string | null;
  ytdlpPath: string | null;
  ffmpegPath: string | null;
  onVercel: boolean;
};

export type YtdlpPlaylistEntry = {
  id: string;
  title: string;
  url: string;
  duration: number | null;
};

export type YtdlpDownloadResult = {
  videoId: string;
  title: string;
  searchQuery: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  deezerHit: DeezerTrackHit | null;
};

const YTDLP_CANDIDATES = [
  process.env.YTDLP_PATH?.trim(),
  "yt-dlp",
  join(process.env.HOME ?? "", ".local/bin/yt-dlp"),
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
].filter(Boolean) as string[];

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH?.trim(),
  "ffmpeg",
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
].filter(Boolean) as string[];

function onVercel(): boolean {
  return Boolean(process.env.VERCEL);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOnPath(cmd: string): Promise<string | null> {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return (await pathExists(cmd)) ? cmd : null;
  }
  return new Promise((resolve) => {
    const child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      const line = out.trim().split("\n")[0]?.trim();
      resolve(code === 0 && line ? line : null);
    });
    child.on("error", () => resolve(null));
  });
}

async function findBinary(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const resolved = await resolveOnPath(c);
    if (resolved) return resolved;
  }
  return null;
}

export function assertYtdlpImportAllowed(): void {
  if (onVercel()) {
    throw new YtdlpImportDisabledError(
      "YouTube download via yt-dlp is disabled on Vercel (timeouts, no binary, disk, IP blocks, ToS). Use local `npm run import:youtube` or `next dev` on a machine with yt-dlp + ffmpeg.",
    );
  }
  if (process.env.YTDLP_IMPORT === "0" || process.env.YTDLP_IMPORT === "false") {
    throw new YtdlpImportDisabledError(
      "YouTube import disabled (YTDLP_IMPORT=0).",
    );
  }
}

export async function getYtdlpStatus(): Promise<YtdlpStatus> {
  if (onVercel()) {
    return {
      available: false,
      reason:
        "Not available on Vercel serverless. Run locally with yt-dlp + ffmpeg, or use npm run import:youtube.",
      ytdlpPath: null,
      ffmpegPath: null,
      onVercel: true,
    };
  }
  if (process.env.YTDLP_IMPORT === "0" || process.env.YTDLP_IMPORT === "false") {
    return {
      available: false,
      reason: "Disabled via YTDLP_IMPORT=0.",
      ytdlpPath: null,
      ffmpegPath: null,
      onVercel: false,
    };
  }
  const ytdlpPath = await findBinary(YTDLP_CANDIDATES);
  const ffmpegPath = await findBinary(FFMPEG_CANDIDATES);
  if (!ytdlpPath) {
    return {
      available: false,
      reason:
        "yt-dlp not found. Install it (e.g. pip install yt-dlp) or set YTDLP_PATH.",
      ytdlpPath: null,
      ffmpegPath,
      onVercel: false,
    };
  }
  if (!ffmpegPath) {
    return {
      available: false,
      reason:
        "ffmpeg not found (required to extract MP3). Install ffmpeg or set FFMPEG_PATH.",
      ytdlpPath,
      ffmpegPath: null,
      onVercel: false,
    };
  }
  return {
    available: true,
    reason: null,
    ytdlpPath,
    ffmpegPath,
    onVercel: false,
  };
}

type SpawnResult = { code: number | null; stdout: string; stderr: string };

function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${bin}`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function cookieArgs(): string[] {
  const args: string[] = [];
  const cookies = process.env.YTDLP_COOKIES?.trim();
  if (cookies) {
    args.push("--cookies", cookies);
  }
  const fromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (fromBrowser) {
    args.push("--cookies-from-browser", fromBrowser);
  }
  // Prefer Node when present (yt-dlp EJS); harmless if unused.
  args.push("--js-runtimes", "node");
  return args;
}

function baseYtdlpArgs(): string[] {
  return [
    ...cookieArgs(),
    "--no-warnings",
    "--newline",
    // Prefer common audio; fall back to bestaudio.
    "-f",
    "bestaudio[ext=m4a]/bestaudio/best",
  ];
}

export async function resolveYoutubePlaylist(
  rawUrl: string,
): Promise<YtdlpPlaylistEntry[]> {
  assertYtdlpImportAllowed();
  const status = await getYtdlpStatus();
  if (!status.available || !status.ytdlpPath) {
    throw new YtdlpImportDisabledError(status.reason ?? "yt-dlp unavailable");
  }

  const kind = classifyYoutubeUrl(rawUrl);
  let target = rawUrl.trim();
  if (kind === "playlist") {
    const listId = extractYoutubePlaylistId(rawUrl);
    if (!listId) throw new Error("Invalid playlist URL");
    target = canonicalYoutubePlaylistUrl(listId);
  } else if (kind === "video") {
    const videoId = extractYoutubeVideoId(rawUrl);
    if (!videoId) throw new Error("Invalid video URL");
    // Single video: still return one entry via flat dump.
    target = canonicalYoutubeWatchUrl(videoId);
  } else {
    throw new Error("Paste a YouTube video or playlist URL");
  }

  const result = await run(
    status.ytdlpPath,
    [
      ...baseYtdlpArgs(),
      "--flat-playlist",
      "-J",
      "--yes-playlist",
      target,
    ],
    { timeoutMs: 120_000 },
  );

  if (result.code !== 0) {
    throw new Error(formatYtdlpError(result.stderr || result.stdout));
  }

  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error("yt-dlp returned invalid JSON for playlist resolve");
  }

  const entries = flattenPlaylistEntries(json);
  if (entries.length === 0) {
    throw new Error("No videos found in that URL");
  }
  return entries;
}

function flattenPlaylistEntries(json: unknown): YtdlpPlaylistEntry[] {
  if (!json || typeof json !== "object") return [];
  const root = json as {
    _type?: string;
    id?: string;
    title?: string;
    url?: string;
    webpage_url?: string;
    duration?: number;
    entries?: unknown[];
  };

  if (Array.isArray(root.entries)) {
    const out: YtdlpPlaylistEntry[] = [];
    for (const raw of root.entries) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as {
        id?: string;
        title?: string;
        url?: string;
        webpage_url?: string;
        duration?: number;
        ie_key?: string;
      };
      const id = typeof e.id === "string" ? e.id : "";
      if (!id || id.length < 6) continue;
      const title =
        (typeof e.title === "string" && e.title.trim()) || `Video ${id}`;
      const url =
        (typeof e.url === "string" && e.url.startsWith("http")
          ? e.url
          : null) ||
        (typeof e.webpage_url === "string" ? e.webpage_url : null) ||
        canonicalYoutubeWatchUrl(id);
      out.push({
        id,
        title,
        url,
        duration:
          typeof e.duration === "number" && Number.isFinite(e.duration)
            ? e.duration
            : null,
      });
    }
    return out;
  }

  // Single video dump.
  const id = typeof root.id === "string" ? root.id : "";
  if (!id) return [];
  return [
    {
      id,
      title:
        (typeof root.title === "string" && root.title.trim()) || `Video ${id}`,
      url:
        (typeof root.webpage_url === "string" && root.webpage_url) ||
        (typeof root.url === "string" && root.url) ||
        canonicalYoutubeWatchUrl(id),
      duration:
        typeof root.duration === "number" && Number.isFinite(root.duration)
          ? root.duration
          : null,
    },
  ];
}

export async function downloadYoutubeAudio(
  rawUrl: string,
): Promise<YtdlpDownloadResult> {
  assertYtdlpImportAllowed();
  const status = await getYtdlpStatus();
  if (!status.available || !status.ytdlpPath || !status.ffmpegPath) {
    throw new YtdlpImportDisabledError(status.reason ?? "yt-dlp unavailable");
  }

  const videoId = extractYoutubeVideoId(rawUrl);
  if (!videoId) {
    throw new Error("Paste a single YouTube video URL (not a playlist)");
  }
  const target = canonicalYoutubeWatchUrl(videoId);

  const dir = await mkdtemp(join(tmpdir(), "bergs-yt-"));
  try {
    const outTpl = join(dir, "audio.%(ext)s");
    const result = await run(
      status.ytdlpPath,
      [
        ...baseYtdlpArgs(),
        "--no-playlist",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "196K",
        "--ffmpeg-location",
        status.ffmpegPath,
        "-o",
        outTpl,
        "--print",
        "after_move:%(title)s",
        target,
      ],
      { timeoutMs: 8 * 60_000 },
    );

    if (result.code !== 0) {
      throw new Error(formatYtdlpError(result.stderr || result.stdout));
    }

    const files = (await readdir(dir)).filter((f) => !f.startsWith("."));
    const audioName =
      files.find((f) => /\.(mp3|m4a|opus|ogg|webm)$/i.test(f)) ?? files[0];
    if (!audioName) {
      throw new Error("yt-dlp finished but no audio file was written");
    }
    const buffer = await readFile(join(dir, audioName));
    if (buffer.length < 1024) {
      throw new Error("Downloaded audio looks empty");
    }

    const printedTitle = result.stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const title =
      (printedTitle && !printedTitle.startsWith("ERROR")
        ? printedTitle
        : null) || `youtube-${videoId}`;

    const searchQuery = youtubeTitleToSearchQuery(title);
    let deezerHit: DeezerTrackHit | null = null;
    if (searchQuery.length >= 2) {
      try {
        const hits = await searchSongs(searchQuery, 1);
        deezerHit = hits[0] ?? null;
      } catch {
        deezerHit = null;
      }
    }

    const lower = audioName.toLowerCase();
    const mimeType = lower.endsWith(".mp3")
      ? "audio/mpeg"
      : lower.endsWith(".m4a")
        ? "audio/mp4"
        : lower.endsWith(".ogg") || lower.endsWith(".opus")
          ? "audio/ogg"
          : lower.endsWith(".webm")
            ? "audio/webm"
            : "application/octet-stream";

    const safeBase = title
      .replace(/[^\w.\- ]+/g, "")
      .trim()
      .slice(0, 80) || videoId;
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : ".mp3";

    return {
      videoId,
      title,
      searchQuery,
      filename: `${safeBase}${ext}`,
      mimeType,
      buffer,
      deezerHit,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  }
}

function formatYtdlpError(raw: string): string {
  const text = raw.trim() || "yt-dlp failed";
  if (/sign in to confirm/i.test(text) || /not a bot/i.test(text)) {
    return (
      "YouTube blocked this download (bot check). On your machine set " +
      "YTDLP_COOKIES=/path/to/cookies.txt or YTDLP_COOKIES_FROM_BROWSER=chrome " +
      "and retry. Datacenter / cloud IPs are often blocked."
    );
  }
  const lines = text.split("\n").filter(Boolean);
  const last = lines.filter((l) => /error/i.test(l)).at(-1) ?? lines.at(-1);
  return (last ?? text).slice(0, 500);
}
