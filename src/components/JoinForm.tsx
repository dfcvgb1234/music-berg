"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { readApiJson } from "@/lib/readApiJson";
import {
  clearActivePlayer,
  clearMembershipForCode,
  getActivePlayer,
  setActivePlayer,
  type ActivePlayer,
} from "@/lib/sessionLocal";

export function JoinForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState<ActivePlayer | null>(null);
  const [checkingResume, setCheckingResume] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = getActivePlayer();
      if (!active) {
        if (!cancelled) {
          setResume(null);
          setCheckingResume(false);
        }
        return;
      }
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(active.code)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          clearMembershipForCode(active.code, { clearCreds: true });
          if (!cancelled) setResume(null);
          return;
        }
        const data = await readApiJson<{
          state?: { status?: string };
        }>(res);
        if (data.state?.status === "finished") {
          clearMembershipForCode(active.code, { clearCreds: true });
          if (!cancelled) setResume(null);
          return;
        }
        if (!cancelled) setResume(active);
      } catch {
        if (!cancelled) setResume(null);
      } finally {
        if (!cancelled) setCheckingResume(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onJoin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const clean = code.replace(/\D/g, "").slice(0, 6);
    try {
      const res = await fetch(`/api/sessions/${clean}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not join");
      setActivePlayer({
        code: data.code,
        token: data.token,
        participantId: data.participantId,
        displayName: data.displayName,
      });
      router.push(`/play/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  const onResume = () => {
    if (!resume) return;
    setBusy(true);
    router.push(`/play/${resume.code}`);
  };

  return (
    <main className="shell">
      <div className="topbar">
        <Link href="/" className="brand brand-md">
          Bergs Music
        </Link>
        <Link href="/host" className="btn secondary">
          Host a quiz
        </Link>
      </div>

      <section className="stack" style={{ maxWidth: 440 }}>
        <h1 className="brand brand-md">Participate</h1>

        {!checkingResume && resume && (
          <div className="surface stack resume-card">
            <p className="muted" style={{ margin: 0 }}>
              You still have an open quiz as{" "}
              <strong>{resume.displayName}</strong> ({resume.code}).
            </p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={onResume}
            >
              Resume game
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                clearActivePlayer({ clearCreds: true });
                setResume(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        <form className="stack" onSubmit={onJoin}>
          <div className="field">
            <label htmlFor="code">Quiz code</label>
            <input
              id="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="123456"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 24))}
              placeholder="Alex"
              required
            />
          </div>
          <button
            className="btn"
            type="submit"
            disabled={busy || code.length !== 6}
          >
            {busy ? "Joining…" : "Join quiz"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </section>
    </main>
  );
}
