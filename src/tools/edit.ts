import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { diffStats, unifiedDiff } from "./diff.ts";
import { checkFresh, markRead, resolvePath, text, withFileLock } from "./util.ts";

const editSchema = z.object({
  old_text: z.string().describe("Exact text to replace (copy from read output WITHOUT line-number prefixes). Must be unique unless replace_all."),
  new_text: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence"),
});

const schema = z.object({
  path: z.string().describe("File to edit"),
  edits: z.array(editSchema).min(1).describe("One or more replacements, applied atomically against the original file. Must not overlap."),
});

export const editTool: Tool<typeof schema> = {
  name: "edit",
  label: "Edit",
  description:
    "Edit a file with exact text replacements. Batch all changes to one file into a single call via `edits`. Each old_text must match exactly once (tolerates trailing-whitespace, smart-quote and indentation drift). The file must have been read first. Returns a diff.",
  schema,
  concurrency: "exclusive",
  effects: { writesFiles: true },
  summarize: (a) => `${a.path} (${a.edits.length} edit${a.edits.length > 1 ? "s" : ""})`,
  async execute(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    return withFileLock(abs, async () => {
      if (!existsSync(abs)) return text(`File not found: ${abs}. Use write to create new files.`, true);
      const stale = checkFresh(ctx, abs);
      if (stale) return text(stale, true);
      const raw = readFileSync(abs, "utf8");
      const bom = raw.startsWith("﻿") ? "﻿" : "";
      const crlf = raw.includes("\r\n");
      const original = raw.slice(bom.length).replace(/\r\n/g, "\n");
      const spans: Array<{ start: number; end: number; repl: string; i: number }> = [];
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i]!;
        const oldT = e.old_text.replace(/\r\n/g, "\n"), newT = e.new_text.replace(/\r\n/g, "\n");
        if (oldT === newT) return text(`Edit ${i + 1}: old_text and new_text are identical.`, true);
        if (!oldT) return text(`Edit ${i + 1}: old_text is empty. Use write to replace a whole file.`, true);
        const found = locate(original, oldT, newT);
        if (found.kind === "none") return text(`Edit ${i + 1}: old_text not found in ${args.path}.${found.hint ?? ""} Re-read the file and copy the exact text.`, true);
        if (found.kind === "multi" && !e.replace_all) return text(`Edit ${i + 1}: old_text matches ${found.count} places in ${args.path}. Add surrounding context to make it unique, or set replace_all.`, true);
        for (const m of found.matches) spans.push({ start: m.start, end: m.end, repl: m.repl, i });
      }
      spans.sort((a, b) => a.start - b.start);
      for (let k = 1; k < spans.length; k++) if (spans[k]!.start < spans[k - 1]!.end) return text(`Edits ${spans[k - 1]!.i + 1} and ${spans[k]!.i + 1} overlap. Merge them into one edit.`, true);
      let updated = "", pos = 0;
      for (const s of spans) { updated += original.slice(pos, s.start) + s.repl; pos = s.end; }
      updated += original.slice(pos);
      const finalText = bom + (crlf ? updated.replace(/\n/g, "\r\n") : updated);
      writeFileSync(abs, finalText);
      markRead(ctx, abs);
      const rel = relative(ctx.cwd, abs) || abs;
      const diff = unifiedDiff(original, updated, rel);
      const { added, removed } = diffStats(diff);
      return text(`Edited ${rel} (+${added} -${removed})\n${diff.length > 6000 ? diff.slice(0, 6000) + "\n… diff truncated" : diff}`, false, { path: abs, diff, added, removed });
    });
  },
};

type Match = { start: number; end: number; repl: string };
type Found = { kind: "one" | "multi"; count: number; matches: Match[] } | { kind: "none"; hint?: string };

const norm = (s: string) => s.normalize("NFKC").replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—−]/g, "-").replace(/ /g, " ").replace(/[ \t]+$/, "");

export function locate(hay: string, needle: string, repl: string): Found {
  // 1. Exact
  const exact = allIndexes(hay, needle);
  if (exact.length) return { kind: exact.length > 1 ? "multi" : "one", count: exact.length, matches: exact.map((s) => ({ start: s, end: s + needle.length, repl })) };
  // Line-based strategies
  const hLines = hay.split("\n");
  const nLines = needle.replace(/\n$/, "").split("\n");
  const offsets: number[] = [];
  { let o = 0; for (const l of hLines) { offsets.push(o); o += l.length + 1; } }
  const tryLines = (f: (s: string) => string, reindent: boolean): Found | undefined => {
    const target = nLines.map(f);
    const hits: number[] = [];
    for (let i = 0; i + target.length <= hLines.length; i++) {
      let ok = true;
      for (let j = 0; j < target.length; j++) if (f(hLines[i + j]!) !== target[j]) { ok = false; break; }
      if (ok) hits.push(i);
    }
    if (!hits.length) return undefined;
    const matches = hits.map((i) => {
      const start = offsets[i]!;
      const lastLine = i + nLines.length - 1;
      const end = offsets[lastLine]! + hLines[lastLine]!.length + (needle.endsWith("\n") ? 1 : 0);
      let r = repl;
      if (reindent) r = reindentTo(repl, nLines, hLines.slice(i, i + nLines.length));
      return { start, end, repl: r };
    });
    return { kind: hits.length > 1 ? "multi" : "one", count: hits.length, matches };
  };
  // 2. Normalized (unicode, quotes, trailing ws)
  const n = tryLines(norm, false);
  if (n) return n;
  // 3. Indentation-insensitive (re-indent replacement to file's indentation)
  const ind = tryLines((s) => norm(s).trimStart(), true);
  if (ind) return ind;
  // Hint: first line location
  const first = norm(nLines[0] ?? "").trim();
  if (first) {
    const idx = hLines.findIndex((l) => norm(l).trim() === first);
    if (idx >= 0) return { kind: "none", hint: ` The first line appears at line ${idx + 1}, but following lines differ.` };
  }
  return { kind: "none" };
}

function allIndexes(h: string, n: string): number[] {
  const out: number[] = [];
  let i = h.indexOf(n);
  while (i !== -1) { out.push(i); i = h.indexOf(n, i + n.length); }
  return out;
}

function leading(s: string) { return s.match(/^[ \t]*/)![0]; }

function reindentTo(repl: string, needleLines: string[], fileLines: string[]): string {
  const fromIdx = needleLines.findIndex((l) => l.trim());
  if (fromIdx < 0) return repl;
  const from = leading(needleLines[fromIdx]!), to = leading(fileLines[fromIdx]!);
  if (from === to) return repl;
  return repl.split("\n").map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l.trim() ? to + l.trimStart() : l)).join("\n");
}
