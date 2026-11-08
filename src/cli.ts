#!/usr/bin/env bun
/**
 * rcode CLI
 *   rcode                      interactive TUI
 *   rcode "fix the tests"      TUI with an initial prompt
 *   rcode -p "..." [--json]    headless (text or JSONL events)
 *   rcode --rpc                JSONL RPC over stdio (drive rcode from any program)
 *   rcode acp                  Agent Client Protocol server (Zed, t3code, goose desktop, …)
 *   rcode setup | doctor | models | sessions | login | mcp
 */
import { parseArgs } from "node:util";
import { fstatSync, readFileSync } from "node:fs";
import { AgentSession } from "./core/session.ts";
import type { PermissionMode } from "./permissions/policy.ts";
import type { ThinkingLevel } from "./ai/types.ts";
import { ensureHome } from "./config.ts";

export const VERSION = "0.1.0";

const HELP = `rcode ${VERSION} — the open, fast, extensible coding agent

Usage:
  rcode [prompt]                 Interactive mode
  rcode -p, --print <prompt>     Run headless and print the result (reads stdin if piped)
      --json                     Emit JSONL events instead of text
  rcode --rpc                    JSONL RPC over stdin/stdout
  rcode acp                      Agent Client Protocol server over stdio
  rcode setup                    First-run wizard (models, memory, RuvNet stack)
  rcode doctor                   Health check of providers, tools, MCP, memory
  rcode models [--refresh]       List models (refresh pricing from models.dev)
  rcode sessions                 List recent sessions for this directory
  rcode login <provider> [key]   Store an API key (anthropic, openai, google, openrouter, telegram, …)
  rcode gateway                  Talk to rcode from your phone: Telegram + web UI (pair/install/uninstall)

Options:
  -m, --model <ref>              provider/model or alias (opus, sonnet, haiku, gpt5, gemini, ollama/qwen3-coder)
  -t, --thinking <level>         off|minimal|low|medium|high|xhigh|max
  -c, --continue                 Continue the most recent session
  -r, --resume <file>            Resume a session file
      --plan                     Start in plan mode (read-only)
  -y, --yes                      Full-auto: no approval prompts (catastrophic commands still refused)
      --auto-edit                Edits without asking; risky commands still ask
      --tools <a,b,c>            Restrict tools
      --minimal                  Skip MCP / memory / RuvNet for fastest startup
      --no-session               Don't persist the session
      --cwd <dir>                Working directory
  -v, --version
  -h, --help
`;

/** Read stdin only when it is a real pipe or file (never block on an idle inherited stdin). */
function readPipedStdin(): string {
  try {
    const st = fstatSync(0);
    if (!st.isFIFO() && !st.isFile()) return "";
    if (st.isFile() && st.size === 0) return "";
    return readFileSync(0, "utf8").trim();
  } catch { return ""; }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      print: { type: "boolean", short: "p" }, json: { type: "boolean" }, rpc: { type: "boolean" },
      model: { type: "string", short: "m" }, thinking: { type: "string", short: "t" },
      continue: { type: "boolean", short: "c" }, resume: { type: "string", short: "r" },
      plan: { type: "boolean" }, yes: { type: "boolean", short: "y" }, "auto-edit": { type: "boolean" },
      tools: { type: "string" }, minimal: { type: "boolean" }, "no-session": { type: "boolean" },
      user: { type: "boolean" }, cwd: { type: "string" }, port: { type: "string" }, host: { type: "string" }, "no-web": { type: "boolean" }, quiet: { type: "boolean", short: "q" }, refresh: { type: "boolean" },
      version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values.version) { console.log(VERSION); return 0; }
  const cwd = (values.cwd as string) ?? process.cwd();
  if (values.cwd) process.chdir(cwd);
  ensureHome();

  const sub = positionals[0];
  if (sub && ["setup", "doctor", "models", "sessions", "login", "acp", "mcp", "gateway"].includes(sub) && !values.print) {
    const { runSubcommand } = await import("./commands.ts");
    return runSubcommand(sub, positionals.slice(1), values as any, cwd);
  }

  const mode: PermissionMode = values.plan ? "plan" : values.yes ? "full" : values["auto-edit"] ? "auto-edit" : (undefined as any);
  const baseOpts = {
    cwd,
    model: values.model as string | undefined,
    thinking: values.thinking as ThinkingLevel | undefined,
    mode,
    resume: values.continue ? ("continue" as const) : (values.resume as string | undefined),
    ephemeral: !!values["no-session"],
    minimal: !!values.minimal,
    tools: (values.tools as string | undefined)?.split(","),
  };

  if (values.rpc) {
    const { runRpc } = await import("./modes/rpc.ts");
    return runRpc(baseOpts);
  }

  let prompt = positionals.join(" ");
  if (values.print) {
    const piped = readPipedStdin();
    if (piped) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped}\n</stdin>` : piped;
    if (!prompt.trim()) { console.error("No prompt given."); return 2; }
    const session = await new AgentSession({ ...baseOpts, mode: mode ?? "auto-edit" }).init();
    const { runPrint } = await import("./modes/print.ts");
    const code = await runPrint(session, prompt, { json: !!values.json, quiet: !!values.quiet });
    await session.dispose();
    return code;
  }

  const { runInteractive } = await import("./tui/app.ts");
  return runInteractive(baseOpts, prompt || undefined);
}

main().then((code) => process.exit(code ?? 0)).catch((e) => { console.error(`rcode: ${e?.message ?? e}`); process.exit(1); });
