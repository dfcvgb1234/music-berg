export function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function answersMatch(guess: string, answer: string): boolean {
  const g = normalizeAnswer(guess);
  const a = normalizeAnswer(answer);
  if (!g || !a) return false;
  return g === a || a.includes(g) || g.includes(a);
}

export {
  EXTEND_CLIP_MS,
  FIRST_EXTEND_COST,
  INITIAL_CLIP_MS,
  INITIAL_POINTS,
  LATER_EXTEND_COST,
  MAX_EXTENDS,
  MAX_SEGMENTS,
  MIN_POINTS,
  POINTS_PER_EXTEND,
  canExtendClip,
  clipMsForExpansions,
  deductedForExtends,
  expansionsForClip,
  formatClipSeconds,
  nextClipMs,
  nextExtendCost,
  nextExtendDeltaMs,
  nextExtendDeltaMsForTrack,
  normalizeSegmentPointsMs,
  pointsForClip,
  pointsForExtends,
} from "@/lib/clipRules";
