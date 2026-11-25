"use client";

import { OPUS_BITRATE } from "@/lib/audioMime";

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
    webkitAudioContext?: typeof AudioContext;
  }
}

const LOG_TAG = "[bergs-music:opus]";
/** Target rate for crop WAV + Opus (Opus-native). */
const TARGET_RATE = 48000;

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

function isMemoryError(msg: string): boolean {
  return /memory access out of bounds|out of bounds|OOM|out of memory|Cannot enlarge memory|Aborted/i.test(
    msg,
  );
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
 * Heap size is fixed in the shipped wasm (not configurable via load()).
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
      if (/^Aborted\(\)$/i.test(message.trim())) {
        opusLog(type || "ff", message);
        return;
      }
      if (
        /error|fail|invalid|unknown encoder|does not|could not|out of bounds|memory/i.test(
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

function makeAudioContext(sampleRate?: number): AudioContext {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio API unavailable");
  return sampleRate ? new Ctor({ sampleRate }) : new Ctor();
}

/**
 * Decode source in the browser, crop, downmix to mono @ 48 kHz.
 * Avoids feeding large stereo/ID3 MP3s into the tiny ffmpeg.wasm heap.
 */
async function decodeCropMono(
  source: File | Blob,
  crop: CropRange,
  onProgress?: (p: EncodeProgress) => void,
): Promise<AudioBuffer> {
  onProgress?.({
    phase: "encoding",
    ratio: 0.02,
    message: "Decoding audio in browser…",
  });
  const raw = await source.arrayBuffer();
  // Copy — decodeAudioData may detach the buffer.
  const copy = raw.slice(0);
  const ctx = makeAudioContext();
  try {
    const decoded = await ctx.decodeAudioData(copy);
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
    // Downmix: OfflineAudioContext with 1 channel mixes inputs to mono.
    src.connect(offline.destination);
    src.start(0, start, duration);
    const rendered = await offline.startRendering();
    opusLog("webaudio crop", {
      sourceChannels: decoded.numberOfChannels,
      sourceRate: decoded.sampleRate,
      sourceDuration: decoded.duration,
      cropStart: start,
      cropEnd: end,
      outFrames: rendered.length,
      outRate: rendered.sampleRate,
    });
    return rendered;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

/** 16-bit mono PCM WAV — small enough for ffmpeg MEMFS. */
function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = 1;
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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
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

type EncodeAttempt = {
  label: string;
  outName: string;
  mime: string;
  ext: string;
  args: string[];
};

/** Safe encodes from a tiny mono WAV already cropped in JS. */
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
      args: [
        ...common,
        "-c:a",
        "libopus",
        "-b:a",
        OPUS_BITRATE,
        "out.webm",
      ],
    },
    {
      label: "wav→libmp3lame",
      outName: "out.mp3",
      mime: "audio/mpeg",
      ext: ".mp3",
      args: [
        ...common,
        "-c:a",
        "libmp3lame",
        "-b:a",
        OPUS_BITRATE,
        "out.mp3",
      ],
    },
  ];
}

/**
 * MediaRecorder Opus fallback — no wasm heap.
 * Plays the crop through a MediaStreamDestination and records webm/opus.
 */
async function encodeViaMediaRecorder(
  buffer: AudioBuffer,
  base: string,
  onProgress?: (p: EncodeProgress) => void,
): Promise<File> {
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
      resolve(new Blob(chunks, { type: mime.startsWith("audio/ogg") ? "audio/ogg" : "audio/webm" }));
    };
  });

  try {
    if (ctx.state === "suspended") await ctx.resume();
    recorder.start(200);
    src.start(0);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      // Safety: duration + slack
      window.setTimeout(
        resolve,
        Math.ceil((buffer.duration + 0.35) * 1000),
      );
    });
    if (recorder.state !== "inactive") recorder.stop();
    const blob = await done;
    if (blob.size < 64) throw new Error("MediaRecorder produced empty output");
    const ext = blob.type.includes("ogg") ? ".ogg" : ".webm";
    const file = new File([blob], `${base}${ext}`, {
      type: blob.type || "audio/webm",
      lastModified: Date.now(),
    });
    opusLog("mediarecorder ok", { bytes: file.size, type: file.type });
    return file;
  } finally {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
    src.disconnect();
    void ctx.close().catch(() => undefined);
  }
}

/** Soft MEMFS budget — above this we chunk or prefer MediaRecorder (not a hard reject). */
const WASM_SAFE_WAV_BYTES = 5 * 1024 * 1024; // ~54s mono 48 kHz PCM
/** Chunk length for large crops through ffmpeg.wasm. */
const CHUNK_SEC = 25;

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
  const src = buffer.getChannelData(0);
  out.copyToChannel(src.subarray(startFrame, startFrame + frames), 0);
  return out;
}

