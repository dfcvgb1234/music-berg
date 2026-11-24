"use client";

import { OPUS_BITRATE, OPUS_EXT, OPUS_MIME } from "@/lib/audioMime";

export type EncodeProgress = {
  phase: "loading" | "encoding" | "done" | "error";
  /** 0–1 while encoding; undefined while loading core. */
  ratio?: number;
  message: string;
};

export type CropRange = {
  /** Inclusive start seconds. */
  startSec: number;
  /** Exclusive end seconds (or track duration). */
  endSec: number;
};

type FFmpegLike = {
  loaded: boolean;
  on: (
    event: "log" | "progress",
    cb: (data: { progress?: number; message?: string }) => void,
  ) => void;
  load: (config: {
    coreURL: string;
    wasmURL: string;
  }) => Promise<boolean>;
  writeFile: (name: string, data: Uint8Array) => Promise<void>;
  readFile: (name: string) => Promise<Uint8Array | string>;
  deleteFile: (name: string) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
};

declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegLike };
  }
}

let ffmpegSingleton: FFmpegLike | null = null;
let loadPromise: Promise<FFmpegLike> | null = null;
let scriptPromise: Promise<void> | null = null;

function assetUrl(name: string): string {
  if (typeof window === "undefined") return `/ffmpeg/${name}`;
  return `${window.location.origin}/ffmpeg/${name}`;
}

/** Minimal @ffmpeg/util.fetchFile — avoid broken util UMD in the browser. */
async function fetchFile(file: File | Blob): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

/** Minimal @ffmpeg/util.toBlobURL — fetch asset then wrap as blob: URL. */
async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not fetch ${url} (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  const blob = new Blob([buf], { type: mimeType });
  return URL.createObjectURL(blob);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-bergs-ffmpeg="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error(`Failed to load ${src}`)),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.bergsFfmpeg = src;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureFfmpegScript(
  onProgress?: (p: EncodeProgress) => void,
): Promise<void> {
  if (window.FFmpegWASM?.FFmpeg) return;
  if (!scriptPromise) {
    onProgress?.({
      phase: "loading",
      message: "Loading audio encoder script…",
    });
    scriptPromise = (async () => {
      await loadScript(assetUrl("ffmpeg.js"));
      if (!window.FFmpegWASM?.FFmpeg) {
        throw new Error("ffmpeg UMD global missing after script load");
      }
    })().catch((err) => {
      scriptPromise = null;
      throw err;
    });
  }
  await scriptPromise;
}

/**
 * Load ffmpeg.wasm once (UMD + core from /public/ffmpeg via postinstall).
 * Scripts are loaded outside the Next bundle to avoid Turbopack Worker issues.
 */
export async function getFfmpeg(
  onProgress?: (p: EncodeProgress) => void,
): Promise<FFmpegLike> {
  if (ffmpegSingleton?.loaded) return ffmpegSingleton;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    await ensureFfmpegScript(onProgress);
    onProgress?.({
      phase: "loading",
      message: "Loading audio encoder (wasm)…",
    });
    const ffmpeg = new window.FFmpegWASM!.FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      if (typeof message === "string" && /error|fail/i.test(message)) {
        console.warn("[bergs-music:opus]", message);
      }
    });
    ffmpeg.on("progress", ({ progress }) => {
      const ratio =
        typeof progress === "number" && Number.isFinite(progress)
          ? Math.min(1, Math.max(0, progress))
          : undefined;
      onProgress?.({
        phase: "encoding",
        ratio,
        message:
          ratio != null
            ? `Encoding Opus… ${Math.round(ratio * 100)}%`
            : "Encoding Opus…",
      });
    });

    try {
      const coreURL = await toBlobURL(
        assetUrl("ffmpeg-core.js"),
        "text/javascript",
      );
      const wasmURL = await toBlobURL(
        assetUrl("ffmpeg-core.wasm"),
        "application/wasm",
      );
      const loadTimeoutMs = 120_000;
      await Promise.race([
        ffmpeg.load({ coreURL, wasmURL }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                `Timed out after ${loadTimeoutMs / 1000}s loading wasm (check /ffmpeg assets)`,
              ),
            );
          }, loadTimeoutMs);
        }),
      ]);
    } catch (err) {
      loadPromise = null;
      const message =
        err instanceof Error
          ? err.message
          : "Could not load the audio encoder (ffmpeg.wasm)";
      onProgress?.({ phase: "error", message });
      throw new Error(
        `Audio encoder failed to load. Refresh and try again. (${message})`,
      );
    }

    ffmpegSingleton = ffmpeg;
    return ffmpeg;
  })();

  return loadPromise;
}

export async function encodeOpusCrop(
  source: File | Blob,
  crop: CropRange,
  onProgress?: (p: EncodeProgress) => void,
): Promise<File> {
  const start = Math.max(0, crop.startSec);
  const end = Math.max(start + 0.25, crop.endSec);
  const duration = end - start;

  const ffmpeg = await getFfmpeg(onProgress);
  onProgress?.({
    phase: "encoding",
    ratio: 0,
    message: "Encoding Opus at 96 kbps…",
  });

  const inName = "input_src";
  const outName = `out${OPUS_EXT}`;

  try {
    await ffmpeg.writeFile(inName, await fetchFile(source));
    const code = await ffmpeg.exec([
      "-i",
      inName,
      "-ss",
      start.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      OPUS_BITRATE,
      "-vbr",
      "on",
      "-compression_level",
      "10",
      outName,
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}`);
    }
    const data = await ffmpeg.readFile(outName);
    if (!(data instanceof Uint8Array) || data.byteLength < 64) {
      throw new Error("Encoder produced an empty file");
    }
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const blob = new Blob([copy.buffer], { type: OPUS_MIME });
    const base =
      source instanceof File
        ? source.name.replace(/\.[^.]+$/, "") || "clip"
        : "clip";
    const file = new File([blob], `${base}${OPUS_EXT}`, {
      type: OPUS_MIME,
      lastModified: Date.now(),
    });
    onProgress?.({
      phase: "done",
      ratio: 1,
      message: `Ready · ${(file.size / 1024).toFixed(0)} KB Opus`,
    });
    return file;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Opus encoding failed";
    onProgress?.({
      phase: "error",
      message: `Could not convert audio: ${message}`,
    });
    throw new Error(
      `Could not convert audio to Opus. Try a different file or shorter crop. (${message})`,
    );
  } finally {
    try {
      await ffmpeg.deleteFile(inName);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(outName);
    } catch {
      /* ignore */
    }
  }
}

/** Probe duration via HTMLAudioElement (no ffmpeg required). */
export function probeAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      audio.load();
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      cleanup();
      if (!Number.isFinite(d) || d <= 0) {
        reject(new Error("Could not read audio duration"));
        return;
      }
      resolve(d);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("Browser could not read this audio file"));
    };
    audio.src = url;
  });
}
