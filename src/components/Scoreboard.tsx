"use client";

import type { ParticipantView } from "@/lib/quiz";

export function Scoreboard({
  participants,
  highlightId,
}: {
  participants: ParticipantView[];
  highlightId?: string | null;
}) {
  if (participants.length === 0) {
    return null;
  }

  return (
    <ol className="scoreboard">
      {participants.map((p, i) => (
        <li
          key={p.id}
          className={
            p.id === highlightId
              ? "score-row me"
              : p.guessedCorrect
                ? "score-row ok"
                : p.lockedOut
                  ? "score-row locked"
                  : "score-row"
          }
        >
          <span className="rank">{i + 1}</span>
          <span className="name">
            {p.displayName}
            {p.guessedCorrect ? " ✓" : p.lockedOut ? " ✕" : ""}
          </span>
          <span className="pts">{p.score}</span>
        </li>
      ))}
    </ol>
  );
}
