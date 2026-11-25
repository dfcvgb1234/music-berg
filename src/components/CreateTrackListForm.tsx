"use client";

import { upload } from "@vercel/blob/client";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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

function newSongKey(seq: number): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}`;
  return `song-${seq}-${rand}`;
}

function emptySong(seq: number): SongDraft {
  return {
    key: newSongKey(seq),
    pick: null,
    extraAnswers: [],
    audio: null,
  };
}

export function CreateTrackListForm({
  onCreated,
  onCancel,
}: {
  onCreated?: (trackList: { id: string; name: string; songCount: number }) => void;
  onCancel?: () => void;
}) {
  const seqRef = useRef(1);
  const [name, setName] = useState("");
  const [uploadSecret, setUploadSecret] = useState("");
  const [songs, setSongs] = useState<SongDraft[]>(() => [emptySong(1)]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>("unknown");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/upload-mode", { cache: "no-store" });
        const data = await readApiJson<{ mode?: string }>(res);
        if (!cancelled) {
          setUploadMode(data.mode === "blob" ? "blob" : "direct");
        }
      } catch {
        if (!cancelled) setUploadMode("direct");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalAudioBytes = useMemo(
    () =>
      songs.reduce(
        (sum, s) => sum + (s.audio?.file?.size ?? 0),
        0,
      ),
    [songs],
  );

  const incomplete = useMemo(() => {
    const missingPick: number[] = [];
    const missingAudio: number[] = [];
    const tooLarge: number[] = [];
    songs.forEach((s, i) => {
      const n = i + 1;
      if (!s.pick) missingPick.push(n);
      else if (!s.audio?.file) missingAudio.push(n);
      else if (s.audio.file.size > uploadLimits.maxFileBytes) tooLarge.push(n);
    });
    return { missingPick, missingAudio, tooLarge };
  }, [songs]);

  const saveBlockers = useMemo(() => {
    const reasons: string[] = [];
    if (busy) reasons.push("Save in progress…");
    if (uploadMode === "unknown") {
      reasons.push("Checking upload mode…");
    }
    if (!name.trim()) reasons.push("Enter a track list name.");
    if (incomplete.missingPick.length) {
      const list = incomplete.missingPick.slice(0, 8).join(", ");
      const more =
        incomplete.missingPick.length > 8
          ? ` (+${incomplete.missingPick.length - 8} more)`
          : "";
      reasons.push(
        `Pick a Deezer track for song${incomplete.missingPick.length === 1 ? "" : "s"} ${list}${more}.`,
      );
    }
    if (incomplete.missingAudio.length) {
      const list = incomplete.missingAudio.slice(0, 8).join(", ");
      const more =
        incomplete.missingAudio.length > 8
          ? ` (+${incomplete.missingAudio.length - 8} more)`
          : "";
      reasons.push(
        `Convert audio to Opus for song${incomplete.missingAudio.length === 1 ? "" : "s"} ${list}${more} (Convert to Opus on each row).`,
      );
    }
    if (incomplete.tooLarge.length) {
      reasons.push(
        `Song${incomplete.tooLarge.length === 1 ? "" : "s"} ${incomplete.tooLarge.join(", ")} exceed ${formatBytes(uploadLimits.maxFileBytes)} after encode.`,
      );
    }
    if (totalAudioBytes > uploadLimits.maxTemplateAudioBytes) {
      reasons.push(
        `Total audio ${formatBytes(totalAudioBytes)} exceeds ${formatBytes(uploadLimits.maxTemplateAudioBytes)}.`,
      );
    }
    return reasons;
  }, [busy, uploadMode, name, incomplete, totalAudioBytes]);

  const canSave = saveBlockers.length === 0;

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) {
      setError(saveBlockers[0] ?? "Cannot save yet");
      return;
    }
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
      seqRef.current += 1;
      setSongs([emptySong(seqRef.current)]);
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

  const songStatus = (song: SongDraft) => {
    if (!song.pick && !song.audio?.file) return "Needs track + Opus convert";
    if (!song.pick) return "Needs Deezer track pick";
    if (!song.audio?.file) return "Needs Convert to Opus";
    if (song.audio.file.size > uploadLimits.maxFileBytes) {
      return `Encoded file too large (${formatBytes(song.audio.file.size)})`;
    }
    return `Ready · ${formatBytes(song.audio.file.size)}`;
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
      </div>

      <p className="muted" style={{ margin: 0 }}>
        {songs.length} song{songs.length === 1 ? "" : "s"} ·{" "}
        {formatBytes(totalAudioBytes)} /{" "}
        {formatBytes(uploadLimits.maxTemplateAudioBytes)}
      </p>

      <div className="song-rows">
        {songs.map((song, index) => {
          const ready = Boolean(song.pick && song.audio?.file);
          return (
            <div className="song-row song-row-multi" key={song.key}>
              <TrackPicker
                id={`track-${song.key}`}
                label={`Song ${index + 1}`}
                value={song.pick}
                answers={song.extraAnswers}
                multi
                onChange={(pick) => {
                  setSongs((prev) =>
                    prev.map((s) =>
                      s.key === song.key
                        ? { ...s, pick, extraAnswers: [] }
                        : s,
                    ),
                  );
                }}
                onAnswersChange={(extraAnswers) => {
                  setSongs((prev) =>
                    prev.map((s) =>
                      s.key === song.key ? { ...s, extraAnswers } : s,
                    ),
                  );
                }}
                placeholder="Search title or artist…"
              />
              <AudioCropField
                id={`song-file-${song.key}`}
                label={`Song ${index + 1} audio`}
                value={song.audio}
                disabled={busy}
                onChange={(audio) => {
                  setSongs((prev) =>
                    prev.map((s) =>
                      s.key === song.key ? { ...s, audio } : s,
                    ),
                  );
                }}
              />
              <div className="song-row-side">
                <p
                  className={ready ? "ok-msg" : "muted"}
                  style={{ margin: 0, fontSize: "0.85rem" }}
                >
                  {songStatus(song)}
                </p>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={songs.length === 1 || busy}
                  onClick={() =>
                    setSongs((prev) => prev.filter((s) => s.key !== song.key))
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => {
            seqRef.current += 1;
            setSongs((prev) => [...prev, emptySong(seqRef.current)]);
          }}
        >
          Add song
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn" type="submit" disabled={!canSave}>
          {busy ? "Saving…" : "Save track list"}
        </button>
      </div>

      {!canSave && saveBlockers.length > 0 && (
        <div className="save-blockers" role="status">
          <p className="muted" style={{ margin: "0 0 0.35rem" }}>
            Save is disabled:
          </p>
          <ul className="save-blocker-list">
            {saveBlockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {status && <p className="ok-msg">{status}</p>}
    </form>
  );
}
