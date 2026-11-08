/**
 * `rcode gateway` — a long-running daemon that lets you talk to rcode from your phone and chat apps.
 * One AgentSession per conversation (persisted, resumable), approvals relayed as buttons, streaming via
 * message edits, chat commands, scheduled prompts. Default-deny: only paired/allowlisted users.
 */
import { createInterface } from "node:readline";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserContent } from "../ai/types.ts";
import { AgentSession } from "../core/session.ts";
import { loadAuth, loadConfig } from "../config.ts";
import { RCODE_HOME } from "../session/store.ts";
import type { PermissionMode } from "../permissions/policy.ts";
import { TelegramChannel } from "./telegram.ts";
import type { ChannelAdapter, GatewayConfig, IncomingMessage } from "./types.ts";
import { WebChannel } from "./web.ts";

const STATE = () => join(RCODE_HOME, "gateway.json");
interface GatewayState { telegramAllowed: string[]; sessions: Record<string, string>; pending: Record<string, { userId: string; userName?: string; expires: number }>; telegramOffset?: number }
export function loadState(): GatewayState { try { return { telegramAllowed: [], sessions: {}, pending: {}, ...JSON.parse(readFileSync(STATE(), "utf8")) }; } catch { return { telegramAllowed: [], sessions: {}, pending: {} }; } }
export function saveState(s: GatewayState) { mkdirSync(RCODE_HOME, { recursive: true }); writeFileSync(STATE(), JSON.stringify(s, null, 2), { mode: 0o600 }); }

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const hashCode = (c: string) => createHash("sha256").update(c.trim().toUpperCase()).digest("hex");

/** Create (or reuse) a pairing code for an unknown user. Codes are stored hashed; max 3 pending; 1h expiry. */
export function createPairCode(userId: string, userName?: string): string | undefined {
  const st = loadState();
  for (const [h, p] of Object.entries(st.pending)) if (p.expires < Date.now()) delete st.pending[h];
  if (Object.values(st.pending).some((p) => p.userId === userId)) { saveState(st); return undefined; } // already has a live code
  if (Object.keys(st.pending).length >= 3) { saveState(st); return undefined; }
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  st.pending[hashCode(code)] = { userId, userName, expires: Date.now() + 60 * 60_000 };
  saveState(st);
  return code;
}

/** Approve a pending pairing code (works from a separate `rcode gateway pair` process). */
export function pairCode(code: string): string | undefined {
  const st = loadState();
  const h = hashCode(code);
  const p = st.pending[h];
  if (!p || p.expires < Date.now()) return undefined;
  delete st.pending[h];
  st.telegramAllowed = [...new Set([...st.telegramAllowed, p.userId])];
  saveState(st);
  return p.userName ?? p.userId;
}

