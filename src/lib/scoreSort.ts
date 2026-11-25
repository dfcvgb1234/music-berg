import type { ParticipantView } from "@/lib/quiz";

/** Highest score first; stable tie-break by id. */
export function sortByScoreDesc(
  participants: ParticipantView[],
): ParticipantView[] {
  return [...participants].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
}
