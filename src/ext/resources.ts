/**
 * Markdown resources with YAML-ish frontmatter:
 *   skills   — <dir>/<name>/SKILL.md            (Agent Skills spec; only name+description go in the prompt)
 *   commands — <dir>/<name>.md                  (slash commands / prompt templates; $ARGUMENTS, $1, $2…)
 *   agents   — <dir>/<name>.md                  (subagent types: name, description, tools, model)
 * Search order (later overrides earlier): built-in → ~/.rcode → ~/.claude (compat) → project .claude → project .rcode
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RCODE_HOME } from "../session/store.ts";
import { isTrusted } from "../config.ts";

export interface Frontmatter { [k: string]: string | string[] | boolean | undefined }

export function parseFrontmatter(src: string): { meta: Frontmatter; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta: Frontmatter = {};
  let lastKey = "";
  for (const line of m[1]!.split(/\r?\n/)) {
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && lastKey) { const cur = meta[lastKey]; meta[lastKey] = [...(Array.isArray(cur) ? cur : cur ? [String(cur)] : []), unq(li[1]!)]; continue; }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    lastKey = kv[1]!;
    const v = kv[2]!.trim();
    if (v === "") meta[lastKey] = undefined;
    else if (v.startsWith("[") && v.endsWith("]")) meta[lastKey] = v.slice(1, -1).split(",").map((s) => unq(s.trim())).filter(Boolean);
    else if (v === "true" || v === "false") meta[lastKey] = v === "true";
    else meta[lastKey] = unq(v);
  }
  return { meta, body: m[2]! };
}
const unq = (s: string) => s.replace(/^["']|["']$/g, "");

export const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin");

function roots(cwd: string, kind: "skills" | "commands" | "agents", extra: string[] = []): string[] {
  const r = [join(BUILTIN_DIR, kind), join(RCODE_HOME, kind), join(homedir(), ".claude", kind)];
  if (isTrusted(cwd) || process.env.RCODE_TRUST_PROJECT === "1") r.push(join(cwd, ".claude", kind), join(cwd, ".rcode", kind));
  return [...r, ...extra].filter((d) => existsSync(d));
}

export interface Skill { name: string; description: string; path: string; body: string }
export function loadSkills(cwd: string, extra?: string[]): Skill[] {
  const map = new Map<string, Skill>();
  for (const root of roots(cwd, "skills", extra)) {
    for (const ent of safeReaddir(root)) {
      const file = join(root, ent, "SKILL.md");
      if (!existsSync(file)) continue;
      const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = String(meta.name ?? ent);
      map.set(name, { name, description: String(meta.description ?? body.split("\n").find((l) => l.trim()) ?? "").slice(0, 300), path: file, body });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Command { name: string; description: string; body: string; path: string; argumentHint?: string; model?: string; agent?: string }
export function loadCommands(cwd: string, extra?: string[]): Command[] {
  const map = new Map<string, Command>();
  for (const root of roots(cwd, "commands", extra)) {
    for (const file of walkMd(root)) {
      const rel = file.slice(root.length + 1).replace(/\.md$/, "");
      const name = rel.replace(/\//g, ":");
      const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
      map.set(name, { name, description: String(meta.description ?? body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "").slice(0, 120), body, path: file, argumentHint: meta["argument-hint"] as string | undefined, model: meta.model as string | undefined, agent: meta.agent as string | undefined });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(cmd: Command, argStr: string): string {
  const args = argStr.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [];
  let out = cmd.body.replace(/\$ARGUMENTS|\$@/g, argStr).replace(/\$(\d+)/g, (_, n) => args[Number(n) - 1] ?? "");
  if (!/\$ARGUMENTS|\$@|\$\d/.test(cmd.body) && argStr.trim()) out += `\n\nArguments: ${argStr}`;
  return out;
}

export interface AgentDef { name: string; description: string; tools?: string[]; model?: string; body: string; path: string }
export function loadAgents(cwd: string, extra?: string[]): AgentDef[] {
  const map = new Map<string, AgentDef>();
  for (const root of roots(cwd, "agents", extra)) {
    for (const file of walkMd(root)) {
      const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = String(meta.name ?? basename(file, ".md"));
      const tools = typeof meta.tools === "string" ? meta.tools.split(/,\s*/) : (meta.tools as string[] | undefined);
      map.set(name, { name, description: String(meta.description ?? "").slice(0, 400), tools, model: meta.model as string | undefined, body, path: file });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function safeReaddir(d: string): string[] { try { return readdirSync(d); } catch { return []; } }
function walkMd(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of safeReaddir(dir)) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walkMd(p, depth + 1));
    else if (e.endsWith(".md") && e !== "README.md") out.push(p);
  }
  return out;
}
