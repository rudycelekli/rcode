/**
 * Discord channel — Gateway WebSocket (v10) + REST, no SDK.
 *   Identify with intents GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT, heartbeat on op 10's interval.
 *   MESSAGE_CREATE → message (DMs always; in servers only when the bot is mentioned).
 *   INTERACTION_CREATE (type 3, button) → approval; acknowledged with UPDATE_MESSAGE (callback type 7).
 * Enable the "Message Content" privileged intent for the bot in the Discord developer portal.
 */
import type { ApprovalRequest, ChannelAdapter, ChannelAuth, IncomingMessage, OutgoingHandle } from "./types.ts";

const API = "https://discord.com/api/v10";
const MAX = 1900;
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

export class DiscordChannel implements ChannelAdapter {
  readonly name = "discord";
  private ws?: WebSocket;
  private running = false;
  private seq: number | null = null;
  private hb?: ReturnType<typeof setInterval>;
  private botId = "";
  private lastPairReply = new Map<string, number>();

  constructor(private token: string, private auth: ChannelAuth) {}

  private async rest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bot ${this.token}`, "content-type": "application/json", "user-agent": "rcode (https://github.com/rudycelekli/rcode, 0.1)" }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) { const j: any = await res.json().catch(() => ({})); await Bun.sleep(((j.retry_after ?? 1) as number) * 1000); return this.rest(method, path, body); }
    if (res.status === 204) return undefined as T;
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`discord ${method} ${path}: ${res.status} ${j.message ?? ""}`);
    return j as T;
  }

  async start(onMessage: (m: IncomingMessage) => void, onApproval: (id: string, d: "allow" | "allow-session" | "deny", userId: string, conv: string) => void) {
    const { url } = await this.rest<{ url: string }>("GET", "/gateway/bot");
    this.running = true;
    const connect = () => {
      const ws = new WebSocket(`${url}/?v=10&encoding=json`);
      this.ws = ws;
      ws.onmessage = (ev) => {
        let p: any; try { p = JSON.parse(String(ev.data)); } catch { return; }
        if (p.s != null) this.seq = p.s;
        if (p.op === 10) {
          clearInterval(this.hb);
          this.hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: this.seq })), p.d.heartbeat_interval);
          ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: "rcode", device: "rcode" } } }));
        } else if (p.op === 1) ws.send(JSON.stringify({ op: 1, d: this.seq }));
        else if (p.op === 7 || p.op === 9) { try { ws.close(); } catch {} }
        else if (p.op === 0) {
          if (p.t === "READY") { this.botId = p.d.user.id; console.log(`[gateway] discord connected as ${p.d.user.username}`); }
          else if (p.t === "MESSAGE_CREATE") void this.onMsg(p.d, onMessage);
          else if (p.t === "INTERACTION_CREATE" && p.d.type === 3) void this.onInteraction(p.d, onApproval);
        }
      };
      ws.onclose = () => { clearInterval(this.hb); if (this.running) setTimeout(connect, 3000); };
    };
    connect();
  }

  private async onMsg(d: any, onMessage: (m: IncomingMessage) => void) {
    if (d.author?.bot || !d.author?.id) return;
    const isDm = !d.guild_id;
    const mentioned = (d.mentions ?? []).some((u: any) => u.id === this.botId);
    if (!isDm && !mentioned) return;
    const text = String(d.content ?? "").replace(new RegExp(`<@!?${this.botId}>`, "g"), "").trim();
    const uid = d.author.id;
    if (!this.auth.isAllowed(uid)) {
      if (!isDm) return;
      const last = this.lastPairReply.get(uid) ?? 0;
      if (Date.now() - last < 10 * 60_000 && !/^pair\s+\S{16,}/.test(text)) return;
      this.lastPairReply.set(uid, Date.now());
      const reply = this.auth.onUnknown(uid, d.author.username, text);
      if (reply) await this.rest("POST", `/channels/${d.channel_id}/messages`, { content: reply }).catch(() => {});
      return;
    }
    const images: IncomingMessage["images"] = [];
    for (const att of d.attachments ?? []) {
      if (!String(att.content_type ?? "").startsWith("image/") || att.size > 8_000_000) continue;
      try { images.push({ mimeType: att.content_type, data: Buffer.from(await (await fetch(att.url)).arrayBuffer()).toString("base64") }); } catch {}
    }
    if (text || images.length) onMessage({ channel: this.name, conversationId: d.channel_id, userId: uid, userName: d.author.username, text, images, messageId: d.id });
  }

  private async onInteraction(d: any, onApproval: (id: string, dec: "allow" | "allow-session" | "deny", userId: string, conv: string) => void) {
    const uid = d.member?.user?.id ?? d.user?.id;
    const [kind, dd, id] = String(d.data?.custom_id ?? "").split(":");
    const decision = dd === "a" ? "allow" : dd === "s" ? "allow-session" : dd === "d" ? "deny" : undefined;
    const label = decision === "deny" ? "❌ Denied" : decision === "allow-session" ? "♾ Allowed for session" : "✅ Allowed once";
    if (uid && this.auth.isAllowed(uid) && kind === "ap1" && id && decision) onApproval(id, decision, uid, d.channel_id);
    await this.rest("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 7, data: { content: `${d.message?.content ?? ""}\n${decision ? label : ""}`.slice(0, MAX), components: [] } }).catch(() => {});
  }

  async stop() { this.running = false; clearInterval(this.hb); try { this.ws?.close(); } catch {} }

  async send(conv: string, text: string) { for (const part of split(text)) await this.rest("POST", `/channels/${conv}/messages`, { content: part }).catch(() => {}); }
  async typing(conv: string) { await this.rest("POST", `/channels/${conv}/typing`).catch(() => {}); }

  async reply(conv: string, initial: string): Promise<OutgoingHandle> {
    const msg = await this.rest("POST", `/channels/${conv}/messages`, { content: initial || "…" });
    let pending: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, lastAt = 0;
    const flush = async () => { timer = undefined; if (pending === undefined) return; const t = pending.length > MAX ? "…" + pending.slice(-(MAX - 1)) : pending; pending = undefined; lastAt = Date.now(); await this.rest("PATCH", `/channels/${conv}/messages/${msg.id}`, { content: t }).catch(() => {}); };
    return {
      update: async (t) => { pending = t; if (!timer) timer = setTimeout(flush, Math.max(0, 1200 - (Date.now() - lastAt))); },
      finish: async (t) => {
        if (timer) clearTimeout(timer);
        const parts = split(t || "(no response)");
        await this.rest("PATCH", `/channels/${conv}/messages/${msg.id}`, { content: parts[0] }).catch(() => {});
        for (const p of parts.slice(1)) await this.rest("POST", `/channels/${conv}/messages`, { content: p }).catch(() => {});
      },
    };
  }

  async askApproval(conv: string, req: ApprovalRequest) {
    const detail = req.detail ? "\n```\n" + req.detail.slice(0, 1400).replace(/```/g, "ˋˋˋ") + "\n```" : "";
    await this.rest("POST", `/channels/${conv}/messages`, {
      content: `⚠️ Permission needed (${req.reason})\n${req.title.slice(0, 300)}${detail}`.slice(0, MAX),
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: "Allow once", custom_id: `ap1:a:${req.id}` },
        { type: 2, style: 1, label: "Allow for session", custom_id: `ap1:s:${req.id}` },
        { type: 2, style: 4, label: "Deny", custom_id: `ap1:d:${req.id}` },
      ] }],
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
