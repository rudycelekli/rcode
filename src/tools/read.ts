import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { IMAGE_EXT, isBinary, markRead, MAX_BYTES, MAX_LINE_CHARS, MAX_LINES, resolvePath, text } from "./util.ts";

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd). Supports a line selector suffix like 'src/a.ts:120-180' or 'src/a.ts:-50' (last 50 lines)."),
  offset: z.number().int().min(1).optional().describe("1-based line to start from"),
  limit: z.number().int().min(1).optional().describe("Max lines to return (default 2000)"),
});

export const readTool: Tool<typeof schema> = {
  name: "read",
  label: "Read",
  description:
    "Read a file. Returns numbered lines (`  N│text`). Large files are truncated with an exact continuation offset. Images are returned as images. Directories list their entries. You must read a file before editing it.",
  schema,
  concurrency: "shared",
  effects: { readOnly: true },
  summarize: (a) => a.path + (a.offset ? `:${a.offset}` : ""),
  async execute(args, ctx) {
    let p = args.path, offset = args.offset, limit = args.limit, tail: number | undefined;
    const sel = p.match(/^(.*?):(-?\d+)(?:-(\d+))?$/);
    if (sel && !safeExists(resolvePath(ctx.cwd, p))) {
      p = sel[1]!;
      const a = Number(sel[2]);
      if (a < 0) tail = -a;
      else { offset = a; if (sel[3]) limit = Number(sel[3]) - a + 1; }
    }
    const abs = resolvePath(ctx.cwd, p);
    let st;
    try { st = statSync(abs); } catch { return text(`File not found: ${abs}${suggest(abs)}`, true); }
    if (st.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort();
      return text(`${abs}/ (${entries.length} entries)\n${entries.slice(0, 500).join("\n")}${entries.length > 500 ? `\n… ${entries.length - 500} more` : ""}`);
    }
    const mime = IMAGE_EXT[extname(abs).toLowerCase()];
    if (mime) {
      if (st.size > 5 * 1024 * 1024) return text(`Image too large (${st.size} bytes)`, true);
      markRead(ctx, abs);
      return { content: [{ type: "text", text: `Image: ${abs}` }, { type: "image", mimeType: mime, data: readFileSync(abs).toString("base64") }] };
    }
    const buf = readFileSync(abs);
    if (isBinary(buf)) return text(`${abs} is a binary file (${st.size} bytes). Use bash (e.g. xxd, file, strings) to inspect it.`, true);
    markRead(ctx, abs);
    const all = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/);
    if (all.length && all[all.length - 1] === "") all.pop();
    const total = all.length;
    if (total === 0) return text(`${abs} is empty.`);
    let start = tail ? Math.max(0, total - tail) : (offset ?? 1) - 1;
    if (start >= total) return text(`Offset ${start + 1} is past the end of ${abs} (${total} lines).`, true);
    const max = limit ?? MAX_LINES;
    const out: string[] = [];
    let bytes = 0, i = start;
    const w = String(Math.min(total, start + max)).length;
    for (; i < total && out.length < max; i++) {
      let line = all[i]!;
      if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) + ` … [line truncated, ${line.length} chars]`;
      const row = `${String(i + 1).padStart(w)}│${line}`;
      bytes += row.length + 1;
      if (bytes > MAX_BYTES && out.length) break;
      out.push(row);
    }
    let footer = "";
    if (i < total) footer = `\n[Showing lines ${start + 1}-${i} of ${total}. Continue with offset=${i + 1}.]`;
    else if (start > 0) footer = `\n[Lines ${start + 1}-${total} of ${total}.]`;
    return text(out.join("\n") + footer, false, { path: abs, lines: total });
  },
};

function safeExists(p: string) { try { statSync(p); return true; } catch { return false; } }

function suggest(abs: string): string {
  try {
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    const base = abs.slice(abs.lastIndexOf("/") + 1).toLowerCase();
    const near = readdirSync(dir).filter((n) => n.toLowerCase().includes(base.slice(0, 4)) || base.includes(n.toLowerCase().replace(/\.\w+$/, ""))).slice(0, 5);
    return near.length ? `\nDid you mean: ${near.map((n) => `${dir}/${n}`).join(", ")}?` : "";
  } catch { return ""; }
}
