export interface MemoryItem {
  id: string;
  text: string;
  /** "project" memories are scoped to a cwd; "global" apply everywhere. */
  scope: "project" | "global";
  project?: string;
  kind?: "fact" | "preference" | "decision" | "pattern" | "observation" | "lesson";
  tags?: string[];
  createdAt: number;
  /** Reinforced on recall hits that helped; decays otherwise. */
  score?: number;
  source?: string;
}

export interface MemoryHit { item: MemoryItem; score: number }

export interface MemoryProvider {
  readonly name: string;
  init(): Promise<void>;
  add(item: Omit<MemoryItem, "id" | "createdAt"> & { id?: string }): Promise<MemoryItem>;
  search(query: string, opts?: { k?: number; project?: string; minScore?: number }): Promise<MemoryHit[]>;
  list(opts?: { project?: string; limit?: number }): Promise<MemoryItem[]>;
  remove(id: string): Promise<boolean>;
  close?(): Promise<void>;
}
