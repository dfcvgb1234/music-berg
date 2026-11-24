"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionState } from "@/lib/quiz";

export function useSessionStream(
  code: string | null,
  opts: { hostToken?: string | null; enabled?: boolean } = {},
) {
  const [state, setState] = useState<SessionState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostToken = opts.hostToken ?? null;
  const enabled = opts.enabled !== false && Boolean(code);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled || !code) return;

    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const qs = hostToken
        ? `?hostToken=${encodeURIComponent(hostToken)}`
        : "";
      const url = `/api/sessions/${encodeURIComponent(code)}/events${qs}`;
      source = new EventSource(url);

      source.onopen = () => {
        if (!closed) setConnected(true);
      };

      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type: string;
            state?: SessionState;
          };
          if (payload.type === "state" && payload.state) {
            setState(payload.state);
            setError(null);
          }
        } catch {
          // ignore malformed
        }
      };

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!closed) {
          retryTimer = setTimeout(connect, 1500);
        }
      };
    };

    connect();

    const refresh = async () => {
      try {
        const headers: HeadersInit = {};
        if (hostToken) headers["x-host-token"] = hostToken;
        const res = await fetch(`/api/sessions/${encodeURIComponent(code)}`, {
          headers,
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { state: SessionState };
        setState(data.state);
      } catch {
        // ignore
      }
    };
    void refresh();
    const poll = setInterval(refresh, 1000);

    return () => {
      closed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(poll);
    };
  }, [code, enabled, hostToken]);

  return { state, setState, connected, error, setError };
}
