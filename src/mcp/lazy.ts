/**
 * Lazy MCP tool loading. With many MCP tools, sending every schema each turn wastes context and
 * hurts tool selection. Instead expose two tools: `mcp_search` (keyword search over the catalog,
 * returns names, descriptions and input schemas) and `mcp_call` (invoke one by name). Permissions
 * and effects are resolved from the target tool, so approval behaviour is unchanged.
 */
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { text } from "../tools/util.ts";
import { tokenize } from "../memory/flat.ts";

export function createLazyMcpTools(getTools: () => Tool[]): Tool[] {
  const find = (name: string) => getTools().find((t) => t.name === name);
  const searchSchema = z.object({ query: z.string().describe("What you want to do, e.g. 'create github issue' or 'query postgres'"), limit: z.number().int().min(1).max(20).optional() });
  const callSchema = z.object({ name: z.string().describe("Exact tool name from mcp_search, e.g. mcp__github__create_issue"), arguments: z.record(z.string(), z.unknown()).describe("Arguments matching the tool's input schema") });
  const servers = () => [...new Set(getTools().map((t) => t.name.split("__")[1]))].join(", ");

  const search: Tool<typeof searchSchema> = {
    name: "mcp_search",
    label: "MCP search",
    get description() { return `Search the tools provided by connected MCP servers (${servers() || "none"}). Returns matching tool names, descriptions and input schemas; then call one with mcp_call.`; },
    schema: searchSchema,
    concurrency: "shared",
    effects: { readOnly: true },
    summarize: (a) => a.query,
    async execute(a) {
      const q = tokenize(a.query);
      const scored = getTools().map((t) => {
        const hay = tokenize(`${t.name.replace(/__/g, " ")} ${t.description}`);
        const score = q.reduce((s, w) => s + (hay.includes(w) ? 2 : hay.some((h) => h.startsWith(w) || w.startsWith(h)) ? 1 : 0), 0);
        return { t, score };
      }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, a.limit ?? 8);
      if (!scored.length) return text(`No MCP tools matched. Servers: ${servers()}. Try broader words.`);
      return text(scored.map(({ t }) => `## ${t.name}\n${t.description.slice(0, 600)}\ninput schema: ${JSON.stringify(t.jsonSchema ?? {}).slice(0, 1500)}`).join("\n\n"));
    },
  };

  const call: Tool<typeof callSchema> = {
    name: "mcp_call",
    label: "MCP call",
    description: "Call an MCP tool by exact name (find it first with mcp_search).",
    schema: callSchema,
    concurrency: "exclusive",
    effects: { runsProcess: true, network: true },
    effectsFor: (a) => find(a.name)?.effects ?? { runsProcess: true, network: true },
    permissionKey: (a) => a.name,
    summarize: (a) => `${a.name} ${JSON.stringify(a.arguments).slice(0, 100)}`,
    async execute(a, ctx) {
      const t = find(a.name);
      if (!t) return text(`Unknown MCP tool "${a.name}". Use mcp_search to find the exact name.`, true);
      return t.execute(a.arguments as any, ctx);
    },
  };
  return [search, call] as Tool[];
}
