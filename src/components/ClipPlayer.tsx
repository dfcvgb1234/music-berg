"use client";

import { useEffect, useRef, useState } from "react";

export function ClipPlayer({
  code,
  songId,
  clipMs,
  playToken,
  active,
  fullTrack = false,
  hostToken,
  participantToken,
}: {
  code: string;
  songId: string | null;
  clipMs: number;
  playToken: number;
  active: boolean;
  fullTrack?: boolean;
  hostToken?: string | null;
  participantToken?: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const pendingRef = useRef<{ clipMs: number; playToken: number } | null>(null);
  const stopTimerRef = useRef<number | undefined>(undefined);

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
      const headers: HeadersInit = {};
      if (hostToken) headers["x-host-token"] = hostToken;
      if (participantToken) headers["x-participant-token"] = participantToken;
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(code)}/audio?v=${playToken}`,
        { headers, cache: "no-store" },
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
  }, [code, songId, clipMs, playToken, active, hostToken, participantToken, fullTrack]);

  const runClip = async (clip: number) => {
    const audio = audioRef.current;
    if (!audio || !objectUrl) return;
    try {
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      audio.pause();
      audio.currentTime = 0;
      await audio.play();
      setNeedsGesture(false);
      if (!fullTrack) {
        stopTimerRef.current = window.setTimeout(() => {
          if (audioRef.current === audio) audio.pause();
        }, Math.max(200, clip));
      }
    } catch {
      setNeedsGesture(true);
      pendingRef.current = { clipMs: clip, playToken };
    }
  };

  useEffect(() => {
    if (!objectUrl || !active || playToken <= 0) return;
    void runClip(clipMs);
    return () => {
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectUrl, clipMs, playToken, active, fullTrack]);

  if (!songId || !active) return null;

  return (
    <div className="clip-player">
      {objectUrl && (
        <audio ref={audioRef} src={objectUrl} preload="auto" playsInline />
      )}
      {needsGesture && (
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            const pending = pendingRef.current;
            void runClip(pending?.clipMs ?? clipMs);
          }}
        >
          Tap to enable sound
        </button>
      )}
    </div>
  );
}
