"use client";

/** Plays [0, clipMs] of the given audio element, restarting on each call. */
export function playClip(
  audio: HTMLAudioElement,
  clipMs: number,
  playToken: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      audio.pause();
      audio.currentTime = 0;
      await audio.play();
      timer = setTimeout(() => {
        if (stopped) return;
        audio.pause();
      }, Math.max(200, clipMs));
    } catch {
      // Autoplay blocked — caller should prompt for a gesture
    }
  };

  void run();
  void playToken;

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    audio.pause();
  };
}
