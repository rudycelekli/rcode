/**
 * Session store: append-only JSONL tree.
 *   ~/.rcode/sessions/<project-slug>/<timestamp>_<id>.jsonl
 * Every entry has id + parentId. The current leaf is persisted (unlike pi), so
 * branching via /tree survives reloads. The model context is rebuilt from the
 * file path (leaf → root), applying compaction entries. Nothing is written until
 * the first message, and appends are fsync'd in batches.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Message, UserMessage } from "../ai/types.ts";

export type Entry =
  | { type: "header"; id: string; version: 1; cwd: string; createdAt: number; parentSession?: string }
  | { type: "message"; id: string; parentId: string | null; message: Message }
  | { type: "compaction"; id: string; parentId: string | null; summary: string; firstKeptId: string | null; tokensBefore: number }
  | { type: "leaf"; id: string; leafId: string | null }
  | { type: "meta"; id: string; title?: string; model?: string; thinking?: string; tags?: string[] }
  | { type: "custom"; id: string; parentId: string | null; kind: string; data: unknown };

export const RCODE_HOME = process.env.RCODE_HOME ?? join(homedir(), ".rcode");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function projectSlug(cwd: string) { return cwd.replace(/^\//, "").replace(/[\/\\:]/g, "-").slice(-120) || "root"; }
export function sessionsDir(cwd: string) { return join(RCODE_HOME, "sessions", projectSlug(cwd)); }

export class Session {
  readonly entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  leafId: string | null = null;
  title?: string;
  meta: { model?: string; thinking?: string } = {};
  private flushed = false;
  private pending: string[] = [];

  private constructor(readonly file: string, readonly id: string, readonly cwd: string) {}

  static create(cwd: string, opts: { parentSession?: string; ephemeral?: boolean } = {}): Session {
    const id = newId();
    const dir = sessionsDir(cwd);
    const file = opts.ephemeral ? "" : join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
    const s = new Session(file, id, cwd);
    s.add({ type: "header", id, version: 1, cwd, createdAt: Date.now(), parentSession: opts.parentSession }, false);
    return s;
  }

  static open(file: string): Session {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    let header: Extract<Entry, { type: "header" }> | undefined;
    const entries: Entry[] = [];
    for (const l of lines) {
      try { const e = JSON.parse(l) as Entry; entries.push(e); if (e.type === "header") header ??= e; } catch { /* salvage: skip corrupt line */ }
    }
    if (!header) throw new Error(`Not an rcode session: ${file}`);
    const s = new Session(file, header.id, header.cwd);
    s.flushed = true;
    for (const e of entries) s.ingest(e);
    return s;
  }

  /** Most recent session for a cwd. */
  static latest(cwd: string): string | undefined { return listSessions(cwd)[0]?.file; }

  private ingest(e: Entry) {
    this.entries.push(e);
    this.byId.set(e.id, e);
    if (e.type === "message" || e.type === "compaction" || e.type === "custom") this.leafId = e.id;
    else if (e.type === "leaf") this.leafId = e.leafId;
    else if (e.type === "meta") { if (e.title) this.title = e.title; if (e.model) this.meta.model = e.model; if (e.thinking) this.meta.thinking = e.thinking; }
  }

  private add(e: Entry, persist = true) {
    this.ingest(e);
    this.pending.push(JSON.stringify(e));
    if (persist) this.flush();
  }

  /** Write pending entries. The file is created lazily on the first real message. */
  flush() {
    if (!this.file || !this.pending.length) return;
    if (!this.flushed && !this.entries.some((e) => e.type === "message")) return;
    mkdirSync(join(this.file, ".."), { recursive: true });
    const fd = openSync(this.file, "a");
    try { appendFileSync(fd, this.pending.join("\n") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    this.pending = [];
    this.flushed = true;
  }

  appendMessage(message: Message): string {
    const id = newId();
    this.add({ type: "message", id, parentId: this.leafId, message });
    return id;
  }

  appendCompaction(summary: string, firstKeptId: string | null, tokensBefore: number) {
    this.add({ type: "compaction", id: newId(), parentId: this.leafId, summary, firstKeptId, tokensBefore });
  }

  appendCustom(kind: string, data: unknown) { this.add({ type: "custom", id: newId(), parentId: this.leafId, kind, data }); }

  setMeta(m: { title?: string; model?: string; thinking?: string }) { this.add({ type: "meta", id: newId(), ...m }); }

  /** Move the leaf (branch navigation). Next message becomes a child of `entryId`. */
  setLeaf(entryId: string | null) { this.add({ type: "leaf", id: newId(), leafId: entryId }); }

  /** Entries from root to current leaf. */
  path(leafId = this.leafId): Entry[] {
    const out: Entry[] = [];
    let cur = leafId ? this.byId.get(leafId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      const pid = (cur as any).parentId as string | null | undefined;
      cur = pid ? this.byId.get(pid) : undefined;
    }
    return out.reverse();
  }

  /** Rebuild LLM context from the current branch, applying the latest compaction. */
  buildContext(): { messages: Message[]; ids: string[] } {
    const p = this.path();
    let startIdx = 0;
    let summary: string | undefined;
    for (let i = p.length - 1; i >= 0; i--) {
      const e = p[i]!;
      if (e.type === "compaction") {
        summary = e.summary;
        const keptIdx = e.firstKeptId ? p.findIndex((x) => x.id === e.firstKeptId) : -1;
        startIdx = keptIdx >= 0 && keptIdx < i ? keptIdx : i + 1;
        // Messages between firstKept and the compaction entry are kept; those after it too.
        const kept = p.slice(startIdx).filter((x) => x.type === "message" && x.id !== e.id) as Array<Extract<Entry, { type: "message" }>>;
        const msgs: Message[] = [summaryMessage(summary), ...kept.map((k) => k.message)];
        return { messages: msgs, ids: ["compaction", ...kept.map((k) => k.id)] };
      }
    }
    const msgs = p.filter((e) => e.type === "message") as Array<Extract<Entry, { type: "message" }>>;
    return { messages: msgs.map((m) => m.message), ids: msgs.map((m) => m.id) };
  }

  /** Children of an entry (for tree UI). */
  children(id: string | null): Entry[] {
    return this.entries.filter((e) => (e as any).parentId === id && (e.type === "message" || e.type === "compaction"));
  }

  /** Copy the current branch into a new session file (fork). */
  fork(atEntryId = this.leafId): Session {
    const s = Session.create(this.cwd, { parentSession: this.id });
    const ids = new Map<string, string>();
    for (const e of this.path(atEntryId)) {
      if (e.type === "message") { const nid = s.appendMessage(e.message); ids.set(e.id, nid); }
      else if (e.type === "compaction") s.appendCompaction(e.summary, e.firstKeptId ? ids.get(e.firstKeptId) ?? null : null, e.tokensBefore);
    }
    if (this.title) s.setMeta({ title: `${this.title} (fork)` });
    return s;
  }
}

export function summaryMessage(summary: string): UserMessage {
  return { role: "user", content: [{ type: "text", text: `<conversation_summary>\nThe earlier part of this conversation was compacted. Summary:\n\n${summary}\n</conversation_summary>` }], timestamp: 0 };
}

export interface SessionInfo { file: string; id: string; mtime: number; title: string; messages: number }

export function listSessions(cwd: string, limit = 50): SessionInfo[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ file, mtime }) => {
      let title = "", messages = 0;
      try {
        for (const l of readFileSync(file, "utf8").split("\n")) {
          if (!l) continue;
          if (l.includes('"type":"meta"') && l.includes('"title"')) title = JSON.parse(l).title ?? title;
          if (l.includes('"type":"message"')) { messages++; if (!title && l.includes('"role":"user"')) { const m = JSON.parse(l).message; title = (m.content?.[0]?.text ?? "").slice(0, 80); } }
        }
      } catch {}
      return { file, id: basename(file, ".jsonl").split("_").pop()!, mtime, title: title || "(untitled)", messages };
    });
}
