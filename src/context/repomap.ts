/**
 * Repo map (aider-style, native TS): rank files by a PageRank over the "file A references a symbol
 * defined in file B" graph, personalized toward the current task (mentioned files/identifiers), then
 * render the top files with their key definitions within a token budget.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_IGNORES } from "../tools/util.ts";
import { extractDefs, identifiers, languageFor, type Def } from "./symbols.ts";

interface FileInfo { path: string; mtime: number; defs: Def[]; idents: Map<string, number> }
const cache = new Map<string, FileInfo>();
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 6000;

export function listSourceFiles(root: string): string[] {
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  let files: string[];
  if (git.status === 0) files = git.stdout.split("\n").filter(Boolean);
  else {
    files = [];
    const walk = (d: string, depth: number) => {
      if (depth > 12 || files.length > MAX_FILES * 2) return;
      let ents; try { ents = readdirSync(join(root, d), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith(".") || DEFAULT_IGNORES.includes(e.name)) continue;
        const p = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, depth + 1); else files.push(p);
      }
    };
    walk("", 0);
  }
  return files.filter((f) => languageFor(f) && !/(^|\/)(vendor|third_party|node_modules|dist|build|target|\.next|coverage|__generated__|generated)\//.test(f) && !/\.(min|bundle|d)\.(js|ts)$/.test(f)).slice(0, MAX_FILES);
}

function info(root: string, rel: string): FileInfo | undefined {
  const abs = join(root, rel);
  let st; try { st = statSync(abs); } catch { return undefined; }
  if (st.size > MAX_FILE_BYTES) return undefined;
  const hit = cache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  let src: string; try { src = readFileSync(abs, "utf8"); } catch { return undefined; }
  const fi = { path: rel, mtime: st.mtimeMs, defs: extractDefs(rel, src), idents: identifiers(src) };
  cache.set(abs, fi);
  return fi;
}

export interface RepoMapOptions { focusFiles?: string[]; query?: string; maxTokens?: number }

export interface RankedFile { path: string; rank: number; defs: Def[] }

export function rankRepo(root: string, opts: RepoMapOptions = {}): RankedFile[] {
  const files = listSourceFiles(root).map((f) => info(root, f)).filter((x): x is FileInfo => !!x);
  if (!files.length) return [];
  const idx = new Map(files.map((f, i) => [f.path, i]));
  // name → defining files
  const definers = new Map<string, number[]>();
  files.forEach((f, i) => { for (const d of f.defs) { const a = definers.get(d.name) ?? []; if (!a.includes(i)) a.push(i); definers.set(d.name, a); } });
  const queryIds = new Set((opts.query ?? "").match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []);
  // Loose query words (lowercased, camelCase/snake split) for fuzzy path/definition matching.
  const queryWords = [...new Set((opts.query ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))];
  const stem = (w: string) => w.replace(/(ions?|ing|ers?|ed|es|s)$/, "");
  const wordHits = (s: string) => { const l = s.toLowerCase(); return queryWords.reduce((n, w) => n + (l.includes(stem(w)) ? 1 : 0), 0); };
  const focus = new Set((opts.focusFiles ?? []).map((p) => relative(root, join(root, p))));

  // Edges: referencer → definer, weighted.
  const N = files.length;
  const out: Array<Map<number, number>> = Array.from({ length: N }, () => new Map());
  const refCount = new Map<string, number>(); // how many files reference a def name
  files.forEach((f, i) => {
    for (const [name, count] of f.idents) {
      const defs = definers.get(name);
      if (!defs || defs.length > 6) continue; // overly generic names carry no signal
      for (const j of defs) {
        if (j === i) continue;
        let w = Math.sqrt(count);
        if (name.length >= 8 || /[a-z][A-Z]|_/.test(name)) w *= 2; // specific identifiers matter more
        if (name.startsWith("_")) w *= 0.3;
        if (queryIds.has(name)) w *= 10;
        if (focus.has(f.path)) w *= 5;
        out[i]!.set(j, (out[i]!.get(j) ?? 0) + w);
        refCount.set(name, (refCount.get(name) ?? 0) + 1);
      }
    }
  });

  // Personalized PageRank.
  const pers = new Float64Array(N);
  let ps = 0;
  files.forEach((f, i) => {
    let p = 1;
    if (focus.has(f.path)) p += 50;
    for (const q of queryIds) { if (definers.get(q)?.includes(i)) p += 20; }
    p += wordHits(f.path) * 15;
    p += Math.min(30, f.defs.reduce((n, d) => n + wordHits(d.name), 0) * 6);
    pers[i] = p; ps += p;
  });
  for (let i = 0; i < N; i++) pers[i]! /= ps;
  let rank = Float64Array.from(pers);
  const outSum = out.map((m) => [...m.values()].reduce((s, x) => s + x, 0));
  for (let iter = 0; iter < 30; iter++) {
    const next = new Float64Array(N);
    let dangling = 0;
    for (let i = 0; i < N; i++) {
      if (!outSum[i]) { dangling += rank[i]!; continue; }
      for (const [j, w] of out[i]!) next[j]! += 0.85 * rank[i]! * (w / outSum[i]!);
    }
    for (let i = 0; i < N; i++) next[i]! += (0.15 + 0.85 * dangling) * pers[i]!;
    rank = next;
  }

  return files.map((f, i) => {
    // Keep the defs others actually use (plus top-level ones), most-referenced first, shown in source order.
    const scored = f.defs.filter((d) => d.depth <= 4 || (refCount.get(d.name) ?? 0) > 0 || queryIds.has(d.name))
      .map((d) => ({ d, s: (refCount.get(d.name) ?? 0) + (queryIds.has(d.name) ? 100 : 0) + wordHits(d.name) * 20 + (d.depth === 0 ? 0.5 : 0) }));
    const keep = scored.sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.d).sort((a, b) => a.line - b.line);
    // With a query, relevance multiplies centrality so on-topic files outrank generic hubs.
    const rel = queryWords.length ? 1 + 4 * wordHits(f.path) + Math.min(8, f.defs.reduce((n, d) => n + wordHits(d.name), 0)) : 1;
    return { path: f.path, rank: rank[i]! * rel * (focus.has(f.path) ? 3 : 1), defs: keep };
  }).sort((a, b) => b.rank - a.rank);
}

export function renderRepoMap(ranked: RankedFile[], maxTokens = 2000): string {
  const budget = maxTokens * 3.6;
  const lines: string[] = [];
  let used = 0, shown = 0;
  for (const f of ranked) {
    const block = [`${f.path}:`, ...f.defs.map((d) => `  ${String(d.line).padStart(4)}│ ${d.sig}`)];
    const size = block.join("\n").length + 1;
    if (used + size > budget) {
      if (used + f.path.length + 2 <= budget) { lines.push(`${f.path}`); used += f.path.length + 1; shown++; continue; }
      break;
    }
    lines.push(...block); used += size; shown++;
  }
  const rest = ranked.length - shown;
  return lines.join("\n") + (rest > 0 ? `\n… ${rest} more source files (narrow with query/focus, or use glob/grep)` : "");
}

export function repoMap(root: string, opts: RepoMapOptions = {}): string {
  return renderRepoMap(rankRepo(root, opts), opts.maxTokens ?? 2000);
}

/** Outline of one file (for large reads). */
export function outline(path: string, src: string): string {
  const defs = extractDefs(path, src);
  if (!defs.length) return "";
  return defs.slice(0, 300).map((d) => `${" ".repeat(Math.min(d.depth, 12))}${String(d.line).padStart(5)}│ ${d.sig}`).join("\n");
}
