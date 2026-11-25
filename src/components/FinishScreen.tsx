"use client";

import { Scoreboard } from "@/components/Scoreboard";
import type { ParticipantView } from "@/lib/quiz";
import { sortByScoreDesc } from "@/lib/scoreSort";

const PODIUM_ORDER = [1, 0, 2] as const; // visual: 2nd, 1st, 3rd

export function FinishScreen({
  participants,
  highlightId,
  title = "Finished",
}: {
  participants: ParticipantView[];
  highlightId?: string | null;
  title?: string;
}) {
  const ranked = sortByScoreDesc(participants);
  const top3 = ranked.slice(0, 3);

  return (
    <div className="finish-screen stack">
      <h1 className="brand brand-md finish-title">{title}</h1>

      {top3.length > 0 && (
        <div className="finish-podium" aria-label="Top 3">
          {PODIUM_ORDER.map((rankIndex) => {
            const p = top3[rankIndex];
            if (!p) {
              return (
                <div
                  key={`empty-${rankIndex}`}
                  className={`podium-slot podium-${rankIndex + 1} is-empty`}
                  aria-hidden
                />
              );
            }
            const place = rankIndex + 1;
            return (
              <div
                key={p.id}
                className={`podium-slot podium-${place}${
                  p.id === highlightId ? " is-me" : ""
                }`}
              >
                <div className="podium-place">{place}</div>
                <div className="podium-name">{p.displayName}</div>
                <div className="podium-score">{p.score}</div>
                <div className="podium-block" aria-hidden />
              </div>
            );
          })}
        </div>
      )}

      <div className="finish-full-list">
        <h3>Scores</h3>
        <Scoreboard
          participants={ranked}
          highlightId={highlightId}
          hideRoundMarks
        />
      </div>
    </div>
  );
}
