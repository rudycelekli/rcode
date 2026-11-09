/**
 * Default local-stack prelude.
 *
 * On every prompt, ask the connected learning server for a route and for
 * patterns that worked before. Each call has a 1.2s cap. A miss is dropped.
 * The turn never waits on a slow backend. Source excerpts stay in the
 * integration's own beforePrompt.
 *
 * Session start does not start a worker daemon (that path can spend tokens).
 */
import type { McpManager } from "../mcp/manager.ts";
import type { Tool } from "../agent/types.ts";

export interface StackHint { route?: string; patterns?: string }

export function formatStackHint(h: StackHint): string | undefined {
  const parts: string[] = [];
  if (h.route) parts.push(`Route: ${h.route}`);
  if (h.patterns) parts.push(`What worked before:\n${h.patterns}`);
  if (!parts.length) return undefined;
  return `<stack note="local routing and memory; use when it helps, ignore when it doesn't">\n${parts.join("\n").slice(0, 1200)}\n</stack>`;
}

export function routeLine(raw: string): string | undefined {
  try {
    const j = JSON.parse(raw);
    const p = j.primaryAgent ?? j.routing?.primaryAgent ?? j.result?.primaryAgent;
    if (p && typeof p === "object" && typeof p.type === "string") {
      const why = p.reason ? ` — ${String(p.reason).replace(/\s+/g, " ").slice(0, 140)}` : "";
      return `${p.type}${why}`;
    }
  } catch { /* plain text */ }
  const line = raw.split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("{") && !s.startsWith("["));
  return line ? line.slice(0, 180) : undefined;
}

export function clipText(raw: string, max = 500): string | undefined {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function findTool(mcp: McpManager, suffix: string): Tool | undefined {
  return mcp.getTools().find((t) => t.name.endsWith(`__${suffix}`));
}

async function callTool(tool: Tool, args: Record<string, unknown>, cwd: string, timeoutMs: number): Promise<string | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await tool.execute(args, { cwd, signal: ctl.signal, toolCallId: "stack", state: new Map(), agent: undefined as never });
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    return text || undefined;
  } catch { return undefined; } finally { clearTimeout(timer); }
}

/** Route + remembered patterns. Undefined when nothing came back in time. */
export async function stackPrelude(mcp: McpManager | undefined, prompt: string, cwd: string): Promise<string | undefined> {
  if (!mcp) return undefined;
  const q = prompt.slice(0, 400);
  const routeTool = findTool(mcp, "hooks_route");
  const patternTool = findTool(mcp, "hooks_intelligence_pattern-search");
  if (!routeTool && !patternTool) return undefined;
  const [route, patterns] = await Promise.all([
    routeTool ? callTool(routeTool, { task: q }, cwd, 1200) : undefined,
    patternTool ? callTool(patternTool, { query: q, topK: 3 }, cwd, 1200) : undefined,
  ]);
  return formatStackHint({
    route: route ? routeLine(route) : undefined,
    patterns: patterns ? clipText(patterns, 500) : undefined,
  });
}

/** Once the learning server connects, open a session without starting its daemon. */
export function armStackSession(mcp: McpManager | undefined, sessionId: string, cwd: string) {
  if (!mcp) return;
  let armed = false;
  const fire = () => {
    if (armed) return;
    const tool = findTool(mcp, "hooks_session-start");
    if (!tool) return;
    armed = true;
    void callTool(tool, { sessionId, restoreLatest: true, startDaemon: false }, cwd, 2000);
  };
  fire();
  mcp.onChange(fire);
}
