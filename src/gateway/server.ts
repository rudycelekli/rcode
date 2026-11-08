/**
 * `rcode gateway` — a long-running daemon that lets you talk to rcode from your phone and chat apps
 * (Telegram, Slack, Discord, built-in web UI).
 *   · default deny: only paired users; roles — owner (approve, change settings, schedule) vs user (chat only)
 *   · one AgentSession per conversation (persisted, resumable); approvals as buttons bound to their conversation
 *   · streaming replies via message edits; chat commands; jobs (/every, /daily) that cannot create more jobs
 *   · single instance per machine (lock file)
 */
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { UserContent } from "../ai/types.ts";
import { AgentSession } from "../core/session.ts";
import { loadAuth, loadConfig } from "../config.ts";
import type { PermissionMode } from "../permissions/policy.ts";
import { DiscordChannel } from "./discord.ts";
import { SlackChannel } from "./slack.ts";
import { acquireLock, createPairCode, loadState, pairCode, redeemLink, releaseLock, roleOf, updateState, type Job, type Role } from "./state.ts";
import { TelegramChannel } from "./telegram.ts";
import type { ChannelAdapter, ChannelAuth, GatewayConfig, IncomingMessage } from "./types.ts";
import { WebChannel } from "./web.ts";

export { createPairCode, pairCode, loadState } from "./state.ts";

const HELP = `rcode remote — just type a task.
/new fresh session · /stop interrupt · /status · /undo
/mode ask|auto-edit|plan · /model <ref>          (owner)
/every 30m <prompt> · /daily 09:00 <prompt> · /jobs · /unjob <id>   (owner)`;

