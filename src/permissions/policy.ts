/**
 * Permission policy.
 *   modes:  plan (read-only) · ask (approve writes & risky commands) · auto-edit (edits free, risky bash asks) · full (no prompts, catastrophic still denied)
 *   rules:  "allow"/"deny" lists of patterns: "bash(npm test*)", "edit(src/**)", "web_fetch", "mcp__github__*"
 *   bash:   deterministic risk classifier (safe / normal / risky / catastrophic) — inspired by jcode-command-risk.
 */
import type { BeforeToolCall, PermissionDecision, Tool } from "../agent/types.ts";

export type PermissionMode = "plan" | "ask" | "auto-edit" | "full";

export interface PermissionRules { allow: string[]; deny: string[] }

export type Asker = (req: { tool: Tool; args: Record<string, unknown>; summary: string; reason: string }) => Promise<"allow" | "allow-session" | "deny">;

const SAFE_CMDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "echo", "which", "whoami", "date", "file", "stat", "tree", "rg", "grep", "find", "fd", "du", "df", "env", "printenv", "uname", "sort", "uniq", "cut", "diff", "basename", "dirname", "realpath", "jq", "true", "type", "less", "md5", "shasum", "sha256sum", "nproc", "ps", "id", "hostname", "test", "["]);
const SAFE_GIT = /^git\s+(status|diff|log|show|branch(\s+-[avl]+)*\s*$|rev-parse|ls-files|blame|remote\s+-v|config\s+--get|describe|tag\s*$|stash\s+list|grep|shortlog)/;
const SAFE_PKG = /^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|typecheck|check|build)|ls|why|outdated|-v|--version)\b|^(cargo\s+(check|test|build|clippy|fmt\s+--check)|go\s+(test|vet|build)|pytest|python3?\s+-m\s+pytest|tsc(\s|$)|eslint|ruff\s+check|mypy|deno\s+(test|check|lint))/;

const CATASTROPHIC: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|~\/\*)(\s|$)/, "recursive delete of root or home"],
  [/\bmkfs(\.\w+)?\b/, "formats a filesystem"],
  [/\bdd\b.*\bof=\/dev\/(sd|disk|nvme|hd)/, "overwrites a block device"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\bchmod\s+-R\s+0?777\s+\/(\s|$)/, "chmod 777 on root"],
  [/>\s*\/dev\/(sd|disk|nvme)/, "writes to a block device"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "powers off the machine"],
];
const RISKY: Array<[RegExp, string]> = [
  [/\brm\s+-[a-zA-Z]*r/, "recursive delete"],
  [/\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/, "force push"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.)/, "discards local changes"],
  [/\bgit\s+push\b/, "pushes to a remote"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "pipes a download into a shell"],
  [/\bsudo\b/, "runs as root"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b/, "publishes a package"],
  [/\b(drop\s+(table|database)|truncate\s+table)\b/i, "destructive SQL"],
  [/\bkubectl\s+(delete|apply)|\bterraform\s+(apply|destroy)/, "changes infrastructure"],
];

export type Risk = { level: "safe" | "normal" | "risky" | "catastrophic"; reason?: string };

