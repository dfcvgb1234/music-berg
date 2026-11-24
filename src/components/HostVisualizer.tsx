"use client";

import { useEffect, useRef, useState } from "react";

const BAR_COUNT = 64;
const TIMELINE_MAX_MS = 30000;

export function HostVisualizer({
  code,
  songId,
  clipMs,
  playToken,
  active,
  hostToken,
  onPlay,
  busy,
}: {
  code: string;
  songId: string | null;
  clipMs: number;
  playToken: number;
  active: boolean;
  hostToken: string;
  onPlay: () => void;
  busy: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef<number>(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    if (!songId || !active || playToken <= 0) {
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    void (async () => {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(code)}/audio?v=${playToken}`,
        { headers: { "x-host-token": hostToken }, cache: "no-store" },
      );
      if (!res.ok || cancelled) return;
      const blob = await res.blob();
      if (cancelled) return;
      created = URL.createObjectURL(blob);
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return created;
      });
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [code, songId, clipMs, playToken, active, hostToken]);

  const ensureGraph = () => {
    const audio = audioRef.current;
    if (!audio) return null;
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.72;
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      sourceRef.current = source;
    }
    return { ctx: ctxRef.current, analyser: analyserRef.current! };
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const innerR = size * 0.28;
    const data = new Uint8Array(analyser?.frequencyBinCount ?? BAR_COUNT);
    if (analyser) analyser.getByteFrequencyData(data);

    for (let i = 0; i < BAR_COUNT; i++) {
      const t = i / BAR_COUNT;
      const angle = t * Math.PI * 2 - Math.PI / 2;
      const sample =
        analyser && data.length
          ? data[Math.floor((i / BAR_COUNT) * data.length)] / 255
          : 0.15 + 0.1 * Math.sin(Date.now() / 180 + i);
      const amp = playing ? 0.18 + sample * 0.55 : 0.12 + sample * 0.08;
      const outer = innerR + size * amp * 0.22;
      const x0 = cx + Math.cos(angle) * (innerR + 6);
      const y0 = cy + Math.sin(angle) * (innerR + 6);
      const x1 = cx + Math.cos(angle) * outer;
      const y1 = cy + Math.sin(angle) * outer;
      g.strokeStyle = `hsla(${155 + sample * 40}, 85%, ${55 + sample * 20}%, ${0.45 + sample * 0.5})`;
      g.lineWidth = Math.max(2, size * 0.008);
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }

    g.beginPath();
    g.arc(cx, cy, innerR, 0, Math.PI * 2);
    g.fillStyle = "rgba(7, 20, 26, 0.72)";
    g.fill();
    g.strokeStyle = "rgba(200, 245, 96, 0.35)";
    g.lineWidth = 2;
    g.stroke();
  };

  useEffect(() => {
    const tick = () => {
      draw();
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        setPositionMs(Math.min(clipMs, audio.currentTime * 1000));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clipMs]);

  const runUnlocked = async () => {
    const audio = audioRef.current;
    if (!audio || !objectUrl) {
      onPlay();
      return;
    }
    try {
      const graph = ensureGraph();
      await graph?.ctx.resume();
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      audio.pause();
      audio.currentTime = 0;
      setPositionMs(0);
      await audio.play();
      setPlaying(true);
      setNeedsGesture(false);
      stopTimerRef.current = setTimeout(() => {
        audio.pause();
        setPlaying(false);
        setPositionMs(clipMs);
      }, Math.max(200, clipMs));
    } catch {
      setNeedsGesture(true);
    }
  };

  useEffect(() => {
    if (!objectUrl || !active || playToken <= 0) return;
    void runUnlocked();
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      audioRef.current?.pause();
      setPlaying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectUrl, playToken, clipMs, active]);

  const unlockedPct = Math.min(100, (clipMs / TIMELINE_MAX_MS) * 100);
  const posPct = Math.min(unlockedPct, (positionMs / TIMELINE_MAX_MS) * 100);
  const unlockedLabel = `${(clipMs / 1000).toFixed(clipMs % 1000 === 0 ? 0 : 1)}s unlocked`;

  return (
    <div className="host-deck">
      <div className="host-viz-wrap">
        <canvas ref={canvasRef} className="host-viz-canvas" aria-hidden />
        <button
          type="button"
          className="host-play-btn"
          disabled={busy || !songId}
          onClick={() => {
            if (active && objectUrl) void runUnlocked();
            else onPlay();
          }}
          aria-label={playing ? "Replay unlocked clip" : "Play unlocked clip"}
        >
          <span className="host-play-icon" aria-hidden />
        </button>
      </div>

      {objectUrl && (
        <audio ref={audioRef} src={objectUrl} preload="auto" playsInline />
      )}

      <div className="host-timeline" aria-label={unlockedLabel}>
        <div className="host-timeline-track">
          <div
            className="host-timeline-unlocked"
            style={{ width: `${unlockedPct}%` }}
          />
          <div
            className="host-timeline-pointer"
            style={{ left: `${posPct}%` }}
          />
        </div>
        <div className="host-timeline-meta">
          <span>{(positionMs / 1000).toFixed(1)}s</span>
          <span>{unlockedLabel}</span>
          <span>30s</span>
        </div>
      </div>

      {needsGesture && (
        <button type="button" className="btn secondary" onClick={() => void runUnlocked()}>
          Tap to enable sound
        </button>
      )}
    </div>
  );
}
