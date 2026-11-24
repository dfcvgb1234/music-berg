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
    cb: (data: { progress?: number; message?: string; type?: string }) => void,
  ) => void;
  off?: (
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
  terminate?: () => void;
};

declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegLike };
  }
}

const LOG_TAG = "[bergs-music:opus]";

function opusLog(...args: unknown[]) {
  console.log(LOG_TAG, ...args);
}
function opusWarn(...args: unknown[]) {
  console.warn(LOG_TAG, ...args);
}
function opusError(...args: unknown[]) {
  console.error(LOG_TAG, ...args);
}

/** ffmpeg.wasm often rejects with a bare string / plain object, not Error. */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; name?: unknown; code?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

let ffmpegSingleton: FFmpegLike | null = null;
let loadPromise: Promise<FFmpegLike> | null = null;
let scriptPromise: Promise<void> | null = null;

function assetUrl(name: string): string {
  if (typeof window === "undefined") return `/ffmpeg/${name}`;
  return `${window.location.origin}/ffmpeg/${name}`;
}

/**
 * Own ArrayBuffer copy for writeFile.
 * ffmpeg UMD transfers `uint8.buffer` via postMessage — that detaches the
 * buffer, so we must never pass a view into a shared/reused buffer.
 */
function toTransferableBytes(data: Uint8Array): Uint8Array {
  const ab = new ArrayBuffer(data.byteLength);
  const copy = new Uint8Array(ab);
  copy.set(data);
  return copy;
}

async function fetchFileBytes(file: File | Blob): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return toTransferableBytes(new Uint8Array(buf));
}

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
      opusLog("loading UMD", assetUrl("ffmpeg.js"));
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

function resetFfmpegSingleton(reason: string) {
  opusWarn("resetting ffmpeg singleton", reason);
  try {
    ffmpegSingleton?.terminate?.();
  } catch {
    /* ignore */
  }
  ffmpegSingleton = null;
  loadPromise = null;
}

