"use client";

import { useEffect, useRef, useState } from "react";

export function ClipPlayer({
  songId,
  clipMs,
  playToken,
  active,
}: {
  songId: string | null;
  clipMs: number;
  playToken: number;
  active: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const pendingRef = useRef<{ clipMs: number; playToken: number } | null>(null);

  const runClip = async (clip: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      await audio.play();
      setNeedsGesture(false);
      window.setTimeout(() => {
        if (audioRef.current === audio) audio.pause();
      }, Math.max(200, clip));
    } catch {
      setNeedsGesture(true);
      pendingRef.current = { clipMs: clip, playToken };
    }
  };

  useEffect(() => {
    if (!songId || !active || playToken <= 0) return;
    void runClip(clipMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, clipMs, playToken, active]);

  if (!songId) return null;

  return (
    <div className="clip-player">
      <audio
        ref={audioRef}
        src={`/api/songs/${songId}/audio`}
        preload="auto"
        playsInline
      />
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
