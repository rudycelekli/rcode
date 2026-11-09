/**
 * `rcode center` — a local command center.
 *
 * One screen for the work rcode already does: several threads, a crash-safe mission queue,
 * live tool calls, approvals, and a receipt after every turn. Studied the host-and-threads
 * shape of t3code (MIT, T3 Tools Inc.); this UI is rcode's own.
 *
 * Binds 127.0.0.1. The page and the socket both require the token printed at startup.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../agent/types.ts";
import type { ServerWebSocket } from "bun";
import { AgentSession } from "../core/session.ts";
import { add, clearFinished, drain, load, type Job } from "../core/queue.ts";
import { listSessions } from "../session/store.ts";
import { runSessionJob } from "./queue.ts";
import { GUEST_NOTE, runGuest, type GuestEngine } from "../center/guests.ts";
import { runAcpGuest, splitCommand } from "../center/acp-guest.ts";
import { addWorktree, claudePlanUsage, codexThreadCount, deviceShot, githubPullRequest, lanHosts, listDevices, saveSpill, spillPaste, turnDiff } from "../center/studio.ts";
import { deviceArgv, startShare, widenPath } from "../center/desk.ts";
import { loadCenterToken } from "../center/token.ts";
import { centerPage } from "../center/page.ts";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const PAGE = centerPage();
const MODES = ["ask", "auto-edit", "full", "plan"];

function branchOf(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 2000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

const engines = () => ({ claude: !!Bun.which("claude"), codex: !!Bun.which("codex") });

function composePrompt(text: string, file?: { name?: string; text?: string }): string {
  const spill = spillPaste(text);
  let out = spill.keep;
  if (spill.spill) out += `\n\nThe rest of the message is in ${saveSpill(spill.spill, "paste.txt")}. Read that file.`;
  if (typeof file?.text === "string" && file.text) out += `\n\nAttached ${file.name || "file"} is in ${saveSpill(String(file.text).slice(0, 200_000), String(file.name || "file.txt"))}. Read that file.`;
  return out;
}

function planUsage() {
  let claude: ReturnType<typeof claudePlanUsage> = [];
  let codex = 0;
  try { claude = claudePlanUsage(readFileSync(join(homedir(), ".claude", "stats-cache.json"), "utf8")); } catch { /* no local Claude stats */ }
  try { codex = codexThreadCount(readFileSync(join(homedir(), ".codex", "session_index.jsonl"), "utf8")); } catch { /* no local Codex index */ }
  return { claude, codex };
}

type Sock = ServerWebSocket<{ id: string }>;

export interface CenterOptions {
  cwd: string;
  port?: number;
  host?: string;
  /** Open a cloudflared link so a device off this network can reach the page. */
  share?: boolean;
  token?: string;
  model?: string;
  /** Override the queue file. Tests use this so they never touch ~/.rcode. */
  queueFile?: string;
}

const MODELS = ["claude-cli/sonnet", "claude-cli/opus", "claude-cli/haiku"];

