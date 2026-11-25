"use client";

import { useEffect, useId, useRef, useState } from "react";
import { WaveformCrop } from "@/components/WaveformCrop";
import {
  cropCacheKey,
  encodeOpusCrop,
  isEncodeAbortError,
  probeAudioDuration,
  resetFfmpegSingleton,
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
  /**
   * Segment boundaries in the cropped clip (seconds from clip start).
   * Empty = progressive +seconds unlock at play time.
   */
  segmentPointsSec: number[];
};

type Props = {
  id?: string;
  label?: string;
  value: PreparedAudio | null;
  onChange: (next: PreparedAudio | null) => void;
  /**
   * Absolute segment times on the current source/visualized file.
   * Parent may lift these for edit-without-reencode flows.
   */
  segmentPointsSec?: number[];
  onSegmentPointsChange?: (points: number[]) => void;
  /**
   * Existing stored clip (edit mode). Crop is locked; segments editable.
   * Cleared when the user picks a new source file.
   */
  existingClip?: { file: File; label: string } | null;
  onClearExisting?: () => void;
  disabled?: boolean;
};

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Map absolute source markers into cropped-clip-relative seconds. */
export function remapSegmentsToCrop(
  absoluteSec: number[],
  startSec: number,
  endSec: number,
): number[] {
  return [
    ...new Set(
      absoluteSec
        .map((t) => Math.round((t - startSec) * 1000) / 1000)
        .filter((t) => t > 0.05 && t < endSec - startSec - 0.05),
    ),
  ].sort((a, b) => a - b);
}

