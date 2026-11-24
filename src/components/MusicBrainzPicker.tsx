"use client";

import { useEffect, useRef, useState } from "react";
import type { MbRecordingHit } from "@/lib/musicbrainz";
import { readApiJson } from "@/lib/readApiJson";

export type PickedRecording = {
  musicbrainzId: string;
  title: string;
  artist: string;
  coverArtUrl: string | null;
  label: string;
};

export function MusicBrainzPicker({
  id,
  label,
  value,
  onChange,
  placeholder = "Search MusicBrainz…",
}: {
  id: string;
  label: string;
  value: PickedRecording | null;
  onChange: (pick: PickedRecording | null) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MbRecordingHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (value) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(null);
        try {
          const res = await fetch(
            `/api/musicbrainz/search?q=${encodeURIComponent(q)}`,
            { cache: "no-store" },
          );
          const data = await readApiJson<{
            results?: MbRecordingHit[];
            error?: string;
          }>(res);
          if (!res.ok) throw new Error(data.error || "Search failed");
          setResults(data.results ?? []);
          setOpen(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
        } finally {
          setLoading(false);
        }
      })();
    }, 400);
    return () => clearTimeout(handle);
  }, [query, value]);

  if (value) {
    return (
      <div className="field mb-pick">
        <label htmlFor={id}>{label}</label>
        <div className="mb-selected">
          {value.coverArtUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value.coverArtUrl}
              alt=""
              className="mb-cover"
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="mb-cover mb-cover-empty" aria-hidden />
          )}
          <div className="mb-selected-meta">
            <strong>{value.title}</strong>
            <span className="muted">{value.artist}</span>
          </div>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              onChange(null);
              setQuery("");
              setResults([]);
            }}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field mb-pick" ref={boxRef}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        required
      />
      {loading && <p className="muted">Searching MusicBrainz…</p>}
      {error && <p className="error">{error}</p>}
      {open && results.length > 0 && (
        <ul className="mb-results" role="listbox">
          {results.map((hit) => {
            const labelText = `${hit.artist} — ${hit.title}`;
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  className="mb-result"
                  onClick={() => {
                    onChange({
                      musicbrainzId: hit.id,
                      title: hit.title,
                      artist: hit.artist,
                      coverArtUrl: hit.coverArtUrl,
                      label: labelText,
                    });
                    setOpen(false);
                    setQuery("");
                    setResults([]);
                  }}
                >
                  {hit.coverArtUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={hit.coverArtUrl}
                      alt=""
                      className="mb-cover"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility =
                          "hidden";
                      }}
                    />
                  ) : (
                    <div className="mb-cover mb-cover-empty" aria-hidden />
                  )}
                  <span className="mb-result-text">
                    <strong>{hit.title}</strong>
                    <span className="muted">{hit.artist}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted" style={{ margin: 0 }}>
        Pick a MusicBrainz recording — free text is not allowed.
      </p>
    </div>
  );
}
