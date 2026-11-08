/** Context "X-ray": where the tokens in the next request go (goose-style breakdown). */
import type { Message } from "../ai/types.ts";
import type { Tool } from "../agent/types.ts";
import { toolSchema } from "../agent/loop.ts";

const est = (chars: number) => Math.ceil(chars / 3.6);

export interface Breakdown { total: number; window: number; groups: Array<{ name: string; tokens: number; items: Array<{ name: string; tokens: number }> }> }

export function contextBreakdown(systemPrompt: string, tools: Tool[], messages: Message[], window: number): Breakdown {
  // System prompt sections split on top-level "# " headings.
  const sections: Array<{ name: string; tokens: number }> = [];
  const parts = systemPrompt.split(/\n(?=# )/);
  for (const p of parts) sections.push({ name: (p.match(/^# (.+)/)?.[1] ?? "core").slice(0, 40), tokens: est(p.length) });

  const toolItems = new Map<string, number>();
  for (const t of tools) {
    const key = t.name.startsWith("mcp__") ? `mcp: ${t.name.split("__")[1]}` : t.name;
    toolItems.set(key, (toolItems.get(key) ?? 0) + est(JSON.stringify(toolSchema(t)).length));
  }

  const msg = new Map<string, number>();
  const add = (k: string, n: number) => msg.set(k, (msg.get(k) ?? 0) + n);
  for (const m of messages) {
    if (m.role === "user") add(m.timestamp === 0 ? "compaction summary" : "user messages", est(m.content.reduce((s, c) => s + (c.type === "text" ? c.text.length : 4800), 0)));
    else if (m.role === "assistant") for (const c of m.content) {
      if (c.type === "text") add("assistant text", est(c.text.length));
      else if (c.type === "thinking") add("thinking", est(c.thinking.length));
      else add("tool calls", est(JSON.stringify(c.arguments).length + 20));
    }
    else add(`results: ${m.toolName.startsWith("mcp__") ? "mcp" : m.toolName}`, est(m.content.reduce((s, c) => s + (c.type === "text" ? c.text.length : 4800), 0)));
  }
  const sort = (xs: Array<{ name: string; tokens: number }>) => xs.sort((a, b) => b.tokens - a.tokens);
  const groups = [
    { name: "system prompt", items: sort(sections) },
    { name: "tool definitions", items: sort([...toolItems].map(([name, tokens]) => ({ name, tokens }))) },
    { name: "conversation", items: sort([...msg].map(([name, tokens]) => ({ name, tokens }))) },
  ].map((g) => ({ ...g, tokens: g.items.reduce((s, i) => s + i.tokens, 0) }));
  return { total: groups.reduce((s, g) => s + g.tokens, 0), window, groups };
}

export function renderBreakdown(b: Breakdown, width = 60): string {
  const bar = (n: number) => "█".repeat(Math.max(0, Math.round((n / Math.max(1, b.window)) * width))) || "▏";
  const lines = [`context ≈ ${b.total.toLocaleString()} / ${b.window.toLocaleString()} tokens (${((b.total / b.window) * 100).toFixed(1)}%)`];
  for (const g of b.groups) {
    lines.push(`\n${g.name.padEnd(18)} ${g.tokens.toLocaleString().padStart(8)}  ${bar(g.tokens)}`);
    for (const i of g.items.slice(0, 10)) lines.push(`  ${i.name.slice(0, 26).padEnd(26)} ${i.tokens.toLocaleString().padStart(7)}`);
    if (g.items.length > 10) lines.push(`  … ${g.items.length - 10} more`);
  }
  return lines.join("\n");
}
