/**
 * Automatic lesson capture (claude-mem-inspired, in-process, no daemon).
 * After a prompt finishes, if it was "worth learning from" (several tool calls, a recovered error, or the
 * user correcting/stating a preference), a small model extracts 0–3 durable, project-level lessons as JSON.
 * Runs in the background, deduplicated by the memory store, never blocks or fails a turn.
 */
import { complete } from "../ai/index.ts";
import type { Message, Model } from "../ai/types.ts";
import type { MemoryProvider } from "./types.ts";

const CORRECTION = /\b(no[,.!]|don'?t|do not|never|always|instead|prefer|stop|wrong|actually|remember|from now on|make sure)\b/i;

const PROMPT = `You extract durable memories for a coding agent from one finished interaction.
Return ONLY a JSON array (possibly empty) of at most 3 objects: {"text": string, "kind": "preference"|"decision"|"fact"|"lesson", "scope": "project"|"global"}.
Keep only things that will still matter in future sessions:
- user preferences and corrections ("use pnpm, not npm"; "don't add comments")
- project conventions, commands and gotchas discovered the hard way ("tests need DATABASE_URL set"; "run make gen after editing .proto")
- decisions with their reason
Never include: task progress, file contents, secrets/tokens/keys, things obvious from reading the code, speculation.
Each text must be one self-contained sentence. Prefer an empty array over weak memories.`;

export function worthCapturing(turn: Message[]): boolean {
  const users = turn.filter((m) => m.role === "user");
  const tools = turn.filter((m) => m.role === "toolResult");
  const errors = tools.filter((m) => m.role === "toolResult" && m.isError).length;
  const userText = users.map((u) => u.content.map((c) => (c.type === "text" ? c.text : "")).join("")).join("\n");
  return tools.length >= 6 || (errors > 0 && tools.length > errors) || CORRECTION.test(userText.replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, ""));
}

function digest(turn: Message[]): string {
  const out: string[] = [];
  for (const m of turn) {
    if (m.role === "user") out.push(`USER: ${m.content.map((c) => (c.type === "text" ? c.text : "")).join("").replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>\s*/g, "").slice(0, 2000)}`);
    else if (m.role === "assistant") for (const c of m.content) {
      if (c.type === "text" && c.text.trim()) out.push(`ASSISTANT: ${c.text.slice(0, 1500)}`);
      else if (c.type === "toolCall") out.push(`CALL ${c.name} ${JSON.stringify(c.arguments).slice(0, 300)}`);
    }
    else out.push(`RESULT ${m.toolName}${m.isError ? " ERROR" : ""}: ${m.content.map((c) => (c.type === "text" ? c.text : "")).join("").slice(0, m.isError ? 600 : 200)}`);
  }
  const s = out.join("\n");
  return s.length > 24_000 ? s.slice(0, 8_000) + "\n…\n" + s.slice(-16_000) : s;
}

export async function captureLessons(opts: { model: Model; apiKey?: string; memory: MemoryProvider; project: string; turn: Message[] }): Promise<number> {
  if (!worthCapturing(opts.turn)) return 0;
  const r = await complete(opts.model, { systemPrompt: PROMPT, messages: [{ role: "user", content: [{ type: "text", text: digest(opts.turn) }], timestamp: Date.now() }] }, { apiKey: opts.apiKey, maxTokens: 800, thinking: "off" });
  if (r.error) return 0;
  const m = r.text.match(/\[[\s\S]*\]/);
  if (!m) return 0;
  let items: Array<{ text?: string; kind?: string; scope?: string }>;
  try { items = JSON.parse(m[0]); } catch { return 0; }
  let n = 0;
  for (const it of items.slice(0, 3)) {
    if (!it?.text || it.text.length < 12 || it.text.length > 400) continue;
    if (/(api[_-]?key|secret|password|token)\s*[:=]|sk-[a-z0-9]{12,}/i.test(it.text)) continue;
    const scope = it.scope === "global" ? "global" : "project";
    await opts.memory.add({ text: it.text.trim(), kind: (["preference", "decision", "fact", "lesson"].includes(it.kind ?? "") ? it.kind : "lesson") as any, scope, project: scope === "project" ? opts.project : undefined, source: "auto" });
    n++;
  }
  return n;
}

/** Budgeted session-start block: preferences first, then the most recent project memories. */
export async function sessionMemoryBlock(memory: MemoryProvider, project: string, maxChars = 5000): Promise<string | undefined> {
  const items = await memory.list({ project, limit: 200 });
  if (!items.length) return undefined;
  const rank = (k?: string) => (k === "preference" ? 0 : k === "decision" ? 1 : k === "lesson" ? 2 : 3);
  const sorted = [...items].sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt);
  const lines: string[] = [];
  let used = 0;
  for (const it of sorted) {
    const l = `- ${it.text}`;
    if (used + l.length > maxChars) break;
    lines.push(l); used += l.length;
  }
  return lines.length ? lines.join("\n") + (sorted.length > lines.length ? `\n(${sorted.length - lines.length} more — use recall)` : "") : undefined;
}
