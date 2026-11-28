/** First unlock length (ms). */
export const INITIAL_CLIP_MS = 2000;
/**
 * @deprecated First-step size only — later unlocks grow (2n seconds).
 * Prefer nextExtendDeltaMs / clipMsForExpansions.
 */
export const EXTEND_CLIP_MS = 2000;

/** Starting points before any Unlock. */
export const INITIAL_POINTS = 10;
/** Floor — participants always keep at least this many points. */
export const MIN_POINTS = 2;
/** Cost of the first Unlock press. */
export const FIRST_EXTEND_COST = 2;
/** Cost of each Unlock after the first. */
export const LATER_EXTEND_COST = 1;
/** Max segment markers per track (= max Unlock presses that stay ≥ MIN_POINTS). */
export const MAX_SEGMENTS = 7;
/** Max Unlock presses (segmented or not) before floor. */
export const MAX_EXTENDS = MAX_SEGMENTS;

/** @deprecated Prefer FIRST_EXTEND_COST / LATER_EXTEND_COST. */
export const POINTS_PER_EXTEND = FIRST_EXTEND_COST;

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
  return [...new Set(ms)].sort((a, b) => a - b).slice(0, MAX_SEGMENTS);
}

/** Points deducted by the next Unlock (the one about to be pressed). */
export function nextExtendCost(extendCount: number): number {
  const n = Math.max(0, Math.floor(extendCount));
  if (n >= MAX_EXTENDS) return 0;
  return n === 0 ? FIRST_EXTEND_COST : LATER_EXTEND_COST;
}

/**
 * Total points deducted after `extendCount` Unlock presses.
 * First costs 2, each later costs 1 → total = extendCount + 1 (for n≥1).
 */
export function deductedForExtends(extendCount: number): number {
  const n = Math.max(0, Math.floor(extendCount));
  if (n <= 0) return 0;
  return FIRST_EXTEND_COST + LATER_EXTEND_COST * (n - 1);
}

/** Points for a correct guess after `extendCount` Unlock presses (floor MIN_POINTS). */
export function pointsForExtends(extendCount: number): number {
  return Math.max(MIN_POINTS, INITIAL_POINTS - deductedForExtends(extendCount));
}

/**
 * Points for a correct guess at the current unlocked length.
 * Prefer `extendCount` when known; else derive from clip length.
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

export type NextClipOpts = {
  segmentPointsMs?: number[] | null;
  /** Full cropped clip length; last non-segmented unlock jumps here. */
  durationMs?: number | null;
  /** Unlocks already applied this round (before the upcoming press). */
  extendCount?: number | null;
};

/**
 * Next unlocked length.
 * - Segmented: jump to next segment point (max 7). After the last point, jump
 *   to full duration when known.
 * - Non-segmented: progressive +seconds until the last allowed Unlock, which
 *   plays the entire track (no reveal).
 */
export function nextClipMs(
  clipMs: number,
  segmentPointsMsOrOpts?: number[] | null | NextClipOpts,
  maybeDuration?: number | null,
  maybeExtendCount?: number | null,
): number {
  const opts: NextClipOpts =
    segmentPointsMsOrOpts != null &&
    typeof segmentPointsMsOrOpts === "object" &&
    !Array.isArray(segmentPointsMsOrOpts)
      ? segmentPointsMsOrOpts
      : {
          segmentPointsMs: segmentPointsMsOrOpts as number[] | null | undefined,
          durationMs: maybeDuration,
          extendCount: maybeExtendCount,
        };

  const current = Math.max(0, Math.round(clipMs));
  const points = normalizeSegmentPointsMs(opts.segmentPointsMs ?? []);
  const duration =
    opts.durationMs != null && Number.isFinite(Number(opts.durationMs))
      ? Math.max(0, Math.round(Number(opts.durationMs)))
      : null;
  const extendCount = Math.max(0, Math.floor(Number(opts.extendCount ?? 0)));
  const nextCount = extendCount + 1;

  if (points.length > 0) {
    const nextPoint = points.find((p) => p > current);
    if (nextPoint != null) {
      if (duration != null) return Math.min(nextPoint, duration);
      return nextPoint;
    }
    // Past last segment — finish the clip if we know its length.
    if (duration != null && duration > current) return duration;
    if (duration != null) return duration;
    return current + nextExtendDeltaMs(current);
  }

  // Non-segmented progressive, with a final "full track" step.
  if (duration != null && duration <= current) return duration;

  const progressive = current + nextExtendDeltaMs(current);
  const forceFull =
    nextCount >= MAX_EXTENDS ||
    (duration != null && progressive >= duration);

  if (forceFull && duration != null) return duration;
  if (duration != null) return Math.min(progressive, duration);
  return progressive;
}

/** Delta for the Unlock button label / extend route. */
export function nextExtendDeltaMsForTrack(
  clipMs: number,
  segmentPointsMs?: number[] | null,
  durationMs?: number | null,
  extendCount?: number | null,
): number {
  return Math.max(
    0,
    nextClipMs(clipMs, {
      segmentPointsMs,
      durationMs,
      extendCount,
    }) - Math.round(clipMs),
  );
}

/** True when another Unlock would still lengthen the clip. */
export function canExtendClip(
  clipMs: number,
  opts: NextClipOpts = {},
): boolean {
  const extendCount = Math.max(0, Math.floor(Number(opts.extendCount ?? 0)));
  if (extendCount >= MAX_EXTENDS) return false;
  return nextExtendDeltaMsForTrack(
    clipMs,
    opts.segmentPointsMs,
    opts.durationMs,
    extendCount,
  ) > 0;
}

export function formatClipSeconds(clipMs: number): string {
  const s = clipMs / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
