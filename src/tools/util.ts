import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolContext, ToolResult } from "../agent/types.ts";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
export const MAX_LINE_CHARS = 2000;

export function resolvePath(cwd: string, p: string): string {
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export const text = (t: string, isError = false, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], isError, details });

/** Keep the tail (for command output); spill full output to a file and say where. */
export function truncateTail(output: string, label = "output"): { text: string; truncated: boolean; fullPath?: string } {
  const bytes = Buffer.byteLength(output);
  const lines = output.split("\n");
  if (lines.length <= MAX_LINES && bytes <= MAX_BYTES) return { text: output, truncated: false };
  const dir = join(tmpdir(), "rcode-output");
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`);
  writeFileSync(fullPath, output);
  let kept = lines.slice(-MAX_LINES);
  let t = kept.join("\n");
  while (Buffer.byteLength(t) > MAX_BYTES && kept.length > 1) { kept = kept.slice(Math.ceil(kept.length / 10)); t = kept.join("\n"); }
  return { text: `[… ${lines.length - kept.length} earlier lines omitted; full ${label} saved to ${fullPath} — read it with offsets if needed]\n${t}`, truncated: true, fullPath };
}

// ── Per-file mutation lock (shared across all agents in this process, incl. subagents) ──
const locks = new Map<string, Promise<void>>();
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(path, chained);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(path) === chained) locks.delete(path); }
}

// ── Read tracking: refuse edits to files the agent never read or that changed since ──
interface ReadRecord { mtimeMs: number; size: number }
function readMap(ctx: ToolContext): Map<string, ReadRecord> {
  let m = ctx.state.get("reads") as Map<string, ReadRecord> | undefined;
  if (!m) { m = new Map(); ctx.state.set("reads", m); }
  return m;
}
export function markRead(ctx: ToolContext, path: string) {
  try { const s = statSync(path); readMap(ctx).set(path, { mtimeMs: s.mtimeMs, size: s.size }); } catch {}
}
/** Returns an error string if the file exists but is unread or stale. */
export function checkFresh(ctx: ToolContext, path: string): string | undefined {
  let s;
  try { s = statSync(path); } catch { return undefined; }
  const r = readMap(ctx).get(path);
  if (!r) return `You must read ${path} before modifying it.`;
  if (Math.abs(s.mtimeMs - r.mtimeMs) > 1 || s.size !== r.size) return `${path} changed on disk since you last read it (another agent, the user, or a formatter). Read it again before editing.`;
  return undefined;
}

export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

let rgPath: string | null | undefined;
export function ripgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  const candidates = [process.env.RCODE_RG, Bun.which("rg"), "/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].filter(Boolean) as string[];
  for (const c of candidates) { try { if (statSync(c).isFile()) return (rgPath = c); } catch {} }
  return (rgPath = null);
}

export const DEFAULT_IGNORES = ["node_modules", ".git", "dist", "build", ".next", "target", ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo"];
