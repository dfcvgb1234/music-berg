"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { FinishScreen } from "@/components/FinishScreen";
import { TrackPicker, type PickedTrack } from "@/components/TrackPicker";
import { Scoreboard } from "@/components/Scoreboard";
import { formatClipSeconds, pointsForClip } from "@/lib/clipRules";
import { readApiJson } from "@/lib/readApiJson";
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
  const [pick, setPick] = useState<PickedTrack | null>(null);
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

  useEffect(() => {
    setFeedback(null);
    setError(null);
    setPick(null);
  }, [state?.currentSongIndex]);

  const onGuess = async (e: FormEvent) => {
    e.preventDefault();
    if (!player || !pick) return;
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
        body: JSON.stringify({
          itunesTrackId: pick.itunesTrackId,
          answerIds: pick.answerIds,
          label: pick.label,
        }),
      });
      const data = await readApiJson<{
        error?: string;
        correct?: boolean;
        points?: number;
        alreadyGuessed?: boolean;
        lockedOut?: boolean;
        message?: string;
        state?: NonNullable<typeof state>;
      }>(res);
      if (data.state) setState(data.state);
      if (!res.ok && !data.alreadyGuessed) {
        throw new Error(data.error || data.message || "Guess failed");
      }
      if (data.correct) {
        setFeedback(
          data.alreadyGuessed
            ? "Already locked in."
            : `Correct! +${data.points ?? 0} pts`,
        );
        setPick(null);
      } else {
        setFeedback(
          data.message || "Wrong — you're locked out for this round",
        );
        setPick(null);
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
    state?.status === "playing" &&
    me &&
    !me.guessedCorrect &&
    !me.lockedOut;
  const finished = state?.status === "finished";

  return (
    <main className="shell">
      <div className="topbar">
        <Link href="/" className="brand brand-md">
          Bergs Music
        </Link>
        <span className="badge">
          {player.displayName} · {connected ? "Live" : "…"}
        </span>
      </div>

      {finished ? (
        <FinishScreen
          participants={state.participants}
          highlightId={player.participantId}
        />
      ) : (
        <div className="layout-split">
          <section className="stack">
            <div>
              <p className="muted" style={{ margin: 0 }}>
                {code}
                {state
                  ? ` · ${Math.min(state.currentSongIndex + 1, state.songCount)}/${state.songCount}`
                  : ""}
                {state?.status === "playing"
                  ? ` · ${formatClipSeconds(state.clipMs)}s · ${pointsForClip(state.clipMs, state.extendCount)} pts`
                  : ""}
              </p>
              <h1 className="brand brand-md">
                {state?.status === "playing"
                  ? "Guess"
                  : state?.status === "revealed"
                    ? "Revealed"
                    : "Waiting"}
              </h1>
            </div>

            <div className="surface stack">
              {state?.status === "playing" && (
                <div className="wave" aria-hidden>
                  <i /><i /><i /><i /><i />
                </div>
              )}

              {state?.currentSongName && (
                <div className="reveal-card">
                  {state.currentCoverArtUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={state.currentCoverArtUrl}
                      alt=""
                      className="reveal-card-cover"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <p className="ok-msg" style={{ margin: 0 }}>
                    {state.currentSongName}
                  </p>
                </div>
              )}

              {canGuess ? (
                <form className="guess-form guess-track" onSubmit={onGuess}>
                  <TrackPicker
                    id="guess-track"
                    label="Guess"
                    value={pick}
                    onChange={setPick}
                    placeholder="Search…"
                  />
                  <button
                    className="btn"
                    type="submit"
                    disabled={busy || !pick}
                  >
                    Lock guess
                  </button>
                </form>
              ) : me?.guessedCorrect ? (
                <p className="ok-msg">Correct</p>
              ) : me?.lockedOut ? (
                <p className="error">Locked out</p>
              ) : null}

              {feedback && (
                <p
                  className={
                    feedback.startsWith("Wrong") ||
                    feedback.startsWith("No more")
                      ? "error"
                      : "ok-msg"
                  }
                >
                  {feedback}
                </p>
              )}
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
      )}
    </main>
  );
}
