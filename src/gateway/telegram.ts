/**
 * Telegram channel — Bot API over plain fetch, long-polling (no webhook, no public URL needed).
 *   getUpdates(offset, timeout=50) · sendMessage · editMessageText · answerCallbackQuery · sendChatAction · setMyCommands · getFile
 * Pairing: unknown users get a one-time code; `rcode gateway pair <code>` (or a code printed at startup)
 * adds their user id to the allowlist. Everyone else is ignored.
 */
import type { ApprovalRequest, ChannelAdapter, ChannelAuth, IncomingMessage, OutgoingHandle } from "./types.ts";

const API = "https://api.telegram.org";
const MAX = 4000;

export class TelegramChannel implements ChannelAdapter {
  readonly name = "telegram";
  private offset = 0;
  private running = false;
  private ctl = new AbortController();
  private lastPairReply = new Map<string, number>();
  username = "";
  constructor(private token: string, private auth: ChannelAuth, private offsetStore?: { get: () => number; set: (n: number) => void }) {}

  private async call<T = any>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const j: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!j.ok) {
      if (j.parameters?.retry_after) { await Bun.sleep(j.parameters.retry_after * 1000); return this.call(method, body, signal); }
      if (/message is not modified/.test(j.description ?? "")) return undefined as T;
      throw new Error(`telegram ${method}: ${j.description}`);
    }
    return j.result as T;
  }

  async start(onMessage: (m: IncomingMessage) => void, onApproval: (id: string, d: "allow" | "allow-session" | "deny", userId: string, conv: string) => void) {
    const me = await this.call("getMe", {});
    this.username = me.username;
    // A leftover webhook makes getUpdates fail with 409 — long polling requires it gone.
    await this.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    this.offset = this.offsetStore?.get() ?? 0;
    await this.call("setMyCommands", { commands: [
      { command: "new", description: "Start a fresh session" }, { command: "stop", description: "Interrupt the agent" },
      { command: "status", description: "Model, mode, usage" }, { command: "mode", description: "ask | auto-edit | plan" },
      { command: "model", description: "Switch model" }, { command: "undo", description: "Revert last turn's file edits" },
    ] }).catch(() => {});
    console.log(`[gateway] telegram connected as @${me.username}`);
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          const updates: any[] = await this.call("getUpdates", { offset: this.offset, timeout: 50, limit: 100, allowed_updates: ["message", "callback_query"] }, this.ctl.signal);
          for (const u of updates) {
            this.offset = u.update_id + 1;
            this.offsetStore?.set(this.offset);
            if (u.callback_query) {
              const cq = u.callback_query;
              const from = String(cq.from.id);
              await this.call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
              if (!this.auth.isAllowed(from)) continue;
              const [kind, d, id] = String(cq.data ?? "").split(":");
              const decision = d === "a" ? "allow" : d === "s" ? "allow-session" : d === "d" ? "deny" : undefined;
              if (kind === "ap1" && id && decision) {
                const conv = cq.message?.message_thread_id ? `${cq.message.chat.id}:${cq.message.message_thread_id}` : String(cq.message?.chat?.id);
                onApproval(id, decision, from, conv);
                const label = decision === "deny" ? "❌ Denied" : decision === "allow-session" ? "♾ Allowed for session" : "✅ Allowed once";
                await this.call("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `${cq.message.text}\n\n${label}`, reply_markup: { inline_keyboard: [] } }).catch(() => {});
              }
              continue;
            }
            const m = u.message;
            if (!m) continue;
            const from = String(m.from?.id ?? "");
            if (!this.auth.isAllowed(from)) {
              if (m.chat?.type !== "private") continue; // strangers are only answered in DMs
              const isLink = /^\/start\s+\S{16,}/.test(m.text ?? "");
              const last = this.lastPairReply.get(from) ?? 0;
              if (!isLink && Date.now() - last < 10 * 60_000) continue; // rate limit
              this.lastPairReply.set(from, Date.now());
              const reply = this.auth.onUnknown(from, m.from?.username, m.text ?? "");
              if (reply) await this.call("sendMessage", { chat_id: m.chat.id, text: reply }).catch(() => {});
              continue;
            }
            const conv = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : String(m.chat.id);
            let text: string = m.text ?? m.caption ?? "";
            const images: IncomingMessage["images"] = [];
            if (m.photo?.length) {
              const ph = m.photo[m.photo.length - 1];
              try {
                const f = await this.call("getFile", { file_id: ph.file_id });
                const buf = await (await fetch(`${API}/file/bot${this.token}/${f.file_path}`)).arrayBuffer();
                images.push({ mimeType: "image/jpeg", data: Buffer.from(buf).toString("base64") });
              } catch {}
            }
            if (m.document && !text) text = `(received file ${m.document.file_name} — documents are not yet supported)`;
            if (!text && !images.length) continue;
            onMessage({ channel: this.name, conversationId: conv, userId: from, userName: m.from?.username, text, images, messageId: String(m.message_id) });
          }
        } catch (e) {
          if (!this.running) break;
          console.error(`[gateway] telegram poll error: ${(e as Error).message}`);
          await Bun.sleep(3000);
        }
      }
    })();
  }

  async stop() { this.running = false; this.ctl.abort(); }

  private chat(conv: string) { const [chat_id, thread] = conv.split(":"); return { chat_id, ...(thread ? { message_thread_id: Number(thread) } : {}) }; }

  async send(conv: string, text: string) {
    for (const part of split(text)) await this.call("sendMessage", { ...this.chat(conv), text: part }).catch(async () => {});
  }

  async typing(conv: string) { await this.call("sendChatAction", { ...this.chat(conv), action: "typing" }).catch(() => {}); }

  async reply(conv: string, initial: string): Promise<OutgoingHandle> {
    const msg = await this.call("sendMessage", { ...this.chat(conv), text: initial || "…" });
    let lastSent = initial, lastAt = 0, pending: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      if (pending === undefined || pending === lastSent) return;
      const t = pending.length > MAX ? "…" + pending.slice(-(MAX - 1)) : pending;
      lastSent = pending; lastAt = Date.now(); pending = undefined;
      await this.call("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: t }).catch(() => {});
    };
    return {
      update: async (text) => {
        pending = text;
        // Telegram tolerates ~1 edit/sec per chat; coalesce.
        if (!timer) timer = setTimeout(flush, Math.max(0, 1200 - (Date.now() - lastAt)));
      },
      finish: async (text) => {
        if (timer) clearTimeout(timer);
        const parts = split(text || "(no response)");
        await this.call("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: parts[0] }).catch(() => {});
        for (const p of parts.slice(1)) await this.call("sendMessage", { ...this.chat(conv), text: p }).catch(() => {});
      },
    };
  }

  async askApproval(conv: string, req: ApprovalRequest) {
    const detail = req.detail ? `\n\n${req.detail.slice(0, 3200)}` : "";
    await this.call("sendMessage", {
      ...this.chat(conv),
      text: `⚠️ Permission needed (${req.reason})\n${req.title.slice(0, 400)}${detail}`,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [
        [{ text: "✅ Allow once", callback_data: `ap1:a:${req.id}` }, { text: "♾ Allow for session", callback_data: `ap1:s:${req.id}` }],
        [{ text: "❌ Deny", callback_data: `ap1:d:${req.id}` }],
      ] },
    });
  }
}

function split(t: string): string[] {
  if (t.length <= MAX) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf("\n", MAX);
    if (cut < MAX / 2) cut = MAX;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
