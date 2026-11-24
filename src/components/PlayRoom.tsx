"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { ClipPlayer } from "@/components/ClipPlayer";
import { Scoreboard } from "@/components/Scoreboard";
import { useSessionStream } from "@/lib/useSessionStream";

type StoredPlayer = {
  token: string;
  participantId: string;
  displayName: string;
};

export function PlayRoom() {
  const params = useParams<{ code: string }>();
  const code = String(params.code ?? "").toUpperCase();
  const [player, setPlayer] = useState<StoredPlayer | null>(null);
  const [guess, setGuess] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem(`riffrush-player-${code}`);
    if (!raw) return;
    try {
      setPlayer(JSON.parse(raw) as StoredPlayer);
    } catch {
      setPlayer(null);
    }
  }, [code]);

  const { state, setState, connected } = useSessionStream(code, {
    enabled: Boolean(player),
  });

  const onGuess = async (e: FormEvent) => {
    e.preventDefault();
    if (!player) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await fetch(`/api/sessions/${code}/guess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-participant-token": player.token,
        },
        body: JSON.stringify({ guess }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Guess failed");
      if (data.state) setState(data.state);
      if (data.correct) {
        setFeedback(
          data.alreadyCorrect
            ? "Already locked in."
            : `Correct! +${data.points} pts`,
        );
        setGuess("");
      } else {
        setFeedback("Not quite — keep listening.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (!player) {
    return (
      <main className="shell">
        <p className="error">Join this room from Participate first.</p>
        <Link className="btn" href="/join">
          Participate
        </Link>
      </main>
    );
  }

  const me = state?.participants.find((p) => p.id === player.participantId);
  const canGuess =
    state?.status === "playing" && me && !me.guessedCorrect;

  return (
    <main className="shell">
      <div className="topbar">
        <Link href="/" className="brand brand-md">
          RiffRush
        </Link>
        <span className="badge">
          {player.displayName} · {connected ? "Live" : "…"}
        </span>
      </div>

      <div className="layout-split">
        <section className="stack">
          <div>
            <p className="muted" style={{ margin: 0 }}>
              Code {code}
            </p>
            <h1 className="brand brand-md">
              {state?.status === "finished"
                ? "Quiz finished"
                : state?.status === "playing"
                  ? "Name that track"
                  : state?.status === "revealed"
                    ? "Revealed"
                    : "Waiting for host"}
            </h1>
            {state && (
              <p className="muted">
                Song {Math.min(state.currentSongIndex + 1, state.songCount)} /{" "}
                {state.songCount}
                {state.status === "playing"
                  ? ` · hearing ${(state.clipMs / 1000).toFixed(
                      state.clipMs % 1000 === 0 ? 0 : 1,
                    )}s`
                  : ""}
              </p>
            )}
          </div>

          <div className="surface stack">
            {state?.status === "playing" && (
              <div className="wave" aria-hidden>
                <i /><i /><i /><i /><i />
              </div>
            )}

            <ClipPlayer
              code={code}
              songId={state?.currentSongId ?? null}
              clipMs={state?.clipMs ?? 1000}
              playToken={state?.playToken ?? 0}
              active={state?.status === "playing"}
              participantToken={player.token}
            />

            {state?.currentSongName && (
              <p className="ok-msg">It was: {state.currentSongName}</p>
            )}

            {canGuess ? (
              <form className="guess-form" onSubmit={onGuess}>
                <input
                  value={guess}
                  onChange={(e) => setGuess(e.target.value)}
                  placeholder="Song name"
                  aria-label="Guess the song"
                  autoComplete="off"
                />
                <button className="btn" type="submit" disabled={busy || !guess.trim()}>
                  Guess
                </button>
              </form>
            ) : me?.guessedCorrect ? (
              <p className="ok-msg">You got it — hang tight for the next track.</p>
            ) : (
              <p className="muted">
                {state?.status === "finished"
                  ? "Thanks for playing."
                  : "Host will start the next clip."}
              </p>
            )}

            {feedback && <p className="ok-msg">{feedback}</p>}
            {error && <p className="error">{error}</p>}
          </div>
        </section>

        <aside className="surface">
          <h3>Scores</h3>
          <Scoreboard
            participants={state?.participants ?? []}
            highlightId={player.participantId}
          />
        </aside>
      </div>
    </main>
  );
}
