#!/usr/bin/env node
/**
 * Local YouTube → tracklist prep (does NOT run on Vercel).
 *
 * Requires: yt-dlp + ffmpeg on PATH (or YTDLP_PATH / FFMPEG_PATH).
 *
 * Usage:
 *   npm run import:youtube -- <youtube-url> [--out dir]
 *
 * Downloads ~196k MP3 audio, writes files + manifest.json with Deezer first-hit
 * suggestions. Open the create-track-list UI and attach the MP3s (or use the
 * in-app YouTube fields while `next dev` is running locally).
 *
 * Optional anti-bot:
 *   YTDLP_COOKIES=/path/cookies.txt
 *   YTDLP_COOKIES_FROM_BROWSER=chrome
 */
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  writeFile,
  readdir,
  rename,
  constants as fsConstants,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

function usage(code = 1) {
  console.error(`Usage: npm run import:youtube -- <youtube-url> [--out dir]

Downloads audio with yt-dlp (~196k MP3) and writes a Deezer-suggested manifest.
Refuses nothing here — but never call this from Vercel serverless handlers.`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let out = resolve("import-out");
  let url = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") usage(0);
    if (a === "--out") {
      out = resolve(args[++i] ?? "");
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      usage(1);
    }
    url = a;
  }
  if (!url) usage(1);
  return { url, out };
}

async function which(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      await access(cmd, fsConstants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  return new Promise((resolvePromise) => {
    const child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c.toString("utf8");
    });
    child.on("close", (code) => {
      const line = out.trim().split("\n")[0]?.trim();
      resolvePromise(code === 0 && line ? line : null);
    });
    child.on("error", () => resolvePromise(null));
  });
}

async function findYtdlp() {
  const candidates = [
    process.env.YTDLP_PATH,
    "yt-dlp",
    join(homedir(), ".local/bin/yt-dlp"),
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ].filter(Boolean);
  for (const c of candidates) {
    const hit = await which(c);
    if (hit) return hit;
  }
  return null;
}

async function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    "ffmpeg",
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ].filter(Boolean);
  for (const c of candidates) {
    const hit = await which(c);
    if (hit) return hit;
  }
  return null;
}

function cookieArgs() {
  const args = [];
  if (process.env.YTDLP_COOKIES) {
    args.push("--cookies", process.env.YTDLP_COOKIES);
  }
  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    args.push("--cookies-from-browser", process.env.YTDLP_COOKIES_FROM_BROWSER);
  }
  args.push("--js-runtimes", "node");
  return args;
}

function run(bin, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      process.stderr.write(c);
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function titleToQuery(title) {
  let q = String(title || "").trim();
  q = q.replace(/\[[^\]]*]/g, " ");
  q = q.replace(/\([^)]*\)/g, " ");
  q = q.replace(
    /\b(official\s*(music\s*)?video|official\s*audio|lyrics?\s*video|lyric\s*video|visuali[sz]er|audio|hd|4k|remaster(ed)?|music\s*video)\b/gi,
    " ",
  );
  q = q.replace(/[|/_]+/g, " ");
  return q.replace(/\s+/g, " ").trim();
}

async function searchDeezerFirst(query) {
  if (!query || query.length < 2) return null;
  const url =
    `https://api.deezer.com/search?` +
    new URLSearchParams({ q: query, limit: "8" }).toString();
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const row = (data.data ?? []).find(
    (r) => r && r.readable !== false && r.preview && r.id && r.title,
  );
  if (!row) return null;
  return {
    id: String(row.id),
    title: row.title,
    artist: row.artist?.name ?? "Unknown artist",
    album: row.album?.title ?? null,
    coverArtUrl: row.album?.cover_medium || row.album?.cover_big || null,
    previewUrl: row.preview || null,
  };
}

function flattenEntries(json) {
  if (Array.isArray(json?.entries)) {
    return json.entries
      .filter((e) => e && e.id)
      .map((e) => ({
        id: String(e.id),
        title: e.title || `Video ${e.id}`,
        url:
          (typeof e.url === "string" && e.url.startsWith("http") && e.url) ||
          e.webpage_url ||
          `https://www.youtube.com/watch?v=${e.id}`,
      }));
  }
  if (json?.id) {
    return [
      {
        id: String(json.id),
        title: json.title || `Video ${json.id}`,
        url:
          json.webpage_url ||
          json.url ||
          `https://www.youtube.com/watch?v=${json.id}`,
      },
    ];
  }
  return [];
}

