/**
 * Slack channel via Socket Mode (no public URL needed) — plain fetch + WebSocket, no SDK.
 *   apps.connections.open (xapp- app token) → wss; events_api (message / app_mention) and interactive
 *   (block_actions) envelopes are acked by envelope_id. Replies via chat.postMessage / chat.update (xoxb- bot token).
 * DMs: one session per DM. Channels: the bot answers when mentioned, in a thread (one session per thread).
 * Required scopes: app_mentions:read, chat:write, im:history, im:read, im:write; Socket Mode enabled.
 */
import type { ApprovalRequest, ChannelAdapter, ChannelAuth, IncomingMessage, OutgoingHandle } from "./types.ts";

const API = "https://slack.com/api";
const MAX = 3800;

export class SlackChannel implements ChannelAdapter {
  readonly name = "slack";
  private ws?: WebSocket;
  private running = false;
  private botUserId = "";
  private lastPairReply = new Map<string, number>();

  constructor(private botToken: string, private appToken: string, private auth: ChannelAuth) {}

  private async api<T = any>(method: string, body: Record<string, unknown>, token = this.botToken): Promise<T> {
    const res = await fetch(`${API}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    if (res.status === 429) { await Bun.sleep(Number(res.headers.get("retry-after") ?? 1) * 1000); return this.api(method, body, token); }
    const j: any = await res.json();
    if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
    return j as T;
  }

  async start(onMessage: (m: IncomingMessage) => void, onApproval: (id: string, d: "allow" | "allow-session" | "deny", userId: string, conv: string) => void) {
    const me = await this.api("auth.test", {});
    this.botUserId = me.user_id;
    this.running = true;
    const connect = async () => {
      const { url } = await this.api("apps.connections.open", {}, this.appToken);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onmessage = (ev) => {
        let env: any; try { env = JSON.parse(String(ev.data)); } catch { return; }
        if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
        if (env.type === "disconnect") { try { ws.close(); } catch {} return; }
        if (env.type === "events_api") void this.onEvent(env.payload?.event, onMessage);
        else if (env.type === "interactive" && env.payload?.type === "block_actions") {
          const p = env.payload;
          const userId = p.user?.id;
          if (!userId || !this.auth.isAllowed(userId)) return;
          for (const act of p.actions ?? []) {
            const [kind, d, id] = String(act.action_id ?? "").split(":");
            const decision = d === "a" ? "allow" : d === "s" ? "allow-session" : d === "d" ? "deny" : undefined;
            if (kind !== "ap1" || !id || !decision) continue;
            const threadTs = p.message?.thread_ts;
            const conv = threadTs ? `${p.channel.id}:${threadTs}` : p.channel.id;
            onApproval(id, decision, userId, conv);
            const label = decision === "deny" ? "❌ Denied" : decision === "allow-session" ? "♾ Allowed for session" : "✅ Allowed once";
            void this.api("chat.update", { channel: p.channel.id, ts: p.message.ts, text: `${p.message.text ?? "Permission"}\n${label}`, blocks: [] }).catch(() => {});
          }
        }
      };
      ws.onclose = () => { if (this.running) setTimeout(() => void connect().catch((e) => console.error(`[gateway] slack reconnect failed: ${e.message}`)), 2000); };
    };
    await connect();
    console.log(`[gateway] slack connected as <@${this.botUserId}>`);
  }

  private async onEvent(ev: any, onMessage: (m: IncomingMessage) => void) {
    if (!ev || ev.bot_id || ev.subtype || !ev.user || ev.user === this.botUserId) return;
    const isDm = ev.channel_type === "im";
    if (ev.type === "message" && !isDm) return; // in channels, respond to app_mention only
    const text = String(ev.text ?? "").replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
    if (!this.auth.isAllowed(ev.user)) {
      if (!isDm) return;
      const last = this.lastPairReply.get(ev.user) ?? 0;
      if (Date.now() - last < 10 * 60_000 && !/^pair\s+\S{16,}/.test(text)) return;
      this.lastPairReply.set(ev.user, Date.now());
      const reply = this.auth.onUnknown(ev.user, undefined, text);
      if (reply) await this.api("chat.postMessage", { channel: ev.channel, text: reply }).catch(() => {});
      return;
    }
    const conv = isDm ? ev.channel : `${ev.channel}:${ev.thread_ts ?? ev.ts}`;
    if (text) onMessage({ channel: this.name, conversationId: conv, userId: ev.user, text, messageId: ev.ts });
  }

  async stop() { this.running = false; try { this.ws?.close(); } catch {} }

  private target(conv: string) { const [channel, thread_ts] = conv.split(":"); return { channel, ...(thread_ts ? { thread_ts } : {}) }; }

  async send(conv: string, text: string) { for (const part of split(text)) await this.api("chat.postMessage", { ...this.target(conv), text: part }).catch(() => {}); }

  async reply(conv: string, initial: string): Promise<OutgoingHandle> {
    const r = await this.api("chat.postMessage", { ...this.target(conv), text: initial || "…" });
    let pending: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, lastAt = 0;
    const flush = async () => { timer = undefined; if (pending === undefined) return; const t = pending.length > MAX ? "…" + pending.slice(-(MAX - 1)) : pending; pending = undefined; lastAt = Date.now(); await this.api("chat.update", { channel: r.channel, ts: r.ts, text: t }).catch(() => {}); };
    return {
      update: async (t) => { pending = t; if (!timer) timer = setTimeout(flush, Math.max(0, 1100 - (Date.now() - lastAt))); },
      finish: async (t) => {
        if (timer) clearTimeout(timer);
        const parts = split(t || "(no response)");
        await this.api("chat.update", { channel: r.channel, ts: r.ts, text: parts[0] }).catch(() => {});
        for (const p of parts.slice(1)) await this.api("chat.postMessage", { ...this.target(conv), text: p }).catch(() => {});
      },
    };
  }

  async askApproval(conv: string, req: ApprovalRequest) {
    const head = `⚠️ Permission needed (${req.reason})\n${req.title.slice(0, 400)}`;
    await this.api("chat.postMessage", {
      ...this.target(conv),
      text: head,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: head.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!) } },
        ...(req.detail ? [{ type: "section", text: { type: "mrkdwn", text: "```" + req.detail.slice(0, 2800).replace(/```/g, "ˋˋˋ") + "```" } }] : []),
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "✅ Allow once" }, style: "primary", action_id: `ap1:a:${req.id}` },
          { type: "button", text: { type: "plain_text", text: "♾ Allow for session" }, action_id: `ap1:s:${req.id}` },
          { type: "button", text: { type: "plain_text", text: "❌ Deny" }, style: "danger", action_id: `ap1:d:${req.id}` },
        ] },
      ],
    });
  }
}

function split(t: string): string[] {
  const out: string[] = [];
  let rest = t;
  while (rest.length > MAX) { let cut = rest.lastIndexOf("\n", MAX); if (cut < MAX / 2) cut = MAX; out.push(rest.slice(0, cut)); rest = rest.slice(cut); }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}
