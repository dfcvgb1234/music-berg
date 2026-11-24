"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { CreateTrackListForm } from "@/components/CreateTrackListForm";

type TrackList = {
  id: string;
  name: string;
  songCount: number;
};

export function HostSetup() {
  const router = useRouter();
  const [trackLists, setTrackLists] = useState<TrackList[]>([]);
  const [trackListId, setTrackListId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadLists = useCallback(async () => {
    const res = await fetch("/api/templates", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      templates: { id: string; name: string; songCount: number }[];
    };
    const lists = data.templates.map((t) => ({
      id: t.id,
      name: t.name,
      songCount: t.songCount,
    }));
    setTrackLists(lists);
    setTrackListId((prev) => {
      if (prev && lists.some((l) => l.id === prev)) return prev;
      return lists[0]?.id ?? "";
    });
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const onStart = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: trackListId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start quiz");
      localStorage.setItem(`riffrush-host-${data.code}`, data.hostToken);
      router.push(`/host/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <div className="topbar">
        <Link href="/" className="brand brand-md">
          Bergs Music
        </Link>
        <Link href="/join" className="btn secondary">
          Participate instead
        </Link>
      </div>

      <section className="stack host-setup">
        <h1 className="brand brand-md">Start a new quiz</h1>
        <p className="muted">
          Pick a track list. You&apos;ll get a 6-digit code for the room.
        </p>

        <form className="stack" onSubmit={onStart}>
          <div className="track-list-picker">
            <div className="field" style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="track-list">Track list</label>
              <select
                id="track-list"
                value={trackListId}
                onChange={(e) => setTrackListId(e.target.value)}
                required={trackLists.length > 0}
                disabled={trackLists.length === 0}
              >
                {trackLists.length === 0 ? (
                  <option value="">No track lists yet</option>
                ) : (
                  trackLists.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.songCount} songs)
                    </option>
                  ))
                )}
              </select>
            </div>
            <button
              type="button"
              className={`btn secondary${creating ? " is-active" : ""}`}
              style={{ alignSelf: "end" }}
              onClick={() => setCreating((v) => !v)}
            >
              {creating ? "Hide create" : "Create new track list"}
            </button>
          </div>

          {trackLists.length === 0 && !creating && (
            <p className="muted" style={{ margin: 0 }}>
              Create a track list to start hosting.
            </p>
          )}

          <button
            className="btn"
            type="submit"
            disabled={busy || !trackListId || creating}
          >
            {busy ? "Starting…" : "Create session"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>

        {creating && (
          <div className="surface stack" style={{ marginTop: "0.5rem" }}>
            <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
              Create new track list
            </h2>
            <CreateTrackListForm
              onCancel={() => setCreating(false)}
              onCreated={(list) => {
                void (async () => {
                  await loadLists();
                  setTrackListId(list.id);
                  setCreating(false);
                })();
              }}
            />
          </div>
        )}
      </section>
    </main>
  );
}
