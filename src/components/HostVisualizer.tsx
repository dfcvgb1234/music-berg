"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { INITIAL_CLIP_MS, formatClipSeconds } from "@/lib/clipRules";
import type { SessionState } from "@/lib/quiz";

const BAR_COUNT = 64;
const TIMELINE_MAX_MS = 30000;
const LOG_TAG = "[bergs-music:host-audio]";

function haLog(...args: unknown[]) {
  console.log(LOG_TAG, ...args);
}
function haWarn(...args: unknown[]) {
  console.warn(LOG_TAG, ...args);
}
function haError(...args: unknown[]) {
  console.error(LOG_TAG, ...args);
}

/**
 * Minimal valid silent WAV (44-byte header + 2 bytes of PCM).
 * Used only to unlock HTMLMediaElement autoplay inside a click gesture.
 */
const SILENCE_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

export type HostVisualizerHandle = {
  /**
   * Run a host control from inside a click: unlock media, POST action,
   * fetch audio, play immediately. Do not rely on useEffect autoplay.
   */
  runFromGesture: (
    path: "play" | "extend" | "reveal" | "next",
  ) => Promise<SessionState | null>;
};

type Props = {
  code: string;
  songId: string | null;
  clipMs: number;
  playToken: number;
  active: boolean;
  revealed: boolean;
  coverArtUrl: string | null;
  hostToken: string;
  busy: boolean;
  onState: (state: SessionState) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
};

