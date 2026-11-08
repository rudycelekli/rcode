import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { DEFAULT_IGNORES, isBinary, resolvePath, ripgrep, text, truncateTail } from "./util.ts";

// ───────────── grep ─────────────
const grepSchema = z.object({
  pattern: z.string().describe("Regex pattern (ripgrep syntax)"),
  path: z.string().optional().describe("File or directory to search (default: cwd)"),
  glob: z.string().optional().describe("Filter files, e.g. '*.ts' or '**/*.{ts,tsx}'"),
  ignore_case: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional().describe("Lines of context around matches"),
  files_only: z.boolean().optional().describe("Only list matching file paths"),
  limit: z.number().int().min(1).optional().describe("Max matches (default 200)"),
});

export const grepTool: Tool<typeof grepSchema> = {
  name: "grep",
  label: "Grep",
  description: "Search file contents with a regex (ripgrep; respects .gitignore). Returns path:line:text. Use files_only to just list files.",
  schema: grepSchema,
  concurrency: "shared",
  effects: { readOnly: true },
  summarize: (a) => `/${a.pattern}/${a.path ? " in " + a.path : ""}${a.glob ? " " + a.glob : ""}`,
  async execute(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? ".");
    const limit = a.limit ?? 200;
    const rg = ripgrep();
    if (rg) {
      const args = ["--line-number", "--no-heading", "--color=never", "--max-columns=400", "--max-columns-preview", "--hidden", "-g", "!.git"];
      if (a.ignore_case) args.push("-i");
      if (a.context) args.push("-C", String(a.context));
      if (a.files_only) args.push("-l");
      if (a.glob) args.push("-g", a.glob);
      args.push("--", a.pattern, root);
      const r = spawnSync(rg, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal: ctx.signal });
      if (r.status === 1) return text("No matches.");
      if (r.status !== 0 && !r.stdout) return text(`grep error: ${r.stderr}`, true);
      const relRoot = relative(ctx.cwd, root);
      const lines = r.stdout.split("\n").filter(Boolean).map((l) => (l.startsWith(root + "/") ? (relRoot ? relRoot + "/" : "") + l.slice(root.length + 1) : l));
      const more = lines.length > limit ? `\n[${lines.length - limit} more matches; narrow the pattern or path]` : "";
      return text(truncateTail(lines.slice(0, limit).join("\n"), "grep").text + more);
    }
    // Pure-JS fallback
    let re: RegExp;
    try { re = new RegExp(a.pattern, a.ignore_case ? "i" : ""); } catch (e: any) { return text(`Invalid regex: ${e.message}`, true); }
    const globRe = a.glob ? new Bun.Glob(a.glob) : undefined;
    const out: string[] = [];
    for (const f of walk(root)) {
      if (out.length >= limit) break;
      const rel = relative(ctx.cwd, f);
      if (globRe && !globRe.match(rel) && !globRe.match(f.split("/").pop()!)) continue;
      let buf: Buffer;
      try { buf = readFileSync(f); } catch { continue; }
      if (isBinary(buf)) continue;
      const ls = buf.toString("utf8").split("\n");
      for (let i = 0; i < ls.length && out.length < limit; i++) {
        if (re.test(ls[i]!)) { if (a.files_only) { out.push(rel); break; } out.push(`${rel}:${i + 1}:${ls[i]!.slice(0, 400)}`); }
      }
    }
    return text(out.length ? out.join("\n") : "No matches.");
  },
};

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 30) return;
  let entries;
  try { if (statSync(dir).isFile()) { yield dir; return; } entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (DEFAULT_IGNORES.includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

// ───────────── glob ─────────────
const globSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts', 'src/**/test_*.py'"),
  path: z.string().optional().describe("Directory to search (default cwd)"),
  limit: z.number().int().min(1).optional(),
});

export const globTool: Tool<typeof globSchema> = {
  name: "glob",
  label: "Glob",
  description: "Find files by glob pattern (respects .gitignore in git repos). Results sorted by most recently modified.",
  schema: globSchema,
  concurrency: "shared",
  effects: { readOnly: true },
  summarize: (a) => a.pattern + (a.path ? ` in ${a.path}` : ""),
  async execute(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? ".");
    const limit = a.limit ?? 300;
    const g = new Bun.Glob(a.pattern);
    let files: string[] = [];
    const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (git.status === 0) files = git.stdout.split("\n").filter((f) => f && g.match(f)).map((f) => join(root, f));
    else for (const f of g.scanSync({ cwd: root, onlyFiles: true, dot: false })) { if (!f.split("/").some((s) => DEFAULT_IGNORES.includes(s))) files.push(join(root, f)); }
    const withTime = files.map((f) => { try { return [f, statSync(f).mtimeMs] as const; } catch { return [f, 0] as const; } }).sort((x, y) => y[1] - x[1]);
    const shown = withTime.slice(0, limit).map(([f]) => relative(ctx.cwd, f) || f);
    return text(shown.length ? shown.join("\n") + (withTime.length > limit ? `\n[${withTime.length - limit} more]` : "") : "No files found.");
  },
};

// ───────────── ls ─────────────
const lsSchema = z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(5).optional().describe("Tree depth (default 2)") });
export const lsTool: Tool<typeof lsSchema> = {
  name: "ls",
  label: "List",
  description: "Show a directory tree (ignores node_modules, .git, build dirs).",
  schema: lsSchema,
  concurrency: "shared",
  effects: { readOnly: true },
  summarize: (a) => a.path ?? ".",
  async execute(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? ".");
    const lines: string[] = [];
    const max = 400;
    const rec = (dir: string, prefix: string, d: number) => {
      if (lines.length >= max) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !DEFAULT_IGNORES.includes(e.name)).sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name)); } catch { return; }
      for (const e of entries) {
        if (lines.length >= max) { lines.push(prefix + "…"); return; }
        lines.push(prefix + e.name + (e.isDirectory() ? "/" : ""));
        if (e.isDirectory() && d > 1) rec(join(dir, e.name), prefix + "  ", d - 1);
      }
    };
    rec(root, "", a.depth ?? 2);
    return text(`${root}/\n${lines.join("\n")}`);
  },
};
