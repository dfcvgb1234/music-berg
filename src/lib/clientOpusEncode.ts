"use client";

import { OPUS_BITRATE } from "@/lib/audioMime";

export type EncodeProgress = {
  phase: "loading" | "encoding" | "done" | "error";
  /** 0–1 while encoding; undefined while loading core. */
  ratio?: number;
  message: string;
  /** Optional chunk counters for UI (“chunk 3/8”). */
  chunkIndex?: number;
  chunkTotal?: number;
};

export type CropRange = {
  /** Inclusive start seconds. */
  startSec: number;
  /** Exclusive end seconds (or track duration). */
  endSec: number;
};

export type EncodeOptions = {
  signal?: AbortSignal;
  /**
   * Reuse a previously decoded mono crop (same source + range) so cancel/retry
   * does not re-decode the full MP3.
   */
  cachedMono?: AudioBuffer | null;
  /** Called once the mono crop is ready (for the UI to cache). */
  onMonoReady?: (mono: AudioBuffer) => void;
};

export class EncodeAbortError extends Error {
  constructor(message = "Encoding cancelled") {
    super(message);
    this.name = "EncodeAbortError";
  }
}

export function isEncodeAbortError(err: unknown): boolean {
  return (
    err instanceof EncodeAbortError ||
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error &&
      (err.name === "AbortError" || /cancelled|canceled|aborted/i.test(err.message)))
  );
}

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
  /** UMD: exec(args, timeoutMs = -1, { signal }). */
  exec: (
    args: string[],
    timeout?: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<number>;
  terminate?: () => void;
};

declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegLike };
    webkitAudioContext?: typeof AudioContext;
  }
}

const LOG_TAG = "[bergs-music:opus]";
const TARGET_RATE = 48000;
/** Soft MEMFS budget — above this we chunk or prefer MediaRecorder. */
const WASM_SAFE_WAV_BYTES = 5 * 1024 * 1024;
const CHUNK_SEC = 25;
/** Per-chunk / single exec hang watchdog. */
const CHUNK_TIMEOUT_MS = 45_000;
const EXEC_TIMEOUT_MS = 60_000;

