/**
 * User-configured shell hooks (Claude-Code / Open-Plugins compatible shape).
 * Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SessionEnd.
 * The hook receives a JSON payload on stdin. Exit code 2 (or {"decision":"block"} on stdout) blocks
 * PreToolUse / UserPromptSubmit; stdout text from UserPromptSubmit/SessionStart is added as context.
 */
import { spawn } from "node:child_process";
import type { HookConfig } from "../config.ts";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "PreCompact" | "SessionEnd";

export interface HookOutcome { block?: string; context?: string }

export class ShellHooks {
  constructor(private hooks: HookConfig[], private cwd: string) {}
  has(event: HookEvent) { return this.hooks.some((h) => h.event === event); }

  async run(event: HookEvent, payload: Record<string, unknown>, matchTarget?: string): Promise<HookOutcome> {
    const relevant = this.hooks.filter((h) => h.event === event && (!h.matcher || !matchTarget || new RegExp(`^(${h.matcher})$`).test(matchTarget)));
    const out: HookOutcome = {};
    for (const h of relevant) {
      const r = await exec(h.command, JSON.stringify({ hook_event_name: event, cwd: this.cwd, ...payload }), this.cwd, h.timeoutMs ?? 30_000);
      let parsed: any;
      try { parsed = JSON.parse(r.stdout); } catch {}
      if (r.code === 2 || parsed?.decision === "block") { out.block = (parsed?.reason ?? r.stderr ?? r.stdout).trim() || "Blocked by hook"; break; }
      const ctx = parsed?.additionalContext ?? parsed?.hookSpecificOutput?.additionalContext ?? (parsed ? undefined : r.stdout.trim());
      if (ctx) out.context = (out.context ? out.context + "\n" : "") + ctx;
    }
    return out;
  }
}

function exec(cmd: string, input: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.env.SHELL ?? "/bin/sh", ["-c", cmd], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RCODE_HOOK: "1" } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { p.kill("SIGKILL"); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
    p.on("error", () => { clearTimeout(t); resolve({ code: 1, stdout, stderr: "hook failed to start" }); });
    p.stdin.end(input);
  });
}
