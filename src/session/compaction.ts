import { complete } from "../ai/index.ts";
import type { Message, Model, Usage } from "../ai/types.ts";

export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; triggerRatio: number }
export const DEFAULT_COMPACTION: CompactionSettings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, triggerRatio: 0.85 };

export function estimateTokens(m: Message): number {
  let chars = 0;
  for (const c of m.content as any[]) {
    if (c.type === "text") chars += c.text.length;
    else if (c.type === "thinking") chars += c.thinking.length;
    else if (c.type === "toolCall") chars += JSON.stringify(c.arguments).length + c.name.length;
    else if (c.type === "image") chars += 4800;
  }
  return Math.ceil(chars / 3.6) + 4;
}

export function contextTokens(messages: Message[], lastUsage?: Usage): number {
  // Prefer real numbers from the last response; add estimates for anything appended since.
  if (lastUsage && lastUsage.input + lastUsage.cacheRead > 0) {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant") { idx = i; break; }
    const tail = messages.slice(idx + 1).reduce((s, m) => s + estimateTokens(m), 0);
    return lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite + lastUsage.output + tail;
  }
  return messages.reduce((s, m) => s + estimateTokens(m), 0);
}

export function shouldCompact(model: Model, tokens: number, s: CompactionSettings = DEFAULT_COMPACTION): boolean {
  if (!s.enabled) return false;
  const limit = Math.min(model.contextWindow - s.reserveTokens, model.contextWindow * s.triggerRatio);
  return tokens > limit;
}

/** Index of the first message to keep: ~keepRecentTokens from the end, never starting at a tool result. */
export function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]!);
    if (acc > keepRecentTokens) break;
    cut = i;
  }
  // Move cut forward to a user message (a clean turn boundary).
  while (cut < messages.length && messages[cut]!.role !== "user") cut++;
  if (cut >= messages.length) {
    // No clean boundary in the tail; walk backward to the last user message instead.
    for (let i = messages.length - 1; i > 0; i--) if (messages[i]!.role === "user") return i;
    return messages.length;
  }
  return Math.max(1, cut);
}

const SUMMARY_PROMPT = `You are compacting a coding-agent conversation so work can continue seamlessly in a fresh context.
Write a dense, factual summary using exactly these sections (omit empty ones):

## Goal
What the user ultimately wants. Quote key requirements verbatim.
## Constraints & Preferences
Explicit instructions, style rules, things to avoid.
## Progress
What has been done, with file paths and function names. Note what was verified (tests run, results).
## Key Decisions
Decisions made and why.
## Open Problems
Errors still unresolved — include exact error messages.
## Next Steps
The concrete next actions, in order.
## Critical Context
Anything else needed to continue: important file contents, commands, URLs, IDs.

Be specific. Do not invent. Do not address the user.`;

function render(messages: Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push(`USER: ${m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("")}`);
    else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "text" && c.text) out.push(`ASSISTANT: ${c.text}`);
        else if (c.type === "toolCall") out.push(`TOOL CALL ${c.name}: ${JSON.stringify(c.arguments).slice(0, 1500)}`);
      }
    } else {
      const t = m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
      out.push(`TOOL RESULT ${m.toolName}${m.isError ? " (error)" : ""}: ${t.length > 3000 ? t.slice(0, 1500) + "\n…\n" + t.slice(-1500) : t}`);
    }
  }
  return out.join("\n\n");
}

export async function summarize(model: Model, apiKey: string | undefined, messages: Message[], previousSummary?: string, focus?: string, signal?: AbortSignal): Promise<string> {
  let transcript = render(messages);
  const maxChars = Math.max(20_000, (model.contextWindow - 20_000) * 3);
  if (transcript.length > maxChars) transcript = transcript.slice(0, maxChars / 3) + "\n\n[… middle omitted …]\n\n" + transcript.slice(-(maxChars * 2) / 3);
  const user = `${previousSummary ? `Previous summary (update and merge it):\n${previousSummary}\n\n` : ""}${focus ? `Focus especially on: ${focus}\n\n` : ""}Conversation to summarize:\n\n${transcript}`;
  const r = await complete(model, { systemPrompt: SUMMARY_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, { apiKey, signal, maxTokens: 8000, thinking: "low" });
  if (r.error) throw new Error(`Compaction failed: ${r.error}`);
  return r.text.trim();
}