function opusLog(...args: unknown[]) {
  console.log(LOG_TAG, ...args);
}
function opusWarn(...args: unknown[]) {
  console.warn(LOG_TAG, ...args);
}
function opusError(...args: unknown[]) {
  console.error(LOG_TAG, ...args);
}

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as { message?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function isMemoryError(msg: string): boolean {
  return /memory access out of bounds|out of bounds|OOM|out of memory|Cannot enlarge memory|timed out|hang/i.test(
    msg,
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new EncodeAbortError();
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let timer: number | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        if (signal) {
          onAbort = () => reject(new EncodeAbortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer != null) window.clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

let ffmpegSingleton: FFmpegLike | null = null;
let loadPromise: Promise<FFmpegLike> | null = null;
let scriptPromise: Promise<void> | null = null;

function assetUrl(name: string): string {
  if (typeof window === "undefined") return `/ffmpeg/${name}`;
  return `${window.location.origin}/ffmpeg/${name}`;
}

function toTransferableBytes(data: Uint8Array): Uint8Array {
  const ab = new ArrayBuffer(data.byteLength);
  const copy = new Uint8Array(ab);
  copy.set(data);
  return copy;
}

async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`);
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
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
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
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
  await withTimeout(scriptPromise, 60_000, "ffmpeg script load", signal);
}

export function resetFfmpegSingleton(reason: string) {
  opusWarn("resetting ffmpeg singleton", reason);
  try {
    ffmpegSingleton?.terminate?.();
  } catch {
    /* ignore */
  }
  ffmpegSingleton = null;
  loadPromise = null;
}

export async function getFfmpeg(
  onProgress?: (p: EncodeProgress) => void,
  signal?: AbortSignal,
): Promise<FFmpegLike> {
  throwIfAborted(signal);
  if (ffmpegSingleton?.loaded) return ffmpegSingleton;
  if (loadPromise) {
    return withTimeout(loadPromise, 120_000, "ffmpeg load (pending)", signal);
  }

  loadPromise = (async () => {
    await ensureFfmpegScript(onProgress, signal);
    onProgress?.({
      phase: "loading",
      message: "Loading audio encoder (wasm)…",
    });
    const ffmpeg = new window.FFmpegWASM!.FFmpeg();
    ffmpeg.on("log", ({ type, message }) => {
      if (typeof message !== "string") return;
      if (/^Aborted\(\)$/i.test(message.trim())) {
        opusLog(type || "ff", message);
        return;
      }
      if (
        /error|fail|invalid|unknown encoder|does not|could not|out of bounds|memory|timed out/i.test(
          message,
        )
      ) {
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
      opusLog("ffmpeg.load start");
      await withTimeout(
        ffmpeg.load({ coreURL, wasmURL }),
        120_000,
        "ffmpeg.load",
        signal,
      );
      opusLog("ffmpeg.load ok");
    } catch (err) {
      loadPromise = null;
      if (isEncodeAbortError(err)) throw err;
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

async function execTimed(
  ffmpeg: FFmpegLike,
  args: string[],
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  try {
    // Prefer native timeout + AbortSignal when the UMD supports them.
    return await withTimeout(
      ffmpeg.exec(args, timeoutMs, { signal }),
      timeoutMs + 2_000,
      label,
      signal,
    );
  } catch (err) {
    const msg = formatUnknownError(err);
    if (isEncodeAbortError(err)) throw err;
    if (/timed out|timeout/i.test(msg)) {
      resetFfmpegSingleton(`${label} hang`);
      throw new Error(msg);
    }
    throw err;
  }
}

function makeAudioContext(sampleRate?: number): AudioContext {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio API unavailable");
  return sampleRate ? new Ctor({ sampleRate }) : new Ctor();
}

export function cropCacheKey(
  source: File | Blob,
  crop: CropRange,
): string {
  const id =
    source instanceof File
      ? `${source.name}|${source.size}|${source.lastModified}`
      : `blob|${source.size}`;
  return `${id}|${crop.startSec.toFixed(3)}|${crop.endSec.toFixed(3)}`;
}

async function decodeCropMono(
  source: File | Blob,
  crop: CropRange,
  onProgress?: (p: EncodeProgress) => void,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  throwIfAborted(signal);
  onProgress?.({
    phase: "encoding",
    ratio: 0.02,
    message: "Decoding audio in browser…",
  });
  const raw = await source.arrayBuffer();
  throwIfAborted(signal);
  const copy = raw.slice(0);
  const ctx = makeAudioContext();
  try {
    const decoded = await withTimeout(
      ctx.decodeAudioData(copy),
      120_000,
      "decodeAudioData",
      signal,
    );
    const start = Math.max(0, Math.min(crop.startSec, decoded.duration));
    const end = Math.max(
      start + 0.25,
      Math.min(crop.endSec, decoded.duration),
    );
    const duration = end - start;
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(duration * TARGET_RATE)),
      TARGET_RATE,
    );
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0, start, duration);
    const rendered = await withTimeout(
      offline.startRendering(),
      120_000,
      "offline render",
      signal,
    );
    opusLog("webaudio crop", {
      sourceChannels: decoded.numberOfChannels,
      sourceRate: decoded.sampleRate,
      cropStart: start,
      cropEnd: end,
      outFrames: rendered.length,
    });
    return rendered;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const dataSize = samples.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(out);
}

function fileFromBytes(
  bytes: Uint8Array,
  base: string,
  ext: string,
  mime: string,
): File {
  const copy = toTransferableBytes(bytes);
  const blob = new Blob([copy as BlobPart], { type: mime });
  return new File([blob], `${base}${ext}`, {
    type: mime,
    lastModified: Date.now(),
  });
}

function sliceAudioBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
): AudioBuffer {
  const rate = buffer.sampleRate;
  const startFrame = Math.max(0, Math.floor(startSec * rate));
  const endFrame = Math.min(buffer.length, Math.ceil(endSec * rate));
  const frames = Math.max(1, endFrame - startFrame);
  const out = new AudioBuffer({
    length: frames,
    numberOfChannels: 1,
    sampleRate: rate,
  });
  out.copyToChannel(
    buffer.getChannelData(0).subarray(startFrame, startFrame + frames),
    0,
  );
  return out;
}

type EncodeAttempt = {
  label: string;
  outName: string;
  mime: string;
  ext: string;
  args: string[];
};

function buildWavAttempts(inName: string): EncodeAttempt[] {
  const common = [
    "-i",
    inName,
    "-vn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-ac",
    "1",
    "-ar",
    String(TARGET_RATE),
  ];
  return [
    {
      label: "wav→libopus/ogg mono",
      outName: "out.ogg",
      mime: "audio/ogg",
      ext: ".ogg",
      args: [
        ...common,
        "-c:a",
        "libopus",
        "-b:a",
        OPUS_BITRATE,
        "-application",
        "audio",
        "-vbr",
        "on",
        "out.ogg",
      ],
    },
    {
      label: "wav→libopus/webm mono",
      outName: "out.webm",
      mime: "audio/webm",
      ext: ".webm",
      args: [...common, "-c:a", "libopus", "-b:a", OPUS_BITRATE, "out.webm"],
    },
    {
      label: "wav→libmp3lame",
      outName: "out.mp3",
      mime: "audio/mpeg",
      ext: ".mp3",
      args: [...common, "-c:a", "libmp3lame", "-b:a", OPUS_BITRATE, "out.mp3"],
    },
  ];
}

async function encodeViaMediaRecorder(
  buffer: AudioBuffer,
  base: string,
  onProgress?: (p: EncodeProgress) => void,
  signal?: AbortSignal,
): Promise<File> {
  throwIfAborted(signal);
  onProgress?.({
    phase: "encoding",
    ratio: 0.4,
    message: "Fallback: browser Opus recorder…",
  });

  const mimeCandidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  const mime =
    mimeCandidates.find((m) => {
      try {
        return (
          typeof MediaRecorder !== "undefined" &&
          MediaRecorder.isTypeSupported(m)
        );
      } catch {
        return false;
      }
    }) ?? "";
  if (!mime) {
    throw new Error("MediaRecorder Opus/WebM not supported in this browser");
  }

  const ctx = makeAudioContext(buffer.sampleRate);
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(dest.stream, {
    mimeType: mime,
    audioBitsPerSecond: 96_000,
  });
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("MediaRecorder failed"));
    recorder.onstop = () => {
      resolve(
        new Blob(chunks, {
          type: mime.startsWith("audio/ogg") ? "audio/ogg" : "audio/webm",
        }),
      );
    };
  });

  const onAbort = () => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
    try {
      src.stop();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfAborted(signal);
    if (ctx.state === "suspended") await ctx.resume();
    recorder.start(200);
    src.start(0);
    await withTimeout(
      new Promise<void>((resolve) => {
        src.onended = () => resolve();
        window.setTimeout(resolve, Math.ceil((buffer.duration + 0.35) * 1000));
      }),
      Math.ceil((buffer.duration + 15) * 1000),
      "MediaRecorder playback",
      signal,
    );
    if (recorder.state !== "inactive") recorder.stop();
    const blob = await withTimeout(done, 30_000, "MediaRecorder finish", signal);
    if (blob.size < 64) throw new Error("MediaRecorder produced empty output");
    const ext = blob.type.includes("ogg") ? ".ogg" : ".webm";
    const file = new File([blob], `${base}${ext}`, {
      type: blob.type || "audio/webm",
      lastModified: Date.now(),
    });
    opusLog("mediarecorder ok", { bytes: file.size, type: file.type });
    return file;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
    src.disconnect();
    void ctx.close().catch(() => undefined);
  }
}

async function encodeWavWithFfmpeg(
  wav: Uint8Array,
  base: string,
  onProgress?: (p: EncodeProgress) => void,
  signal?: AbortSignal,
): Promise<File> {
  throwIfAborted(signal);
  const ffmpeg = await getFfmpeg(onProgress, signal);
  const inName = "crop.wav";

  try {
    for (const name of [inName, "out.ogg", "out.webm", "out.mp3"]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }
    opusLog("writeFile crop wav", { bytes: wav.byteLength });
    await withTimeout(
      ffmpeg.writeFile(inName, toTransferableBytes(wav)),
      30_000,
      "writeFile wav",
      signal,
    );

    let lastErr = "";
    for (const attempt of buildWavAttempts(inName)) {
      throwIfAborted(signal);
      try {
        opusLog("exec", attempt.label);
        onProgress?.({
          phase: "encoding",
          ratio: 0.35,
          message: `Encoding (${attempt.label})…`,
        });
        try {
          await ffmpeg.deleteFile(attempt.outName);
        } catch {
          /* ignore */
        }
        const code = await execTimed(
          ffmpeg,
          attempt.args,
          attempt.label,
          EXEC_TIMEOUT_MS,
          signal,
        );
        if (code !== 0) {
          lastErr = `ffmpeg exit ${code} [${attempt.label}]`;
          continue;
        }
        const data = await ffmpeg.readFile(attempt.outName);
        if (!(data instanceof Uint8Array) || data.byteLength < 64) {
          lastErr = `empty output [${attempt.label}]`;
          continue;
        }
        return fileFromBytes(data, base, attempt.ext, attempt.mime);
      } catch (err) {
        if (isEncodeAbortError(err)) throw err;
        lastErr = `${attempt.label}: ${formatUnknownError(err)}`;
        opusError("exec failed", lastErr, err);
        if (isMemoryError(formatUnknownError(err))) {
          resetFfmpegSingleton("wasm memory/timeout");
          throw new Error(lastErr);
        }
      }
    }
    throw new Error(lastErr || "All ffmpeg encode attempts failed");
  } finally {
    try {
      await ffmpeg.deleteFile(inName);
    } catch {
      /* ignore */
    }
  }
}

async function encodeOneChunk(
  ffmpeg: FFmpegLike,
  wav: Uint8Array,
  part: number,
  signal?: AbortSignal,
): Promise<string> {
  const inName = `chunk_${part}.wav`;
  const outName = `part_${part}.ogg`;
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
  await withTimeout(
    ffmpeg.writeFile(inName, toTransferableBytes(wav)),
    20_000,
    `write ${inName}`,
    signal,
  );
  const code = await execTimed(
    ffmpeg,
    [
      "-i",
      inName,
      "-vn",
      "-map_metadata",
      "-1",
      "-ac",
      "1",
      "-ar",
      String(TARGET_RATE),
      "-c:a",
      "libopus",
      "-b:a",
      OPUS_BITRATE,
      "-application",
      "audio",
      outName,
    ],
    `chunk ${part + 1}`,
    CHUNK_TIMEOUT_MS,
    signal,
  );
  try {
    await ffmpeg.deleteFile(inName);
  } catch {
    /* ignore */
  }
  if (code !== 0) throw new Error(`chunk ${part + 1} ffmpeg exit ${code}`);
  return outName;
}

async function encodeChunkedOpus(
  buffer: AudioBuffer,
  base: string,
  onProgress?: (p: EncodeProgress) => void,
  signal?: AbortSignal,
): Promise<File> {
  throwIfAborted(signal);
  const duration = buffer.duration;
  const totalChunks = Math.max(1, Math.ceil(duration / CHUNK_SEC));
  const parts: string[] = [];
  let ffmpeg = await getFfmpeg(onProgress, signal);

  try {
    let part = 0;
    for (let t = 0; t < duration; t += CHUNK_SEC) {
      throwIfAborted(signal);
      const end = Math.min(duration, t + CHUNK_SEC);
      const slice = sliceAudioBuffer(buffer, t, end);
      const wav = audioBufferToWav(slice);
      onProgress?.({
        phase: "encoding",
        ratio: 0.15 + (0.6 * part) / totalChunks,
        message: `Encoding chunk ${part + 1}/${totalChunks} (${t.toFixed(0)}–${end.toFixed(0)}s)…`,
        chunkIndex: part + 1,
        chunkTotal: totalChunks,
      });
      opusLog("chunk encode", {
        part,
        of: totalChunks,
        start: t,
        end,
        wavBytes: wav.byteLength,
      });

      let outName: string | null = null;
      try {
        outName = await encodeOneChunk(ffmpeg, wav, part, signal);
      } catch (err) {
        if (isEncodeAbortError(err)) throw err;
        const msg = formatUnknownError(err);
        opusWarn(`chunk ${part + 1} failed — reset + retry once`, msg);
        resetFfmpegSingleton(`chunk ${part + 1} fail`);
        ffmpeg = await getFfmpeg(onProgress, signal);
        try {
          outName = await encodeOneChunk(ffmpeg, wav, part, signal);
        } catch (err2) {
          if (isEncodeAbortError(err2)) throw err2;
          resetFfmpegSingleton(`chunk ${part + 1} retry fail`);
          throw new Error(
            `Chunk ${part + 1}/${totalChunks} timed out or failed (${formatUnknownError(err2)}). Falling back…`,
          );
        }
      }
      parts.push(outName);
      part += 1;
    }

    if (parts.length === 1) {
      const data = await ffmpeg.readFile(parts[0]);
      if (!(data instanceof Uint8Array) || data.byteLength < 64) {
        throw new Error("chunked encode empty");
      }
      return fileFromBytes(data, base, ".ogg", "audio/ogg");
    }

    const listBody = parts.map((p) => `file '${p}'`).join("\n");
    await ffmpeg.writeFile(
      "concat.txt",
      toTransferableBytes(new TextEncoder().encode(listBody)),
    );
    try {
      await ffmpeg.deleteFile("out_concat.ogg");
    } catch {
      /* ignore */
    }
    onProgress?.({
      phase: "encoding",
      ratio: 0.85,
      message: `Joining ${parts.length} Opus chunks…`,
      chunkIndex: totalChunks,
      chunkTotal: totalChunks,
    });
    let concatCode = await execTimed(
      ffmpeg,
      [
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "concat.txt",
        "-c",
        "copy",
        "out_concat.ogg",
      ],
      "chunk concat",
      EXEC_TIMEOUT_MS,
      signal,
    );
    if (concatCode !== 0) {
      concatCode = await execTimed(
        ffmpeg,
        [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          "concat.txt",
          "-c:a",
          "libopus",
          "-b:a",
          OPUS_BITRATE,
          "-ac",
          "1",
          "-ar",
          String(TARGET_RATE),
          "out_concat.ogg",
        ],
        "chunk remux",
        EXEC_TIMEOUT_MS,
        signal,
      );
      if (concatCode !== 0) throw new Error("chunk concat failed");
    }
    const data = await ffmpeg.readFile("out_concat.ogg");
    if (!(data instanceof Uint8Array) || data.byteLength < 64) {
      throw new Error("concat output empty");
    }
    opusLog("chunked encode ok", { parts: parts.length, bytes: data.byteLength });
    return fileFromBytes(data, base, ".ogg", "audio/ogg");
  } catch (err) {
    if (isEncodeAbortError(err)) throw err;
    if (isMemoryError(formatUnknownError(err))) {
      resetFfmpegSingleton("chunked OOB/timeout");
    }
    throw err;
  }
}

function doneMessage(file: File, via?: string): string {
  const kind = file.type.includes("mpeg")
    ? "MP3"
    : file.type.includes("webm") || file.type.includes("ogg")
      ? "Opus"
      : "audio";
  const suffix = via ? ` (${via})` : "";
  return `Ready · ${(file.size / 1024).toFixed(0)} KB ${kind}${suffix}`;
}

export async function encodeOpusCrop(
  source: File | Blob,
  crop: CropRange,
  onProgress?: (p: EncodeProgress) => void,
  options?: EncodeOptions,
): Promise<File> {
  const signal = options?.signal;
  const start = Math.max(0, crop.startSec);
  const end = Math.max(start + 0.25, crop.endSec);
  const base =
    source instanceof File
      ? source.name.replace(/\.[^.]+$/, "") || "clip"
      : "clip";

  const errors: string[] = [];

  try {
    throwIfAborted(signal);
    onProgress?.({
      phase: "encoding",
      ratio: 0,
      message: "Preparing crop…",
    });

    let mono: AudioBuffer;
    if (options?.cachedMono && options.cachedMono.length > 0) {
      opusLog("reusing cached mono crop", {
        frames: options.cachedMono.length,
        duration: options.cachedMono.duration,
      });
      mono = options.cachedMono;
      onProgress?.({
        phase: "encoding",
        ratio: 0.08,
        message: "Using cached crop…",
      });
    } else {
      mono = await decodeCropMono(
        source,
        { startSec: start, endSec: end },
        onProgress,
        signal,
      );
      options?.onMonoReady?.(mono);
    }

    const wav = audioBufferToWav(mono);
    opusLog("crop wav ready", {
      wavBytes: wav.byteLength,
      duration: mono.duration,
      mb: (wav.byteLength / (1024 * 1024)).toFixed(1),
    });

    const large = wav.byteLength > WASM_SAFE_WAV_BYTES;

    if (large) {
      opusLog("large crop — trying chunked ffmpeg", {
        wavBytes: wav.byteLength,
        chunkSec: CHUNK_SEC,
      });
      try {
        const file = await encodeChunkedOpus(mono, base, onProgress, signal);
        onProgress?.({
          phase: "done",
          ratio: 1,
          message: doneMessage(file, "chunked"),
        });
        return file;
      } catch (err) {
        if (isEncodeAbortError(err)) throw err;
        const msg = formatUnknownError(err);
        errors.push(`chunked: ${msg}`);
        onProgress?.({
          phase: "encoding",
          ratio: 0.35,
          message: `Chunk encode failed (${msg}). Trying browser recorder…`,
        });
        opusWarn("chunked failed — MediaRecorder", msg);
        resetFfmpegSingleton("after chunked failure");
      }

      try {
        const file = await encodeViaMediaRecorder(
          mono,
          base,
          onProgress,
          signal,
        );
        onProgress?.({
          phase: "done",
          ratio: 1,
          message: doneMessage(file, "browser"),
        });
        return file;
      } catch (err) {
        if (isEncodeAbortError(err)) throw err;
        errors.push(`mediarecorder: ${formatUnknownError(err)}`);
      }
    }

    try {
      const file = await encodeWavWithFfmpeg(wav, base, onProgress, signal);
      onProgress?.({ phase: "done", ratio: 1, message: doneMessage(file) });
      return file;
    } catch (err) {
      if (isEncodeAbortError(err)) throw err;
      errors.push(`ffmpeg: ${formatUnknownError(err)}`);
      resetFfmpegSingleton("after ffmpeg failure");
    }

    try {
      const file = await encodeViaMediaRecorder(mono, base, onProgress, signal);
      onProgress?.({
        phase: "done",
        ratio: 1,
        message: doneMessage(file, "browser"),
      });
      return file;
    } catch (err) {
      if (isEncodeAbortError(err)) throw err;
      errors.push(`mediarecorder: ${formatUnknownError(err)}`);
    }

    throw new Error(errors.join(" · ") || "All encode paths failed");
  } catch (err) {
    if (isEncodeAbortError(err)) {
      resetFfmpegSingleton("user cancel");
      onProgress?.({
        phase: "error",
        message: "Cancelled",
      });
      throw err;
    }
    const message = formatUnknownError(err);
    opusError("encodeOpusCrop failed", message, err);
    onProgress?.({
      phase: "error",
      message: `Could not convert audio: ${message}`,
    });
    throw new Error(
      `Could not convert audio to Opus. Try a different file or shorter crop. (${message})`,
    );
  }
}

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
