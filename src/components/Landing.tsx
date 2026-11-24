"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { readApiJson } from "@/lib/readApiJson";
import { formatBytes, uploadLimits } from "@/lib/uploadLimits";

type Template = {
  id: string;
  name: string;
  songCount: number;
};

type SongDraft = { key: string; name: string; file: File | null };

function isLocalHost(): boolean {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

export function Landing() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [uploadSecret, setUploadSecret] = useState("");
  const [songs, setSongs] = useState<SongDraft[]>([
    { key: "1", name: "", file: null },
  ]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isLocalHost()) setUploadSecret("local-dev-upload");
  }, []);

  const load = async () => {
    const res = await fetch("/api/templates", { cache: "no-store" });
    if (!res.ok) return;
    try {
      const data = await readApiJson<{ templates: Template[] }>(res);
      setTemplates(data.templates);
    } catch {
      // ignore list refresh errors
    }
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
      let total = 0;
      for (const song of songs) {
        if (!song.name.trim() || !song.file) {
          throw new Error("Each song needs a display name and an MP3");
        }
        if (song.file.size > uploadLimits.maxFileBytes) {
          throw new Error(
            `“${song.file.name}” is too large (max ${formatBytes(uploadLimits.maxFileBytes)} per file).`,
          );
        }
        total += song.file.size;
      }
      if (total > uploadLimits.maxRequestBytes) {
        throw new Error(
          `Total upload too large (max ${formatBytes(uploadLimits.maxRequestBytes)}). Use shorter clips.`,
        );
      }
      if (songs.length > uploadLimits.maxSongsPerTemplate) {
        throw new Error(
          `At most ${uploadLimits.maxSongsPerTemplate} songs per template`,
        );
      }

      const form = new FormData();
      form.set("name", templateName.trim());
      for (const song of songs) {
        form.append("songNames", song.name.trim());
        form.append("songFiles", song.file!);
      }
      const res = await fetch("/api/templates", {
        method: "POST",
        body: form,
        headers: { "x-upload-secret": uploadSecret.trim() },
      });
      const data = await readApiJson<{ error?: string; name?: string }>(res);
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
          Name the pack, upload short MP3s (max{" "}
          {formatBytes(uploadLimits.maxFileBytes)} each,{" "}
          {formatBytes(uploadLimits.maxRequestBytes)} total), and you&apos;re
          ready to host anytime.
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
              On the published app, enter the upload secret you configured for
              this app. Locally it fills in automatically.
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
