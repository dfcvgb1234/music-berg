"use client";

import { useState } from "react";
import { classifyYoutubeUrl } from "@/lib/youtubeUrl";
import { downloadYoutubeAudioClient } from "@/lib/youtubeClient";

type Props = {
  uploadSecret: string;
  available: boolean;
  unavailableReason: string | null;
  disabled?: boolean;
  onImported: (result: Awaited<ReturnType<typeof downloadYoutubeAudioClient>>) => void;
};

/** Per-track YouTube URL paste — local yt-dlp only (see /api/youtube/status). */
export function YouTubeUrlImport({
  uploadSecret,
  available,
  unavailableReason,
  disabled,
  onImported,
}: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFetch = async () => {
    setError(null);
    const kind = classifyYoutubeUrl(url);
    if (kind !== "video") {
      setError("Paste a single YouTube video URL (use playlist import above for lists)");
      return;
    }
    if (!available) {
      setError(unavailableReason || "YouTube download not available here");
      return;
    }
    setBusy(true);
    try {
      const result = await downloadYoutubeAudioClient(url, uploadSecret);
      onImported(result);
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="youtube-url-import">
      <label className="youtube-url-label">Or YouTube URL</label>
      <div className="youtube-url-row">
        <input
          type="url"
          value={url}
          disabled={disabled || busy}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          autoComplete="off"
        />
        <button
          type="button"
          className="btn secondary"
          disabled={disabled || busy || !url.trim()}
          onClick={() => void onFetch()}
        >
          {busy ? "Fetching…" : "Fetch"}
        </button>
      </div>
      {!available && (
        <p className="muted youtube-url-hint">
          {unavailableReason ||
            "Local only: run next dev with yt-dlp + ffmpeg, or npm run import:youtube."}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
