/**
 * Deterministic eval harness.
 * A case is a fixture directory, a scripted (or live) agent run, and graders.
 * The suite reports a Wilson 95% interval so a 2/2 and a 200/200 are not the same claim.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "../agent/loop.ts";
import { resolveModel } from "../ai/models.ts";
import { fauxReset, fauxScript, type FauxStep } from "../ai/providers/faux.ts";
import { coreTools } from "../tools/index.ts";

export type Grader =
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_not_contains"; path: string; text: string }
  | { type: "file_absent"; path: string }
  | { type: "transcript_contains"; text: string }
  | { type: "command"; command: string; exit?: number };

export interface EvalCase {
  id: string;
  prompt: string;
  files?: Record<string, string>;
  /** Scripted faux steps. Omit only when running with a live model. */
  script?: FauxStep[];
  graders: Grader[];
  maxTurns?: number;
}

export interface CaseResult { id: string; pass: boolean; failures: string[] }

export interface SuiteReport {
  results: CaseResult[];
  passed: number;
  total: number;
  wilson: { p: number; low: number; high: number };
}

/** Wilson score interval for a binomial proportion. z=1.96 ≈ 95%. */
export function wilson(k: number, n: number, z = 1.96): { p: number; low: number; high: number } {
  if (n <= 0) return { p: 0, low: 0, high: 0 };
  const ph = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (ph + z2 / (2 * n)) / den;
  const margin = (z * Math.sqrt((ph * (1 - ph) + z2 / (4 * n)) / n)) / den;
  return { p: ph, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

function grade(g: Grader, cwd: string, transcript: string): string | undefined {
  const read = (p: string) => { const abs = join(cwd, p); return existsSync(abs) ? readFileSync(abs, "utf8") : undefined; };
  if (g.type === "file_contains") {
    const t = read(g.path);
    if (t === undefined) return `${g.path} is missing (expected to contain ${JSON.stringify(g.text)})`;
    if (!t.includes(g.text)) return `${g.path} does not contain ${JSON.stringify(g.text)}`;
  } else if (g.type === "file_not_contains") {
    const t = read(g.path);
    if (t?.includes(g.text)) return `${g.path} still contains ${JSON.stringify(g.text)}`;
  } else if (g.type === "file_absent") {
    if (existsSync(join(cwd, g.path))) return `${g.path} exists and should not`;
  } else if (g.type === "transcript_contains") {
    if (!transcript.includes(g.text)) return `transcript missing ${JSON.stringify(g.text)}`;
  } else if (g.type === "command") {
    const r = spawnSync("bash", ["-lc", g.command], { cwd, encoding: "utf8", timeout: 30_000 });
    const want = g.exit ?? 0;
    if ((r.status ?? 1) !== want) return `\`${g.command}\` exited ${r.status}, expected ${want}\n${(r.stderr || r.stdout || "").slice(0, 400)}`;
  }
  return undefined;
}

export async function runCase(c: EvalCase): Promise<CaseResult> {
  const cwd = mkdtempSync(join(tmpdir(), `rcode-eval-${c.id.replace(/[^\w.-]+/g, "_")}-`));
  for (const [p, body] of Object.entries(c.files ?? {})) {
    const abs = join(cwd, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  const model = resolveModel("faux/eval")!;
  fauxReset();
  if (c.script?.length) fauxScript(...c.script);
  const agent = new Agent({ model, systemPrompt: "You are rcode running an eval. Follow the scripted task.", tools: coreTools(), cwd, sessionId: `eval:${c.id}`, maxTurns: c.maxTurns ?? 8 });
  const last = await agent.prompt(c.prompt);
  const transcript = agent.messages.map((m) => {
    if (m.role === "assistant") return m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (m.role === "toolResult") return m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    return "";
  }).join("\n");
  if (!c.script?.length && last?.stopReason === "error") {
    return { id: c.id, pass: false, failures: [last.errorMessage ?? "model error (case has no script; pass --model for a live run, or add a script)"] };
  }
  const failures = c.graders.map((g) => grade(g, cwd, transcript)).filter((x): x is string => !!x);
  return { id: c.id, pass: failures.length === 0, failures };
}

export async function runSuite(cases: EvalCase[]): Promise<SuiteReport> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c));
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length, wilson: wilson(passed, results.length) };
}

export function loadSuite(file: string): EvalCase[] {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const cases = Array.isArray(raw) ? raw : raw.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error(`No cases in ${file}`);
  for (const c of cases) {
    if (!c.id || !c.prompt || !Array.isArray(c.graders)) throw new Error(`Case missing id, prompt, or graders`);
  }
  return cases as EvalCase[];
}

export function formatReport(r: SuiteReport): string {
  const lines = r.results.map((c) => `${c.pass ? "pass" : "FAIL"}  ${c.id}${c.failures.length ? "\n" + c.failures.map((f) => `      ${f.split("\n")[0]}`).join("\n") : ""}`);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  lines.push(`${r.passed}/${r.total} passed · Wilson 95% CI [${pct(r.wilson.low)}, ${pct(r.wilson.high)}]`);
  return lines.join("\n");
}
