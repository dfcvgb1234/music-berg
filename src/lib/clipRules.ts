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

/** Milliseconds added by the next Unlock from the current clip length (progressive). */
export function nextExtendDeltaMs(clipMs: number): number {
  const next = expansionsForClip(clipMs) + 1;
  return 2 * next * 1000;
}

/** Normalize / sanitize host-authored segment points (ms from cropped clip start). */
export function normalizeSegmentPointsMs(raw: unknown): number[] {
  let values: unknown[] = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) values = parsed;
    } catch {
      values = [];
    }
  } else if (Array.isArray(raw)) {
    values = raw;
  }
  const ms = values
    .map((v) => Math.round(Number(v)))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ms)].sort((a, b) => a - b).slice(0, 40);
}

/**
 * Next unlocked length. When segment points exist, jump to the next point
 * strictly after `clipMs`; otherwise use progressive +seconds.
 */
export function nextClipMs(
  clipMs: number,
  segmentPointsMs?: number[] | null,
): number {
  const current = Math.max(0, Math.round(clipMs));
  const points = normalizeSegmentPointsMs(segmentPointsMs ?? []);
  const nextPoint = points.find((p) => p > current);
  if (nextPoint != null) return nextPoint;
  return current + nextExtendDeltaMs(current);
}

/** Delta for the Unlock button label / extend route. */
export function nextExtendDeltaMsForTrack(
  clipMs: number,
  segmentPointsMs?: number[] | null,
): number {
  return Math.max(0, nextClipMs(clipMs, segmentPointsMs) - Math.round(clipMs));
}

/** Points for a correct guess after `extendCount` Unlock presses. */
export function pointsForExtends(extendCount: number): number {
  const n = Math.max(0, Math.floor(extendCount));
  return Math.max(0, INITIAL_POINTS - POINTS_PER_EXTEND * n);
}

/**
 * Points for a correct guess at the current unlocked length.
 * Prefer `extendCount` when known (segment jumps); else derive from clip length.
 */
export function pointsForClip(
  clipMs: number,
  extendCount?: number | null,
): number {
  if (extendCount != null && Number.isFinite(extendCount)) {
    return pointsForExtends(extendCount);
  }
  return pointsForExtends(expansionsForClip(clipMs));
}

export function formatClipSeconds(clipMs: number): string {
  const s = clipMs / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
