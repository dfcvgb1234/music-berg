"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type TemplateSong = { id: string; displayName: string; sortOrder: number };
type Template = {
  id: string;
  name: string;
  songCount: number;
  songs: TemplateSong[];
};

type SongDraft = { key: string; name: string; file: File | null };

export function Landing() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [uploadSecret, setUploadSecret] = useState("local-dev-upload");
  const [songs, setSongs] = useState<SongDraft[]>([
    { key: "1", name: "", file: null },
  ]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await fetch("/api/templates", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { templates: Template[] };
    setTemplates(data.templates);
  };

  useEffect(() => {
    void load();
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("name", templateName.trim());
      for (const song of songs) {
        if (!song.name.trim() || !song.file) {
          throw new Error("Each song needs a display name and an MP3");
        }
        form.append("songNames", song.name.trim());
        form.append("songFiles", song.file);
      }
      const res = await fetch("/api/templates", {
        method: "POST",
        body: form,
        headers: { "x-upload-secret": uploadSecret.trim() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save template");
      setStatus(`Saved template “${data.name}”`);
      setTemplateName("");
      setSongs([{ key: String(Date.now()), name: "", file: null }]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="badge">Live party quiz</p>
        <h1 className="brand brand-xl">RiffRush</h1>
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

      <section className="panel" id="templates">
        <h2>Create a quiz template</h2>
        <p className="lead">
          Name the pack, upload MP3s, and you&apos;re ready to host anytime.
        </p>

        <form className="stack" onSubmit={onCreate}>
          <div className="field">
            <label htmlFor="template-name">Template name</label>
            <input
              id="template-name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="90s indie warm-up"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="upload-secret">Upload secret</label>
            <input
              id="upload-secret"
              type="password"
              autoComplete="off"
              value={uploadSecret}
              onChange={(e) => setUploadSecret(e.target.value)}
              placeholder="Required to create templates"
              required
            />
            <p className="muted" style={{ margin: 0 }}>
              Local default works here; on the published app use the secret you
              set for RIFFRUSH_UPLOAD_SECRET.
            </p>
          </div>

          <div className="song-rows">
            {songs.map((song, index) => (
              <div className="song-row" key={song.key}>
                <div className="field">
                  <label htmlFor={`song-name-${song.key}`}>
                    Song {index + 1} display name
                  </label>
                  <input
                    id={`song-name-${song.key}`}
                    value={song.name}
                    onChange={(e) => {
                      const next = [...songs];
                      next[index] = { ...song, name: e.target.value };
                      setSongs(next);
                    }}
                    placeholder="Artist — Title"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor={`song-file-${song.key}`}>MP3 file</label>
                  <input
                    id={`song-file-${song.key}`}
                    type="file"
                    accept="audio/mpeg,audio/mp3,.mp3,audio/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      const next = [...songs];
                      next[index] = { ...song, file };
                      setSongs(next);
                    }}
                    required
                  />
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={songs.length === 1}
                  onClick={() =>
                    setSongs(songs.filter((s) => s.key !== song.key))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() =>
                setSongs([
                  ...songs,
                  { key: String(Date.now()), name: "", file: null },
                ])
              }
            >
              Add song
            </button>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save template"}
            </button>
          </div>

          {error && <p className="error">{error}</p>}
          {status && <p className="ok-msg">{status}</p>}
        </form>

        {templates.length > 0 && (
          <div style={{ marginTop: "2rem" }}>
            <h3 className="brand brand-md" style={{ fontSize: "1.35rem" }}>
              Your templates
            </h3>
            <ul className="stack" style={{ marginTop: "0.75rem", padding: 0, listStyle: "none" }}>
              {templates.map((t) => (
                <li key={t.id} className="surface">
                  <strong>{t.name}</strong>
                  <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                    {t.songCount} song{t.songCount === 1 ? "" : "s"}
                    {t.songs.length
                      ? ` — ${t.songs.map((s) => s.displayName).join(", ")}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}
