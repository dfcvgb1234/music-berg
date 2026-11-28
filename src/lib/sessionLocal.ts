"use client";

/** Device-local pointer to the participant's current unfinished quiz. */
const ACTIVE_PLAYER_KEY = "bergs-music-active-player";
/** Device-local pointer to the host's current unfinished quiz. */
const ACTIVE_HOST_KEY = "bergs-music-active-host";

export type ActivePlayer = {
  code: string;
  token: string;
  participantId: string;
  displayName: string;
  savedAt: number;
};

export type ActiveHost = {
  code: string;
  savedAt: number;
};

export type StoredPlayer = {
  token: string;
  participantId: string;
  displayName: string;
};

function playerKey(code: string): string {
  return `riffrush-player-${String(code).toUpperCase()}`;
}

function hostKey(code: string): string {
  return `riffrush-host-${String(code).toUpperCase()}`;
}

export function readStoredPlayer(code: string): StoredPlayer | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(playerKey(code));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredPlayer;
    if (!parsed?.token || !parsed?.participantId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredPlayer(code: string, player: StoredPlayer): void {
  localStorage.setItem(playerKey(code), JSON.stringify(player));
}

export function clearStoredPlayer(code: string): void {
  localStorage.removeItem(playerKey(code));
}

export function readHostToken(code: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(hostKey(code));
}

export function writeHostToken(code: string, token: string): void {
  localStorage.setItem(hostKey(code), token);
}

export function clearHostToken(code: string): void {
  localStorage.removeItem(hostKey(code));
}

export function getActivePlayer(): ActivePlayer | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(ACTIVE_PLAYER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActivePlayer;
    if (!parsed?.code || !parsed?.token || !parsed?.participantId) return null;
    return {
      ...parsed,
      code: String(parsed.code).toUpperCase(),
    };
  } catch {
    return null;
  }
}

export function setActivePlayer(player: Omit<ActivePlayer, "savedAt">): void {
  const code = String(player.code).toUpperCase();
  const payload: ActivePlayer = {
    ...player,
    code,
    savedAt: Date.now(),
  };
  localStorage.setItem(ACTIVE_PLAYER_KEY, JSON.stringify(payload));
  writeStoredPlayer(code, {
    token: player.token,
    participantId: player.participantId,
    displayName: player.displayName,
  });
}

/** Drop the Participate “Resume game” pointer (and optional per-code creds). */
export function clearActivePlayer(opts: { clearCreds?: boolean } = {}): void {
  if (typeof localStorage === "undefined") return;
  const active = getActivePlayer();
  localStorage.removeItem(ACTIVE_PLAYER_KEY);
  if (opts.clearCreds && active?.code) {
    clearStoredPlayer(active.code);
  }
}

export function getActiveHost(): ActiveHost | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(ACTIVE_HOST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActiveHost;
    if (!parsed?.code) return null;
    return { code: String(parsed.code).toUpperCase(), savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function setActiveHost(code: string): void {
  const payload: ActiveHost = {
    code: String(code).toUpperCase(),
    savedAt: Date.now(),
  };
  localStorage.setItem(ACTIVE_HOST_KEY, JSON.stringify(payload));
}

export function clearActiveHost(opts: { clearCreds?: boolean } = {}): void {
  if (typeof localStorage === "undefined") return;
  const active = getActiveHost();
  localStorage.removeItem(ACTIVE_HOST_KEY);
  if (opts.clearCreds && active?.code) {
    clearHostToken(active.code);
  }
}

/**
 * Clear rejoin pointers for a code.
 * - finish: drop Resume / active-host pointers only (keep room creds for podium).
 * - gone: also wipe per-code tokens (expired / 404).
 */
export function clearMembershipForCode(
  code: string,
  opts: { clearCreds?: boolean } = {},
): void {
  const upper = String(code).toUpperCase();
  const clearCreds = opts.clearCreds === true;
  const activePlayer = getActivePlayer();
  if (activePlayer?.code === upper) {
    clearActivePlayer({ clearCreds });
  } else if (clearCreds) {
    clearStoredPlayer(upper);
  }
  const activeHost = getActiveHost();
  if (activeHost?.code === upper) {
    clearActiveHost({ clearCreds });
  } else if (clearCreds) {
    clearHostToken(upper);
  }
}
