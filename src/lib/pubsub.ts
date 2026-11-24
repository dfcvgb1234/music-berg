type Listener = (payload: string) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(code: string, listener: Listener): () => void {
  const key = code.toUpperCase();
  let set = channels.get(key);
  if (!set) {
    set = new Set();
    channels.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) channels.delete(key);
  };
}

export function publish(code: string, payload: unknown): void {
  const key = code.toUpperCase();
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  const set = channels.get(key);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(data);
    } catch {
      // ignore broken listeners
    }
  }
}
