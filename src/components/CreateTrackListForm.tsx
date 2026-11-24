"use client";

import { FormEvent, useState } from "react";
import { TrackPicker, type PickedTrack } from "@/components/TrackPicker";
import { readApiJson } from "@/lib/readApiJson";
import { formatBytes, uploadLimits } from "@/lib/uploadLimits";

type SongDraft = {
  key: string;
  pick: PickedTrack | null;
  file: File | null;
};

export function CreateTrackListForm({
  onCreated,
  onCancel,
}: {
  onCreated?: (trackList: { id: string; name: string; songCount: number }) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [uploadSecret, setUploadSecret] = useState("");
  const [songs, setSongs] = useState<SongDraft[]>([
    { key: "1", pick: null, file: null },
  ]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      let total = 0;
      for (const song of songs) {
        if (!song.pick || !song.file) {
          throw new Error("Each song needs a track pick and an MP3");
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
          `At most ${uploadLimits.maxSongsPerTemplate} songs per track list`,
        );
      }

      const form = new FormData();
      form.set("name", name.trim());
      for (const song of songs) {
        form.append("itunesTrackIds", song.pick!.itunesTrackId);
        form.append("songFiles", song.file!);
      }
      const headers: HeadersInit = {};
      const secret = uploadSecret.trim();
      if (secret) headers["x-upload-secret"] = secret;
      const res = await fetch("/api/templates", {
        method: "POST",
        body: form,
        headers,
      });
      const data = await readApiJson<{
        error?: string;
        name?: string;
        id?: string;
        songCount?: number;
      }>(res);
      if (!res.ok) throw new Error(data.error || "Could not save track list");
      setStatus(`Saved track list “${data.name}”`);
      setName("");
      setSongs([{ key: String(Date.now()), pick: null, file: null }]);
      if (data.id && data.name) {
        onCreated?.({
          id: data.id,
          name: data.name,
          songCount: data.songCount ?? songs.length,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={onCreate}>
      <div className="field">
        <label htmlFor="track-list-name">Track list name</label>
        <input
          id="track-list-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
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
          placeholder="Required on the published app"
        />
        <p className="muted" style={{ margin: 0 }}>
          Enter the upload secret configured for this app. Leave blank only for
          local development.
        </p>
      </div>

      <p className="muted" style={{ margin: 0 }}>
        Search and pick each track, then upload a short MP3 (max{" "}
        {formatBytes(uploadLimits.maxFileBytes)} each,{" "}
        {formatBytes(uploadLimits.maxRequestBytes)} total).
      </p>

      <div className="song-rows">
        {songs.map((song, index) => (
          <div className="song-row" key={song.key}>
            <TrackPicker
              id={`track-${song.key}`}
              label={`Song ${index + 1}`}
              value={song.pick}
              onChange={(pick) => {
                const next = [...songs];
                next[index] = { ...song, pick };
                setSongs(next);
              }}
              placeholder="Search title or artist…"
            />
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
              onClick={() => setSongs(songs.filter((s) => s.key !== song.key))}
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
              { key: String(Date.now()), pick: null, file: null },
            ])
          }
        >
          Add song
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          className="btn"
          type="submit"
          disabled={busy || songs.some((s) => !s.pick || !s.file)}
        >
          {busy ? "Saving…" : "Save track list"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {status && <p className="ok-msg">{status}</p>}
    </form>
  );
}
