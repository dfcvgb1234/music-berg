"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export function JoinForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      localStorage.setItem(`riffrush-player-${data.code}`, JSON.stringify({
        token: data.token,
        participantId: data.participantId,
        displayName: data.displayName,
      }));
      router.push(`/play/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <div className="topbar">
        <Link href="/" className="brand brand-md">
          RiffRush
        </Link>
        <Link href="/host" className="btn secondary">
          Host a quiz
        </Link>
      </div>

      <section className="stack" style={{ maxWidth: 440 }}>
        <h1 className="brand brand-md">Participate</h1>
        <p className="muted">Enter the 6-digit code from the host.</p>
        <form className="stack" onSubmit={onJoin}>
          <div className="field">
            <label htmlFor="code">Quiz code</label>
            <input
              id="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
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
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Joining…" : "Join quiz"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </section>
    </main>
  );
}
