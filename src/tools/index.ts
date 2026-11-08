import type { Tool } from "../agent/types.ts";
import { bashKillTool, bashOutputTool, bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { globTool, grepTool, lsTool } from "./search.ts";
import { todoTool } from "./todo.ts";
import { webFetchTool } from "./web.ts";
import { writeTool } from "./write.ts";

export { readTool, writeTool, editTool, bashTool, bashOutputTool, bashKillTool, grepTool, globTool, lsTool, todoTool, webFetchTool };

/** Core built-in tools (task/memory/mcp tools are added by the session). */
export function coreTools(): Tool[] {
  return [readTool, editTool, writeTool, bashTool, bashOutputTool, bashKillTool, grepTool, globTool, lsTool, todoTool, webFetchTool] as Tool[];
}

export function filterTools(tools: Tool[], allow?: string[]): Tool[] {
  if (!allow || !allow.length || allow.includes("*")) return tools;
  const names = new Set(allow.map((n) => n.trim().toLowerCase()));
  // Accept Claude-Code style names too (Read, Bash, Grep…)
  return tools.filter((t) => names.has(t.name) || names.has(t.name.toLowerCase()) || (t.name === "edit" && names.has("multiedit")) || (t.name === "glob" && names.has("ls")));
}
