"use client";

import { useEffect, useRef, useState } from "react";
import type { ItunesTrackHit } from "@/lib/itunes";
import { readApiJson } from "@/lib/readApiJson";

export type PickedTrack = {
  itunesTrackId: string;
  title: string;
  artist: string;
  coverArtUrl: string | null;
  label: string;
};

export function TrackPicker({
  id,
  label,
  value,
  onChange,
  placeholder = "Search title or artist…",
}: {
  id: string;
  label: string;
  value: PickedTrack | null;
  onChange: (pick: PickedTrack | null) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ItunesTrackHit[]>([]);
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
            `/api/itunes/search?q=${encodeURIComponent(q)}`,
            { cache: "no-store" },
          );
          const data = await readApiJson<{
            results?: ItunesTrackHit[];
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
    }, 350);
    return () => clearTimeout(handle);
  }, [query, value]);

  const showResults = open && results.length > 0;

  if (value) {
    return (
      <div className="field track-pick">
        <label htmlFor={id}>{label}</label>
        <div className="track-selected">
          {value.coverArtUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value.coverArtUrl}
              alt=""
              className="track-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="track-cover track-cover-empty" aria-hidden />
          )}
          <div className="track-selected-meta">
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
    <div
      className={`field track-pick${showResults ? " is-open" : ""}`}
      ref={boxRef}
    >
      <label htmlFor={id}>{label}</label>
      <div className="track-combobox">
        <input
          id={id}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          autoComplete="off"
          required
        />
        {showResults && (
          <ul className="track-results" role="listbox">
            {results.map((hit) => {
              const labelText = `${hit.artist} — ${hit.title}`;
              return (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="track-result"
                    onClick={() => {
                      onChange({
                        itunesTrackId: hit.id,
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
                        className="track-cover"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.visibility =
                            "hidden";
                        }}
                      />
                    ) : (
                      <div className="track-cover track-cover-empty" aria-hidden />
                    )}
                    <span className="track-result-text">
                      <strong>{hit.title}</strong>
                      <span className="muted">{hit.artist}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {loading && <p className="muted">Searching…</p>}
      {error && <p className="error">{error}</p>}
      <p className="muted" style={{ margin: 0 }}>
        Pick a track from the results — free text is not allowed.
      </p>
    </div>
  );
}