export const HostVisualizer = forwardRef<HostVisualizerHandle, Props>(
  function HostVisualizer(
    {
      code,
      songId,
      clipMs,
      playToken,
      active,
      revealed,
      coverArtUrl,
      hostToken,
      busy,
      onState,
      onBusy,
      onError,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);
    const stopTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );
    const playGenRef = useRef(0);
    const unlockedRef = useRef(false);
    const rafRef = useRef(0);

    const [playing, setPlaying] = useState(false);
    const [positionMs, setPositionMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [needsGesture, setNeedsGesture] = useState(false);
    const [coverIn, setCoverIn] = useState(false);
    const [hasSrc, setHasSrc] = useState(false);

    const clearStopTimer = () => {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = undefined;
      }
    };

    const revokeObjectUrl = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };

    /** Must run synchronously at the start of a click handler. */
    const unlockMediaElement = () => {
      const audio = audioRef.current;
      if (!audio) {
        haWarn("unlock skipped — no <audio> ref yet");
        return;
      }
      if (unlockedRef.current) {
        haLog("unlock skipped — already unlocked this session");
        return;
      }
      try {
        haLog("unlock: playing silence inside user gesture");
        const prev = audio.src;
        audio.src = SILENCE_WAV;
        const p = audio.play();
        void Promise.resolve(p)
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            if (prev) audio.src = prev;
            else audio.removeAttribute("src");
            unlockedRef.current = true;
            haLog("unlock: silence play ok — media element unlocked");
          })
          .catch((err: unknown) => {
            unlockedRef.current = true;
            const e = err instanceof Error ? err : new Error(String(err));
            haWarn("unlock: silence play rejected", e.name, e.message);
          });
      } catch (err) {
        unlockedRef.current = true;
        const e = err instanceof Error ? err : new Error(String(err));
        haWarn("unlock: threw", e.name, e.message);
      }
    };

    const attachAndPlay = async (
      blob: Blob,
      opts: { clipMs: number; revealed: boolean; action: string },
    ) => {
      const audio = audioRef.current;
      if (!audio) throw new Error("Audio element missing");

      clearStopTimer();
      const gen = ++playGenRef.current;
      revokeObjectUrl();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      audio.src = url;
      setHasSrc(true);
      haLog("src set", {
        action: opts.action,
        blobBytes: blob.size,
        blobType: blob.type || "(none)",
        objectUrlPrefix: url.slice(0, 24),
        clipMs: opts.clipMs,
        revealed: opts.revealed,
        unlocked: unlockedRef.current,
      });

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (reason: string) => {
          if (settled) return;
          settled = true;
          audio.removeEventListener("canplay", onCanPlay);
          window.clearTimeout(timeoutId);
          if (reason === "canplay") {
            haLog("canplay", {
              readyState: audio.readyState,
              duration: audio.duration,
            });
          } else {
            haWarn("canplay timeout — proceeding anyway", {
              readyState: audio.readyState,
            });
          }
          resolve();
        };
        const onCanPlay = () => finish("canplay");
        audio.addEventListener("canplay", onCanPlay);
        audio.load();
        const timeoutId = window.setTimeout(() => finish("timeout"), 2000);
      });
      if (gen !== playGenRef.current) {
        haWarn("attachAndPlay aborted — newer generation", { gen });
        return;
      }

      audio.currentTime = 0;
      setPositionMs(0);
      haLog("audio.play() calling", {
        action: opts.action,
        paused: audio.paused,
        readyState: audio.readyState,
        srcEmpty: !audio.src,
      });
      try {
        await audio.play();
        haLog("audio.play() resolved", {
          action: opts.action,
          paused: audio.paused,
          currentTime: audio.currentTime,
          duration: audio.duration,
          clipSeconds: opts.clipMs / 1000,
          note: "playing via HTMLMediaElement (no WebAudio graph — cannot be WebAudio-disconnected)",
        });
        setPlaying(true);
        setNeedsGesture(false);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setDurationMs(audio.duration * 1000);
        }
        if (!opts.revealed) {
          stopTimerRef.current = setTimeout(() => {
            if (gen !== playGenRef.current) return;
            haLog("clip stop timer", {
              clipMs: opts.clipMs,
              currentTime: audio.currentTime,
            });
            audio.pause();
            setPlaying(false);
            setPositionMs(opts.clipMs);
          }, Math.max(200, opts.clipMs));
        } else {
          audio.onended = () => {
            if (gen !== playGenRef.current) return;
            haLog("full track ended");
            setPlaying(false);
          };
        }
      } catch (err) {
        setPlaying(false);
        setNeedsGesture(true);
        const e = err instanceof Error ? err : new Error(String(err));
        haError("audio.play() rejected", {
          name: e.name,
          message: e.message,
          action: opts.action,
          autoplayPolicy:
            e.name === "NotAllowedError"
              ? "blocked — needs user gesture"
              : "other",
        });
        throw err;
      }
    };

    const runFromGesture = async (
      path: "play" | "extend" | "reveal" | "next",
    ): Promise<SessionState | null> => {
      haLog("click received", { path, code });
      // 1) Keep user gesture for HTMLMediaElement autoplay.
      unlockMediaElement();
      onBusy(true);
      onError(null);
      try {
        if (path === "next") {
          clearStopTimer();
          playGenRef.current += 1;
          audioRef.current?.pause();
          setPlaying(false);
          revokeObjectUrl();
          const audio = audioRef.current;
          if (audio) {
            audio.removeAttribute("src");
            audio.load();
          }
          setHasSrc(false);
          haLog("next: cleared audio src");
        }

        haLog("POST session action", { path });
        const res = await fetch(`/api/sessions/${encodeURIComponent(code)}/${path}`, {
          method: "POST",
          headers: { "x-host-token": hostToken },
        });
        const data = (await res.json()) as {
          error?: string;
          state?: SessionState;
        };
        if (!res.ok) throw new Error(data.error || "Action failed");
        if (data.state) {
          haLog("session state updated", {
            status: data.state.status,
            clipMs: data.state.clipMs,
            playToken: data.state.playToken,
            hasSongId: Boolean(data.state.currentSongId),
          });
          onState(data.state);
        }

        if (path === "next" || !data.state) return data.state ?? null;

        const next = data.state;
        const shouldPlay =
          next.status === "playing" || next.status === "revealed";
        if (!shouldPlay || !next.currentSongId) {
          haWarn("not loading audio — unexpected state", {
            status: next.status,
            hasSongId: Boolean(next.currentSongId),
          });
          return next;
        }

        // 2) Load full track, then play; client enforces clip length.
        haLog("GET host audio", {
          playToken: next.playToken,
          status: next.status,
        });
        const audioRes = await fetch(
          `/api/sessions/${encodeURIComponent(code)}/audio?v=${next.playToken}`,
          { headers: { "x-host-token": hostToken }, cache: "no-store" },
        );
        if (!audioRes.ok) {
          haError("audio fetch failed", {
            httpStatus: audioRes.status,
          });
          throw new Error("Could not load host audio");
        }
        const blob = await audioRes.blob();
        haLog("audio blob received", {
          bytes: blob.size,
          type: blob.type || "(none)",
        });
        if (blob.size < 256) {
          haWarn("audio blob suspiciously small — may be invalid/empty");
        }
        await attachAndPlay(blob, {
          clipMs: next.clipMs,
          revealed: next.status === "revealed",
          action: path,
        });
        return next;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Playback failed";
        const e = err instanceof Error ? err : new Error(String(err));
        haError("runFromGesture failed", {
          path,
          name: e.name,
          message: e.message,
        });
        onError(message);
        return null;
      } finally {
        onBusy(false);
      }
    };

    useImperativeHandle(ref, () => ({ runFromGesture }), [
      code,
      hostToken,
      onBusy,
      onError,
      onState,
    ]);

    useEffect(() => {
      if (revealed && coverArtUrl) {
        setCoverIn(false);
        const t = requestAnimationFrame(() => setCoverIn(true));
        return () => cancelAnimationFrame(t);
      }
      setCoverIn(false);
    }, [revealed, coverArtUrl, playToken]);

    useEffect(() => {
      return () => {
        clearStopTimer();
        revokeObjectUrl();
        cancelAnimationFrame(rafRef.current);
      };
    }, []);

    // Visualizer only — no Web Audio graph (that muted element output when ctx suspended).
    useEffect(() => {
      const tick = () => {
        const canvas = canvasRef.current;
        const audio = audioRef.current;
        if (canvas) {
          const dpr = window.devicePixelRatio || 1;
          const size = canvas.clientWidth || 1;
          if (canvas.width !== size * dpr) {
            canvas.width = size * dpr;
            canvas.height = size * dpr;
          }
          const g = canvas.getContext("2d");
          if (g) {
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, size, size);
            const cx = size / 2;
            const cy = size / 2;
            const innerR = size * 0.28;
            const now = Date.now() / 1000;
            const isPlaying = Boolean(audio && !audio.paused);
            for (let i = 0; i < BAR_COUNT; i++) {
              const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
              const synth =
                0.35 +
                0.45 *
                  Math.abs(Math.sin(now * 6.2 + i * 0.55)) *
                  Math.abs(Math.cos(now * 3.1 + i * 0.2));
              const sample = isPlaying ? synth : 0.15;
              const amp = isPlaying ? 0.22 + sample * 0.7 : 0.14;
              const outer = innerR + size * amp * 0.26;
              g.strokeStyle = `hsla(${155 + sample * 40}, 85%, ${55 + sample * 20}%, ${0.45 + sample * 0.5})`;
              g.lineWidth = Math.max(2, size * 0.008);
              g.lineCap = "round";
              g.beginPath();
              g.moveTo(
                cx + Math.cos(angle) * (innerR + 6),
                cy + Math.sin(angle) * (innerR + 6),
              );
              g.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
              g.stroke();
            }
            g.beginPath();
            g.arc(cx, cy, innerR, 0, Math.PI * 2);
            g.fillStyle = revealed
              ? "rgba(7, 20, 26, 0.35)"
              : "rgba(7, 20, 26, 0.72)";
            g.fill();
            g.strokeStyle = "rgba(200, 245, 96, 0.35)";
            g.lineWidth = 2;
            g.stroke();
          }
        }
        if (audio && !audio.paused) {
          const cap = revealed
            ? Number.isFinite(audio.duration)
              ? audio.duration * 1000
              : positionMs
            : clipMs;
          setPositionMs(Math.min(cap || clipMs, audio.currentTime * 1000));
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setDurationMs(audio.duration * 1000);
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipMs, revealed, playing]);

    const timelineMax = revealed
      ? Math.max(durationMs || clipMs, clipMs, 1000)
      : TIMELINE_MAX_MS;
    const unlockedPct = revealed
      ? 100
      : Math.min(100, (clipMs / TIMELINE_MAX_MS) * 100);
    const posPct = Math.min(unlockedPct, (positionMs / timelineMax) * 100);
    const unlockedLabel = revealed
      ? "Full track"
      : !active
        ? "Ready"
        : `${formatClipSeconds(clipMs)}s`;
    const unlockedPctDisplay =
      !active && !revealed
        ? Math.min(100, (INITIAL_CLIP_MS / TIMELINE_MAX_MS) * 100)
        : unlockedPct;

    return (
      <div className="host-deck">
        <div className="host-viz-wrap">
          <canvas ref={canvasRef} className="host-viz-canvas" aria-hidden />
          {revealed && coverArtUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverArtUrl}
              alt=""
              className={`host-reveal-cover${coverIn ? " is-in" : ""}`}
              referrerPolicy="no-referrer"
            />
          ) : (
            <button
              type="button"
              className="host-play-btn"
              disabled={busy || !songId}
              onClick={() => {
                if (active && hasSrc) {
                  haLog("center button: replay existing src");
                  unlockMediaElement();
                  void (async () => {
                    const audio = audioRef.current;
                    if (!audio) return;
                    try {
                      clearStopTimer();
                      audio.currentTime = 0;
                      haLog("audio.play() calling (replay)");
                      await audio.play();
                      haLog("audio.play() resolved (replay)", {
                        currentTime: audio.currentTime,
                        paused: audio.paused,
                      });
                      setPlaying(true);
                      setNeedsGesture(false);
                      if (!revealed) {
                        const gen = ++playGenRef.current;
                        stopTimerRef.current = setTimeout(() => {
                          if (gen !== playGenRef.current) return;
                          audio.pause();
                          setPlaying(false);
                          setPositionMs(clipMs);
                        }, Math.max(200, clipMs));
                      }
                    } catch (err) {
                      const e =
                        err instanceof Error ? err : new Error(String(err));
                      haError("audio.play() rejected (replay)", {
                        name: e.name,
                        message: e.message,
                      });
                      setNeedsGesture(true);
                    }
                  })();
                } else {
                  void runFromGesture("play");
                }
              }}
              aria-label={playing ? "Replay unlocked clip" : "Play unlocked clip"}
            >
              <span className="host-play-icon" aria-hidden />
            </button>
          )}
        </div>

        <audio ref={audioRef} preload="auto" playsInline />

        <div className="host-timeline" aria-label={unlockedLabel}>
          <div className="host-timeline-track">
            <div
              className="host-timeline-unlocked"
              style={{ width: `${unlockedPctDisplay}%` }}
            />
            <div
              className="host-timeline-pointer"
              style={{ left: `${!active && !revealed ? 0 : posPct}%` }}
            />
          </div>
          <div className="host-timeline-meta">
            <span>{(positionMs / 1000).toFixed(1)}s</span>
            <span>{unlockedLabel}</span>
            <span>
              {revealed
                ? `${((durationMs || timelineMax) / 1000).toFixed(0)}s`
                : "30s"}
            </span>
          </div>
        </div>

        {needsGesture && (
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              unlockMediaElement();
              void runFromGesture(revealed ? "reveal" : "play");
            }}
          >
            Tap to enable sound
          </button>
        )}
      </div>
    );
  },
);
