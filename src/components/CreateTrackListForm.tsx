"use client";

import { upload } from "@vercel/blob/client";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioCropField,
  remapSegmentsToCrop,
  type PreparedAudio,
} from "@/components/AudioCropField";
import { TrackPicker, hitToPick, type PickedTrack } from "@/components/TrackPicker";
import { YouTubeUrlImport } from "@/components/YouTubeUrlImport";
import { OPUS_MIME } from "@/lib/audioMime";
import { probeAudioDuration } from "@/lib/clientOpusEncode";
import { readApiJson } from "@/lib/readApiJson";
import { formatBytes, uploadLimits } from "@/lib/uploadLimits";
import { classifyYoutubeUrl } from "@/lib/youtubeUrl";
import {
  downloadYoutubeAudioClient,
  fetchYoutubeImportStatus,
  resolveYoutubePlaylistClient,
  type YoutubeImportStatus,
} from "@/lib/youtubeClient";

type SongDraft = {
  key: string;
  pick: PickedTrack | null;
  extraAnswers: PickedTrack[];
  audio: PreparedAudio | null;
  /** Absolute segment times on the visualized file (source or existing clip). */
  segmentPointsSec: number[];
  /** Cropped clip length in ms (for non-segmented full-track unlock). */
  durationMs?: number | null;
  /** Existing DB song — keep audio when `audio` is null. */
  existingSongId?: string;
  existingClip?: { file: File; label: string } | null;
  /** Inject downloaded YouTube audio into AudioCropField. */
  injectFile?: { file: File; token: number } | null;
};

type UploadMode = "r2" | "blob" | "direct" | "unknown";

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
    segmentPointsSec: [],
  };
}

function segmentPointsMsFromDraft(song: SongDraft): number[] {
  if (song.audio?.file) {
    return song.audio.segmentPointsSec.map((s) => Math.round(s * 1000));
  }
  // Existing clip: segmentPointsSec are already relative to clip start.
  if (song.existingSongId) {
    return song.segmentPointsSec.map((s) => Math.round(s * 1000));
  }
  // Pre-encode absolute markers — only used after convert via PreparedAudio.
  return remapSegmentsToCrop(
    song.segmentPointsSec,
    song.audio?.startSec ?? 0,
    song.audio?.endSec ?? Number.POSITIVE_INFINITY,
  ).map((s) => Math.round(s * 1000));
}

function durationMsFromDraft(song: SongDraft): number | null {
  if (song.audio?.file) {
    const ms = Math.round((song.audio.endSec - song.audio.startSec) * 1000);
    return ms >= 500 ? ms : null;
  }
  if (song.durationMs != null && song.durationMs >= 500) {
    return Math.round(song.durationMs);
  }
  return null;
}

