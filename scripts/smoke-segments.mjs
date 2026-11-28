/**
 * Smoke: segment unlock + scoring floor (no DB / browser).
 * Run: node scripts/smoke-segments.mjs
 */
import assert from "node:assert/strict";

const INITIAL_CLIP_MS = 2000;
const INITIAL_POINTS = 10;
const MIN_POINTS = 2;
const FIRST_EXTEND_COST = 2;
const LATER_EXTEND_COST = 1;
const MAX_SEGMENTS = 7;
const MAX_EXTENDS = 7;

function normalizeSegmentPointsMs(raw) {
  let values = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
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

function expansionsForClip(clipMs) {
  const ms = Math.max(INITIAL_CLIP_MS, Math.round(clipMs));
  let n = 0;
  const clipMsForExpansions = (k) => INITIAL_CLIP_MS + 1000 * k * (k + 1);
  while (clipMsForExpansions(n + 1) <= ms) n += 1;
  return n;
}

function nextExtendDeltaMs(clipMs) {
  const next = expansionsForClip(clipMs) + 1;
  return 2 * next * 1000;
}

function nextExtendCost(extendCount) {
  const n = Math.max(0, Math.floor(extendCount));
  if (n >= MAX_EXTENDS) return 0;
  return n === 0 ? FIRST_EXTEND_COST : LATER_EXTEND_COST;
}

function deductedForExtends(extendCount) {
  const n = Math.max(0, Math.floor(extendCount));
  if (n <= 0) return 0;
  return FIRST_EXTEND_COST + LATER_EXTEND_COST * (n - 1);
}

function pointsForExtends(extendCount) {
  return Math.max(MIN_POINTS, INITIAL_POINTS - deductedForExtends(extendCount));
}

function nextClipMs(clipMs, opts = {}) {
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
      return duration != null ? Math.min(nextPoint, duration) : nextPoint;
    }
    if (duration != null) return Math.max(duration, current);
    return current + nextExtendDeltaMs(current);
  }

  if (duration != null && duration <= current) return duration;
  const progressive = current + nextExtendDeltaMs(current);
  const forceFull =
    nextCount >= MAX_EXTENDS || (duration != null && progressive >= duration);
  if (forceFull && duration != null) return duration;
  if (duration != null) return Math.min(progressive, duration);
  return progressive;
}

function remapSegmentsToCrop(absoluteSec, startSec, endSec) {
  return [
    ...new Set(
      absoluteSec
        .map((t) => Math.round((t - startSec) * 1000) / 1000)
        .filter((t) => t > 0.05 && t < endSec - startSec - 0.05),
    ),
  ].sort((a, b) => a - b);
}

// Scoring: start 10, first -2 then -1, floor 2
assert.equal(pointsForExtends(0), 10);
assert.equal(nextExtendCost(0), 2);
assert.equal(pointsForExtends(1), 8);
assert.equal(nextExtendCost(1), 1);
assert.equal(pointsForExtends(2), 7);
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 6, 7].map(pointsForExtends),
  [10, 8, 7, 6, 5, 4, 3, 2],
);
assert.equal(pointsForExtends(8), 2); // floor
assert.equal(nextExtendCost(7), 0);

// Segment cap
assert.equal(
  normalizeSegmentPointsMs([1, 2, 3, 4, 5, 6, 7, 8, 9]).length,
  MAX_SEGMENTS,
);

// Segment jumps
const segs = [5000, 12000, 20000];
assert.equal(nextClipMs(2000, { segmentPointsMs: segs, extendCount: 0 }), 5000);
assert.equal(nextClipMs(5000, { segmentPointsMs: segs, extendCount: 1 }), 12000);

// Non-segmented: progressive then full track on last extend
const dur = 30000;
assert.equal(
  nextClipMs(2000, { durationMs: dur, extendCount: 0 }),
  4000,
);
assert.equal(
  nextClipMs(2000, { durationMs: dur, extendCount: 6 }),
  dur,
); // 7th unlock = full
assert.equal(
  nextClipMs(14000, { durationMs: 16000, extendCount: 2 }),
  16000,
); // progressive would overshoot → full

// Crop remap
assert.deepEqual(remapSegmentsToCrop([10, 15, 25], 8, 20), [2, 7]);

console.log("smoke-segments: ok");
