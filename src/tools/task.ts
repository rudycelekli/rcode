/**
 * task: delegate work to subagents. A batch of tasks runs in parallel, each in its own context
 * window, sharing an optional context preamble. Agent types come from agents/*.md
 * (built-in roster + ~/.rcode/agents + .claude/agents compat). Nesting depth is capped.
 */
import { z } from "zod";
import { Agent } from "../agent/loop.ts";
import type { AgentHooks, Tool } from "../agent/types.ts";
import type { Model } from "../ai/types.ts";
import type { AgentDef } from "../ext/resources.ts";
import { text } from "./util.ts";

export interface SubagentFactory {
  agents: () => AgentDef[];
  /** Build a child agent's model/tools/prompt. */
  build: (def: AgentDef | undefined, depth: number) => { model: Model; apiKey?: string; tools: Tool[]; systemPrompt: string; hooks?: AgentHooks };
  maxDepth: number;
  maxParallel: number;
}

export function createTaskTool(factory: SubagentFactory): Tool {
  const schema = z.object({
    context: z.string().optional().describe("Shared background given to every task in this batch (goal, constraints, relevant paths)"),
    tasks: z.array(z.object({
      description: z.string().describe("3-6 word label"),
      prompt: z.string().describe("Complete, self-contained instructions. The subagent sees nothing else from this conversation."),
      agent: z.string().optional().describe("Agent type (default: general)"),
    })).min(1).max(12),
  });
  const list = () => factory.agents().map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return {
    name: "task",
    label: "Task",
    get description() {
      return `Delegate work to subagents that run in parallel, each with a fresh context window. Use for independent research, broad searches, or parallel implementation of separate files. Each subagent returns one final report. Do not delegate trivial lookups.\nAgent types:\n- general: full-capability agent\n${list()}`;
    },
    schema,
    concurrency: "shared",
    effects: { runsProcess: true, writesFiles: true },
    summarize: (a: z.infer<typeof schema>) => a.tasks.map((t) => t.description).join(" · "),
    async execute(a: z.infer<typeof schema>, ctx) {
      const depth = ctx.agent.depth + 1;
      if (depth > factory.maxDepth) return text(`Max subagent depth (${factory.maxDepth}) reached. Do the work directly.`, true);
      const defs = factory.agents();
      const queue = a.tasks.map((t, i) => ({ ...t, i }));
      const results: string[] = new Array(queue.length);
      let totalCost = 0;
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift()!;
          const def = t.agent && t.agent !== "general" ? defs.find((d) => d.name === t.agent) : undefined;
          if (t.agent && t.agent !== "general" && !def) { results[t.i] = `### ${t.description}\nUnknown agent type "${t.agent}".`; continue; }
          const b = factory.build(def, depth);
          const child = new Agent({ model: b.model, apiKey: b.apiKey, systemPrompt: b.systemPrompt, tools: b.tools, cwd: ctx.cwd, sessionId: `${ctx.agent.sessionId}:sub${t.i}`, depth, hooks: b.hooks, maxTurns: 100 });
          const off = ctx.signal.addEventListener("abort", () => child.abort(), { once: true });
          let steps = 0;
          child.subscribe((e) => {
            if (e.type === "tool_start") { steps++; ctx.onUpdate?.({ text: `[${t.description}] ${e.name} ${e.summary ?? ""}`.slice(0, 200), details: { task: t.i, steps } }); }
          });
          const prompt = (a.context ? `<context>\n${a.context}\n</context>\n\n` : "") + t.prompt;
          const last = await child.prompt(prompt);
          void off;
          totalCost += child.usage.cost.total;
          const out = last?.content.filter((c) => c.type === "text").map((c: any) => c.text).join("").trim();
          results[t.i] = `### ${t.description}${def ? ` (${def.name})` : ""}\n${last?.stopReason === "error" ? `FAILED: ${last.errorMessage}` : out || "(no final report)"}`;
        }
      };
      await Promise.all(Array.from({ length: Math.min(factory.maxParallel, a.tasks.length) }, worker));
      return text(results.join("\n\n"), false, { cost: totalCost, tasks: a.tasks.length });
    },
  } as Tool;
}