export async function runGateway(opts: { cwd: string; model?: string; web?: boolean; port?: number; host?: string; mode?: PermissionMode }): Promise<number> {
  const lock = acquireLock();
  if (!lock.ok) { console.error(`rcode gateway is already running (pid ${lock.pid}). Stop it first, or use that instance.`); return 1; }
  const cfg = loadConfig(opts.cwd);
  const g: GatewayConfig = (cfg as any).gateway ?? {};
  const cwd = g.cwd ?? opts.cwd;
  const mode: PermissionMode = opts.mode ?? g.mode ?? "ask";
  const auth = loadAuth();
  const channels: ChannelAdapter[] = [];

  const fixedFor = (ch: string) => ({ owners: (g as any)[ch]?.owners as string[] | undefined, users: (g as any)[ch]?.allowedUsers as string[] | undefined });
  const role = (ch: string, uid: string): Role | undefined => (ch === "web" ? "owner" : roleOf(ch, uid, fixedFor(ch)));
  const authFor = (ch: string): ChannelAuth => ({
    isAllowed: (uid) => !!role(ch, uid),
    onUnknown: (uid, name, text) => {
      const tok = text.match(/^(?:\/start|pair)\s+(\S{16,})$/)?.[1] ?? (/^\S{24,}$/.test(text.trim()) ? text.trim() : undefined);
      if (tok) {
        const r = redeemLink(tok, ch, uid, name);
        if (r) { console.log(`[gateway] ${ch}: ${name ?? uid} paired via link as ${r}`); return `✅ Paired as ${r}. Send /help to get started.`; }
      }
      const code = createPairCode(ch, uid, name);
      if (!code) return undefined;
      console.log(`[gateway] ${ch}: pairing request from ${name ?? uid} — approve with: rcode gateway pair ${code}`);
      return `🔒 This rcode instance is private.\nPairing code: ${code}\nAsk the owner to run: rcode gateway pair ${code}`;
    },
  });

  const telegramToken = g.telegram?.token ?? process.env.TELEGRAM_BOT_TOKEN ?? auth.telegram;
  let telegram: TelegramChannel | undefined;
  if (telegramToken) {
    telegram = new TelegramChannel(telegramToken, authFor("telegram"), {
      get: () => loadState().telegramOffset ?? 0,
      set: (n) => updateState((st) => { st.telegramOffset = n; }),
    });
    channels.push(telegram);
  }
  const slackBot = g.slack?.botToken ?? process.env.SLACK_BOT_TOKEN ?? auth.slack;
  const slackApp = g.slack?.appToken ?? process.env.SLACK_APP_TOKEN ?? auth["slack-app"];
  if (slackBot && slackApp) channels.push(new SlackChannel(slackBot, slackApp, authFor("slack")));
  const discordToken = g.discord?.token ?? process.env.DISCORD_BOT_TOKEN ?? auth.discord;
  if (discordToken) channels.push(new DiscordChannel(discordToken, authFor("discord")));
  if (opts.web !== false) channels.push(new WebChannel(opts.port ?? g.web?.port ?? 7788, opts.host ?? g.web?.host ?? "127.0.0.1", g.web?.token));
  if (!channels.length) { console.error("No channels configured. See `rcode gateway --help`."); releaseLock(); return 2; }

  const sessions = new Map<string, Promise<AgentSession>>();
  const approvals = new Map<string, { resolve: (d: "allow" | "allow-session" | "deny") => void; conv: string; channel: string }>();
  const chanFor = (name: string) => channels.find((c) => c.name === name);

  function sessionFor(m: IncomingMessage): Promise<AgentSession> {
    const key = `${m.channel}|${m.conversationId}`;
    const existing = sessions.get(key);
    if (existing) return existing; // cached first, so concurrent messages share one session
    const ch = chanFor(m.channel)!;
    const prev = loadState().sessions[key];
    const created = new AgentSession({
      cwd, model: opts.model ?? g.model, mode,
      resume: prev && existsSync(prev) ? prev : undefined,
      asker: (req) => new Promise((resolve) => {
        const id = randomBytes(8).toString("hex");
        approvals.set(id, { resolve, conv: m.conversationId, channel: m.channel });
        const detail = typeof req.args.command === "string" ? `$ ${req.args.command}` : JSON.stringify(req.args, null, 1).slice(0, 3000);
        ch.askApproval(m.conversationId, { id, title: `${req.tool.label ?? req.tool.name}: ${req.summary}`, reason: req.reason, detail })
          .catch(() => { approvals.delete(id); resolve("deny"); });
        setTimeout(() => { const p = approvals.get(id); if (p) { approvals.delete(id); p.resolve("deny"); void ch.send(m.conversationId, "⌛ Approval timed out — denied."); } }, 15 * 60_000);
      }),
    }).init().then((s) => { updateState((st) => { st.sessions[key] = s.session.file; }); return s; });
    created.catch(() => sessions.delete(key));
    sessions.set(key, created);
    return created;
  }

  // ── jobs ──
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function schedule(job: Job) {
    const fire = () => void onMessage({ channel: job.channel, conversationId: job.conversationId, userId: "scheduler", role: "scheduler", text: job.prompt });
    const every = job.every?.match(/^(\d+)\s*(m|h|d)$/);
    if (every) {
      const ms = Number(every[1]) * (every[2] === "d" ? 86_400_000 : every[2] === "h" ? 3_600_000 : 60_000);
      timers.set(job.id, setInterval(fire, Math.max(ms, 5 * 60_000)));
    }
    const at = job.at?.match(/^(\d{1,2}):(\d\d)$/);
    if (at) {
      const tick = () => { const n = new Date(); const t = new Date(n); t.setHours(Number(at[1]), Number(at[2]), 0, 0); if (t <= n) t.setDate(t.getDate() + 1); timers.set(job.id, setTimeout(() => { fire(); tick(); }, t.getTime() - n.getTime())); };
      tick();
    }
  }
  function unschedule(id: string) { const t = timers.get(id); if (t) { clearTimeout(t); clearInterval(t); timers.delete(id); } }

  async function command(m: IncomingMessage, s: AgentSession, ch: ChannelAdapter): Promise<boolean> {
    const [cmd, ...rest] = m.text.trim().split(/\s+/);
    const arg = rest.join(" ");
    const ownerOnly = async () => { if (m.role !== "owner") { await ch.send(m.conversationId, "🔐 Only an owner can do that."); return true; } return false; };
    switch (cmd) {
      case "/start": case "/help": await ch.send(m.conversationId, HELP); return true;
      case "/new": s.newSession(); updateState((st) => { st.sessions[`${m.channel}|${m.conversationId}`] = s.session.file; }); await ch.send(m.conversationId, "🆕 New session."); return true;
      case "/stop": for (const [id, p] of approvals) if (p.conv === m.conversationId && p.channel === m.channel) { approvals.delete(id); p.resolve("deny"); } s.abort(); await ch.send(m.conversationId, "⏹ Interrupted."); return true;
      case "/status": { const u = s.agent.usage; await ch.send(m.conversationId, `model ${s.model.provider}/${s.model.id}\nmode ${s.mode}\n${s.isRunning ? "working" : "idle"} · ${s.messages.length} messages · $${u.cost.total.toFixed(4)}\ncwd ${s.cwd}\nyou: ${m.role}`); return true; }
      case "/undo": { const r = s.undo(); await ch.send(m.conversationId, r ? `↩️ reverted ${r.files.length} file(s)` : "nothing to undo"); return true; }
      case "/mode":
        if (await ownerOnly()) return true;
        if (arg === "full" && g.mode !== "full") { await ch.send(m.conversationId, "Full-auto from chat is disabled. Set gateway.mode = \"full\" in config to allow it."); return true; }
        if (["ask", "auto-edit", "plan", "full"].includes(arg)) { s.setMode(arg as PermissionMode); await ch.send(m.conversationId, `mode → ${arg}`); } else await ch.send(m.conversationId, `mode: ${s.mode}`);
        return true;
      case "/model":
        if (arg && (await ownerOnly())) return true;
        if (arg) { try { const md = s.setModel(arg); await ch.send(m.conversationId, `model → ${md.provider}/${md.id}`); } catch (e) { await ch.send(m.conversationId, (e as Error).message); } }
        else await ch.send(m.conversationId, `model: ${s.model.provider}/${s.model.id}`);
        return true;
      case "/every": case "/daily": {
        if (await ownerOnly()) return true;
        const [when, ...p] = rest;
        const prompt = p.join(" ").trim();
        const valid = cmd === "/every" ? /^\d+\s*(m|h|d)$/.test(when ?? "") : /^\d{1,2}:\d\d$/.test(when ?? "");
        if (!valid || !prompt) { await ch.send(m.conversationId, cmd === "/every" ? "usage: /every 30m|2h|1d <prompt>  (minimum 5m)" : "usage: /daily 09:00 <prompt>"); return true; }
        const job: Job = { id: randomBytes(3).toString("hex"), channel: m.channel, conversationId: m.conversationId, ...(cmd === "/every" ? { every: when } : { at: when }), prompt, createdBy: m.userId };
        updateState((st) => { st.jobs.push(job); });
        schedule(job);
        await ch.send(m.conversationId, `⏰ job ${job.id}: ${cmd === "/every" ? `every ${when}` : `daily at ${when}`} — "${prompt.slice(0, 80)}"`);
        return true;
      }
      case "/jobs": {
        const jobs = loadState().jobs.filter((j) => j.channel === m.channel && j.conversationId === m.conversationId);
        await ch.send(m.conversationId, jobs.length ? jobs.map((j) => `${j.id} · ${j.every ? `every ${j.every}` : `daily ${j.at}`} · ${j.prompt.slice(0, 60)}`).join("\n") : "no jobs here");
        return true;
      }
      case "/unjob": {
        if (await ownerOnly()) return true;
        let found = false;
        updateState((st) => { const n = st.jobs.length; st.jobs = st.jobs.filter((j) => !(j.id === arg && j.channel === m.channel && j.conversationId === m.conversationId)); found = st.jobs.length < n; });
        if (found) unschedule(arg);
        await ch.send(m.conversationId, found ? `removed job ${arg}` : `no job ${arg} here`);
        return true;
      }
    }
    return false;
  }

  async function onMessage(m: IncomingMessage) {
    const ch = chanFor(m.channel);
    if (!ch) return;
    if (m.role !== "scheduler") m.role = role(m.channel, m.userId);
    if (!m.role) return; // adapters already filter; defense in depth
    try {
      const s = await sessionFor(m);
      if (m.text.startsWith("/")) {
        if (m.role === "scheduler") return; // scheduled prompts can't run commands (no jobs creating jobs)
        if (await command(m, s, ch)) return;
      }
      if (s.isRunning) { s.steer(m.text); await ch.send(m.conversationId, "↳ added to the running task"); return; }
      await ch.typing?.(m.conversationId);
      const handle = await ch.reply(m.conversationId, m.role === "scheduler" ? "⏰ scheduled run…" : "…");
      let text = "", toolLine = "";
      const off = s.subscribe((e) => {
        if (e.type === "message_update" && e.delta?.kind === "text") { text += e.delta.text; void handle.update(text + toolLine); }
        else if (e.type === "tool_start") { toolLine = `\n\n⚙️ ${e.name} ${e.summary ?? ""}`.slice(0, 300); void handle.update((text || "") + toolLine); }
        else if (e.type === "tool_end") toolLine = "";
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

  const onApproval = (channel: string) => (id: string, decision: "allow" | "allow-session" | "deny", userId: string, conv: string) => {
    const p = approvals.get(id);
    // Bound to the conversation + channel that raised it, and only owners may approve.
    if (!p || p.conv !== conv || p.channel !== channel) return;
    if (role(channel, userId) !== "owner") { void chanFor(channel)?.send(conv, "🔐 Only an owner can answer approvals."); return; }
    approvals.delete(id);
    p.resolve(decision);
  };

  for (const ch of channels) {
    try { await ch.start((m) => void onMessage(m), onApproval(ch.name)); }
    catch (e) { console.error(`[gateway] ${ch.name} failed to start: ${(e as Error).message}`); }
  }

  for (const sch of g.schedules ?? []) {
    const [chName, ...convParts] = sch.conversation.split(":");
    schedule({ id: `cfg-${Math.random().toString(36).slice(2, 6)}`, channel: chName!, conversationId: convParts.join(":") || "web", every: sch.every, at: sch.at?.replace(/^daily\s+/, ""), prompt: sch.prompt, createdBy: "config" });
  }
  for (const job of loadState().jobs) schedule(job);

  console.log(`[gateway] ready · cwd ${cwd} · mode ${mode} · channels: ${channels.map((c) => c.name).join(", ")}`);
  if (telegram?.username) console.log(`[gateway] pair your phone: rcode gateway link   (or DM @${telegram.username} and approve the code)`);
  const shutdown = async () => { for (const t of timers.keys()) unschedule(t); for (const ch of channels) await ch.stop().catch(() => {}); for (const s of sessions.values()) await (await s.catch(() => undefined))?.dispose(); releaseLock(); process.exit(0); };
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => {
      const [c, a] = l.trim().split(/\s+/);
      if (c === "pair" && a) { const r = pairCode(a); console.log(r ? `[gateway] paired ${r.who} on ${r.channel}` : "[gateway] unknown or expired code"); }
      else if (c === "quit") void shutdown();
    });
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("exit", releaseLock);
  return new Promise<number>(() => {});
}
