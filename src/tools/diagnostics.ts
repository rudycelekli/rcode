/**
 * diagnostics: run the project's own checker, and a millisecond syntax check
 * that the session appends after TypeScript/JavaScript edits.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { resolvePath, text, truncateTail } from "./util.ts";

const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function loaderFor(ext: string): "ts" | "tsx" | "js" | undefined {
  if (ext === ".tsx" || ext === ".jsx") return "tsx";
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
  return undefined;
}

/** First syntax error, or undefined when the file is fine or not a script. */
export function syntaxNote(cwd: string, rel: string): string | undefined {
  if (!rel || rel.includes("node_modules")) return undefined;
  const ext = extname(rel.split(":")[0] ?? rel);
  const loader = loaderFor(ext);
  if (!loader || !CODE.has(ext)) return undefined;
  const abs = resolvePath(cwd, rel);
  if (!existsSync(abs)) return undefined;
  let src: string;
  try { src = readFileSync(abs, "utf8"); } catch { return undefined; }
  if (src.length > 500_000) return undefined;
  try {
    new Bun.Transpiler({ loader }).transformSync(src);
    return undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.split("\n").slice(0, 6).join("\n");
  }
}

function projectChecker(cwd: string): { label: string; cmd: string[] } | undefined {
  if (existsSync(join(cwd, "tsconfig.json"))) return { label: "tsc", cmd: ["bunx", "tsc", "--noEmit", "--pretty", "false", "--incremental", "false"] };
  if (existsSync(join(cwd, "Cargo.toml"))) return { label: "cargo check", cmd: ["cargo", "check", "--quiet", "--message-format", "short"] };
  if (existsSync(join(cwd, "go.mod"))) return { label: "go vet", cmd: ["go", "vet", "./..."] };
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.cfg"))) return { label: "compileall", cmd: ["python3", "-m", "compileall", "-q", "."] };
  return undefined;
}

const schema = z.object({
  path: z.string().optional().describe("Optional file to syntax-check. Omit to run the project's type-checker or compiler."),
});

export const diagnosticsTool: Tool<typeof schema> = {
  name: "diagnostics",
  label: "Diagnostics",
  description: "Check the project for errors. With path, syntax-check that file. Without path, run the project's checker (tsc, cargo check, go vet, or python compileall) and return its output. Use after edits, before claiming the change works.",
  schema,
  concurrency: "exclusive",
  effects: { readOnly: true, runsProcess: true },
  summarize: (a) => a.path ? `syntax ${a.path}` : "project check",
  async execute(args, ctx) {
    if (args.path) {
      const note = syntaxNote(ctx.cwd, args.path);
      return note ? text(`Syntax error in ${args.path}:\n${note}`, true) : text(`${args.path}: syntax ok`);
    }
    const checker = projectChecker(ctx.cwd);
    if (!checker) return text("No project checker detected (looked for tsconfig.json, Cargo.toml, go.mod, pyproject.toml). Syntax-check a file with path, or run the project's test command.");
    const [bin, ...rest] = checker.cmd;
    const r = spawnSync(bin!, rest, { cwd: ctx.cwd, encoding: "utf8", timeout: 60_000, env: process.env });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (r.error) return text(`${checker.label} failed to start: ${r.error.message}`, true);
    const shaped = truncateTail(out || `(no output, exit ${r.status})`, checker.label);
    const ok = r.status === 0;
    return text(`${checker.label}: ${ok ? "clean" : `exit ${r.status}`}\n${shaped.text}`, !ok);
  },
};
