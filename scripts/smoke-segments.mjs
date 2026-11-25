/**
 * Smoke: segment unlock + progressive fallback (no DB / browser).
 * Run: node scripts/smoke-segments.mjs
 */
import assert from "node:assert/strict";

const INITIAL_CLIP_MS = 2000;

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
  return [...new Set(ms)].sort((a, b) => a - b).slice(0, 40);
}

function expansionsForClip(clipMs) {
  const ms = Math.max(INITIAL_CLIP_MS, Math.round(clipMs));
  let n = 0;
  const clipMsForExpansions = (k) =>
    INITIAL_CLIP_MS + 1000 * k * (k + 1);
  while (clipMsForExpansions(n + 1) <= ms) n += 1;
  return n;
}

function nextExtendDeltaMs(clipMs) {
  const next = expansionsForClip(clipMs) + 1;
  return 2 * next * 1000;
}

function nextClipMs(clipMs, segmentPointsMs) {
  const current = Math.max(0, Math.round(clipMs));
  const points = normalizeSegmentPointsMs(segmentPointsMs ?? []);
  const nextPoint = points.find((p) => p > current);
  if (nextPoint != null) return nextPoint;
  return current + nextExtendDeltaMs(current);
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

// Progressive unchanged when no segments
assert.equal(nextClipMs(2000, []), 4000); // +2s
assert.equal(nextClipMs(4000, []), 8000); // +4s
assert.equal(nextClipMs(8000, null), 14000); // +6s

// Segment jumps
const segs = [5000, 12000, 20000];
assert.equal(nextClipMs(2000, segs), 5000);
assert.equal(nextClipMs(5000, segs), 12000);
assert.equal(nextClipMs(12000, segs), 20000);
// Past last segment → progressive from current
assert.equal(nextClipMs(20000, segs), 20000 + nextExtendDeltaMs(20000));

// Normalize / dedupe
assert.deepEqual(normalizeSegmentPointsMs([12000, 5000, 5000, -1, "x"]), [
  5000, 12000,
]);
assert.deepEqual(normalizeSegmentPointsMs("[8000, 3000]"), [3000, 8000]);

// Crop remap: absolute source markers → clip-relative
assert.deepEqual(remapSegmentsToCrop([10, 15, 25], 8, 20), [2, 7]);

console.log("smoke-segments: ok");
