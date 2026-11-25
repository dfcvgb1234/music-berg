"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FinishScreen } from "@/components/FinishScreen";
import {
  HostVisualizer,
  type HostVisualizerHandle,
} from "@/components/HostVisualizer";
import { Scoreboard } from "@/components/Scoreboard";
import { formatClipSeconds, pointsForClip } from "@/lib/clipRules";
import { useSessionStream } from "@/lib/useSessionStream";

export function HostRoom() {
  const params = useParams<{ code: string }>();
  const code = String(params.code ?? "").toUpperCase();
  const [hostToken, setHostToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vizRef = useRef<HostVisualizerHandle | null>(null);

  useEffect(() => {
    setHostToken(localStorage.getItem(`riffrush-host-${code}`));
  }, [code]);

  const { state, setState, connected } = useSessionStream(code, {
    hostToken,
    enabled: Boolean(hostToken),
  });

  const run = (path: "play" | "extend" | "reveal" | "next") => {
    void vizRef.current?.runFromGesture(path);
  };

  if (!hostToken) {
    return (
      <main className="shell">
        <p className="error">
          Missing host credentials for this code. Start a new quiz from the host
          page.
        </p>
        <Link className="btn" href="/host">
          Start new quiz
        </Link>
      </main>
    );
  }

  const pointsNow =
    state?.status === "playing"
      ? (state.pointsNow ?? pointsForClip(state.clipMs, state.extendCount))
      : null;
  const nextCost =
    state?.status === "playing" ? (state.nextExtendCost ?? 0) : 0;
  const finished = state?.status === "finished";

  return (
    <main className="host-stage">
      <header className="host-stage-top">
        <Link href="/" className="brand brand-md host-stage-brand">
          Bergs Music
        </Link>
        <div className="host-code-block">
          <p className="host-code-label">Join with code</p>
          <div className="code-pill host-code-xl">{code}</div>
        </div>
        <span className="badge">{connected ? "Live" : "Reconnecting…"}</span>
      </header>

      {finished ? (
        <div className="host-stage-body host-stage-finish">
          <div className="finish-wrap">
            <FinishScreen participants={state.participants} />
            <div className="actions finish-actions">
              <Link className="btn" href="/host">
                New quiz
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="host-stage-body">
          <section className="host-stage-center">
            {state && (
              <>
                <p className="host-round-meta">
                  {state.templateName} · Song{" "}
                  {Math.min(state.currentSongIndex + 1, state.songCount)} /{" "}
                  {state.songCount}
                  {pointsNow != null ? ` · ${pointsNow} pts` : ""}
                </p>

                {state.revealAnswer && state.currentSongName && (
                  <p className="ok-msg host-track-name">
                    Revealed: {state.currentSongName}
                  </p>
                )}

                <HostVisualizer
                  ref={vizRef}
                  code={code}
                  songId={state.currentSongId}
                  clipMs={state.clipMs}
                  playToken={state.playToken}
                  active={
                    state.status === "playing" || state.status === "revealed"
                  }
                  revealed={state.status === "revealed"}
                  coverArtUrl={state.currentCoverArtUrl}
                  hostToken={hostToken}
                  busy={busy}
                  onState={setState}
                  onBusy={setBusy}
                  onError={setError}
                />

                <div className="host-controls">
                  <button
                    className="btn host-ctrl-primary"
                    disabled={busy}
                    onClick={() => run("play")}
                  >
                    {state.status === "playing" ? "Play unlocked" : "Play 2s"}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={
                      busy ||
                      state.status !== "playing" ||
                      state.canExtend === false ||
                      !(state.nextExtendMs > 0)
                    }
                    onClick={() => run("extend")}
                  >
                    Unlock +
                    {formatClipSeconds(state.nextExtendMs ?? 0)}s
                    {nextCost > 0 ? ` (−${nextCost})` : ""}
                    {state.segmentPointsMs?.length
                      ? " · segment"
                      : state.durationMs != null &&
                          state.clipMs + (state.nextExtendMs ?? 0) >=
                            state.durationMs
                        ? " · full"
                        : ""}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || state.status === "lobby"}
                    onClick={() => run("reveal")}
                  >
                    Reveal
                  </button>
                  <button
                    className="btn danger"
                    disabled={busy}
                    onClick={() => run("next")}
                  >
                    {state.currentSongIndex + 1 >= state.songCount
                      ? "Finish"
                      : "Next song"}
                  </button>
                </div>

                {state.everyoneCorrect && state.status === "playing" && (
                  <p className="ok-msg">Everyone got it</p>
                )}
              </>
            )}
            {error && <p className="error">{error}</p>}
          </section>

          <aside className="host-score-panel">
            <h3>Scores</h3>
            <Scoreboard participants={state?.participants ?? []} />
          </aside>
        </div>
      )}
    </main>
  );
}
