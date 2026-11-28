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
  const [missing, setMissing] = useState(false);
  const hostToken = opts.hostToken ?? null;
  const enabled = opts.enabled !== false && Boolean(code);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled || !code) return;

    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    setMissing(false);

    const connect = async () => {
      try {
        const headers: HeadersInit = {
          Accept: "text/event-stream",
        };
        if (hostToken) headers["x-host-token"] = hostToken;

        const res = await fetch(
          `/api/sessions/${encodeURIComponent(code)}/events`,
          {
            headers,
            cache: "no-store",
            signal: abort.signal,
          },
        );
        if (res.status === 404) {
          if (!closed) {
            setMissing(true);
            setConnected(false);
            setState(null);
          }
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error("SSE failed");
        }
        if (!closed) setConnected(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const lines = chunk.split("\n");
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const payload = JSON.parse(line.slice(6)) as {
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
            }
          }
        }
      } catch {
        if (!closed) {
          setConnected(false);
          retryTimer = setTimeout(() => {
            void connect();
          }, 1500);
        }
      }
    };

    void connect();

    const refresh = async () => {
      try {
        const headers: HeadersInit = {};
        if (hostToken) headers["x-host-token"] = hostToken;
        const res = await fetch(`/api/sessions/${encodeURIComponent(code)}`, {
          headers,
          cache: "no-store",
        });
        if (res.status === 404) {
          setMissing(true);
          setState(null);
          setConnected(false);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { state: SessionState };
        setMissing(false);
        setState(data.state);
      } catch {
        // ignore
      }
    };
    void refresh();
    const poll = setInterval(refresh, 1000);

    return () => {
      closed = true;
      abort.abort();
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(poll);
    };
  }, [code, enabled, hostToken]);

  return { state, setState, connected, error, setError, missing };
}
