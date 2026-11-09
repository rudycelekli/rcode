/**
 * Grow rcode by talking to it:
 *   /hire <one sentence>  → a persistent teammate (subagent type) in ~/.rcode/agents
 *   /teach <name>         → the work just done, distilled into a reusable /<name> workflow
 * Both ask the fast model for a small JSON object and write plain markdown the user can edit.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "../ai/index.ts";
import type { Message, Model } from "../ai/types.ts";
import { RCODE_HOME } from "../session/store.ts";

const NAME = /^[a-z][a-z0-9-]{1,31}$/;
const READ_ONLY_TOOLS = "read, grep, glob, ls, repo_map, web_fetch";

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "helper";
}

export function firstJson(text: string): any {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return undefined;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return undefined; }
}

const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export interface TeammateSpec { name: string; description: string; readOnly: boolean; instructions: string }

export function parseTeammate(raw: any, fallbackName: string): TeammateSpec | undefined {
  if (!raw || typeof raw.instructions !== "string" || !raw.instructions.trim()) return undefined;
  const name = NAME.test(String(raw.name ?? "")) ? String(raw.name) : slug(String(raw.name ?? fallbackName));
  return { name, description: oneLine(raw.description || raw.instructions, 300), readOnly: raw.readOnly === true, instructions: raw.instructions.trim() };
}

export function renderTeammate(t: TeammateSpec): string {
  return `---\nname: ${t.name}\ndescription: ${t.description}\n${t.readOnly ? `tools: ${READ_ONLY_TOOLS}\n` : ""}model: inherit\n---\n\n${t.instructions}\n`;
}

export interface WorkflowSpec { description: string; body: string }

export function parseWorkflow(raw: any): WorkflowSpec | undefined {
  if (!raw || typeof raw.body !== "string" || !raw.body.trim()) return undefined;
  return { description: oneLine(raw.description || raw.body, 120), body: raw.body.trim() };
}

export function renderWorkflow(w: WorkflowSpec): string {
  const hint = /\$ARGUMENTS|\$1/.test(w.body) ? `argument-hint: <what to work on>\n` : "";
  return `---\ndescription: ${w.description}\n${hint}---\n\n${w.body}\n`;
}

/** What happened this session, compact enough for a cheap model: asks, actions, outcomes. */
export function transcriptDigest(messages: Message[], max = 12_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const t = m.content.map((c) => (c.type === "text" ? c.text : "")).join("").replace(/<(relevant_memories|stack|active_goal|hook_context)[\s\S]*?<\/\1>\s*/g, "").trim();
      if (t) lines.push(`USER: ${t.slice(0, 800)}`);
    } else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "toolCall") lines.push(`ACTION ${c.name}: ${JSON.stringify(c.arguments).slice(0, 200)}`);
        else if (c.type === "text" && c.text.trim()) lines.push(`AGENT: ${c.text.trim().slice(0, 600)}`);
      }
    } else if (m.isError) lines.push(`FAILED ${m.toolName}`);
  }
  const s = lines.join("\n");
  return s.length > max ? s.slice(s.length - max) : s;
}

/** Write without clobbering: name, name-2, name-3… */
export function writeUnique(dir: string, name: string, content: string): { name: string; file: string } {
  mkdirSync(dir, { recursive: true });
  let n = name, i = 2;
  while (existsSync(join(dir, `${n}.md`))) n = `${name}-${i++}`;
  const file = join(dir, `${n}.md`);
  writeFileSync(file, content);
  return { name: n, file };
}

async function askJson(model: Model, apiKey: string | undefined, system: string, user: string): Promise<any> {
  const r = await complete(model, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, { apiKey, maxTokens: 2000, thinking: "off" });
  if (r.error) throw new Error(r.error);
  return firstJson(r.text);
}

const HIRE_SYSTEM = `You design a teammate for a coding agent. Reply with only a JSON object:
{"name": "kebab-case, 2-3 words", "description": "one sentence: what it does and when to use it", "readOnly": true if it only needs to look and report, "instructions": "second-person markdown: role, how it works step by step, what it returns, what it must never do"}`;

export async function hireTeammate(o: { model: Model; apiKey?: string; ask: string; dir?: string }): Promise<{ name: string; file: string; spec: TeammateSpec }> {
  const spec = parseTeammate(await askJson(o.model, o.apiKey, HIRE_SYSTEM, o.ask), slug(o.ask));
  if (!spec) throw new Error("couldn't design that teammate; try describing the job in one sentence");
  const w = writeUnique(o.dir ?? join(RCODE_HOME, "agents"), spec.name, "");
  writeFileSync(w.file, renderTeammate({ ...spec, name: w.name }));
  return { ...w, spec: { ...spec, name: w.name } };
}

const TEACH_SYSTEM = `You turn a finished piece of agent work into a reusable recipe the agent can follow next time. Reply with only a JSON object:
{"description": "one line: what running this workflow does", "body": "markdown instructions to the agent: numbered steps that worked, the checks that proved it, pitfalls hit along the way. Write $ARGUMENTS where the specific target should vary between runs."}
Keep what generalizes; drop one-off details.`;

export async function teachWorkflow(o: { model: Model; apiKey?: string; name: string; messages: Message[]; dir?: string }): Promise<{ name: string; file: string; spec: WorkflowSpec }> {
  const digest = transcriptDigest(o.messages);
  if (!digest.includes("ACTION")) throw new Error("nothing to learn yet: do the task once, then /teach it");
  const spec = parseWorkflow(await askJson(o.model, o.apiKey, TEACH_SYSTEM, `Workflow name: ${o.name}\n\n${digest}`));
  if (!spec) throw new Error("couldn't distill a workflow from this session");
  const w = writeUnique(o.dir ?? join(RCODE_HOME, "commands"), slug(o.name), renderWorkflow(spec));
  return { ...w, spec };
}
