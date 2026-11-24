"use client";

import Link from "next/link";

export function Landing() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="badge">Live party quiz</p>
        <h1 className="brand brand-xl">Bergs Music</h1>
        <p className="tagline">
          Drop a one-second riff. Stretch the clip. Race the room to name the
          track.
        </p>
        <div className="actions">
          <Link className="btn" href="/join">
            Participate
          </Link>
          <Link className="btn secondary" href="/host">
            Start new quiz
          </Link>
        </div>
      </section>
    </main>
  );
}
