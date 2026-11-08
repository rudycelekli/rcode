/**
 * Stale-output masking (applied via the agent's transformContext hook; the stored transcript is untouched).
 *   - A `read` result is stale once the same file is read again or edited/written later.
 *   - A `bash`/`grep`/`glob` result is stale once the exact same call runs again later.
 * Masking only kicks in when it saves a meaningful amount (cache-friendly: avoid busting the
 * prompt prefix for tiny wins), and the most recent turns are never touched.
 */
import type { Message, ToolCallPart, ToolResultMessage } from "../ai/types.ts";

const MIN_SAVINGS_CHARS = 24_000;
const PROTECT_RECENT_MESSAGES = 12;
const MIN_RESULT_CHARS = 1_500;

const size = (r: ToolResultMessage) => r.content.reduce((s, c) => s + (c.type === "text" ? c.text.length : 3000), 0);

export function maskStale(messages: Message[]): Message[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown>; idx: number }>();
  messages.forEach((m, idx) => {
    if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") calls.set((c as ToolCallPart).id, { name: c.name, args: c.arguments, idx });
  });
  const lastTouch = new Map<string, number>(); // path → last idx of read/edit/write
  const lastSame = new Map<string, number>(); // call signature → last idx
  for (const [, c] of calls) {
    const p = typeof c.args.path === "string" ? c.args.path.replace(/:[-\d]+(-\d+)?$/, "") : undefined;
    if (p && ["read", "edit", "write"].includes(c.name)) lastTouch.set(p, Math.max(lastTouch.get(p) ?? -1, c.idx));
    if (["bash", "grep", "glob", "ls", "web_fetch"].includes(c.name)) { const sig = c.name + JSON.stringify(c.args); lastSame.set(sig, Math.max(lastSame.get(sig) ?? -1, c.idx)); }
  }
  const limit = messages.length - PROTECT_RECENT_MESSAGES;
  const toMask = new Map<number, string>();
  let savings = 0;
  messages.forEach((m, i) => {
    if (i >= limit || m.role !== "toolResult" || m.isError) return;
    const c = calls.get(m.toolCallId);
    if (!c || size(m) < MIN_RESULT_CHARS) return;
    let reason: string | undefined;
    if (c.name === "read" && typeof c.args.path === "string") {
      const p = c.args.path.replace(/:[-\d]+(-\d+)?$/, "");
      if ((lastTouch.get(p) ?? -1) > c.idx) reason = `stale read of ${p} — it was re-read or modified later; see the newer result`;
    } else if (["bash", "grep", "glob", "ls", "web_fetch"].includes(c.name)) {
      if ((lastSame.get(c.name + JSON.stringify(c.args)) ?? -1) > c.idx) reason = `superseded: the same ${c.name} call ran again later`;
    }
    if (reason) { toMask.set(i, reason); savings += size(m); }
  });
  if (savings < MIN_SAVINGS_CHARS) return messages;
  return messages.map((m, i) => (toMask.has(i) && m.role === "toolResult" ? { ...m, content: [{ type: "text" as const, text: `[${toMask.get(i)}]` }], details: undefined } : m));
}