function authed(token: string, got: string | null) {
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function textOf(content: any[]): string {
  return content.map((c) => (c?.type === "text" ? c.text : "")).join("");
}

function transcript(s: AgentSession) {
  const out: { role: string; text: string; tools?: string[] }[] = [];
  for (const m of s.messages.slice(-40)) {
    if (m.role === "user") {
      const t = textOf(m.content).replace(/<(relevant_memories|stack|active_goal|hook_context)[\s\S]*?<\/\1>\s*/g, "").trim();
      if (t) out.push({ role: "user", text: t.slice(0, 4000) });
    } else if (m.role === "assistant") {
      const say = textOf(m.content).trim();
      const tools = m.content.filter((c) => c.type === "toolCall").map((c: any) => c.name);
      if (say || tools.length) out.push({ role: "agent", text: say.slice(0, 8000), tools });
    }
  }
  return out;
}

/** What an approval card shows: the command, the new file, or the lines an edit swaps. */
export function approvalDetail(args: any): string {
  if (typeof args?.command === "string") return `$ ${args.command}`;
  if (typeof args?.content === "string") return args.content.slice(0, 1500);
  if (Array.isArray(args?.edits)) {
    const minus = (t: unknown) => String(t ?? "").split("\n").map((l) => `- ${l}`).join("\n");
    const plus = (t: unknown) => String(t ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
    return args.edits.map((e: any) => `${minus(e?.old_text)}\n${plus(e?.new_text)}`).join("\n\n").slice(0, 1500);
  }
  return JSON.stringify(args ?? {}).slice(0, 1500);
}

function titleOf(s: AgentSession) {
  const first = s.messages.find((m) => m.role === "user");
  const t = first ? textOf(first.content).replace(/<[\s\S]*?>/g, "").trim() : "";
  return (t || "New thread").slice(0, 80);
}

function jobView(j: Job) {
  return { id: j.id, status: j.status, prompt: j.prompt, verdict: j.verdict, result: j.result?.slice(0, 240), error: j.error?.slice(0, 240) };
}

export async function startCenter(opts: CenterOptions) {
  const token = opts.token ?? randomBytes(18).toString("base64url");
  const host = opts.host ?? "127.0.0.1";
  const file = opts.queueFile;
  const threads = new Map<string, AgentSession>();
  type Hosted = GuestEngine | "agent";
  const guests = new Map<string, { id: string; engine: Hosted; title: string; command?: string; running: boolean; warned: boolean; stop?: () => void }>();
  const approvals = new Map<string, (d: "allow" | "allow-session" | "deny") => void>();
  const sockets = new Set<Sock>();
  let queueRunning = false;
  let share: { url: Promise<string>; stop: () => void } | undefined;

  const send = (ws: Sock, msg: unknown) => { try { ws.send(JSON.stringify(msg)); } catch {} };
  const broadcast = (msg: unknown) => { for (const ws of sockets) send(ws, msg); };
  const jobs = () => (file ? load(file) : load()).map(jobView);
  const pushQueue = () => broadcast({ type: "queue", jobs: jobs(), running: queueRunning });

  function pack(e: AgentEvent): Record<string, unknown> | null {
    switch (e.type) {
      case "agent_start": return { type: "status", running: true };
      case "message_update":
        if (e.delta?.kind === "text" || e.delta?.kind === "thinking") return { type: "delta", kind: e.delta.kind, text: e.delta.text };
        return null;
      case "tool_start": return { type: "tool", id: e.toolCallId, name: e.name, summary: (e.summary ?? "").slice(0, 180), status: "run" };
      case "tool_end": {
        const text = e.result.content.map((c) => (c.type === "text" ? c.text : "")).join("").slice(0, 1500);
        return { type: "tool", id: e.toolCallId, name: e.name, status: e.result.isError ? "fail" : "ok", text };
      }
      case "notice": return { type: "note", text: e.text, level: e.level };
      case "compaction": return { type: "note", text: `Compacted context ${e.before.toLocaleString()} → ${e.after.toLocaleString()} tokens`, level: "info" };
      case "agent_end": return { type: "turn" };
      default: return null;
    }
  }

  function stateOf(s: AgentSession) {
    const r = s.lastReceipt;
    return {
      id: s.session.id, title: titleOf(s), model: `${s.model.provider}/${s.model.id}`, mode: s.mode, plain: s.plain,
      needsModel: s.needsModel, running: s.isRunning, cost: s.agent.usage.cost.total,
      receipt: r ? { hash: r.hash, verdict: r.verdict } : null, guest: false,
    };
  }

  function guestState(g: { id: string; engine: Hosted; title: string; command?: string; running: boolean }) {
    const model = g.engine === "claude" ? "Claude plan" : g.engine === "codex" ? "Codex plan" : (g.command ?? "any agent");
    return { id: g.id, title: g.title, model, mode: "guest", plain: false, needsModel: false, running: g.running, cost: 0, receipt: null, guest: true, engine: g.engine };
  }

  const engineOf = (v: unknown): "rcode" | Hosted => (v === "claude" || v === "codex" || v === "agent" ? v : "rcode");

  const AGENT_NOTE = "This agent uses its own tools and its own sign-in. You still approve what it asks. rcode's threat rules do not run inside it.";

  async function acpTurn(argv: string[], text: string, existing?: string) {
    let g = existing ? guests.get(existing) : undefined;
    if (g?.running) { broadcast({ type: "evt", thread: g.id, evt: { type: "note", level: "warn", text: "Still working. Stop it before sending more." } }); return; }
    if (!g || g.engine !== "agent") {
      g = { id: randomBytes(4).toString("hex"), engine: "agent", title: text.slice(0, 80), command: argv.join(" "), running: false, warned: false };
      guests.set(g.id, g);
      broadcast({ type: "focus", id: g.id, messages: [] });
    }
    g.command = argv.join(" ");
    if (g.title === "New thread") g.title = text.slice(0, 80);
    if (!g.warned) { g.warned = true; broadcast({ type: "evt", thread: g.id, evt: { type: "note", level: "warn", text: AGENT_NOTE } }); }
    broadcast({ type: "you", thread: g.id, text: text.slice(0, 4000) });
    g.running = true;
    broadcast({ type: "thread", thread: guestState(g) });
    const ac = new AbortController();
    g.stop = () => ac.abort();
    const thread = g.id;
    await runAcpGuest({
      argv, cwd: opts.cwd, prompt: text, signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "delta") broadcast({ type: "evt", thread, evt: { type: "delta", kind: "text", text: e.text } });
        else if (e.type === "tool") broadcast({ type: "evt", thread, evt: e });
        else if (e.type === "note") broadcast({ type: "evt", thread, evt: { type: "note", level: "info", text: e.text } });
        else if (e.error) broadcast({ type: "evt", thread, evt: { type: "note", level: "error", text: e.error } });
      },
      onApproval: (req) => new Promise((resolve) => {
        const id = randomBytes(6).toString("hex");
        approvals.set(id, resolve);
        broadcast({ type: "approval", thread, id, title: req.title, reason: req.reason || "The agent wants to use its own tools." });
      }),
    });
    g.running = false;
    g.stop = undefined;
    broadcast({ type: "evt", thread, evt: { type: "turn" } });
    broadcast({ type: "thread", thread: guestState(g) });
  }

  async function guestTurn(engine: GuestEngine, text: string, existing?: string) {
    let g = existing ? guests.get(existing) : undefined;
    if (g?.running) { broadcast({ type: "evt", thread: g.id, evt: { type: "note", level: "warn", text: "Still working. Stop it before sending more." } }); return; }
    if (!g || g.engine !== engine) {
      g = { id: randomBytes(4).toString("hex"), engine, title: text.slice(0, 80), running: false, warned: false };
      guests.set(g.id, g);
      broadcast({ type: "focus", id: g.id, messages: [] });
    }
    if (g.title === "New thread") g.title = text.slice(0, 80);
    if (!g.warned) { g.warned = true; broadcast({ type: "evt", thread: g.id, evt: { type: "note", level: "warn", text: GUEST_NOTE[engine] } }); }
    broadcast({ type: "you", thread: g.id, text: text.slice(0, 4000) });
    g.running = true;
    broadcast({ type: "thread", thread: guestState(g) });
    const ac = new AbortController();
    g.stop = () => ac.abort();
    await runGuest({
      engine, prompt: text, cwd: opts.cwd, signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "delta") broadcast({ type: "evt", thread: g!.id, evt: { type: "delta", kind: "text", text: e.text } });
        else if (e.type === "tool") broadcast({ type: "evt", thread: g!.id, evt: e });
        else if (e.type === "note") broadcast({ type: "evt", thread: g!.id, evt: { type: "note", level: "info", text: e.text } });
        else if (e.error) broadcast({ type: "evt", thread: g!.id, evt: { type: "note", level: "error", text: e.error } });
      },
    });
    g.running = false;
    g.stop = undefined;
    broadcast({ type: "evt", thread: g.id, evt: { type: "turn" } });
    broadcast({ type: "thread", thread: guestState(g) });
  }

  async function open(resume?: string): Promise<AgentSession> {
    if (resume) {
      for (const s of threads.values()) if (s.session.file === resume) return s;
    }
    const holder: { s?: AgentSession } = {};
    const s = await new AgentSession({
      cwd: opts.cwd,
      model: opts.model,
      resume,
      asker: (req) => new Promise((resolve) => {
        const id = randomBytes(6).toString("hex");
        approvals.set(id, resolve);
        const detail = approvalDetail(req.args);
        broadcast({ type: "approval", thread: holder.s!.session.id, id, title: `${req.tool.name}: ${req.summary}`, reason: req.reason, detail });
        setTimeout(() => { const fn = approvals.get(id); if (fn) { approvals.delete(id); fn("deny"); } }, 15 * 60_000);
      }),
    }).init();
    if (s.needsModel && !opts.model && Bun.which("claude")) { s.setModel("claude-cli/sonnet"); s.needsModel = false; }
    holder.s = s;
    threads.set(s.session.id, s);
    s.subscribe((e) => {
      const evt = pack(e);
      if (evt) broadcast({ type: "evt", thread: s.session.id, evt });
      if (e.type === "agent_end") broadcast({ type: "thread", thread: stateOf(s) });
    });
    broadcast({ type: "thread", thread: stateOf(s) });
    return s;
  }

  const recent = () => listSessions(opts.cwd, 12).map((s) => ({ file: s.file, title: s.title, messages: s.messages }));

  const server = Bun.serve({
    port: opts.port ?? 7799,
    hostname: host,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/manifest.webmanifest") return new Response(JSON.stringify({ name: "rcode center", short_name: "rcode", display: "standalone", start_url: "/", background_color: "#000000", theme_color: "#000000" }), { headers: { "content-type": "application/manifest+json" } });
      if (url.pathname === "/device/frame") {
        if (!authed(token, url.searchParams.get("token"))) return new Response("unauthorized", { status: 401 });
        const shot = deviceShot(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "");
        if ("error" in shot) return new Response(shot.error, { status: 404 });
        return new Response(Buffer.from(shot.png, "base64"), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
      }
      if (!authed(token, url.searchParams.get("token"))) return new Response("rcode center: unauthorized", { status: 401 });
      if (url.pathname === "/ws") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== req.headers.get("host")) return new Response("bad origin", { status: 403 });
        return srv.upgrade(req, { data: { id: randomBytes(4).toString("hex") } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:" } });
    },
    websocket: {
      open(ws: Sock) {
        sockets.add(ws);
        const live: object[] = [...threads.values()].map(stateOf);
        live.push(...[...guests.values()].map(guestState));
        send(ws, { type: "ready", cwd: opts.cwd, project: basename(opts.cwd), branch: branchOf(opts.cwd), engines: engines(), models: MODELS, recent: recent(), jobs: jobs(), threads: live, usage: planUsage(), lan: host === "0.0.0.0" ? lanHosts() : [] });
      },
      close(ws: Sock) { sockets.delete(ws); },
      async message(ws: Sock, raw) {
        let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
        try {
          if (m.type === "new") {
            const engine = engineOf(m.engine);
            if (engine !== "rcode") {
              const g = { id: randomBytes(4).toString("hex"), engine, title: "New thread", running: false, warned: false };
              guests.set(g.id, g);
              send(ws, { type: "focus", id: g.id, messages: [] });
              broadcast({ type: "thread", thread: guestState(g) });
              return;
            }
            const s = await open(); send(ws, { type: "focus", id: s.session.id, messages: [] }); return;
          }
          if (m.type === "open" && typeof m.file === "string") {
            const s = await open(m.file);
            send(ws, { type: "focus", id: s.session.id, messages: transcript(s) });
            send(ws, { type: "thread", thread: stateOf(s) });
            return;
          }
          if (m.type === "prompt" && typeof m.text === "string" && m.text.trim()) {
            const engine = engineOf(m.engine);
            const typed = m.text.trim();
            const text = composePrompt(typed, m.file);
            if (engine === "agent") {
              const argv = splitCommand(String(m.command ?? ""));
              if (!argv.length) { send(ws, { type: "note", text: "Type the agent command first. Example: grok acp", level: "warn" }); return; }
              const same = m.thread && guests.get(String(m.thread))?.engine === "agent" ? String(m.thread) : undefined;
              await acpTurn(argv, text, same);
              return;
            }
            if (engine !== "rcode") {
              const same = m.thread && guests.get(String(m.thread))?.engine === engine ? String(m.thread) : undefined;
              await guestTurn(engine, text, same);
              return;
            }
            let s = m.thread ? threads.get(m.thread) : undefined;
            if (!s) {
              s = await open();
              if (typeof m.model === "string" && MODELS.includes(m.model)) { s.setModel(m.model); s.needsModel = false; }
              if (MODES.includes(m.mode)) s.setMode(m.mode);
              broadcast({ type: "thread", thread: stateOf(s) });
              send(ws, { type: "focus", id: s.session.id, messages: transcript(s) });
            }
            if (s.needsModel) { broadcast({ type: "evt", thread: s.session.id, evt: { type: "note", level: "warn", text: "rcode has no model yet. Install Claude Code and sign in (run `claude`, then /login), then pick a Claude model below. Or switch Who to Codex plan." } }); return; }
            broadcast({ type: "you", thread: s.session.id, text: typed.slice(0, 4000) });
            await s.prompt(text);
            const diff = turnDiff(opts.cwd, s.lastReceipt?.filesChanged ?? []);
            if (diff) broadcast({ type: "evt", thread: s.session.id, evt: { type: "diff", text: diff, verdict: s.lastReceipt?.verdict ?? "" } });
            broadcast({ type: "usage", usage: planUsage() });
            broadcast({ type: "thread", thread: stateOf(s) });
            return;
          }
          if (m.type === "stop") { threads.get(String(m.thread))?.abort(); guests.get(String(m.thread))?.stop?.(); return; }
          const s = m.thread ? threads.get(String(m.thread)) : undefined;
          if (m.type === "view" && s) { send(ws, { type: "focus", id: s.session.id, messages: transcript(s) }); return; }
          if (m.type === "mode" && s && MODES.includes(m.mode)) { s.setMode(m.mode); broadcast({ type: "thread", thread: stateOf(s) }); return; }
          if (m.type === "plain" && s) { s.setPlain(!!m.on); broadcast({ type: "thread", thread: stateOf(s) }); return; }
          if (m.type === "model" && s && typeof m.ref === "string") {
            s.setModel(m.ref);
            s.needsModel = false;
            broadcast({ type: "thread", thread: stateOf(s) });
            return;
          }
          if (m.type === "approval") { const fn = approvals.get(String(m.id)); if (fn) { approvals.delete(String(m.id)); fn(m.decision); } return; }
          if (m.type === "undo" && s) {
            const u = s.undo();
            send(ws, { type: "note", text: u ? `Reverted ${u.files.length} file(s) from turn ${u.turn}.` : "Nothing to undo." });
            return;
          }
          if (m.type === "pr") {
            const pr = githubPullRequest(opts.cwd);
            send(ws, { type: "note", text: pr.ok ? `Pull request: ${pr.url}` : pr.error });
            return;
          }
          if (m.type === "worktree" && typeof m.name === "string") {
            const made = addWorktree(opts.cwd, m.name.trim().toLowerCase());
            send(ws, { type: "note", text: made.ok ? `A copy is ready at ${made.path}, on branch rcode/${m.name.trim().toLowerCase()}.` : made.error });
            return;
          }
          if (m.type === "devices") { send(ws, { type: "devices", list: listDevices() }); return; }
          if (m.type === "share") {
            share ??= startShare(server.port ?? 0);
            share.url.then((u) => send(ws, { type: "note", text: `Open this on another device. Cloudflare carries the link, and anyone who has it can drive the agent.\n${u}/?token=${token}` })).catch((e) => send(ws, { type: "note", text: (e as Error).message, level: "error" }));
            return;
          }
          if (m.type === "device" && typeof m.action === "string") {
            const argv = deviceArgv(m.action, { id: String(m.id ?? ""), kind: m.kind === "android" ? "android" : "ios" }, typeof m.x === "number" ? { x: m.x, y: Number(m.y) } : undefined);
            if ("error" in argv) { send(ws, { type: "note", text: argv.error, level: "warn" }); return; }
            const [cmd, ...args] = argv;
            const r = spawnSync(cmd!, args, { encoding: "utf8", timeout: m.action === "boot" ? 45_000 : 8_000 });
            send(ws, { type: "note", text: r.status === 0 ? `${m.action} done.` : (r.stderr || r.stdout || `${m.action} failed.`).trim().slice(0, 300), level: r.status === 0 ? "info" : "warn" });
            if (m.action === "boot" || m.action === "shutdown") send(ws, { type: "devices", list: listDevices() });
            return;
          }
          if (m.type === "shot") {
            const shot = deviceShot(String(m.kind), String(m.id));
            send(ws, "png" in shot ? { type: "shot", png: shot.png } : { type: "note", text: shot.error, level: "warn" });
            return;
          }
          if (m.type === "queue-add" && typeof m.text === "string" && m.text.trim()) {
            file ? add(m.text, opts.cwd, file) : add(m.text, opts.cwd);
            pushQueue();
            return;
          }
          if (m.type === "queue-clear") { file ? clearFinished(file) : clearFinished(); pushQueue(); return; }
          if (m.type === "queue-run") {
            if (queueRunning) { send(ws, { type: "note", text: "A mission run is already going.", level: "warn" }); return; }
            queueRunning = true; pushQueue();
            const model = typeof m.model === "string" ? m.model : opts.model;
            void drain((job) => runSessionJob(job, { mode: m.yes ? "full" : "auto-edit", model }), { file, onStart: pushQueue, onEnd: pushQueue })
              .then(() => { queueRunning = false; pushQueue(); })
              .catch((e) => { queueRunning = false; broadcast({ type: "note", text: (e as Error).message, level: "error" }); pushQueue(); });
            return;
          }
        } catch (e) { send(ws, { type: "note", text: (e as Error).message, level: "error" }); }
      },
    },
  });

  const shownHost = host === "0.0.0.0" ? "localhost" : host;
  const port = server.port ?? 0;
  const url = `http://${shownHost}:${port}/?token=${token}`;
  if (opts.share) {
    share = startShare(port);
    share.url.then((u) => console.log(`  Off this network: ${u}/?token=${token}\n  Cloudflare carries that link. Anyone who has it can drive the agent.`)).catch((e) => console.log(`  Share failed: ${(e as Error).message}`));
  }
  return {
    url, token, port,
    stop: () => { share?.stop(); server.stop(true); for (const s of threads.values()) void s.dispose(); for (const g of guests.values()) g.stop?.(); },
  };
}

export async function runCenter(opts: CenterOptions): Promise<number> {
  process.env.PATH = widenPath();
  const c = await startCenter({ ...opts, token: opts.token ?? loadCenterToken() });
  const reach = opts.host === "0.0.0.0"
    ? "This link works on your network. Anyone who has it can drive the agent. The link is the key."
    : "This page stays on this computer. rcode center --lan opens it to your network.";
  console.log(`rcode center  ${c.url}\n  ${opts.cwd}\n  ${reach}\n  Ctrl+C to stop.`);
  return new Promise(() => {});
}
