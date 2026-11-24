"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  encodeOpusCrop,
  probeAudioDuration,
  type EncodeProgress,
} from "@/lib/clientOpusEncode";
import { formatBytes, uploadLimits } from "@/lib/uploadLimits";

export type PreparedAudio = {
  /** Original user pick (for display). */
  sourceName: string;
  /** Cropped Opus file ready to upload. */
  file: File;
  startSec: number;
  endSec: number;
};

type Props = {
  id?: string;
  label?: string;
  value: PreparedAudio | null;
  onChange: (next: PreparedAudio | null) => void;
  disabled?: boolean;
};

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioCropField({
  id: idProp,
  label = "Audio file",
  value,
  onChange,
  disabled,
}: Props) {
  const uid = useId();
  const inputId = idProp ?? `audio-crop-${uid}`;
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const [source, setSource] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [progress, setProgress] = useState<EncodeProgress | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(false);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const setPreview = (file: File | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    const el = previewRef.current;
    if (!el) return;
    if (!file) {
      el.removeAttribute("src");
      el.load();
      return;
    }
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    el.src = url;
  };

  const reset = () => {
    setSource(null);
    setDuration(0);
    setStartSec(0);
    setEndSec(0);
    setProgress(null);
    setLocalError(null);
    setEncoding(false);
    setPreview(null);
    onChange(null);
  };

  const onPickFile = async (file: File | null) => {
    reset();
    if (!file) return;
    if (file.size > uploadLimits.maxFileBytes * 2) {
      // Allow larger source before Opus shrink; hard cap ~2× stored limit.
      setLocalError(
        `File is too large to process (max ~${formatBytes(uploadLimits.maxFileBytes * 2)}).`,
      );
      return;
    }
    setSource(file);
    setLocalError(null);
    try {
      const d = await probeAudioDuration(file);
      setDuration(d);
      setStartSec(0);
      setEndSec(d);
      setPreview(file);
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : "Could not read this audio file",
      );
      setSource(null);
    }
  };

  const applyCropPreview = () => {
    const el = previewRef.current;
    if (!el || !source) return;
    el.currentTime = startSec;
    void el.play().catch(() => {
      /* autoplay may be blocked until click — ignore */
    });
  };

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const onTime = () => {
      if (endSec > 0 && el.currentTime >= endSec) {
        el.pause();
        el.currentTime = startSec;
      }
    };
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [startSec, endSec]);

  const onEncode = async () => {
    if (!source || duration <= 0) return;
    if (endSec - startSec < 0.5) {
      setLocalError("Crop must be at least 0.5 seconds");
      return;
    }
    setEncoding(true);
    setLocalError(null);
    setProgress({ phase: "loading", message: "Starting encoder…" });
    try {
      const file = await encodeOpusCrop(
        source,
        { startSec, endSec },
        setProgress,
      );
      if (file.size > uploadLimits.maxFileBytes) {
        throw new Error(
          `Encoded file is still too large (max ${formatBytes(uploadLimits.maxFileBytes)}). Use a shorter crop.`,
        );
      }
      onChange({
        sourceName: source.name,
        file,
        startSec,
        endSec,
      });
      setPreview(file);
    } catch (err) {
      onChange(null);
      setProgress(null);
      setLocalError(
        err instanceof Error ? err.message : "Encoding failed",
      );
    } finally {
      setEncoding(false);
    }
  };

  const cropLen = Math.max(0, endSec - startSec);
  const ready = Boolean(value?.file);

  return (
    <div className="field audio-crop-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm"
        disabled={disabled || encoding}
        onChange={(e) => {
          void onPickFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <p className="muted audio-crop-hint">
        Pick any common audio file, optionally crop, then convert to Opus 96
        kbps before upload (max {formatBytes(uploadLimits.maxFileBytes)}{" "}
        encoded).
      </p>

      {source && duration > 0 && (
        <div className="audio-crop-panel">
          <audio ref={previewRef} controls preload="metadata" className="audio-crop-preview" />
          <div className="audio-crop-sliders">
            <label>
              Start ({fmtTime(startSec)})
              <input
                type="range"
                min={0}
                max={Math.max(0, duration - 0.5)}
                step={0.1}
                value={startSec}
                disabled={encoding || ready}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setStartSec(next);
                  setEndSec((end) => Math.max(end, next + 0.5));
                  if (value) onChange(null);
                }}
              />
            </label>
            <label>
              End ({fmtTime(endSec)})
              <input
                type="range"
                min={Math.min(duration, startSec + 0.5)}
                max={duration}
                step={0.1}
                value={endSec}
                disabled={encoding || ready}
                onChange={(e) => {
                  setEndSec(Number(e.target.value));
                  if (value) onChange(null);
                }}
              />
            </label>
          </div>
          <div className="audio-crop-meta muted">
            Crop {fmtTime(startSec)} → {fmtTime(endSec)} ({cropLen.toFixed(1)}s
            of {fmtTime(duration)})
            {ready && value
              ? ` · Encoded ${formatBytes(value.file.size)} Opus`
              : ""}
          </div>
          <div className="audio-crop-actions">
            <button
              type="button"
              className="btn secondary"
              disabled={encoding}
              onClick={applyCropPreview}
            >
              Preview crop
            </button>
            {!ready ? (
              <button
                type="button"
                className="btn"
                disabled={encoding || cropLen < 0.5}
                onClick={() => void onEncode()}
              >
                {encoding ? "Converting…" : "Convert to Opus"}
              </button>
            ) : (
              <button
                type="button"
                className="btn secondary"
                disabled={encoding}
                onClick={() => {
                  onChange(null);
                  setProgress(null);
                  setPreview(source);
                }}
              >
                Re-crop
              </button>
            )}
          </div>
          {progress && progress.phase !== "done" && (
            <div className="audio-crop-progress" role="status">
              <div className="audio-crop-progress-bar">
                <span
                  style={{
                    width: `${Math.round((progress.ratio ?? (progress.phase === "loading" ? 0.15 : 0)) * 100)}%`,
                  }}
                />
              </div>
              <span className="muted">{progress.message}</span>
            </div>
          )}
          {progress?.phase === "done" && (
            <p className="ok-msg" style={{ margin: 0 }}>
              {progress.message}
            </p>
          )}
        </div>
      )}

      {localError && <p className="error">{localError}</p>}
    </div>
  );
}
