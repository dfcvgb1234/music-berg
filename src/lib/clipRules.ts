/** First unlock length (ms). */
export const INITIAL_CLIP_MS = 2000;
/** Added on each Unlock / extend. */
export const EXTEND_CLIP_MS = 2000;
/** Points for a correct guess at the first unlock. */
export const INITIAL_POINTS = 10;
/** Points lost per expansion. */
export const POINTS_PER_EXTEND = 2;

/** Points for a correct guess at the current unlocked length. */
export function pointsForClip(clipMs: number): number {
  const expansions = Math.max(
    0,
    Math.round((clipMs - INITIAL_CLIP_MS) / EXTEND_CLIP_MS),
  );
  return Math.max(0, INITIAL_POINTS - POINTS_PER_EXTEND * expansions);
}

export function formatClipSeconds(clipMs: number): string {
  const s = clipMs / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