export function classifyCommand(cmd: string): Risk {
  const c = cmd.trim();
  for (const [re, why] of CATASTROPHIC) if (re.test(c)) return { level: "catastrophic", reason: why };
  for (const [re, why] of RISKY) if (re.test(c)) return { level: "risky", reason: why };
  // Safe only if every segment of a pipeline/chain is safe and there's no redirection to files.
  if (/[^>]>[^>&]|>>|`|\$\(/.test(c)) return { level: "normal" };
  const segments = c.split(/\|\||&&|;|\|/).map((s) => s.trim()).filter(Boolean);
  const allSafe = segments.every((s) => {
    const first = s.split(/\s+/)[0]!.replace(/^.*\//, "");
    return SAFE_CMDS.has(first) && !/\s-(exec|delete)\b/.test(s) || SAFE_GIT.test(s) || SAFE_PKG.test(s);
  });
  return allSafe ? { level: "safe" } : { level: "normal" };
}

function globToRe(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".") + "$");
}

/** "bash(npm test*)" → matches tool "bash" whose primary arg matches the glob. */
export function matchRule(rule: string, tool: string, primary: string | undefined): boolean {
  const m = rule.match(/^([\w*-]+)(?:\((.*)\))?$/);
  if (!m) return false;
  if (!globToRe(m[1]!).test(tool)) return false;
  if (m[2] === undefined) return true;
  if (primary === undefined) return false;
  // For commands, "*" spans anything (including "/").
  const pat = tool === "bash" ? new RegExp("^" + m[2].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : globToRe(m[2]);
  return pat.test(primary);
}

function primaryArg(tool: Tool, args: Record<string, unknown>): string | undefined {
  return (args.command ?? args.path ?? args.url ?? args.pattern) as string | undefined;
}

export class PermissionPolicy {
  private sessionAllows = new Set<string>();
  constructor(public mode: PermissionMode, public rules: PermissionRules = { allow: [], deny: [] }, public asker?: Asker) {}

  async decide({ tool, args }: BeforeToolCall): Promise<PermissionDecision> {
    const primary = primaryArg(tool, args);
    const summary = tool.summarize?.(args as any) ?? JSON.stringify(args).slice(0, 200);

    if (tool.name === "bash") {
      const risk = classifyCommand(String(args.command ?? ""));
      if (risk.level === "catastrophic") return { action: "deny", reason: `Refused: command ${risk.reason}. rcode never runs this automatically — ask the user to run it themselves.` };
    }
    for (const r of this.rules.deny) if (matchRule(r, tool.name, primary)) return { action: "deny", reason: `Denied by rule "${r}"` };
    for (const r of this.rules.allow) if (matchRule(r, tool.name, primary)) return { action: "allow" };

    const e = tool.effects;
    if (e.readOnly && !e.network) return { action: "allow" };
    if (this.mode === "plan") {
      if (e.readOnly) return { action: "allow" };
      if (tool.name === "bash" && classifyCommand(String(args.command)).level === "safe") return { action: "allow" };
      return { action: "deny", reason: "Plan mode is read-only. Present your plan instead of making changes." };
    }
    if (this.mode === "full") return { action: "allow" };

    let needAsk = false, reason = "";
    if (tool.name === "bash") {
      const risk = classifyCommand(String(args.command ?? ""));
      if (risk.level === "safe") return { action: "allow" };
      if (risk.level === "risky") { needAsk = true; reason = risk.reason!; }
      else if (this.mode === "ask") { needAsk = true; reason = "runs a command"; }
    } else if (e.writesFiles) {
      if (this.mode === "ask") { needAsk = true; reason = "modifies files"; }
    } else if (e.network) {
      if (this.mode === "ask") { needAsk = true; reason = "accesses the network"; }
    } else if (e.runsProcess || e.destructive || !e.readOnly) {
      if (this.mode === "ask" || e.destructive) { needAsk = true; reason = e.destructive ? "is destructive" : "has side effects"; }
    }
    if (!needAsk) return { action: "allow" };

    const key = tool.name === "bash" ? `bash:${String(args.command).split(/\s+/).slice(0, 2).join(" ")}` : tool.name;
    if (this.sessionAllows.has(key)) return { action: "allow" };
    if (!this.asker) return { action: "deny", reason: `Needs approval (${reason}) but no interactive user. Re-run with --yes or add an allow rule.` };
    const ans = await this.asker({ tool, args, summary, reason });
    if (ans === "allow-session") { this.sessionAllows.add(key); return { action: "allow" }; }
    if (ans === "allow") return { action: "allow" };
    return { action: "deny", reason: "The user declined this action. Ask what they'd prefer, or take a different approach." };
  }
}