export async function runGateway(opts: { cwd: string; model?: string; web?: boolean; port?: number; host?: string; mode?: PermissionMode }): Promise<number> {
  const cfg = loadConfig(opts.cwd);
  const g: GatewayConfig = (cfg as any).gateway ?? {};
  const state = loadState();
  const cwd = g.cwd ?? opts.cwd;
  const mode: PermissionMode = opts.mode ?? g.mode ?? "ask";
  const channels: ChannelAdapter[] = [];
  const telegramToken = g.telegram?.token ?? process.env.TELEGRAM_BOT_TOKEN ?? loadAuth().telegram;
  let telegram: TelegramChannel | undefined;
  if (telegramToken) {
    const fixed = new Set(g.telegram?.allowedUsers ?? []);
    let cache = { at: 0, ids: new Set<string>() };
    const isAllowed = (uid: string) => {
      if (fixed.has(uid)) return true;
      if (Date.now() - cache.at > 2000) cache = { at: Date.now(), ids: new Set(loadState().telegramAllowed) };
      return cache.ids.has(uid);
    };
    telegram = new TelegramChannel(telegramToken, isAllowed, (userId, userName) => createPairCode(userId, userName), {
      get: () => loadState().telegramOffset ?? 0,
      set: (n) => { const st = loadState(); st.telegramOffset = n; saveState(st); },
    });
    channels.push(telegram);
  }
  if (opts.web !== false) channels.push(new WebChannel(opts.port ?? g.web?.port ?? 7788, opts.host ?? g.web?.host ?? "127.0.0.1", g.web?.token));
  if (!channels.length) { console.error("No channels. Set TELEGRAM_BOT_TOKEN (or `rcode login telegram <token>`) and/or enable the web UI."); return 2; }

  const sessions = new Map<string, Promise<AgentSession>>();
  const approvals = new Map<string, { resolve: (d: "allow" | "allow-session" | "deny") => void; conv: string; channel: string }>();
  const chanFor = (name: string) => channels.find((c) => c.name === name)!;

  function sessionFor(m: IncomingMessage): Promise<AgentSession> {
    const key = `${m.channel}|${m.conversationId}`;
    const existing = sessions.get(key);
    if (existing) return existing; // the promise is cached first, so concurrent messages share one session
    const ch = chanFor(m.channel);
    const prev = loadState().sessions[key];
    const created = new AgentSession({
      cwd, model: opts.model ?? g.model, mode,
      resume: prev && existsSync(prev) ? prev : undefined,
      asker: (req) => new Promise((resolve) => {
        const id = randomBytes(8).toString("hex");
        approvals.set(id, { resolve, conv: m.conversationId, channel: m.channel });
        const detail = typeof req.args.command === "string" ? `$ ${req.args.command}` : JSON.stringify(req.args, null, 1).slice(0, 3000);
        ch.askApproval(m.conversationId, { id, title: `${req.tool.label ?? req.tool.name}: ${req.summary}`, reason: req.reason, detail })
          .catch(() => { approvals.delete(id); resolve("deny"); }); // undeliverable → deny
        setTimeout(() => { const p = approvals.get(id); if (p) { approvals.delete(id); p.resolve("deny"); void ch.send(m.conversationId, "⌛ Approval timed out — denied."); } }, 15 * 60_000);
      }),
    }).init().then((s) => { const st = loadState(); st.sessions[key] = s.session.file; saveState(st); return s; });
    created.catch(() => sessions.delete(key));
    sessions.set(key, created);
    return created;
  }

  async function command(m: IncomingMessage, s: AgentSession, ch: ChannelAdapter): Promise<boolean> {
    const [cmd, ...rest] = m.text.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/start": case "/help": await ch.send(m.conversationId, "rcode remote. Just type a task.\n/new fresh session · /stop interrupt · /status · /mode ask|auto-edit|plan · /model <ref> · /undo"); return true;
      case "/new": { s.newSession(); const st = loadState(); st.sessions[`${m.channel}|${m.conversationId}`] = s.session.file; saveState(st); } await ch.send(m.conversationId, "🆕 New session."); return true;
      case "/stop": for (const [id, p] of approvals) if (p.conv === m.conversationId && p.channel === m.channel) { approvals.delete(id); p.resolve("deny"); } s.abort(); await ch.send(m.conversationId, "⏹ Interrupted."); return true;
      case "/status": { const u = s.agent.usage; await ch.send(m.conversationId, `model ${s.model.provider}/${s.model.id}\nmode ${s.mode}\n${s.isRunning ? "working" : "idle"} · ${s.messages.length} messages · $${u.cost.total.toFixed(4)}\ncwd ${s.cwd}`); return true; }
      case "/mode":
        if (arg === "full" && g.mode !== "full") { await ch.send(m.conversationId, "Full-auto from chat is disabled. Set gateway.mode = \"full\" in config to allow it."); return true; }
        if (["ask", "auto-edit", "plan", "full"].includes(arg)) { s.setMode(arg as PermissionMode); await ch.send(m.conversationId, `mode → ${arg}`); } else await ch.send(m.conversationId, `mode: ${s.mode}`);
        return true;
      case "/model": if (arg) { try { const md = s.setModel(arg); await ch.send(m.conversationId, `model → ${md.provider}/${md.id}`); } catch (e) { await ch.send(m.conversationId, (e as Error).message); } } else await ch.send(m.conversationId, `model: ${s.model.provider}/${s.model.id}`); return true;
      case "/undo": { const r = s.undo(); await ch.send(m.conversationId, r ? `↩️ reverted ${r.files.length} file(s)` : "nothing to undo"); return true; }
    }
    return false;
  }

  async function onMessage(m: IncomingMessage) {
    const ch = chanFor(m.channel);
    try {
      const s = await sessionFor(m);
      if (m.text.startsWith("/") && (await command(m, s, ch))) return;
      if (s.isRunning) { s.steer(m.text); await ch.send(m.conversationId, "↳ added to the running task"); return; }
      await ch.typing?.(m.conversationId);
      const handle = await ch.reply(m.conversationId, "…");
      let text = "", toolLine = "";
      const off = s.subscribe((e) => {
        if (e.type === "message_update" && e.delta?.kind === "text") { text += e.delta.text; void handle.update(text + toolLine); }
        else if (e.type === "tool_start") { toolLine = `\n\n⚙️ ${e.name} ${e.summary ?? ""}`.slice(0, 300); void handle.update((text || "") + toolLine); }
        else if (e.type === "tool_end") { toolLine = ""; }
        else if (e.type === "message_end" && e.message.content.some((c) => c.type === "toolCall")) { /* keep streaming the same message */ }
      });
      const images: UserContent[] = (m.images ?? []).map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }));
      const ticker = setInterval(() => void ch.typing?.(m.conversationId), 4500);
      try { await s.prompt(m.text, images); } finally { clearInterval(ticker); off(); }
      const last = [...s.messages].reverse().find((x) => x.role === "assistant");
      const finalText = last?.role === "assistant" ? (last.stopReason === "error" ? `⚠️ ${last.errorMessage}` : last.content.filter((c) => c.type === "text").map((c: any) => c.text).join("")) : text;
      await handle.finish(finalText || text || "(done)");
    } catch (e) {
      await ch.send(m.conversationId, `⚠️ ${(e as Error).message}`).catch(() => {});
    }
  }

  const onApproval = (channel: string) => (id: string, decision: "allow" | "allow-session" | "deny", _userId: string, conv: string) => {
    const p = approvals.get(id);
    // An approval can only be answered from the conversation (and channel) that raised it.
    if (!p || p.conv !== conv || p.channel !== channel) return;
    approvals.delete(id);
    p.resolve(decision);
  };

  for (const ch of channels) await ch.start((m) => void onMessage(m), onApproval(ch.name));

  // Scheduled prompts ("every 30m", "every 2h", "daily 09:00")
  for (const sch of g.schedules ?? []) {
    const [chName, ...convParts] = sch.conversation.split(":");
    const fire = () => void onMessage({ channel: chName!, conversationId: convParts.join(":") || "web", userId: "scheduler", text: sch.prompt });
    const every = sch.every?.match(/^(\d+)\s*(m|h)$/);
    if (every) setInterval(fire, Number(every[1]) * (every[2] === "h" ? 3_600_000 : 60_000));
    const at = sch.at?.match(/^daily\s+(\d\d):(\d\d)$/);
    if (at) {
      const tick = () => { const n = new Date(); const t = new Date(n); t.setHours(Number(at[1]), Number(at[2]), 0, 0); if (t <= n) t.setDate(t.getDate() + 1); setTimeout(() => { fire(); tick(); }, t.getTime() - n.getTime()); };
      tick();
    }
  }

  console.log(`[gateway] ready · cwd ${cwd} · mode ${mode} · channels: ${channels.map((c) => c.name).join(", ")}`);
  console.log(`[gateway] console: type "pair <CODE>" to approve a Telegram user, "quit" to stop`);
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => {
      const [c, a] = l.trim().split(/\s+/);
      if (c === "pair" && a) { const who = pairCode(a); console.log(who ? `[gateway] paired ${who}` : "[gateway] unknown or expired code"); }
      else if (c === "quit") void shutdown();
    });
  }
  const shutdown = async () => { for (const ch of channels) await ch.stop(); for (const s of sessions.values()) await (await s.catch(() => undefined))?.dispose(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return new Promise<number>(() => {});
}
