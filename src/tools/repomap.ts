import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { repoMap } from "../context/repomap.ts";
import { text } from "./util.ts";

const schema = z.object({
  query: z.string().optional().describe("What you're working on (identifiers, feature words). Biases the ranking toward relevant files."),
  focus: z.array(z.string()).optional().describe("Files you're already looking at; their neighbors rank higher"),
  max_tokens: z.number().int().min(300).max(8000).optional().describe("Budget for the map (default 2000)"),
});

export const repoMapTool: Tool<typeof schema> = {
  name: "repo_map",
  label: "Repo map",
  description: "Get a ranked map of the codebase: the most important files (by how much the rest of the code depends on them, biased toward your query) with their key definitions and line numbers. Use it first in an unfamiliar repo or to find where a feature lives, then read the specific files.",
  schema,
  concurrency: "shared",
  effects: { readOnly: true },
  summarize: (a) => a.query ?? "(whole repo)",
  async execute(a, ctx) {
    const t0 = Date.now();
    const map = repoMap(ctx.cwd, { query: a.query, focusFiles: a.focus, maxTokens: a.max_tokens });
    return text(map ? `${map}\n[repo map built in ${Date.now() - t0}ms]` : "No recognized source files found.");
  },
};
