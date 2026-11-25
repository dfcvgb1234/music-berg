"use client";

import type { ParticipantView } from "@/lib/quiz";
import { sortByScoreDesc } from "@/lib/scoreSort";

export function Scoreboard({
  participants,
  highlightId,
  hideRoundMarks = false,
}: {
  participants: ParticipantView[];
  highlightId?: string | null;
  /** Hide ✓/✕ round marks (e.g. finish screen). */
  hideRoundMarks?: boolean;
}) {
  const ranked = sortByScoreDesc(participants);
  if (ranked.length === 0) {
    return null;
  }

  return (
    <ol className="scoreboard">
      {ranked.map((p, i) => (
        <li
          key={p.id}
          className={
            p.id === highlightId
              ? "score-row me"
              : !hideRoundMarks && p.guessedCorrect
                ? "score-row ok"
                : !hideRoundMarks && p.lockedOut
                  ? "score-row locked"
                  : "score-row"
          }
        >
          <span className="rank">{i + 1}</span>
          <span className="name">
            {p.displayName}
            {!hideRoundMarks && p.guessedCorrect
              ? " ✓"
              : !hideRoundMarks && p.lockedOut
                ? " ✕"
                : ""}
          </span>
          <span className="pts">{p.score}</span>
        </li>
      ))}
    </ol>
  );
}
