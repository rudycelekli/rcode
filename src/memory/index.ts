import { join } from "node:path";
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { RCODE_HOME } from "../session/store.ts";
import { text } from "../tools/util.ts";
import { FlatMemory } from "./flat.ts";
import { RuvectorMemory } from "./ruvector.ts";
import type { MemoryProvider } from "./types.ts";

export type { MemoryProvider, MemoryItem, MemoryHit } from "./types.ts";

let cached: Promise<MemoryProvider> | undefined;

/** First healthy provider: ruvector (native HNSW) → flat (pure TS). */
export function getMemory(pref: "auto" | "ruvector" | "flat" = "auto"): Promise<MemoryProvider> {
  if (cached) return cached;
  const dir = join(RCODE_HOME, "memory");
  const file = join(dir, "memories.jsonl");
  cached = (async () => {
    if (pref !== "flat") {
      try { const m = new RuvectorMemory(file, dir); await m.init(); return m; } catch (e) { if (pref === "ruvector") console.error(`[rcode] ruvector unavailable (${(e as Error).message}); using flat memory`); }
    }
    const m = new FlatMemory(file);
    await m.init();
    return m;
  })();
  return cached;
}

export function createMemoryTools(memory: () => Promise<MemoryProvider>, project: string): Tool[] {
  const rememberSchema = z.object({
    text: z.string().describe("A durable, self-contained fact worth remembering across sessions (preference, decision, convention, gotcha). Not task progress."),
    kind: z.enum(["fact", "preference", "decision", "pattern", "lesson"]).optional(),
    scope: z.enum(["project", "global"]).optional().describe("project (default) or global (applies to all projects)"),
    tags: z.array(z.string()).optional(),
  });
  const recallSchema = z.object({ query: z.string(), k: z.number().int().min(1).max(30).optional() });
  const forgetSchema = z.object({ id: z.string() });
  return [
    {
      name: "remember", label: "Remember",
      description: "Save a durable memory for future sessions (user preferences, project conventions, decisions and their reasons, non-obvious gotchas). Don't store secrets or transient task state.",
      schema: rememberSchema, concurrency: "exclusive", effects: { readOnly: true },
      summarize: (a: z.infer<typeof rememberSchema>) => a.text.slice(0, 80),
      async execute(a: z.infer<typeof rememberSchema>) {
        if (/(api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}|sk-[a-z0-9]{16,}/i.test(a.text)) return text("Refused: looks like a secret. Never store credentials in memory.", true);
        const m = await memory();
        const item = await m.add({ text: a.text, kind: a.kind ?? "fact", scope: a.scope ?? "project", project: a.scope === "global" ? undefined : project, tags: a.tags, source: "agent" });
        return text(`Remembered (${item.id}, ${m.name}).`);
      },
    },
    {
      name: "recall", label: "Recall",
      description: "Search long-term memory from earlier sessions (preferences, decisions, conventions).",
      schema: recallSchema, concurrency: "shared", effects: { readOnly: true },
      summarize: (a: z.infer<typeof recallSchema>) => a.query,
      async execute(a: z.infer<typeof recallSchema>) {
        const hits = await (await memory()).search(a.query, { k: a.k ?? 8, project });
        return text(hits.length ? hits.map((h) => `- [${h.item.id}] (${h.item.kind ?? "fact"}, ${new Date(h.item.createdAt).toISOString().slice(0, 10)}) ${h.item.text}`).join("\n") : "No relevant memories.");
      },
    },
    {
      name: "forget", label: "Forget",
      description: "Delete a memory by id (when it's wrong or outdated).",
      schema: forgetSchema, concurrency: "exclusive", effects: { readOnly: true },
      async execute(a: z.infer<typeof forgetSchema>) { return text((await (await memory()).remove(a.id)) ? `Forgot ${a.id}` : `No memory ${a.id}`); },
    },
  ] as Tool[];
}

/** Compact memory block for injection into a prompt. */
export async function memoryContext(m: MemoryProvider, query: string, project: string, max = 6): Promise<string | undefined> {
  const hits = await m.search(query, { k: max, project, minScore: 0.2 });
  if (!hits.length) return undefined;
  return hits.map((h) => `- ${h.item.text}`).join("\n");
}
