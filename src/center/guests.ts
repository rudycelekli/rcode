/**
 * Guest engines for the command center.
 *
 * Claude and Codex keep the user's own subscription login and run their own tools.
 * rcode hosts the thread and shows what they stream. It does not read their credentials,
 * and its permission checks do not apply to what a guest does. The center says so.
 */
import { spawn } from "node:child_process";

export type GuestEngine = "claude" | "codex";
export type GuestEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary: string; status: "run" | "ok" | "fail" }
  | { type: "note"; text: string; key: string }
  | { type: "done"; text?: string; error?: string };

export const GUEST_NOTE: Record<GuestEngine, string> = {
  claude: "Claude is signed in with your plan and uses its own tools in this folder. rcode's permission checks and receipts do not cover what it does.",
  codex: "Codex is signed in with your ChatGPT plan and uses its own tools, sandboxed to this folder. rcode's permission checks and receipts do not cover what it does.",
};

export function guestBin(engine: GuestEngine): string {
  if (engine === "claude") return process.env.RCODE_CLAUDE_BIN ?? "claude";
  return process.env.RCODE_CODEX_BIN ?? "codex";
}

/** Args only. The prompt is written to stdin, so it can never be read as a flag. */
export function guestArgs(engine: GuestEngine): string[] {
  if (engine === "claude") {
    return ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "acceptEdits"];
  }
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", "--approve-for-me", "-"];
}

function friendly(engine: GuestEngine, raw: string): string {
  if (/authenticat|401|expired|not logged in|\blogin\b|re-?authenticate/i.test(raw)) {
    return engine === "claude"
      ? "Claude isn't signed in. Run `claude`, type /login, finish the browser sign-in, then try again."
      : "Codex isn't signed in. Run `codex login`, finish the browser sign-in, then try again.";
  }
  return raw.trim().slice(0, 400) || `${engine} returned no output`;
}

export function parseClaudeLine(line: string): GuestEvent[] {
  let m: any; try { m = JSON.parse(line); } catch { return []; }
  const out: GuestEvent[] = [];
  if (m.type === "stream_event" && m.event?.delta?.type === "text_delta" && m.event.delta.text) out.push({ type: "delta", text: m.event.delta.text });
  if (m.type === "assistant") {
    for (const c of m.message?.content ?? []) {
      if (c.type === "tool_use") out.push({ type: "tool", name: String(c.name ?? "tool"), summary: JSON.stringify(c.input ?? {}).slice(0, 180), status: "run" });
    }
  }
  if (m.type === "user") {
    for (const c of m.message?.content ?? []) {
      if (c.type === "tool_result") out.push({ type: "tool", name: "tool", summary: "", status: c.is_error ? "fail" : "ok" });
    }
  }
  if (m.type === "result") out.push(m.is_error ? { type: "done", error: friendly("claude", String(m.result ?? "")) } : { type: "done", text: String(m.result ?? "") });
  const novel = claudeNovel(m);
  if (novel && !out.length) out.push(novel);
  return out;
}

const CLAUDE_QUIET = new Set(["system", "rate_limit_event", "assistant", "user", "result"]);
const CLAUDE_DELTA_QUIET = new Set(["text_delta", "content_block_start", "content_block_stop", "message_start", "message_delta", "message_stop", "ping"]);

/** A Claude event we do not render yet. Shown once per kind so a new protocol message is visible the day they ship it. */
function claudeNovel(m: any): GuestEvent | undefined {
  if (m.type === "stream_event") {
    const kind = String(m.event?.delta?.type ?? m.event?.type ?? "");
    if (!kind || CLAUDE_DELTA_QUIET.has(kind)) return;
    return { type: "note", key: `claude:${kind}`, text: `Claude sent a new event (${kind}).` };
  }
  if (!m.type || CLAUDE_QUIET.has(m.type)) return;
  return { type: "note", key: `claude:${m.type}`, text: `Claude sent a new event (${String(m.type).slice(0, 60)}).` };
}

export function parseCodexLine(line: string): GuestEvent[] {
  let m: any; try { m = JSON.parse(line); } catch { return []; }
  const item = m.item ?? {};
  if (m.type === "item.started" && item.type === "command_execution") return [{ type: "tool", name: "command", summary: String(item.command ?? "").slice(0, 180), status: "run" }];
  if (m.type === "item.completed" && item.type === "command_execution") return [{ type: "tool", name: "command", summary: String(item.command ?? "").slice(0, 180), status: item.exit_code ? "fail" : "ok" }];
  if (m.type === "item.completed" && item.type === "agent_message" && item.text) return [{ type: "delta", text: String(item.text) }];
  if (m.type === "turn.completed") return [{ type: "done" }];
  if (m.type === "error") return [{ type: "done", error: friendly("codex", String(m.message ?? m.error ?? "")) }];
  const kind = String(item.type ?? "");
  if ((m.type === "item.started" || m.type === "item.completed") && kind && kind !== "command_execution" && kind !== "agent_message") {
    return [{ type: "note", key: `codex:${kind}`, text: `Codex sent a new ${kind.slice(0, 60)}.` }];
  }
  if (m.type && !["thread.started", "turn.started", "item.started", "item.completed"].includes(m.type)) {
    return [{ type: "note", key: `codex:${m.type}`, text: `Codex sent a new event (${String(m.type).slice(0, 60)}).` }];
  }
  return [];
}

const parse = (engine: GuestEngine, line: string) => (engine === "claude" ? parseClaudeLine(line) : parseCodexLine(line));

/** Run one guest turn. Resolves when the process exits. Never throws for a guest failure; it emits done. */
export function runGuest(o: { engine: GuestEngine; prompt: string; cwd: string; signal?: AbortSignal; onEvent: (e: GuestEvent) => void }): Promise<void> {
  const bin = guestBin(o.engine);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, guestArgs(o.engine), { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (e) {
      o.onEvent({ type: "done", error: (e as Error).message });
      resolve();
      return;
    }
    const kill = () => { try { child.kill("SIGTERM"); } catch {} };
    o.signal?.addEventListener("abort", kill, { once: true });
    let buf = "", err = "", sawDone = false;
    const noted = new Set<string>();
    const emit = (e: GuestEvent) => {
      if (e.type === "note") { if (noted.has(e.key)) return; noted.add(e.key); }
      if (e.type === "done") sawDone = true;
      o.onEvent(e);
    };
    const out = child.stdout, errPipe = child.stderr, input = child.stdin;
    if (!out || !errPipe || !input) { emit({ type: "done", error: "could not start the guest" }); resolve(); return; }
    out.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) for (const e of parse(o.engine, line)) emit(e); }
    });
    errPipe.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e: any) => {
      emit({ type: "done", error: e?.code === "ENOENT" ? `${bin} is not installed.` : e.message });
      resolve();
    });
    child.on("close", () => {
      o.signal?.removeEventListener("abort", kill);
      if (buf.trim()) for (const e of parse(o.engine, buf.trim())) emit(e);
      if (o.signal?.aborted) { if (!sawDone) emit({ type: "done", error: "stopped" }); }
      else if (!sawDone) emit({ type: "done", error: friendly(o.engine, err) });
      resolve();
    });
    input.on("error", () => {});
    input.end(o.prompt);
  });
}
