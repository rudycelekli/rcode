/**
 * FlatMemory — zero-dependency memory: JSONL on disk, hybrid BM25 + hashed-embedding cosine.
 * Always available; used as the fallback when ruvector's native backend can't load.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryHit, MemoryItem, MemoryProvider } from "./types.ts";

const STOP = new Set("a an the and or but if of to in on at for with by from is are was were be been it this that these those as not no do does did can could should would will i you we they he she my our your".split(" "));
export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9_]+/).flatMap((w) => w.split("_")).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Deterministic feature-hashing embedding (unigrams + bigrams + char trigrams), L2-normalized. */
export function hashEmbed(s: string, dim = 512): Float32Array {
  const v = new Float32Array(dim);
  const toks = tokenize(s);
  const add = (f: string, w: number) => { let h = 2166136261; for (let i = 0; i < f.length; i++) { h ^= f.charCodeAt(i); h = Math.imul(h, 16777619); } v[(h >>> 0) % dim]! += (h & 0x80000000 ? -1 : 1) * w; };
  for (let i = 0; i < toks.length; i++) {
    add(toks[i]!, 1);
    if (i + 1 < toks.length) add(toks[i] + " " + toks[i + 1], 0.7);
    const t = `#${toks[i]}#`;
    for (let j = 0; j + 3 <= t.length; j++) add("~" + t.slice(j, j + 3), 0.3);
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= n;
  return v;
}
const cos = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

/** Optional semantic embedder (e.g. ruvector's on-device MiniLM). Vectors are cached on disk by item id. */
export interface SemanticEmbedder { name: string; embedQuery(t: string): Promise<Float32Array>; embedPassage(t: string): Promise<Float32Array> }

export class FlatMemory implements MemoryProvider {
  name: string = "flat";
  private items = new Map<string, MemoryItem>();
  private vecs = new Map<string, Float32Array>();
  private sem = new Map<string, Float32Array>();
  semantic?: SemanticEmbedder;
  constructor(private file: string) {}

  /** Attach a semantic embedder; embeds missing items in the background. */
  async useSemantic(e: SemanticEmbedder) {
    this.semantic = e;
    this.name = `${this.name}+${e.name}`;
    const vf = this.file.replace(/\.jsonl$/, ".vec.jsonl");
    if (existsSync(vf)) for (const l of readFileSync(vf, "utf8").split("\n")) { if (!l) continue; try { const r = JSON.parse(l); this.sem.set(r.id, Float32Array.from(r.v)); } catch {} }
    for (const it of this.items.values()) if (!this.sem.has(it.id)) await this.embedItem(it).catch(() => {});
  }
  private async embedItem(it: MemoryItem) {
    if (!this.semantic) return;
    const v = await this.semantic.embedPassage(it.text);
    this.sem.set(it.id, v);
    appendFileSync(this.file.replace(/\.jsonl$/, ".vec.jsonl"), JSON.stringify({ id: it.id, v: Array.from(v, (x) => Math.round(x * 1e5) / 1e5) }) + "\n");
  }

  async init() {
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.deleted) { this.items.delete(rec.deleted); this.vecs.delete(rec.deleted); continue; }
        this.items.set(rec.id, rec);
        this.vecs.set(rec.id, hashEmbed(rec.text));
      } catch {}
    }
  }

  private append(rec: unknown) { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, JSON.stringify(rec) + "\n"); }

  async add(input: Omit<MemoryItem, "id" | "createdAt"> & { id?: string }): Promise<MemoryItem> {
    // De-duplicate near-identical memories.
    const v = hashEmbed(input.text);
    for (const [id, ov] of this.vecs) {
      const it = this.items.get(id)!;
      if (it.project === input.project && cos(v, ov) > 0.95) return it;
    }
    const item: MemoryItem = { ...input, id: input.id ?? `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
    this.items.set(item.id, item);
    this.vecs.set(item.id, v);
    this.append(item);
    void this.embedItem(item).catch(() => {});
    return item;
  }

  async search(query: string, opts: { k?: number; project?: string; minScore?: number } = {}): Promise<MemoryHit[]> {
    const k = opts.k ?? 8;
    const qv = hashEmbed(query);
    const qs = this.semantic ? await this.semantic.embedQuery(query).catch(() => undefined) : undefined;
    const qt = tokenize(query);
    const pool = [...this.items.values()].filter((i) => i.scope === "global" || !opts.project || i.project === opts.project);
    if (!pool.length) return [];
    // BM25 over the pool
    const docs = pool.map((i) => tokenize(i.text + " " + (i.tags ?? []).join(" ")));
    const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const N = docs.length;
    const hits = pool.map((item, idx) => {
      const d = docs[idx]!;
      let bm = 0;
      for (const t of qt) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        bm += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
      }
      const sv = qs && this.sem.get(item.id);
      const vs = sv ? 0.75 * cos(qs!, sv) + 0.25 * cos(qv, this.vecs.get(item.id)!) : cos(qv, this.vecs.get(item.id)!);
      const recency = Math.exp(-(Date.now() - item.createdAt) / (1000 * 60 * 60 * 24 * 90)) * 0.05;
      return { item, score: 0.55 * vs + 0.45 * Math.tanh(bm / 6) + recency + (item.score ?? 0) * 0.02 };
    });
    return hits.filter((h) => h.score >= (opts.minScore ?? 0.12)).sort((a, b) => b.score - a.score).slice(0, k);
  }

  async list(opts: { project?: string; limit?: number } = {}) {
    return [...this.items.values()].filter((i) => !opts.project || i.scope === "global" || i.project === opts.project).sort((a, b) => b.createdAt - a.createdAt).slice(0, opts.limit ?? 100);
  }

  async remove(id: string) {
    if (!this.items.has(id)) return false;
    this.items.delete(id); this.vecs.delete(id);
    this.append({ deleted: id });
    return true;
  }

  /** Rewrite file without tombstones. */
  compactFile() { writeFileSync(this.file, [...this.items.values()].map((i) => JSON.stringify(i)).join("\n") + "\n"); }
}
