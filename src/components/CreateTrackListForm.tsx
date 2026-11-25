"use client";

import { upload } from "@vercel/blob/client";
import { FormEvent, useEffect, useState } from "react";
import {
  AudioCropField,
  type PreparedAudio,
} from "@/components/AudioCropField";
import { TrackPicker, type PickedTrack } from "@/components/TrackPicker";
import { OPUS_MIME } from "@/lib/audioMime";
import { readApiJson } from "@/lib/readApiJson";
import { formatBytes, uploadLimits } from "@/lib/uploadLimits";

type SongDraft = {
  key: string;
  pick: PickedTrack | null;
  extraAnswers: PickedTrack[];
  audio: PreparedAudio | null;
};

type UploadMode = "blob" | "direct" | "unknown";

function allAnswerIds(pick: PickedTrack, extras: PickedTrack[]): string[] {
  return [
    ...new Set([
      pick.itunesTrackId,
      ...pick.answerIds,
      ...extras.flatMap((e) => [e.itunesTrackId, ...e.answerIds]),
    ]),
  ];
}

function safeAudioBlobPath(file: File, index: number): string {
  const lower = file.name.toLowerCase();
  const ext = lower.endsWith(".ogg")
    ? ".ogg"
    : lower.endsWith(".webm")
      ? ".webm"
      : lower.endsWith(".opus")
        ? ".opus"
        : lower.endsWith(".mp3")
          ? ".mp3"
          : ".ogg";
  const base = `song-${index + 1}${ext}`.replace(/[^\w.\-]+/g, "_");
  return `templates/${Date.now()}-${index}-${base}`.slice(0, 180);
}

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
    { key: "1", pick: null, extraAnswers: [], audio: null },
  ]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>("unknown");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/upload-mode", { cache: "no-store" });
        const data = await readApiJson<{ mode?: string }>(res);
        setUploadMode(data.mode === "blob" ? "blob" : "direct");
      } catch {
        setUploadMode("direct");
      }
    })();
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      let total = 0;
      for (const song of songs) {
        if (!song.pick || !song.audio?.file) {
          throw new Error(
            "Each song needs a track pick and a converted Opus clip",
          );
        }
        if (song.audio.file.size > uploadLimits.maxFileBytes) {
          throw new Error(
            `“${song.audio.sourceName}” is too large after encode (max ${formatBytes(uploadLimits.maxFileBytes)}).`,
          );
        }
        total += song.audio.file.size;
      }
      if (total > uploadLimits.maxTemplateAudioBytes) {
        throw new Error(
          `Track list audio too large (max ${formatBytes(uploadLimits.maxTemplateAudioBytes)} total). Use shorter clips.`,
        );
      }

      const secret = uploadSecret.trim();
      const headers: HeadersInit = {};
      if (secret) headers["x-upload-secret"] = secret;

      let res: Response;
      if (uploadMode === "blob") {
        setStatus("Uploading Opus clips…");
        const payloadSongs: Array<{
          itunesTrackId: string;
          answerIds: string[];
          blobUrl: string;
        }> = [];
        for (let i = 0; i < songs.length; i++) {
          const song = songs[i];
          const pick = song.pick!;
          const file = song.audio!.file;
          setStatus(`Uploading clip ${i + 1}/${songs.length}…`);
          const blob = await upload(safeAudioBlobPath(file, i), file, {
            access: "private",
            handleUploadUrl: "/api/blob/upload",
            headers,
            multipart: file.size > 2 * 1024 * 1024,
            contentType: file.type || OPUS_MIME,
          });
          payloadSongs.push({
            itunesTrackId: pick.itunesTrackId,
            answerIds: allAnswerIds(pick, song.extraAnswers),
            blobUrl: blob.url,
          });
        }
        setStatus("Saving track list…");
        res = await fetch("/api/templates", {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name.trim(),
            songs: payloadSongs,
          }),
        });
      } else {
        setStatus("Saving track list…");
        const form = new FormData();
        form.set("name", name.trim());
        for (const song of songs) {
          const pick = song.pick!;
          form.append("itunesTrackIds", pick.itunesTrackId);
          form.append(
            "itunesAnswerIds",
            JSON.stringify(allAnswerIds(pick, song.extraAnswers)),
          );
          form.append("songFiles", song.audio!.file);
        }
        res = await fetch("/api/templates", {
          method: "POST",
          body: form,
          headers,
        });
      }

      const data = await readApiJson<{
        error?: string;
        name?: string;
        id?: string;
        songCount?: number;
      }>(res);
      if (!res.ok) throw new Error(data.error || "Could not save track list");
      setStatus(`Saved track list “${data.name}”`);
      setName("");
      setSongs([
        { key: String(Date.now()), pick: null, extraAnswers: [], audio: null },
      ]);
      if (data.id && data.name) {
        onCreated?.({
          id: data.id,
          name: data.name,
          songCount: data.songCount ?? songs.length,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus(null);
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
        Search and pick each track (similar remasters are grouped). Optionally
        add more accepted answers, then crop and convert audio to Opus 96 kbps
        (max {formatBytes(uploadLimits.maxFileBytes)} each,{" "}
        {formatBytes(uploadLimits.maxTemplateAudioBytes)} total audio
        {uploadMode === "blob"
          ? "; uploads go directly to storage"
          : ""}
        ).
      </p>

      <div className="song-rows">
        {songs.map((song, index) => (
          <div className="song-row song-row-multi" key={song.key}>
            <TrackPicker
              id={`track-${song.key}`}
              label={`Song ${index + 1}`}
              value={song.pick}
              answers={song.extraAnswers}
              multi
              onChange={(pick) => {
                setSongs((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], pick, extraAnswers: [] };
                  return next;
                });
              }}
              onAnswersChange={(extraAnswers) => {
                setSongs((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], extraAnswers };
                  return next;
                });
              }}
              placeholder="Search title or artist…"
            />
            <AudioCropField
              id={`song-file-${song.key}`}
              label={`Song ${index + 1} audio`}
              value={song.audio}
              disabled={busy}
              onChange={(audio) => {
                setSongs((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], audio };
                  return next;
                });
              }}
            />
            <button
              type="button"
              className="btn secondary"
              disabled={songs.length === 1 || busy}
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
          disabled={busy}
          onClick={() =>
            setSongs([
              ...songs,
              {
                key: String(Date.now()),
                pick: null,
                extraAnswers: [],
                audio: null,
              },
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
          disabled={
            busy ||
            uploadMode === "unknown" ||
            songs.some((s) => !s.pick || !s.audio?.file)
          }
        >
          {busy ? "Saving…" : "Save track list"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {status && <p className="ok-msg">{status}</p>}
    </form>
  );
}
