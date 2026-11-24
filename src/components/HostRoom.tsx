"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { HostVisualizer } from "@/components/HostVisualizer";
import { Scoreboard } from "@/components/Scoreboard";
import { useSessionStream } from "@/lib/useSessionStream";

export function HostRoom() {
  const params = useParams<{ code: string }>();
  const code = String(params.code ?? "").toUpperCase();
  const [hostToken, setHostToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setHostToken(localStorage.getItem(`riffrush-host-${code}`));
  }, [code]);

  const { state, setState, connected } = useSessionStream(code, {
    hostToken,
    enabled: Boolean(hostToken),
  });

  const action = async (path: string) => {
    if (!hostToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${code}/${path}`, {
        method: "POST",
        headers: { "x-host-token": hostToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      if (data.state) setState(data.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
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

  return (
    <main className="host-stage">
      <div className="host-stage-bg" aria-hidden>
        <div className="host-stage-grid" />
        <div className="host-stage-orb host-stage-orb-a" />
        <div className="host-stage-orb host-stage-orb-b" />
        <div className="host-stage-orb host-stage-orb-c" />
      </div>

      <header className="host-stage-top">
        <Link href="/" className="brand brand-md host-stage-brand">
          RiffRush
        </Link>
        <div className="host-code-block">
          <p className="host-code-label">Join with code</p>
          <div className="code-pill host-code-xl">{code}</div>
          <p className="muted host-code-hint">
            Players open Participate on their phone
          </p>
        </div>
        <span className="badge">{connected ? "Live" : "Reconnecting…"}</span>
      </header>

      <div className="host-stage-body">
        <section className="host-stage-center">
          {state && (
            <>
              <p className="host-round-meta">
                {state.templateName} · Song{" "}
                {Math.min(state.currentSongIndex + 1, state.songCount)} /{" "}
                {state.songCount}
                {state.status === "finished" ? " · finished" : ""}
              </p>

              {(state.hostSongName || state.currentSongName) && (
                <p className="ok-msg host-track-name">
                  {state.hostSongName || state.currentSongName}
                </p>
              )}

              <HostVisualizer
                code={code}
                songId={state.currentSongId}
                clipMs={state.clipMs}
                playToken={state.playToken}
                active={state.status === "playing"}
                hostToken={hostToken}
                busy={busy}
                onPlay={() => action("play")}
              />

              {state.status !== "finished" && (
                <div className="host-controls">
                  <button
                    className="btn host-ctrl-primary"
                    disabled={busy}
                    onClick={() => action("play")}
                  >
                    {state.status === "playing" ? "Play unlocked" : "Play 1s"}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || state.status !== "playing"}
                    onClick={() => action("extend")}
                  >
                    Unlock +2s
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || state.status === "lobby"}
                    onClick={() => action("reveal")}
                  >
                    Reveal
                  </button>
                  <button
                    className="btn danger"
                    disabled={busy}
                    onClick={() => action("next")}
                  >
                    {state.currentSongIndex + 1 >= state.songCount
                      ? "Finish"
                      : "Next song"}
                  </button>
                </div>
              )}

              {state.everyoneCorrect && state.status === "playing" && (
                <p className="ok-msg">Everyone got it — advance when ready.</p>
              )}
              {!state.everyoneCorrect &&
                state.participants.length > 0 &&
                state.status === "playing" && (
                  <p className="muted">
                    Still guessing — unlock more of the track or reveal.
                  </p>
                )}
            </>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        <aside className="host-score-panel">
          <h3>Scores</h3>
          <p className="muted" style={{ margin: "0 0 0.75rem" }}>
            {state?.participants.length ?? 0} joined
          </p>
          <Scoreboard participants={state?.participants ?? []} />
        </aside>
      </div>
    </main>
  );
}