async function main() {
  const { url, out } = parseArgs(process.argv);
  const ytdlp = await findYtdlp();
  const ffmpeg = await findFfmpeg();
  if (!ytdlp) {
    console.error("yt-dlp not found. Install it or set YTDLP_PATH.");
    process.exit(1);
  }
  if (!ffmpeg) {
    console.error("ffmpeg not found. Install it or set FFMPEG_PATH.");
    process.exit(1);
  }

  await mkdir(out, { recursive: true });
  console.error(`Resolving ${url}…`);
  const resolved = await run(ytdlp, [
    ...cookieArgs(),
    "--flat-playlist",
    "-J",
    "--yes-playlist",
    url,
  ]);
  if (resolved.code !== 0) {
    console.error(formatErr(resolved.stderr || resolved.stdout));
    process.exit(1);
  }
  let dump;
  try {
    dump = JSON.parse(resolved.stdout);
  } catch {
    console.error("yt-dlp returned invalid JSON");
    process.exit(1);
  }
  const entries = flattenEntries(dump);
  if (!entries.length) {
    console.error("No videos found");
    process.exit(1);
  }

  const tracks = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const idx = String(i + 1).padStart(3, "0");
    console.error(`[${idx}/${entries.length}] ${entry.title}`);
    const work = join(tmpdir(), `bergs-yt-cli-${process.pid}-${idx}`);
    await mkdir(work, { recursive: true });
    const dl = await run(ytdlp, [
      ...cookieArgs(),
      "--no-playlist",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "196K",
      "--ffmpeg-location",
      ffmpeg,
      "-o",
      join(work, "audio.%(ext)s"),
      "--print",
      "after_move:%(title)s",
      entry.url,
    ]);
    if (dl.code !== 0) {
      console.error(`  failed: ${formatErr(dl.stderr || dl.stdout)}`);
      tracks.push({
        index: i + 1,
        youtubeId: entry.id,
        youtubeTitle: entry.title,
        youtubeUrl: entry.url,
        file: null,
        error: formatErr(dl.stderr || dl.stdout),
        deezer: null,
      });
      continue;
    }
    const files = (await readdir(work)).filter((f) => !f.startsWith("."));
    const audio = files.find((f) => /\.(mp3|m4a|opus|ogg|webm)$/i.test(f));
    if (!audio) {
      tracks.push({
        index: i + 1,
        youtubeId: entry.id,
        youtubeTitle: entry.title,
        youtubeUrl: entry.url,
        file: null,
        error: "No audio written",
        deezer: null,
      });
      continue;
    }
    const printed = dl.stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const title = printed || entry.title;
    const safe = `${idx}-${title}`
      .replace(/[^\w.\- ]+/g, "")
      .trim()
      .slice(0, 100)
      .replace(/\s+/g, "_");
    const destName = `${safe}.mp3`;
    const dest = join(out, destName);
    await rename(join(work, audio), dest);
    const query = titleToQuery(title);
    const deezer = await searchDeezerFirst(query);
    tracks.push({
      index: i + 1,
      youtubeId: entry.id,
      youtubeTitle: title,
      youtubeUrl: entry.url,
      searchQuery: query,
      file: destName,
      error: null,
      deezer,
    });
    console.error(
      deezer
        ? `  → ${deezer.artist} — ${deezer.title}`
        : `  → no Deezer hit for “${query}”`,
    );
  }

  const manifest = {
    sourceUrl: url,
    createdAt: new Date().toISOString(),
    note:
      "Attach each file in the create-track-list UI, crop, Convert to Opus. Review Deezer suggestions — first hit is not always correct.",
    tracks,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.error(`\nWrote ${tracks.filter((t) => t.file).length} files + manifest.json → ${out}`);
}

function formatErr(raw) {
  const text = String(raw || "").trim() || "yt-dlp failed";
  if (/sign in to confirm/i.test(text) || /not a bot/i.test(text)) {
    return (
      "YouTube bot check — set YTDLP_COOKIES or YTDLP_COOKIES_FROM_BROWSER and retry"
    );
  }
  const lines = text.split("\n").filter(Boolean);
  return (lines.filter((l) => /error/i.test(l)).at(-1) ?? lines.at(-1) ?? text).slice(
    0,
    400,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
