import type { Tool } from "../agent/types.ts";
import { bashKillTool, bashOutputTool, bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { globTool, grepTool, lsTool } from "./search.ts";
import { todoTool } from "./todo.ts";
import { webFetchTool } from "./web.ts";
import { writeTool } from "./write.ts";
import { browserTool } from "./browser.ts";
import { desktopTool } from "./desktop.ts";
import { findCli } from "./native-cli.ts";
import { repoMapTool } from "./repomap.ts";
import { diagnosticsTool } from "./diagnostics.ts";

export { repoMapTool, browserTool, desktopTool, readTool, writeTool, editTool, bashTool, bashOutputTool, bashKillTool, grepTool, globTool, lsTool, todoTool, webFetchTool, diagnosticsTool };

/** Core built-in tools (task/memory/mcp tools are added by the session). */
export function coreTools(opts: { browser?: boolean; desktop?: boolean } = {}): Tool[] {
  const tools = [readTool, editTool, writeTool, bashTool, bashOutputTool, bashKillTool, grepTool, globTool, lsTool, repoMapTool, todoTool, webFetchTool, diagnosticsTool] as Tool[];
  // Browser/desktop are included when their native CLIs are installed (or forced on in config) — no schema cost otherwise.
  if (opts.browser ?? !!findCli("agent-browser")) tools.push(browserTool as Tool);
  if (opts.desktop ?? !!findCli("agent-desktop")) tools.push(desktopTool as Tool);
  return tools;
}

export function filterTools(tools: Tool[], allow?: string[]): Tool[] {
  if (!allow || !allow.length || allow.includes("*")) return tools;
  const names = new Set(allow.map((n) => n.trim().toLowerCase()));
  // Accept Claude-Code style names too (Read, Bash, Grep…)
  return tools.filter((t) => names.has(t.name) || names.has(t.name.toLowerCase()) || (t.name === "edit" && names.has("multiedit")) || (t.name === "glob" && names.has("ls")));
}
