/**
 * Gateway state (~/.rcode/gateway.json, mode 600): per-channel allowlists with roles, hashed pairing
 * codes and one-time pairing links, session mapping, persisted jobs, Telegram offset.
 * Shared by the daemon and short-lived CLI commands (`rcode gateway pair|link|users`).
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RCODE_HOME } from "../session/store.ts";

export type Role = "owner" | "user";
export interface Job { id: string; channel: string; conversationId: string; every?: string; at?: string; prompt: string; createdBy: string }

export interface GatewayState {
  users: Record<string, Record<string, { role: Role; name?: string; since: number }>>; // channel → userId → info
  pending: Record<string, { channel: string; userId: string; userName?: string; expires: number }>;
  links: Record<string, { role: Role; expires: number }>;
  sessions: Record<string, string>;
  jobs: Job[];
  telegramOffset?: number;
  /** legacy (v1) */ telegramAllowed?: string[];
}

const STATE = () => join(RCODE_HOME, "gateway.json");
const empty = (): GatewayState => ({ users: {}, pending: {}, links: {}, sessions: {}, jobs: [] });

export function loadState(): GatewayState {
  let s: GatewayState;
  try { s = { ...empty(), ...JSON.parse(readFileSync(STATE(), "utf8")) }; } catch { s = empty(); }
  // v1 migration: telegramAllowed[] → owners
  if (s.telegramAllowed?.length) {
    s.users.telegram ??= {};
    for (const id of s.telegramAllowed) s.users.telegram[id] ??= { role: "owner", since: Date.now() };
    delete s.telegramAllowed;
  }
  return s;
}
export function saveState(s: GatewayState) { mkdirSync(RCODE_HOME, { recursive: true }); writeFileSync(STATE(), JSON.stringify(s, null, 2), { mode: 0o600 }); }
export function updateState(fn: (s: GatewayState) => void): GatewayState { const s = loadState(); fn(s); saveState(s); return s; }

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const hash = (c: string) => createHash("sha256").update(c.trim().toUpperCase()).digest("hex");
const hashTok = (t: string) => createHash("sha256").update(t.trim()).digest("hex");

export function roleOf(channel: string, userId: string, fixed?: { owners?: string[]; users?: string[] }): Role | undefined {
  if (fixed?.owners?.includes(userId)) return "owner";
  const r = loadState().users[channel]?.[userId]?.role;
  if (r) return r;
  if (fixed?.users?.includes(userId)) return "user";
  return undefined;
}

/** Pairing code for an unknown user (hashed at rest, 1h expiry, one live code per user, max 3 pending). */
export function createPairCode(channel: string, userId: string, userName?: string): string | undefined {
  let code: string | undefined;
  updateState((st) => {
    for (const [h, p] of Object.entries(st.pending)) if (p.expires < Date.now()) delete st.pending[h];
    if (Object.values(st.pending).some((p) => p.channel === channel && p.userId === userId)) return;
    if (Object.keys(st.pending).length >= 3) return;
    code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    st.pending[hash(code)] = { channel, userId, userName, expires: Date.now() + 60 * 60_000 };
  });
  return code;
}

/** Approve a pairing code. Role defaults to owner (the person running the CLI chose to let them in). */
export function pairCode(code: string, role: Role = "owner"): { channel: string; who: string } | undefined {
  let res: { channel: string; who: string } | undefined;
  updateState((st) => {
    const h = hash(code);
    const p = st.pending[h];
    if (!p || p.expires < Date.now()) return;
    delete st.pending[h];
    st.users[p.channel] ??= {};
    st.users[p.channel]![p.userId] = { role, name: p.userName, since: Date.now() };
    res = { channel: p.channel, who: p.userName ?? p.userId };
  });
  return res;
}

/** One-time pairing link token (15 min). Whoever redeems it first is paired with `role`. */
export function createLinkToken(role: Role = "owner"): string {
  const tok = randomBytes(18).toString("base64url");
  updateState((st) => {
    for (const [h, l] of Object.entries(st.links)) if (l.expires < Date.now()) delete st.links[h];
    st.links[hashTok(tok)] = { role, expires: Date.now() + 15 * 60_000 };
  });
  return tok;
}

export function redeemLink(token: string, channel: string, userId: string, userName?: string): Role | undefined {
  let role: Role | undefined;
  updateState((st) => {
    const h = hashTok(token);
    const l = st.links[h];
    if (!l || l.expires < Date.now()) return;
    delete st.links[h];
    st.users[channel] ??= {};
    st.users[channel]![userId] = { role: l.role, name: userName, since: Date.now() };
    role = l.role;
  });
  return role;
}

export function removeUser(channel: string, userId: string): boolean {
  let ok = false;
  updateState((st) => { if (st.users[channel]?.[userId]) { delete st.users[channel]![userId]; ok = true; } });
  return ok;
}

// ── single-instance lock ──
const LOCK = () => join(RCODE_HOME, "gateway.lock");
export function acquireLock(): { ok: true } | { ok: false; pid: number } {
  try {
    if (existsSync(LOCK())) {
      const pid = Number(readFileSync(LOCK(), "utf8").trim());
      if (pid && pid !== process.pid) { try { process.kill(pid, 0); return { ok: false, pid }; } catch { /* stale */ } }
    }
    mkdirSync(RCODE_HOME, { recursive: true });
    writeFileSync(LOCK(), String(process.pid));
    return { ok: true };
  } catch { return { ok: true }; }
}
export function releaseLock() { try { if (readFileSync(LOCK(), "utf8").trim() === String(process.pid)) rmSync(LOCK()); } catch {} }