export function CreateTrackListForm({
  onCreated,
  onCancel,
  editId = null,
}: {
  onCreated?: (trackList: { id: string; name: string; songCount: number }) => void;
  onCancel?: () => void;
  /** When set, load and PUT this track list instead of creating. */
  editId?: string | null;
}) {
  const seqRef = useRef(1);
  const [name, setName] = useState("");
  const [uploadSecret, setUploadSecret] = useState("");
  const [songs, setSongs] = useState<SongDraft[]>(() => [emptySong(1)]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editLoaded, setEditLoaded] = useState(!editId);
  const [uploadMode, setUploadMode] = useState<UploadMode>("unknown");
  const [ytStatus, setYtStatus] = useState<YoutubeImportStatus | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const injectTokenRef = useRef(1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/upload-mode", { cache: "no-store" });
        const data = await readApiJson<{ mode?: string }>(res);
        if (!cancelled) {
          if (data.mode === "r2") setUploadMode("r2");
          else if (data.mode === "blob") setUploadMode("blob");
          else setUploadMode("direct");
        }
      } catch {
        if (!cancelled) setUploadMode("direct");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await fetchYoutubeImportStatus();
      if (!cancelled) setYtStatus(status);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyYoutubeToSong = (
    songKey: string,
    result: Awaited<ReturnType<typeof downloadYoutubeAudioClient>>,
  ) => {
    injectTokenRef.current += 1;
    const token = injectTokenRef.current;
    const pick = result.meta.deezerHit
      ? hitToPick(result.meta.deezerHit)
      : null;
    setSongs((prev) =>
      prev.map((s) =>
        s.key === songKey
          ? {
              ...s,
              pick: pick ?? s.pick,
              extraAnswers: pick ? [] : s.extraAnswers,
              existingSongId: undefined,
              existingClip: null,
              audio: null,
              segmentPointsSec: [],
              injectFile: { file: result.file, token },
            }
          : s,
      ),
    );
  };

  const onImportPlaylist = async () => {
    setError(null);
    setStatus(null);
    const kind = classifyYoutubeUrl(playlistUrl);
    if (kind === "invalid") {
      setError("Paste a YouTube playlist or video URL");
      return;
    }
    if (!ytStatus?.available) {
      setError(
        ytStatus?.reason ||
          "YouTube import needs local yt-dlp + ffmpeg (not available on Vercel).",
      );
      return;
    }
    setPlaylistBusy(true);
    setBusy(true);
    try {
      setStatus("Resolving YouTube playlist…");
      const entries = await resolveYoutubePlaylistClient(
        playlistUrl,
        uploadSecret,
      );
      if (entries.length === 0) throw new Error("Playlist is empty");

      const imported: SongDraft[] = [];
      let failures = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        setStatus(
          `Downloading ${i + 1}/${entries.length}: ${entry.title.slice(0, 60)}…`,
        );
        try {
          const result = await downloadYoutubeAudioClient(
            entry.url,
            uploadSecret,
          );
          seqRef.current += 1;
          injectTokenRef.current += 1;
          const pick = result.meta.deezerHit
            ? hitToPick(result.meta.deezerHit)
            : null;
          imported.push({
            key: newSongKey(seqRef.current),
            pick,
            extraAnswers: [],
            audio: null,
            segmentPointsSec: [],
            injectFile: {
              file: result.file,
              token: injectTokenRef.current,
            },
          });
        } catch {
          failures += 1;
        }
      }

      if (imported.length === 0) {
        throw new Error(
          failures > 0
            ? `All ${failures} downloads failed (YouTube blocks are common on cloud IPs — try cookies locally).`
            : "No tracks imported",
        );
      }

      setSongs((prev) => {
        const onlyEmpty =
          prev.length === 1 &&
          !prev[0]?.pick &&
          !prev[0]?.audio &&
          !prev[0]?.existingSongId &&
          !prev[0]?.injectFile;
        return onlyEmpty ? imported : [...prev, ...imported];
      });
      setPlaylistUrl("");
      setStatus(
        `Imported ${imported.length} track${imported.length === 1 ? "" : "s"}` +
          (failures ? ` (${failures} failed)` : "") +
          ". Review Deezer matches, crop, and Convert to Opus.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playlist import failed");
      setStatus(null);
    } finally {
      setPlaylistBusy(false);
      setBusy(false);
    }
  };

  const loadEdit = async () => {
    if (!editId) return;
    setLoadingEdit(true);
    setError(null);
    try {
      const headers: HeadersInit = {};
      const secret = uploadSecret.trim();
      if (secret) headers["x-upload-secret"] = secret;
      const res = await fetch(`/api/templates/${encodeURIComponent(editId)}`, {
        cache: "no-store",
        headers,
      });
      const data = await readApiJson<{
        error?: string;
        name?: string;
        songs?: Array<{
          id: string;
          segmentPointsMs?: number[];
          durationMs?: number | null;
          pick: PickedTrack | null;
          extraAnswers?: PickedTrack[];
          displayName?: string;
          mimeType?: string;
        }>;
      }>(res);
      if (!res.ok) throw new Error(data.error || "Could not load track list");
      setName(data.name ?? "");
      const drafts: SongDraft[] = [];
      for (let i = 0; i < (data.songs ?? []).length; i++) {
        const song = data.songs![i];
        seqRef.current += 1;
        drafts.push({
          key: newSongKey(seqRef.current),
          pick: song.pick,
          extraAnswers: song.extraAnswers ?? [],
          audio: null,
          segmentPointsSec: (song.segmentPointsMs ?? []).map((ms) => ms / 1000),
          durationMs: song.durationMs ?? null,
          existingSongId: song.id,
          existingClip: null,
        });
      }
      setSongs(drafts.length ? drafts : [emptySong(1)]);
      setEditLoaded(true);

      for (let i = 0; i < drafts.length; i++) {
        const song = data.songs![i];
        try {
          const audioRes = await fetch(
            `/api/templates/${encodeURIComponent(editId)}/audio?songId=${encodeURIComponent(song.id)}`,
            { headers, cache: "no-store" },
          );
          if (!audioRes.ok) continue;
          const blob = await audioRes.blob();
          const ext =
            (song.mimeType || "").includes("webm")
              ? "webm"
              : (song.mimeType || "").includes("mpeg")
                ? "mp3"
                : "ogg";
          const file = new File(
            [blob],
            `${song.displayName || `song-${i + 1}`}.${ext}`,
            { type: song.mimeType || OPUS_MIME },
          );
          let probedMs: number | null = null;
          try {
            const sec = await probeAudioDuration(file);
            if (Number.isFinite(sec) && sec > 0) {
              probedMs = Math.round(sec * 1000);
            }
          } catch {
            /* keep stored duration */
          }
          setSongs((prev) =>
            prev.map((s) =>
              s.existingSongId === song.id
                ? {
                    ...s,
                    durationMs: s.durationMs ?? probedMs,
                    existingClip: {
                      file,
                      label: song.displayName || file.name,
                    },
                  }
                : s,
            ),
          );
        } catch {
          /* keep without waveform */
        }
      }
    } catch (err) {
      setEditLoaded(false);
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoadingEdit(false);
    }
  };

  useEffect(() => {
    if (!editId) {
      setEditLoaded(true);
      return;
    }
    // Auto-load once (local / secret already typed). Hosted 401 → enter secret + Load.
    void loadEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot per editId
  }, [editId]);

  const totalAudioBytes = useMemo(
    () =>
      songs.reduce((sum, s) => {
        if (s.audio?.file) return sum + s.audio.file.size;
        if (s.existingClip?.file) return sum + s.existingClip.file.size;
        return sum;
      }, 0),
    [songs],
  );

  const incomplete = useMemo(() => {
    const missingPick: number[] = [];
    const missingAudio: number[] = [];
    const tooLarge: number[] = [];
    songs.forEach((s, i) => {
      const n = i + 1;
      if (!s.pick) missingPick.push(n);
      else if (!s.audio?.file && !s.existingSongId) missingAudio.push(n);
      else if (s.audio?.file && s.audio.file.size > uploadLimits.maxFileBytes) {
        tooLarge.push(n);
      }
    });
    return { missingPick, missingAudio, tooLarge };
  }, [songs]);

  const saveBlockers = useMemo(() => {
    const reasons: string[] = [];
    if (busy || loadingEdit) reasons.push(loadingEdit ? "Loading…" : "Save in progress…");
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
  }, [busy, loadingEdit, uploadMode, name, incomplete, totalAudioBytes]);

  const canSave = saveBlockers.length === 0;

  const onSave = async (e: FormEvent) => {
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
        if (!song.pick) {
          throw new Error("Each song needs a track pick");
        }
        if (!song.audio?.file && !song.existingSongId) {
          throw new Error(
            "Each song needs a converted Opus clip or an existing clip",
          );
        }
        if (song.audio?.file) {
          if (song.audio.file.size > uploadLimits.maxFileBytes) {
            throw new Error(
              `“${song.audio.sourceName}” is too large after encode (max ${formatBytes(uploadLimits.maxFileBytes)}).`,
            );
          }
          total += song.audio.file.size;
        } else if (song.existingClip?.file) {
          total += song.existingClip.file.size;
        }
      }
      if (total > uploadLimits.maxTemplateAudioBytes) {
        throw new Error(
          `Track list audio too large (max ${formatBytes(uploadLimits.maxTemplateAudioBytes)} total). Use shorter clips.`,
        );
      }

      const secret = uploadSecret.trim();
      const headers: HeadersInit = {};
      if (secret) headers["x-upload-secret"] = secret;

      const isEdit = Boolean(editId);
      let res: Response;

      if (uploadMode === "r2" || uploadMode === "blob") {
        setStatus(isEdit ? "Updating track list…" : "Uploading Opus clips…");
        const payloadSongs: Array<{
          itunesTrackId: string;
          answerIds: string[];
          stagingUrl?: string;
          keepSongId?: string;
          segmentPointsMs: number[];
          durationMs: number | null;
        }> = [];
        for (let i = 0; i < songs.length; i++) {
          const song = songs[i];
          const pick = song.pick!;
          const segmentPointsMs = segmentPointsMsFromDraft(song);
          const durationMs = durationMsFromDraft(song);
          if (song.audio?.file) {
            setStatus(`Uploading clip ${i + 1}/${songs.length}…`);
            const file = song.audio.file;
            const pathname = safeAudioBlobPath(file, i);
            const contentType = file.type || OPUS_MIME;

            let stagingUrl: string;
            if (uploadMode === "r2") {
              const signRes = await fetch("/api/r2/upload", {
                method: "POST",
                headers: {
                  ...headers,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  pathname,
                  contentType,
                  contentLength: file.size,
                }),
              });
              const signed = await readApiJson<{
                error?: string;
                uploadUrl?: string;
                stagingUrl?: string;
                contentType?: string;
              }>(signRes);
              if (!signRes.ok || !signed.uploadUrl || !signed.stagingUrl) {
                throw new Error(signed.error || "Could not start R2 upload");
              }
              const putRes = await fetch(signed.uploadUrl, {
                method: "PUT",
                headers: {
                  "Content-Type": signed.contentType || contentType,
                },
                body: file,
              });
              if (!putRes.ok) {
                throw new Error(
                  `R2 upload failed (${putRes.status}). Check bucket CORS for PUT.`,
                );
              }
              stagingUrl = signed.stagingUrl;
            } else {
              const blob = await upload(pathname, file, {
                access: "private",
                handleUploadUrl: "/api/blob/upload",
                headers,
                multipart: file.size > 2 * 1024 * 1024,
                contentType,
              });
              stagingUrl = blob.url;
            }

            payloadSongs.push({
              itunesTrackId: pick.itunesTrackId,
              answerIds: allAnswerIds(pick, song.extraAnswers),
              stagingUrl,
              segmentPointsMs,
              durationMs,
            });
          } else {
            payloadSongs.push({
              itunesTrackId: pick.itunesTrackId,
              answerIds: allAnswerIds(pick, song.extraAnswers),
              keepSongId: song.existingSongId,
              segmentPointsMs,
              durationMs,
            });
          }
        }
        setStatus(isEdit ? "Saving changes…" : "Saving track list…");
        res = await fetch(
          isEdit
            ? `/api/templates/${encodeURIComponent(editId!)}`
            : "/api/templates",
          {
            method: isEdit ? "PUT" : "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: name.trim(),
              songs: payloadSongs,
            }),
          },
        );
      } else {
        setStatus(isEdit ? "Saving changes…" : "Saving track list…");
        const form = new FormData();
        form.set("name", name.trim());
        for (const song of songs) {
          const pick = song.pick!;
          form.append("itunesTrackIds", pick.itunesTrackId);
          form.append(
            "itunesAnswerIds",
            JSON.stringify(allAnswerIds(pick, song.extraAnswers)),
          );
          form.append(
            "segmentPointsMs",
            JSON.stringify(segmentPointsMsFromDraft(song)),
          );
          form.append(
            "durationMs",
            String(durationMsFromDraft(song) ?? ""),
          );
          if (song.audio?.file) {
            form.append("songFiles", song.audio.file);
            form.append("keepSongIds", "");
          } else {
            form.append(
              "songFiles",
              new File([], "keep.bin", { type: "application/octet-stream" }),
            );
            form.append("keepSongIds", song.existingSongId ?? "");
          }
        }
        res = await fetch(
          isEdit
            ? `/api/templates/${encodeURIComponent(editId!)}`
            : "/api/templates",
          {
            method: isEdit ? "PUT" : "POST",
            body: form,
            headers,
          },
        );
      }

      const data = await readApiJson<{
        error?: string;
        name?: string;
        id?: string;
        songCount?: number;
      }>(res);
      if (!res.ok) throw new Error(data.error || "Could not save track list");
      setStatus(
        isEdit
          ? `Updated track list “${data.name}”`
          : `Saved track list “${data.name}”`,
      );
      if (!isEdit) {
        setName("");
        seqRef.current += 1;
        setSongs([emptySong(seqRef.current)]);
      }
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
    if (!song.pick && !song.audio?.file && !song.existingSongId) {
      return "Needs track + Opus convert";
    }
    if (!song.pick) return "Needs Deezer track pick";
    if (!song.audio?.file && !song.existingSongId) return "Needs Convert to Opus";
    if (song.audio?.file && song.audio.file.size > uploadLimits.maxFileBytes) {
      return `Encoded file too large (${formatBytes(song.audio.file.size)})`;
    }
    const segs =
      (song.audio?.segmentPointsSec?.length ?? 0) ||
      song.segmentPointsSec.length;
    const segLabel =
      segs > 0 ? ` · ${segs} segment${segs === 1 ? "" : "s"}` : "";
    if (song.audio?.file) {
      return `Ready · ${formatBytes(song.audio.file.size)}${segLabel}`;
    }
    return `Keeping existing clip${segLabel}`;
  };

  if (editId && !editLoaded) {
    return (
      <div className="stack">
        <div className="field">
          <label htmlFor="upload-secret-load">Upload secret</label>
          <input
            id="upload-secret-load"
            type="password"
            autoComplete="off"
            value={uploadSecret}
            onChange={(e) => setUploadSecret(e.target.value)}
            placeholder="Required on the published app"
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={loadingEdit}
            onClick={() => void loadEdit()}
          >
            {loadingEdit ? "Loading…" : "Load track list"}
          </button>
          {onCancel && (
            <button type="button" className="btn secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {loadingEdit && <p className="muted">Loading track list…</p>}
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSave}>
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
        {editId ? " · editing" : ""}
      </p>

      {/* YouTube UI only on local/dev — hidden entirely when process.env.VERCEL. */}
      {ytStatus && !ytStatus.onVercel && (
      <div className="youtube-playlist-import">
        <div className="field">
          <label htmlFor="youtube-playlist-url">Import from YouTube playlist</label>
          <div className="youtube-url-row">
            <input
              id="youtube-playlist-url"
              type="url"
              value={playlistUrl}
              disabled={busy || playlistBusy}
              onChange={(e) => setPlaylistUrl(e.target.value)}
              placeholder="https://www.youtube.com/playlist?list=…"
              autoComplete="off"
            />
            <button
              type="button"
              className="btn secondary"
              disabled={busy || playlistBusy || !playlistUrl.trim()}
              onClick={() => void onImportPlaylist()}
            >
              {playlistBusy ? "Importing…" : "Import playlist"}
            </button>
          </div>
          <p className="muted youtube-url-hint">
            {ytStatus.available
              ? "Local yt-dlp: downloads ~196k MP3, pre-selects first Deezer hit. Review matches, crop, Convert to Opus."
              : ytStatus.reason ||
                "Install yt-dlp + ffmpeg, or use npm run import:youtube."}
          </p>
        </div>
      </div>
      )}

      <div className="song-rows">
        {songs.map((song, index) => {
          const ready = Boolean(
            song.pick && (song.audio?.file || song.existingSongId),
          );
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
              <div className="song-audio-block">
                <AudioCropField
                  id={`song-file-${song.key}`}
                  label={`Song ${index + 1} audio`}
                  value={song.audio}
                  disabled={busy}
                  existingClip={song.existingClip}
                  injectFile={song.injectFile}
                  segmentPointsSec={song.segmentPointsSec}
                  onSegmentPointsChange={(segmentPointsSec) => {
                    setSongs((prev) =>
                      prev.map((s) =>
                        s.key === song.key ? { ...s, segmentPointsSec } : s,
                      ),
                    );
                  }}
                  onClearExisting={() => {
                    setSongs((prev) =>
                      prev.map((s) =>
                        s.key === song.key
                          ? {
                              ...s,
                              existingSongId: undefined,
                              existingClip: null,
                              segmentPointsSec: [],
                              injectFile: null,
                            }
                          : s,
                      ),
                    );
                  }}
                  onChange={(audio) => {
                    setSongs((prev) =>
                      prev.map((s) =>
                        s.key === song.key
                          ? {
                              ...s,
                              audio,
                              existingSongId: audio
                                ? undefined
                                : s.existingSongId,
                              durationMs: audio
                                ? Math.round(
                                    (audio.endSec - audio.startSec) * 1000,
                                  )
                                : s.durationMs,
                              segmentPointsSec: audio
                                ? audio.segmentPointsSec.map(
                                    (p) => p + audio.startSec,
                                  )
                                : s.segmentPointsSec,
                            }
                          : s,
                      ),
                    );
                  }}
                />
                {ytStatus && !ytStatus.onVercel && (
                  <YouTubeUrlImport
                    uploadSecret={uploadSecret}
                    available={Boolean(ytStatus.available)}
                    unavailableReason={ytStatus.reason ?? null}
                    disabled={busy}
                    onImported={(result) =>
                      applyYoutubeToSong(song.key, result)
                    }
                  />
                )}
              </div>
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
          {busy
            ? "Saving…"
            : editId
              ? "Save changes"
              : "Save track list"}
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
