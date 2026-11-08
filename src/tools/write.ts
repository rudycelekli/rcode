import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { diffStats, unifiedDiff } from "./diff.ts";
import { checkFresh, markRead, recordPreimage, resolvePath, text, withFileLock } from "./util.ts";

const schema = z.object({
  path: z.string().describe("File path to write"),
  content: z.string().describe("Full file content"),
});

export const writeTool: Tool<typeof schema> = {
  name: "write",
  label: "Write",
  description: "Create a new file or fully overwrite an existing one (creates parent directories). Prefer edit for changes to existing files; an existing file must be read first.",
  schema,
  concurrency: "exclusive",
  effects: { writesFiles: true },
  summarize: (a) => `${a.path} (${a.content.split("\n").length} lines)`,
  async execute(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    return withFileLock(abs, async () => {
      const existed = existsSync(abs);
      if (existed) { const stale = checkFresh(ctx, abs); if (stale) return text(stale, true); }
      const before = existed ? readFileSync(abs, "utf8") : "";
      recordPreimage(ctx, abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content);
      markRead(ctx, abs);
      const rel = relative(ctx.cwd, abs) || abs;
      const diff = unifiedDiff(before, args.content, rel);
      const { added, removed } = diffStats(diff);
      return text(`${existed ? "Overwrote" : "Created"} ${rel} (${args.content.split("\n").length} lines, +${added} -${removed})`, false, { path: abs, diff, added, removed, created: !existed });
    });
  },
};
