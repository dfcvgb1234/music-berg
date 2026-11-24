"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ClipPlayer } from "@/components/ClipPlayer";
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

  const clipLabel = useMemo(() => {
    if (!state) return "";
    const secs = state.clipMs / 1000;
    return `${secs.toFixed(secs % 1 === 0 ? 0 : 1)}s clip`;
  }, [state]);

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
    <main className="shell">
      <div className="topbar">
        <Link href="/" className="brand brand-md">
          RiffRush
        </Link>
        <span className="badge">{connected ? "Live" : "Reconnecting…"}</span>
      </div>

      <div className="layout-split">
        <section className="stack">
          <div>
            <p className="muted" style={{ margin: 0 }}>
              Room code
            </p>
            <div className="code-pill">{code}</div>
            <p className="muted">
              Players join at Participate with this code.
            </p>
          </div>

          {state && (
            <div className="surface stack">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                <div>
                  <h3 style={{ margin: 0 }}>{state.templateName}</h3>
                  <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                    Song {Math.min(state.currentSongIndex + 1, state.songCount)} of{" "}
                    {state.songCount}
                    {state.status === "finished" ? " — finished" : ""}
                  </p>
                </div>
                <div className="badge">{clipLabel || "Ready"}</div>
              </div>

              {state.status === "playing" && (
                <div className="wave" aria-hidden>
                  <i /><i /><i /><i /><i />
                </div>
              )}

              <div className="clip-meter" aria-hidden>
                <span
                  style={{
                    width: `${Math.min(100, (state.clipMs / 15000) * 100)}%`,
                  }}
                />
              </div>

              {(state.hostSongName || state.currentSongName) && (
                <p className="ok-msg" style={{ fontSize: "1.15rem" }}>
                  Track: {state.hostSongName || state.currentSongName}
                </p>
              )}

              <ClipPlayer
                code={code}
                songId={state.currentSongId}
                clipMs={state.clipMs}
                playToken={state.playToken}
                active={state.status === "playing"}
                hostToken={hostToken}
              />

              {state.status !== "finished" && (
                <div className="actions">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => action("play")}
                  >
                    {state.status === "playing" ? "Replay 1s" : "Play 1s"}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || state.status !== "playing"}
                    onClick={() => action("extend")}
                  >
                    Extend +2s
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || state.status === "lobby"}
                    onClick={() => action("reveal")}
                  >
                    Reveal title
                  </button>
                  <button
                    className="btn danger"
                    disabled={busy}
                    onClick={() => action("next")}
                  >
                    {state.currentSongIndex + 1 >= state.songCount
                      ? "Finish quiz"
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
                    Some players still guessing — extend the clip or reveal.
                  </p>
                )}
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </section>

        <aside className="surface">
          <h3>Scores</h3>
          <Scoreboard participants={state?.participants ?? []} />
        </aside>
      </div>
    </main>
  );
}
