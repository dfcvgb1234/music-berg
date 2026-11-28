"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { CreateTrackListForm } from "@/components/CreateTrackListForm";
import { readApiJson } from "@/lib/readApiJson";
import { setActiveHost, writeHostToken } from "@/lib/sessionLocal";

type TrackList = {
  id: string;
  name: string;
  songCount: number;
};

type Panel = "none" | "create" | "edit";

export function HostSetup() {
  const router = useRouter();
  const [trackLists, setTrackLists] = useState<TrackList[]>([]);
  const [trackListId, setTrackListId] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteSecret, setDeleteSecret] = useState("");
  const [deleting, setDeleting] = useState(false);

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
      writeHostToken(data.code, data.hostToken);
      setActiveHost(data.code);
      router.push(`/host/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!trackListId) return;
    const list = trackLists.find((t) => t.id === trackListId);
    const ok = window.confirm(
      `Delete track list “${list?.name ?? trackListId}”? This also removes quiz sessions that used it.`,
    );
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      const headers: HeadersInit = {};
      const secret = deleteSecret.trim();
      if (secret) headers["x-upload-secret"] = secret;
      const res = await fetch(
        `/api/templates/${encodeURIComponent(trackListId)}`,
        { method: "DELETE", headers },
      );
      const data = await readApiJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(data.error || "Could not delete");
      setPanel("none");
      await loadLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
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

        <form className="stack" onSubmit={onStart}>
          <div className="track-list-picker">
            <div className="field" style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="track-list">Track list</label>
              <select
                id="track-list"
                value={trackListId}
                onChange={(e) => {
                  setTrackListId(e.target.value);
                  if (panel === "edit") setPanel("none");
                }}
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
            <div className="track-list-actions">
              <button
                type="button"
                className={`btn secondary${panel === "create" ? " is-active" : ""}`}
                onClick={() =>
                  setPanel((p) => (p === "create" ? "none" : "create"))
                }
              >
                {panel === "create" ? "Hide create" : "Create new"}
              </button>
              <button
                type="button"
                className={`btn secondary${panel === "edit" ? " is-active" : ""}`}
                disabled={!trackListId}
                onClick={() =>
                  setPanel((p) => (p === "edit" ? "none" : "edit"))
                }
              >
                {panel === "edit" ? "Hide edit" : "Edit"}
              </button>
            </div>
          </div>

          {trackListId && (
            <div className="field track-list-delete">
              <label htmlFor="delete-secret">Upload secret (for delete)</label>
              <div className="track-list-delete-row">
                <input
                  id="delete-secret"
                  type="password"
                  autoComplete="off"
                  value={deleteSecret}
                  onChange={(e) => setDeleteSecret(e.target.value)}
                  placeholder="Same secret as create/edit"
                />
                <button
                  type="button"
                  className="btn danger"
                  disabled={deleting || !trackListId}
                  onClick={() => void onDelete()}
                >
                  {deleting ? "Deleting…" : "Delete list"}
                </button>
              </div>
            </div>
          )}

          <button
            className="btn"
            type="submit"
            disabled={busy || !trackListId || panel !== "none"}
          >
            {busy ? "Starting…" : "Create session"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>

        {panel === "create" && (
          <div className="surface stack" style={{ marginTop: "0.5rem" }}>
            <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
              Create new track list
            </h2>
            <CreateTrackListForm
              onCancel={() => setPanel("none")}
              onCreated={(list) => {
                void (async () => {
                  await loadLists();
                  setTrackListId(list.id);
                  setPanel("none");
                })();
              }}
            />
          </div>
        )}

        {panel === "edit" && trackListId && (
          <div className="surface stack" style={{ marginTop: "0.5rem" }}>
            <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
              Edit track list
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              Enter the upload secret above in the form to load songs, then
              adjust name, order, crop, or segment markers.
            </p>
            <CreateTrackListForm
              key={trackListId}
              editId={trackListId}
              onCancel={() => setPanel("none")}
              onCreated={(list) => {
                void (async () => {
                  await loadLists();
                  setTrackListId(list.id);
                  setPanel("none");
                })();
              }}
            />
          </div>
        )}
      </section>
    </main>
  );
}
