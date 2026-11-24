import { randomBytes, randomInt } from "node:crypto";

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function newSessionCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
