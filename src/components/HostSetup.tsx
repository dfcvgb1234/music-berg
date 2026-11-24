"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

type Template = {
  id: string;
  name: string;
  songCount: number;
};

export function HostSetup() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/templates", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { templates: Template[] };
      setTemplates(data.templates);
      if (data.templates[0]) setTemplateId(data.templates[0].id);
    })();
  }, []);

  const onStart = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start quiz");
      localStorage.setItem(`riffrush-host-${data.code}`, data.hostToken);
      router.push(`/host/${data.code}`);
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
        <Link href="/join" className="btn secondary">
          Participate instead
        </Link>
      </div>

      <section className="stack" style={{ maxWidth: 520 }}>
        <h1 className="brand brand-md">Start a new quiz</h1>
        <p className="muted">
          Pick a template. You&apos;ll get a 6-digit code for the room.
        </p>

        {templates.length === 0 ? (
          <div className="surface">
            <p className="muted" style={{ margin: 0 }}>
              No templates yet. Create one on the frontpage first.
            </p>
            <Link href="/#templates" className="btn" style={{ marginTop: "1rem", display: "inline-flex" }}>
              Create template
            </Link>
          </div>
        ) : (
          <form className="stack" onSubmit={onStart}>
            <div className="field">
              <label htmlFor="template">Template</label>
              <select
                id="template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                required
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.songCount} songs)
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" type="submit" disabled={busy || !templateId}>
              {busy ? "Starting…" : "Create session"}
            </button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </section>
    </main>
  );
}
