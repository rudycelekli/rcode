/**
 * RuvectorMemory — FlatMemory semantics + a ruvector native HNSW index for scale.
 * `ruvector` is an optional dependency (MIT, ruvnet/ruvector). If its native backend
 * isn't available, init() throws and the registry falls back to FlatMemory.
 *
 * Grounded in ruvector/npm/packages/ruvector/src/index.ts: VectorDB({dimensions, storagePath, distanceMetric}),
 * insert({id, vector, metadata}), search({vector, k}) → [{id, score}], delete(id).
 */
import { join } from "node:path";
import { FlatMemory, hashEmbed } from "./flat.ts";
import type { MemoryHit, MemoryItem } from "./types.ts";

const DIM = 512;

export class RuvectorMemory extends FlatMemory {
  override readonly name = "ruvector";
  private db: any;
  private count = 0;
  constructor(file: string, private dir: string) { super(file); }

  override async init() {
    const mod: any = await import("ruvector" as string);
    const VectorDB = mod.VectorDB ?? mod.default?.VectorDB;
    if (!VectorDB) throw new Error("ruvector: VectorDB export not found");
    this.db = new VectorDB({ dimensions: DIM, storagePath: join(this.dir, "rcode-memory.db"), distanceMetric: "cosine" });
    // Probe that writes work (the non-native fallback refuses inserts).
    await this.db.insert({ id: "__probe__", vector: new Float32Array(DIM).fill(1 / Math.sqrt(DIM)) });
    await this.db.delete("__probe__");
    await super.init();
    const existing = await super.list({ limit: 1_000_000 });
    this.count = existing.length;
    if ((await this.db.len()) < existing.length) {
      for (const it of existing) await this.db.insert({ id: it.id, vector: hashEmbed(it.text, DIM) });
    }
  }

  override async add(input: Omit<MemoryItem, "id" | "createdAt"> & { id?: string }) {
    const item = await super.add(input);
    try { await this.db.insert({ id: item.id, vector: hashEmbed(item.text, DIM) }); this.count++; } catch {}
    return item;
  }

  override async search(query: string, opts: { k?: number; project?: string; minScore?: number } = {}): Promise<MemoryHit[]> {
    // Small stores: exact hybrid scoring is better. Large stores: HNSW candidate generation, then hybrid rerank.
    if (this.count < 5000) return super.search(query, opts);
    const k = opts.k ?? 8;
    const cands: Array<{ id: string }> = await this.db.search({ vector: hashEmbed(query, DIM), k: k * 8 });
    const ids = new Set(cands.map((c) => c.id));
    const all = await super.search(query, { ...opts, k: k * 8 });
    return all.filter((h) => ids.has(h.item.id)).concat(all.filter((h) => !ids.has(h.item.id))).slice(0, k);
  }

  override async remove(id: string) {
    const ok = await super.remove(id);
    try { await this.db.delete(id); } catch {}
    return ok;
  }
}
