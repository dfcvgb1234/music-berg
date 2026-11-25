/** First unlock length (ms). */
export const INITIAL_CLIP_MS = 2000;
/**
 * @deprecated First-step size only — later unlocks grow (2n seconds).
 * Prefer nextExtendDeltaMs / clipMsForExpansions.
 */
export const EXTEND_CLIP_MS = 2000;
/** Points for a correct guess at the first unlock. */
export const INITIAL_POINTS = 10;
/** Points lost per expansion. */
export const POINTS_PER_EXTEND = 2;

/**
 * Unlocked length after `n` expansions.
 * n=0 → 2s; each nth extension adds 2n seconds (+2, +4, +6, …).
 */
export function clipMsForExpansions(n: number): number {
  const k = Math.max(0, Math.floor(n));
  return INITIAL_CLIP_MS + 1000 * k * (k + 1);
}

/** How many expansions produced the current unlocked length. */
export function expansionsForClip(clipMs: number): number {
  const ms = Math.max(INITIAL_CLIP_MS, Math.round(clipMs));
  let n = 0;
  while (clipMsForExpansions(n + 1) <= ms) n += 1;
  return n;
}

/** Milliseconds added by the next Unlock from the current clip length. */
export function nextExtendDeltaMs(clipMs: number): number {
  const next = expansionsForClip(clipMs) + 1;
  return 2 * next * 1000;
}

/** Points for a correct guess at the current unlocked length. */
export function pointsForClip(clipMs: number): number {
  const expansions = expansionsForClip(clipMs);
  return Math.max(0, INITIAL_POINTS - POINTS_PER_EXTEND * expansions);
}

export function formatClipSeconds(clipMs: number): string {
  const s = clipMs / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
