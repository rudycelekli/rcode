/**
 * Layered config: defaults ← ~/.rcode/config.json ← <project>/.rcode/config.json ← CLI flags.
 * Credentials live separately in ~/.rcode/auth.json (chmod 600).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "./ai/types.ts";
import type { PermissionMode } from "./permissions/policy.ts";
import { RCODE_HOME } from "./session/store.ts";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Only expose these tools (glob patterns). */
  tools?: string[];
  timeoutMs?: number;
}

export interface HookConfig { event: string; matcher?: string; command: string; timeoutMs?: number }

export interface RcodeConfig {
  model?: string;
  smallModel?: string;
  thinking?: ThinkingLevel;
  permissionMode?: PermissionMode;
  permissions?: { allow?: string[]; deny?: string[] };
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: HookConfig[];
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  memory?: { enabled?: boolean; provider?: "auto" | "ruvector" | "flat" | "off"; autoCapture?: boolean; maxInject?: number; /** "onnx" = on-device MiniLM via ruvector (downloads ~90MB once). Default "hash". */ embeddings?: "hash" | "onnx" };
  ruvnet?: { ruflo?: boolean; brain?: boolean };
  maxTurns?: number;
  /** Nudge the agent to verify (or admit it didn't) after editing files. Default true. */
  verifyGate?: boolean;
  /** Snapshot the git worktree before each prompt (hidden refs) so /undo also reverts bash changes. Default true. */
  checkpoints?: boolean;
  /** Above this many MCP tools, expose them via mcp_search/mcp_call instead of inline schemas. Default 30. */
  mcpLazyThreshold?: number;
  /** Force optional tools on/off (default: on when their native CLI is installed). */
  tools?: { browser?: boolean; desktop?: boolean };
  theme?: string;
  /** Compatibility imports. claudeHome: also load ~/.claude/agents and ~/.claude/skills. */
  compat?: { claudeHome?: boolean };
  /** Extra skill/command/agent directories. */
  paths?: { skills?: string[]; commands?: string[]; agents?: string[] };
}

function readJson(p: string): any { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }

function merge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
  return out;
}

export function loadConfig(cwd: string): RcodeConfig {
  const global = readJson(join(RCODE_HOME, "config.json"));
  const project = readJson(join(cwd, ".rcode", "config.json"));
  // Project MCP servers / hooks run code: only honored when the project is trusted.
  if (!isTrusted(cwd)) { delete project.mcpServers; delete project.hooks; }
  return merge(global, project);
}

export function saveGlobalConfig(patch: Partial<RcodeConfig>) {
  mkdirSync(RCODE_HOME, { recursive: true });
  const p = join(RCODE_HOME, "config.json");
  writeFileSync(p, JSON.stringify(merge(readJson(p), patch), null, 2));
}

// ── Auth store ──
const authPath = () => join(RCODE_HOME, "auth.json");
export function loadAuth(): Record<string, string> { return readJson(authPath()); }
export function saveAuth(provider: string, key: string) {
  mkdirSync(RCODE_HOME, { recursive: true });
  const a = loadAuth();
  a[provider] = key;
  writeFileSync(authPath(), JSON.stringify(a, null, 2));
  try { chmodSync(authPath(), 0o600); } catch {}
}

// ── Trusted projects ──
const trustPath = () => join(RCODE_HOME, "trusted.json");
export function isTrusted(cwd: string): boolean {
  const t: string[] = readJson(trustPath()).dirs ?? [];
  return t.some((d) => cwd === d || cwd.startsWith(d + "/"));
}
export function trust(cwd: string) {
  mkdirSync(RCODE_HOME, { recursive: true });
  const t = readJson(trustPath());
  t.dirs = [...new Set([...(t.dirs ?? []), cwd])];
  writeFileSync(trustPath(), JSON.stringify(t, null, 2));
}

export function ensureHome() {
  for (const d of ["", "sessions", "skills", "commands", "agents", "memory"]) mkdirSync(join(RCODE_HOME, d), { recursive: true });
  return existsSync(RCODE_HOME);
}
