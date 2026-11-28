/** Midpoint of the 2–3 hour playtest window. */
export const SESSION_TTL_HOURS = 2.5;
export const SESSION_TTL_MS = Math.round(SESSION_TTL_HOURS * 60 * 60 * 1000);

export function sessionExpiresAt(createdAt: string | Date): Date {
  const start = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return new Date(start.getTime() + SESSION_TTL_MS);
}

export function isSessionExpired(
  createdAt: string | Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (createdAt == null) return false;
  const start = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(start.getTime())) return false;
  return nowMs - start.getTime() > SESSION_TTL_MS;
}
