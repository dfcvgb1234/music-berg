"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type WaveformCropProps = {
  /** Source or encoded audio file to visualize. */
  file: File | Blob | null;
  duration: number;
  startSec: number;
  endSec: number;
  /** Absolute times on the visualized file (source before convert). */
  segmentPointsSec: number[];
  onStartEndChange?: (startSec: number, endSec: number) => void;
  onSegmentPointsChange?: (points: number[]) => void;
  /** When true, crop handles are fixed (edit existing clip / post-encode). */
  lockCrop?: boolean;
  /** When true, segment markers cannot be added/moved. */
  lockSegments?: boolean;
  disabled?: boolean;
  className?: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

async function buildPeaks(
  file: File | Blob,
  buckets: number,
): Promise<Float32Array> {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const ab = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(ab.slice(0));
    const ch = audio.getChannelData(0);
    const peaks = new Float32Array(buckets);
    const block = Math.max(1, Math.floor(ch.length / buckets));
    for (let i = 0; i < buckets; i++) {
      const start = i * block;
      const end = Math.min(ch.length, start + block);
      let max = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  } finally {
    void ctx.close();
  }
}

type DragKind = "start" | "end" | "segment" | "seek" | null;

export function WaveformCrop({
  file,
  duration,
  startSec,
  endSec,
  segmentPointsSec,
  onStartEndChange,
  onSegmentPointsChange,
  lockCrop = false,
  lockSegments = false,
  disabled = false,
  className,
}: WaveformCropProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dragRef = useRef<{
    kind: DragKind;
    segmentIndex: number;
  }>({ kind: null, segmentIndex: -1 });

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setLoadError(null);
    if (!file || duration <= 0) return;
    void (async () => {
      try {
        const next = await buildPeaks(file, 240);
        if (!cancelled) setPeaks(next);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Could not decode waveform",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, duration]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const wrap = wrapRef.current;
    const cssW = wrap?.clientWidth ?? 480;
    const cssH = 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "rgba(7, 20, 26, 0.55)";
    ctx.fillRect(0, 0, cssW, cssH);

    const mid = cssH / 2;
    if (peaks && peaks.length) {
      const barW = cssW / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const t = (i + 0.5) / peaks.length;
        const sec = t * duration;
        const inCrop = sec >= startSec && sec <= endSec;
        const h = Math.max(1.5, peaks[i] * (cssH * 0.78));
        ctx.fillStyle = inCrop
          ? "rgba(125, 255, 179, 0.75)"
          : "rgba(158, 182, 194, 0.28)";
        ctx.fillRect(i * barW, mid - h / 2, Math.max(1, barW * 0.72), h);
      }
    } else {
      ctx.fillStyle = "rgba(158, 182, 194, 0.35)";
      ctx.fillRect(0, mid - 1, cssW, 2);
    }

    // Dim outside crop
    const x0 = (startSec / duration) * cssW;
    const x1 = (endSec / duration) * cssW;
    ctx.fillStyle = "rgba(4, 16, 22, 0.45)";
    ctx.fillRect(0, 0, x0, cssH);
    ctx.fillRect(x1, 0, cssW - x1, cssH);

    // Crop edges
    ctx.strokeStyle = "rgba(200, 245, 96, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, cssH);
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, cssH);
    ctx.stroke();

    // Segment markers (absolute on this file)
    for (const sec of segmentPointsSec) {
      if (sec < 0 || sec > duration) continue;
      const x = (sec / duration) * cssW;
      ctx.strokeStyle = "rgba(255, 107, 74, 0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, cssH - 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 107, 74, 0.95)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 5, 10);
      ctx.lineTo(x + 5, 10);
      ctx.closePath();
      ctx.fill();
    }
  }, [peaks, duration, startSec, endSec, segmentPointsSec]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const secFromClientX = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * duration;
  };

  const nearestSegment = (sec: number, thresholdSec: number): number => {
    let best = -1;
    let bestDist = thresholdSec;
    segmentPointsSec.forEach((p, i) => {
      const d = Math.abs(p - sec);
      if (d <= bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled || duration <= 0) return;
    const sec = secFromClientX(e.clientX);
    const edgeHit = Math.max(0.25, duration * 0.02);

    if (!lockCrop && onStartEndChange) {
      if (Math.abs(sec - startSec) <= edgeHit) {
        dragRef.current = { kind: "start", segmentIndex: -1 };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (Math.abs(sec - endSec) <= edgeHit) {
        dragRef.current = { kind: "end", segmentIndex: -1 };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (!lockSegments && onSegmentPointsChange) {
      const idx = nearestSegment(sec, edgeHit);
      if (idx >= 0) {
        dragRef.current = { kind: "segment", segmentIndex: idx };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      // Click inside crop adds a segment point
      if (sec > startSec + 0.15 && sec < endSec - 0.15) {
        const next = [...segmentPointsSec, sec]
          .map((v) => Math.round(v * 10) / 10)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .sort((a, b) => a - b)
          .slice(0, 40);
        onSegmentPointsChange(next);
        return;
      }
    }

    dragRef.current = { kind: "seek", segmentIndex: -1 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag.kind || disabled) return;
    const sec = secFromClientX(e.clientX);

    if (drag.kind === "start" && onStartEndChange) {
      const nextStart = clamp(sec, 0, endSec - 0.5);
      onStartEndChange(nextStart, endSec);
    } else if (drag.kind === "end" && onStartEndChange) {
      const nextEnd = clamp(sec, startSec + 0.5, duration);
      onStartEndChange(startSec, nextEnd);
    } else if (
      drag.kind === "segment" &&
      onSegmentPointsChange &&
      drag.segmentIndex >= 0
    ) {
      const next = [...segmentPointsSec];
      next[drag.segmentIndex] = clamp(sec, startSec + 0.05, endSec - 0.05);
      onSegmentPointsChange(
        [...new Set(next.map((v) => Math.round(v * 10) / 10))].sort(
          (a, b) => a - b,
        ),
      );
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { kind: null, segmentIndex: -1 };
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const removeSegmentNear = (sec: number) => {
    if (lockSegments || !onSegmentPointsChange) return;
    const idx = nearestSegment(sec, Math.max(0.3, duration * 0.03));
    if (idx < 0) return;
    onSegmentPointsChange(segmentPointsSec.filter((_, i) => i !== idx));
  };

  return (
    <div className={`waveform-crop${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="waveform-crop-canvas"
        role="img"
        aria-label="Audio waveform with crop and segment markers"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          if (disabled) return;
          removeSegmentNear(secFromClientX(e.clientX));
        }}
      />
      <div className="waveform-crop-legend muted">
        <span>Crop: lime edges</span>
        <span>Segments: coral markers (click to add, drag to move, double-click to remove)</span>
      </div>
      {loadError && <p className="error">{loadError}</p>}
    </div>
  );
}
