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
    return (
      <p className="muted" style={{ margin: 0 }}>
        Waiting for players…
      </p>
    );
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
                : "score-row"
          }
        >
          <span className="rank">{i + 1}</span>
          <span className="name">
            {p.displayName}
            {p.guessedCorrect ? " ✓" : ""}
          </span>
          <span className="pts">{p.score}</span>
        </li>
      ))}
    </ol>
  );
}
