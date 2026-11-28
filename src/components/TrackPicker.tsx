"use client";

import { useEffect, useRef, useState } from "react";
import type { DeezerTrackHit } from "@/lib/deezer";
import { readApiJson } from "@/lib/readApiJson";

export type PickedTrack = {
  /** Deezer track id (stored in DB column itunes_track_id). */
  itunesTrackId: string;
  /** All accepted Deezer ids for this pick (primary + search variants). */
  answerIds: string[];
  title: string;
  artist: string;
  coverArtUrl: string | null;
  previewUrl: string | null;
  label: string;
};

export function hitToPick(hit: DeezerTrackHit): PickedTrack {
  const ids = hit.matchedIds?.length ? hit.matchedIds : [hit.id];
  return {
    itunesTrackId: hit.id,
    answerIds: [...new Set(ids)],
    title: hit.title,
    artist: hit.artist,
    coverArtUrl: hit.coverArtUrl,
    previewUrl: hit.previewUrl,
    label: `${hit.artist} — ${hit.title}`,
  };
}

export function TrackPicker({
  id,
  label,
  value,
  onChange,
  answers = [],
  onAnswersChange,
  multi = false,
  placeholder = "Search title or artist…",
}: {
  id: string;
  label: string;
  value: PickedTrack | null;
  onChange: (pick: PickedTrack | null) => void;
  /** Extra accepted answers (multi mode). Primary is `value`. */
  answers?: PickedTrack[];
  onAnswersChange?: (answers: PickedTrack[]) => void;
  multi?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DeezerTrackHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingExtra, setAddingExtra] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const searching = !value || addingExtra;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!searching) return;
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
            `/api/deezer/search?q=${encodeURIComponent(q)}`,
            { cache: "no-store" },
          );
          const data = await readApiJson<{
            results?: DeezerTrackHit[];
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
  }, [query, searching]);

  const showResults = open && results.length > 0;
  const takenIds = new Set<string>([
    ...(value?.answerIds ?? []),
    ...answers.flatMap((a) => a.answerIds),
  ]);

  const pickResult = (hit: DeezerTrackHit) => {
    const pick = hitToPick(hit);
    if (addingExtra && value) {
      if (takenIds.has(pick.itunesTrackId)) {
        setAddingExtra(false);
        setQuery("");
        setResults([]);
        setOpen(false);
        return;
      }
      onAnswersChange?.([...answers, pick]);
      setAddingExtra(false);
    } else {
      // Primary pick only — parent clears extras in onChange to avoid a
      // stale onAnswersChange([]) racing and wiping the new selection.
      onChange(pick);
    }
    setOpen(false);
    setQuery("");
    setResults([]);
  };

  return (
    <div
      className={`field track-pick${showResults ? " is-open" : ""}`}
      ref={boxRef}
    >
      <label htmlFor={id}>{label}</label>

      {value && !addingExtra && (
        <div className="track-answers">
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
                onAnswersChange?.([]);
                setQuery("");
                setResults([]);
                setAddingExtra(false);
              }}
            >
              Change
            </button>
          </div>

          {multi && answers.length > 0 && (
            <ul className="track-extra-answers">
              {answers.map((a) => (
                <li key={a.itunesTrackId} className="track-extra-chip">
                  {a.coverArtUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.coverArtUrl}
                      alt=""
                      className="track-cover track-cover-sm"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : null}
                  <span>
                    {a.artist} — {a.title}
                  </span>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() =>
                      onAnswersChange?.(
                        answers.filter(
                          (x) => x.itunesTrackId !== a.itunesTrackId,
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {multi && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setAddingExtra(true);
                setQuery("");
                setResults([]);
              }}
            >
              Add another accepted answer
            </button>
          )}
        </div>
      )}

      {searching && (
        <div className="track-combobox">
          <input
            id={id}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder={placeholder}
            autoComplete="off"
            required={!value}
          />
          {showResults && (
            <ul className="track-results" role="listbox">
              {results.map((hit) => {
                const already = takenIds.has(hit.id);
                return (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="track-result"
                      disabled={already}
                      onClick={() => pickResult(hit)}
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
                        <div
                          className="track-cover track-cover-empty"
                          aria-hidden
                        />
                      )}
                      <span className="track-result-text">
                        <strong>{hit.title}</strong>
                        <span className="muted">
                          {hit.artist}
                          {already ? " · added" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {addingExtra && (
            <button
              type="button"
              className="btn secondary"
              style={{ marginTop: "0.4rem" }}
              onClick={() => {
                setAddingExtra(false);
                setQuery("");
                setResults([]);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {loading && <p className="muted">Searching…</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
