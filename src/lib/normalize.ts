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

/** Higher score for shorter clips when the guess lands. */
export function pointsForClip(clipMs: number): number {
  if (clipMs <= 1000) return 5;
  if (clipMs <= 3000) return 4;
  if (clipMs <= 5000) return 3;
  if (clipMs <= 7000) return 2;
  return 1;
}
