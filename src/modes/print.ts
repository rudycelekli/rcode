/** Headless print mode: `rcode -p "..."` (text) or `--json` (JSONL event stream for scripts/AIs). */
import type { AgentSession } from "../core/session.ts";

export async function runPrint(session: AgentSession, prompt: string, opts: { json?: boolean; quiet?: boolean }) {
  const out = process.stdout;
  const err = process.stderr;
  let lastText = "";
  session.subscribe((e) => {
    if (opts.json) {
      // Strip heavy partials from the wire.
      const slim: any = { ...e };
      if (e.type === "message_update") { slim.message = undefined; }
      if (e.type === "agent_end") { slim.messages = undefined; }
      out.write(JSON.stringify(slim) + "\n");
      return;
    }
    if (e.type === "message_update" && e.delta?.kind === "text") { out.write(e.delta.text); lastText += e.delta.text; }
    else if (e.type === "message_end") { if (lastText && !lastText.endsWith("\n")) out.write("\n"); lastText = ""; }
    else if (!opts.quiet && e.type === "tool_start") err.write(`\x1b[2m→ ${e.name} ${e.summary ?? ""}\x1b[0m\n`);
    else if (!opts.quiet && e.type === "tool_end" && e.result.isError) err.write(`\x1b[31m  ✗ ${e.result.content.map((c) => (c.type === "text" ? c.text : "")).join("").split("\n")[0]?.slice(0, 200)}\x1b[0m\n`);
    else if (e.type === "notice" && e.level !== "info") err.write(`\x1b[33m${e.text}\x1b[0m\n`);
    else if (e.type === "compaction") err.write(`\x1b[2m[compacted ${e.before} → ${e.after} tokens]\x1b[0m\n`);
  });
  await session.prompt(prompt);
  const u = session.agent.usage;
  if (!opts.json && !opts.quiet) {
    if (session.lastReceipt) err.write(`\x1b[2m${session.lastReceipt.hash} · ${session.lastReceipt.verdict}\x1b[0m\n`);
    err.write(`\x1b[2m[${session.model.provider}/${session.model.id} · ${u.input + u.cacheRead} in / ${u.output} out · $${u.cost.total.toFixed(4)}]\x1b[0m\n`);
  }
  const last = [...session.messages].reverse().find((m) => m.role === "assistant");
  return last && last.role === "assistant" && last.stopReason === "error" ? 1 : 0;
}