/**
 * Load ffmpeg.wasm once (UMD + core from /public/ffmpeg via postinstall).
 * Single-thread core — no SharedArrayBuffer / COOP-COEP required.
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
    ffmpeg.on("log", ({ type, message }) => {
      if (typeof message !== "string") return;
      // Emscripten prints "Aborted()" on normal process exit — not a real failure.
      if (/^Aborted\(\)$/i.test(message.trim())) {
        opusLog(type || "ff", message);
        return;
      }
      if (/error|fail|invalid|unknown encoder|does not|could not/i.test(message)) {
        opusWarn(type || "ff", message);
      } else {
        opusLog(type || "ff", message);
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
      opusLog("ffmpeg.load start", {
        crossOriginIsolated: Boolean(
          typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
        ),
        sab:
          typeof SharedArrayBuffer !== "undefined"
            ? "available"
            : "unavailable (ok for single-thread core)",
      });
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
      opusLog("ffmpeg.load ok");
    } catch (err) {
      loadPromise = null;
      const message = formatUnknownError(err);
      opusError("ffmpeg.load failed", message, err);
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

function inputFilenameFor(source: File | Blob): string {
  const name =
    source instanceof File ? source.name.toLowerCase() : "source.mp3";
  if (name.endsWith(".wav")) return "input.wav";
  if (name.endsWith(".m4a") || name.endsWith(".mp4") || name.endsWith(".aac")) {
    return "input.m4a";
  }
  if (name.endsWith(".ogg") || name.endsWith(".oga") || name.endsWith(".opus")) {
    return "input.ogg";
  }
  if (name.endsWith(".webm")) return "input.webm";
  if (name.endsWith(".flac")) return "input.flac";
  // Default: mp3 (most quiz uploads); ffmpeg also sniffs content.
  return "input.mp3";
}

type EncodeAttempt = {
  label: string;
  outName: string;
  mime: string;
  ext: string;
  args: string[];
};

function buildAttempts(
  inName: string,
  start: number,
  duration: number,
): EncodeAttempt[] {
  const ss = start.toFixed(3);
  const t = duration.toFixed(3);
  // Prefer libopus → Ogg (browser <audio> friendly). Explicit 48 kHz (Opus native).
  return [
    {
      label: "libopus/ogg@48k",
      outName: "out.ogg",
      mime: "audio/ogg",
      ext: ".ogg",
      args: [
        "-i",
        inName,
        "-ss",
        ss,
        "-t",
        t,
        "-vn",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        OPUS_BITRATE,
        "-application",
        "audio",
        "out.ogg",
      ],
    },
    {
      label: "libopus/webm@48k",
      outName: "out.webm",
      mime: "audio/webm",
      ext: ".webm",
      args: [
        "-i",
        inName,
        "-ss",
        ss,
        "-t",
        t,
        "-vn",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        OPUS_BITRATE,
        "out.webm",
      ],
    },
    {
      label: "opus/ogg@48k",
      outName: "out2.ogg",
      mime: "audio/ogg",
      ext: ".ogg",
      args: [
        "-i",
        inName,
        "-ss",
        ss,
        "-t",
        t,
        "-vn",
        "-ar",
        "48000",
        "-c:a",
        "opus",
        "-b:a",
        OPUS_BITRATE,
        "out2.ogg",
      ],
    },
  ];
}

export async function encodeOpusCrop(
  source: File | Blob,
  crop: CropRange,
  onProgress?: (p: EncodeProgress) => void,
): Promise<File> {
  const start = Math.max(0, crop.startSec);
  const end = Math.max(start + 0.25, crop.endSec);
  const duration = end - start;
  const inName = inputFilenameFor(source);

  const ffmpeg = await getFfmpeg(onProgress);
  onProgress?.({
    phase: "encoding",
    ratio: 0,
    message: "Encoding Opus at 96 kbps…",
  });

  const logLines: string[] = [];
  const onLog = ({ message }: { message?: string }) => {
    if (typeof message === "string" && message.trim()) {
      logLines.push(message);
      // Cap memory — keep a rolling window for the error report.
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
    }
  };
  ffmpeg.on("log", onLog);

  const recentLogs = () =>
    logLines
      .filter((l) => !/^ffmpeg version|^configuration:|^  built with/i.test(l))
      .slice(-12)
      .join(" | ");

  try {
    // Clean slate for this encode (previous run may have left files / detached bufs).
    for (const name of [
      inName,
      "out.ogg",
      "out.webm",
      "out2.ogg",
      "input_src",
      `out${OPUS_EXT}`,
    ]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* missing is fine */
      }
    }

    const bytes = await fetchFileBytes(source);
    opusLog("writeFile", {
      inName,
      bytes: bytes.byteLength,
      start,
      duration,
      sourceType: source instanceof File ? source.type : "(blob)",
      sourceName: source instanceof File ? source.name : "(blob)",
    });
    await ffmpeg.writeFile(inName, bytes);

    const attempts = buildAttempts(inName, start, duration);
    let lastErr = "";

    for (const attempt of attempts) {
      const beforeLen = logLines.length;
      try {
        opusLog("exec", attempt.label, attempt.args.join(" "));
        onProgress?.({
          phase: "encoding",
          ratio: 0.05,
          message: `Encoding (${attempt.label})…`,
        });
        try {
          await ffmpeg.deleteFile(attempt.outName);
        } catch {
          /* ignore */
        }

        const code = await ffmpeg.exec(attempt.args);
        const attemptLogs = logLines.slice(beforeLen);
        const useful = attemptLogs
          .filter((l) =>
            /error|fail|invalid|unknown encoder|could not|does not|Conversion/i.test(
              l,
            ),
          )
          .slice(-6);
        if (code !== 0) {
          lastErr = `ffmpeg exit ${code} [${attempt.label}] ${useful.join(" | ") || recentLogs()}`;
          opusWarn(lastErr);
          continue;
        }

        const data = await ffmpeg.readFile(attempt.outName);
        if (!(data instanceof Uint8Array) || data.byteLength < 64) {
          lastErr = `empty output [${attempt.label}]`;
          opusWarn(lastErr);
          continue;
        }

        // Copy out before any further FS ops (worker may reuse buffers).
        const copy = toTransferableBytes(data);
        const blob = new Blob([copy as BlobPart], {
          type: attempt.mime,
        });
        const base =
          source instanceof File
            ? source.name.replace(/\.[^.]+$/, "") || "clip"
            : "clip";
        const file = new File([blob], `${base}${attempt.ext}`, {
          type: attempt.mime || OPUS_MIME,
          lastModified: Date.now(),
        });
        opusLog("encode ok", {
          label: attempt.label,
          bytes: file.size,
          mime: attempt.mime,
        });
        onProgress?.({
          phase: "done",
          ratio: 1,
          message: `Ready · ${(file.size / 1024).toFixed(0)} KB Opus`,
        });
        return file;
      } catch (err) {
        lastErr = `${attempt.label}: ${formatUnknownError(err)} // ${recentLogs()}`;
        opusError("exec/read failed", lastErr, err);
      }
    }

    throw new Error(lastErr || "All Opus encode attempts failed");
  } catch (err) {
    const message = formatUnknownError(err);
    const detail = recentLogs() ? `${message} — ff: ${recentLogs()}` : message;
    opusError("encodeOpusCrop failed", detail, err);
    onProgress?.({
      phase: "error",
      message: `Could not convert audio: ${detail}`,
    });
    // Next Convert click gets a fresh instance (avoids stuck/detached state).
    resetFfmpegSingleton("encode failure");
    throw new Error(
      `Could not convert audio to Opus. Try a different file or shorter crop. (${detail})`,
    );
  } finally {
    ffmpeg.off?.("log", onLog);
    try {
      await ffmpeg.deleteFile(inName);
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
