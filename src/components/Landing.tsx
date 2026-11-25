"use client";

import Link from "next/link";

export function Landing() {
  return (
    <main className="shell">
      <section className="hero">
        <h1 className="brand brand-xl">Bergs Music</h1>
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