async function encodeWavWithFfmpeg(
  wav: Uint8Array,
  base: string,
  onProgress?: (p: EncodeProgress) => void,
  progressHint = 0.35,
): Promise<File> {
  const ffmpeg = await getFfmpeg(onProgress);
  const inName = "crop.wav";
  const logLines: string[] = [];
  const onLog = ({ message }: { message?: string }) => {
    if (typeof message === "string" && message.trim()) {
      logLines.push(message);
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
    }
  };
  ffmpeg.on("log", onLog);

  const recentLogs = () =>
    logLines
      .filter((l) => !/^ffmpeg version|^configuration:|^  built with/i.test(l))
      .slice(-10)
      .join(" | ");

  try {
    for (const name of [inName, "out.ogg", "out.webm", "out.mp3"]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }

    opusLog("writeFile crop wav", { bytes: wav.byteLength });
    await ffmpeg.writeFile(inName, toTransferableBytes(wav));

    let lastErr = "";
    for (const attempt of buildWavAttempts(inName)) {
      try {
        opusLog("exec", attempt.label, attempt.args.join(" "));
        onProgress?.({
          phase: "encoding",
          ratio: progressHint,
          message: `Encoding (${attempt.label})…`,
        });
        try {
          await ffmpeg.deleteFile(attempt.outName);
        } catch {
          /* ignore */
        }
        const code = await ffmpeg.exec(attempt.args);
        if (code !== 0) {
          lastErr = `ffmpeg exit ${code} [${attempt.label}] ${recentLogs()}`;
          opusWarn(lastErr);
          if (isMemoryError(lastErr)) {
            resetFfmpegSingleton("wasm OOB during exec");
            throw new Error(lastErr);
          }
          continue;
        }
        const data = await ffmpeg.readFile(attempt.outName);
        if (!(data instanceof Uint8Array) || data.byteLength < 64) {
          lastErr = `empty output [${attempt.label}]`;
          continue;
        }
        const file = fileFromBytes(data, base, attempt.ext, attempt.mime);
        opusLog("ffmpeg encode ok", {
          label: attempt.label,
          bytes: file.size,
          mime: attempt.mime,
        });
        return file;
      } catch (err) {
        lastErr = `${attempt.label}: ${formatUnknownError(err)} // ${recentLogs()}`;
        opusError("exec failed", lastErr, err);
        if (isMemoryError(formatUnknownError(err))) {
          resetFfmpegSingleton("wasm memory error");
          throw new Error(lastErr);
        }
      }
    }
    throw new Error(lastErr || "All ffmpeg encode attempts failed");
  } finally {
    ffmpeg.off?.("log", onLog);
    try {
      await ffmpeg.deleteFile(inName);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Encode a long mono buffer as Opus by feeding ~CHUNK_SEC WAV slices into
 * ffmpeg, then concatenating Ogg parts (keeps MEMFS small → avoids OOB).
 */
async function encodeChunkedOpus(
  buffer: AudioBuffer,
  base: string,
  onProgress?: (p: EncodeProgress) => void,
): Promise<File> {
  const duration = buffer.duration;
  const parts: string[] = [];
  const ffmpeg = await getFfmpeg(onProgress);
  const logLines: string[] = [];
  const onLog = ({ message }: { message?: string }) => {
    if (typeof message === "string" && message.trim()) {
      logLines.push(message);
      if (logLines.length > 120) logLines.splice(0, logLines.length - 120);
    }
  };
  ffmpeg.on("log", onLog);

  try {
    let part = 0;
    for (let t = 0; t < duration; t += CHUNK_SEC) {
      const end = Math.min(duration, t + CHUNK_SEC);
      const slice = sliceAudioBuffer(buffer, t, end);
      const wav = audioBufferToWav(slice);
      const inName = `chunk_${part}.wav`;
      const outName = `part_${part}.ogg`;
      onProgress?.({
        phase: "encoding",
        ratio: 0.15 + (0.6 * t) / Math.max(duration, 0.01),
        message: `Encoding chunk ${part + 1} (${t.toFixed(0)}–${end.toFixed(0)}s)…`,
      });
      opusLog("chunk encode", {
        part,
        start: t,
        end,
        wavBytes: wav.byteLength,
      });
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
      await ffmpeg.writeFile(inName, toTransferableBytes(wav));
      const code = await ffmpeg.exec([
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
      ]);
      try {
        await ffmpeg.deleteFile(inName);
      } catch {
        /* ignore */
      }
      if (code !== 0) {
        throw new Error(`chunk ${part} ffmpeg exit ${code}`);
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

    // concat demuxer — copy Opus packets into one Ogg.
    const listBody = parts.map((p) => `file '${p}'`).join("\n");
    const listBytes = new TextEncoder().encode(listBody);
    await ffmpeg.writeFile("concat.txt", toTransferableBytes(listBytes));
    try {
      await ffmpeg.deleteFile("out_concat.ogg");
    } catch {
      /* ignore */
    }
    onProgress?.({
      phase: "encoding",
      ratio: 0.85,
      message: "Joining Opus chunks…",
    });
    const concatCode = await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      "out_concat.ogg",
    ]);
    if (concatCode !== 0) {
      // Re-encode merge if copy fails across Ogg boundaries.
      const remuxCode = await ffmpeg.exec([
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
      ]);
      if (remuxCode !== 0) {
        throw new Error("chunk concat failed");
      }
    }
    const data = await ffmpeg.readFile("out_concat.ogg");
    if (!(data instanceof Uint8Array) || data.byteLength < 64) {
      throw new Error("concat output empty");
    }
    opusLog("chunked encode ok", { parts: parts.length, bytes: data.byteLength });
    return fileFromBytes(data, base, ".ogg", "audio/ogg");
  } catch (err) {
    if (isMemoryError(formatUnknownError(err))) {
      resetFfmpegSingleton("chunked OOB");
    }
    throw err;
  } finally {
    ffmpeg.off?.("log", onLog);
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
): Promise<File> {
  const start = Math.max(0, crop.startSec);
  const end = Math.max(start + 0.25, crop.endSec);
  const base =
    source instanceof File
      ? source.name.replace(/\.[^.]+$/, "") || "clip"
      : "clip";

  const errors: string[] = [];

  try {
    onProgress?.({
      phase: "encoding",
      ratio: 0,
      message: "Preparing crop…",
    });

    // 1) Browser decode + mono crop (avoids stereo/ID3 OOB in wasm).
    const mono = await decodeCropMono(
      source,
      { startSec: start, endSec: end },
      onProgress,
    );
    const wav = audioBufferToWav(mono);
    opusLog("crop wav ready", {
      wavBytes: wav.byteLength,
      duration: mono.duration,
      frames: mono.length,
      mb: (wav.byteLength / (1024 * 1024)).toFixed(1),
    });

    // No hard reject on WAV size — route large crops around MEMFS instead.
    const large = wav.byteLength > WASM_SAFE_WAV_BYTES;

    // 2a) Large crops: chunked ffmpeg (small MEMFS writes) first.
    if (large) {
      opusLog("large crop — trying chunked ffmpeg", {
        wavBytes: wav.byteLength,
        chunkSec: CHUNK_SEC,
      });
      try {
        const file = await encodeChunkedOpus(mono, base, onProgress);
        onProgress?.({
          phase: "done",
          ratio: 1,
          message: doneMessage(file, "chunked"),
        });
        return file;
      } catch (err) {
        const msg = formatUnknownError(err);
        errors.push(`chunked: ${msg}`);
        opusWarn("chunked ffmpeg failed — trying MediaRecorder", msg);
        resetFfmpegSingleton("after chunked failure");
      }

      try {
        const file = await encodeViaMediaRecorder(mono, base, onProgress);
        onProgress?.({
          phase: "done",
          ratio: 1,
          message: doneMessage(file, "browser"),
        });
        return file;
      } catch (err) {
        const msg = formatUnknownError(err);
        errors.push(`mediarecorder: ${msg}`);
        opusWarn("mediarecorder failed — trying single-pass ffmpeg", msg);
      }
    }

    // 2b) Small crops (or large-path exhausted): single-pass ffmpeg on WAV.
    try {
      const file = await encodeWavWithFfmpeg(wav, base, onProgress);
      onProgress?.({
        phase: "done",
        ratio: 1,
        message: doneMessage(file),
      });
      return file;
    } catch (err) {
      const msg = formatUnknownError(err);
      errors.push(`ffmpeg: ${msg}`);
      opusWarn("ffmpeg path failed — trying MediaRecorder", msg);
      resetFfmpegSingleton("after ffmpeg failure");
    }

    // 3) MediaRecorder Opus/WebM (no wasm heap).
    try {
      const file = await encodeViaMediaRecorder(mono, base, onProgress);
      onProgress?.({
        phase: "done",
        ratio: 1,
        message: doneMessage(file, "browser"),
      });
      return file;
    } catch (err) {
      const msg = formatUnknownError(err);
      errors.push(`mediarecorder: ${msg}`);
      opusError("mediarecorder failed", msg);
    }

    throw new Error(errors.join(" · ") || "All encode paths failed");
  } catch (err) {
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