export function AudioCropField({
  id: idProp,
  label = "Audio file",
  value,
  onChange,
  segmentPointsSec: segmentPointsProp,
  onSegmentPointsChange,
  existingClip = null,
  onClearExisting,
  disabled,
}: Props) {
  const uid = useId();
  const inputId = idProp ?? `audio-crop-${uid}`;
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const monoCacheRef = useRef<{ key: string; mono: AudioBuffer } | null>(null);

  const [source, setSource] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [localSegments, setLocalSegments] = useState<number[]>([]);
  const [progress, setProgress] = useState<EncodeProgress | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [existingMode, setExistingMode] = useState(false);

  const segmentsControlled = segmentPointsProp !== undefined;
  const segmentPointsSec = segmentsControlled
    ? segmentPointsProp
    : localSegments;
  const setSegmentPoints = (points: number[]) => {
    if (onSegmentPointsChange) onSegmentPointsChange(points);
    if (!segmentsControlled) setLocalSegments(points);
  };

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Load existing clip for edit (segments-only / keep audio).
  useEffect(() => {
    if (!existingClip?.file || source) return;
    let cancelled = false;
    void (async () => {
      try {
        const d = await probeAudioDuration(existingClip.file);
        if (cancelled) return;
        setExistingMode(true);
        setDuration(d);
        setStartSec(0);
        setEndSec(d);
        setLocalError(null);
      } catch (err) {
        if (!cancelled) {
          setLocalError(
            err instanceof Error
              ? err.message
              : "Could not read existing clip",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [existingClip, source]);

  const setPreview = (file: File | Blob | null) => {
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

  const invalidateMonoCache = () => {
    monoCacheRef.current = null;
  };

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    invalidateMonoCache();
    setSource(null);
    setDuration(0);
    setStartSec(0);
    setEndSec(0);
    setProgress(null);
    setLocalError(null);
    setEncoding(false);
    setExistingMode(false);
    setPreview(null);
    onChange(null);
  };

  const onPickFile = async (file: File | null) => {
    reset();
    onClearExisting?.();
    if (!file) return;
    if (file.size > uploadLimits.maxFileBytes * 2) {
      setLocalError(
        `File is too large to process (max ~${formatBytes(uploadLimits.maxFileBytes * 2)}).`,
      );
      return;
    }
    setSource(file);
    setExistingMode(false);
    setLocalError(null);
    try {
      const d = await probeAudioDuration(file);
      setDuration(d);
      setStartSec(0);
      setEndSec(d);
      setSegmentPoints([]);
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
    if (!el) return;
    el.currentTime = startSec;
    void el.play().catch(() => {
      /* ignore */
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

  const onCancelEncode = () => {
    abortRef.current?.abort();
    resetFfmpegSingleton("UI cancel");
    setEncoding(false);
    setProgress(null);
    setLocalError("Encoding cancelled — crop selection kept. Click Convert to retry.");
  };

  const onEncode = async () => {
    if (!source || duration <= 0) return;
    if (endSec - startSec < 0.5) {
      setLocalError("Crop must be at least 0.5 seconds");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const key = cropCacheKey(source, { startSec, endSec });
    const cached =
      monoCacheRef.current?.key === key ? monoCacheRef.current.mono : null;

    setEncoding(true);
    setLocalError(null);
    setProgress({ phase: "loading", message: "Starting encoder…" });
    try {
      const file = await encodeOpusCrop(
        source,
        { startSec, endSec },
        setProgress,
        {
          signal: ac.signal,
          cachedMono: cached,
          onMonoReady: (mono) => {
            monoCacheRef.current = { key, mono };
          },
        },
      );
      if (ac.signal.aborted) return;
      if (file.size > uploadLimits.maxFileBytes) {
        throw new Error(
          `Encoded file is still too large (max ${formatBytes(uploadLimits.maxFileBytes)}). Use a shorter crop.`,
        );
      }
      const clippedSegments = remapSegmentsToCrop(
        segmentPointsSec,
        startSec,
        endSec,
      );
      onChange({
        sourceName: source.name,
        file,
        startSec,
        endSec,
        segmentPointsSec: clippedSegments,
      });
      // After convert, visualize the Opus clip (crop locked at full file).
      setPreview(file);
      setLocalError(null);
    } catch (err) {
      if (isEncodeAbortError(err) || ac.signal.aborted) {
        setProgress(null);
        setLocalError(
          "Encoding cancelled — crop selection kept. Click Convert to retry.",
        );
        return;
      }
      onChange(null);
      const message =
        err instanceof Error ? err.message : String(err ?? "Encoding failed");
      console.error("[bergs-music:opus]", "UI convert failed", message, err);
      setProgress({
        phase: "error",
        message,
      });
      setLocalError(message);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setEncoding(false);
    }
  };

  const cropLen = Math.max(0, endSec - startSec);
  const ready = Boolean(value?.file);
  const showPanel = (source && duration > 0) || (existingMode && duration > 0);

  // Attach preview once the <audio> mounts (after duration/panel is shown).
  useEffect(() => {
    if (ready && value?.file) {
      setPreview(value.file);
      return;
    }
    if (source) {
      setPreview(source);
      return;
    }
    if (existingMode && existingClip?.file) {
      setPreview(existingClip.file);
    }
  }, [ready, value?.file, source, existingMode, existingClip?.file]);
  const visualFile: File | Blob | null = ready
    ? value!.file
    : source
      ? source
      : existingClip?.file ?? null;
  const visualDuration = ready
    ? Math.max(0.1, value!.endSec - value!.startSec)
    : duration;
  const visualStart = ready ? 0 : startSec;
  const visualEnd = ready ? visualDuration : endSec;
  // After encode, segment points are relative to the cropped file.
  const visualSegments = ready
    ? value!.segmentPointsSec
    : existingMode
      ? segmentPointsSec
      : segmentPointsSec;

  const progressLabel =
    progress?.chunkIndex && progress?.chunkTotal
      ? `${progress.message}`
      : progress?.message;

  const onVisualSegmentsChange = (points: number[]) => {
    if (ready && value) {
      const next = {
        ...value,
        segmentPointsSec: points,
      };
      onChange(next);
      setSegmentPoints(
        // Keep parent absolute-in-source in sync when possible: map back
        points.map((p) => p + value.startSec),
      );
      return;
    }
    if (existingMode) {
      setSegmentPoints(points);
      return;
    }
    setSegmentPoints(points);
  };

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
      {existingMode && !source && existingClip && (
        <p className="muted audio-crop-hint">
          Keeping existing clip “{existingClip.label}”. Adjust segment markers
          on the waveform, or pick a new file to re-crop.
        </p>
      )}
      {showPanel && (
        <div className="audio-crop-panel">
          <audio
            ref={previewRef}
            controls
            preload="metadata"
            className="audio-crop-preview"
          />

          {visualFile && visualDuration > 0 && (
            <WaveformCrop
              file={visualFile}
              duration={visualDuration}
              startSec={visualStart}
              endSec={visualEnd}
              segmentPointsSec={visualSegments}
              lockCrop={ready || existingMode || encoding}
              lockSegments={encoding}
              disabled={disabled || encoding}
              onStartEndChange={(s, e) => {
                setStartSec(s);
                setEndSec(e);
                invalidateMonoCache();
                if (value) onChange(null);
                // Drop markers outside the new crop window
                setSegmentPoints(
                  segmentPointsSec.filter((p) => p > s + 0.05 && p < e - 0.05),
                );
              }}
              onSegmentPointsChange={onVisualSegmentsChange}
            />
          )}

          {!ready && !existingMode && (
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
                    invalidateMonoCache();
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
                    invalidateMonoCache();
                    if (value) onChange(null);
                  }}
                />
              </label>
            </div>
          )}

          <div className="audio-crop-meta muted">
            {ready && value
              ? `Encoded ${fmtTime(0)} → ${fmtTime(visualDuration)} · ${formatBytes(value.file.size)} Opus`
              : existingMode
                ? `Existing clip ${fmtTime(duration)}`
                : `Crop ${fmtTime(startSec)} → ${fmtTime(endSec)} (${cropLen.toFixed(1)}s of ${fmtTime(duration)})`}
            {visualSegments.length > 0
              ? ` · ${visualSegments.length} segment point${visualSegments.length === 1 ? "" : "s"}`
              : " · progressive unlock"}
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
            {!ready && !existingMode ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={encoding || cropLen < 0.5}
                  onClick={() => void onEncode()}
                >
                  {encoding ? "Converting…" : "Convert to Opus"}
                </button>
                {encoding && (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={onCancelEncode}
                  >
                    Cancel
                  </button>
                )}
              </>
            ) : ready ? (
              <button
                type="button"
                className="btn secondary"
                disabled={encoding}
                onClick={() => {
                  onChange(null);
                  setProgress(null);
                  if (source) {
                    setPreview(source);
                    setExistingMode(false);
                  }
                }}
              >
                Re-crop
              </button>
            ) : null}
          </div>
          {progress && progress.phase !== "done" && progress.phase !== "error" && (
            <div className="audio-crop-progress" role="status">
              <div className="audio-crop-progress-bar">
                <span
                  style={{
                    width: `${Math.round((progress.ratio ?? (progress.phase === "loading" ? 0.15 : 0)) * 100)}%`,
                  }}
                />
              </div>
              <span className="muted">{progressLabel}</span>
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
