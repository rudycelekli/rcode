/**
 * Embedding mode. "auto" (the default) uses the on-device model only when it is
 * already cached, so a first run never pauses to download it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RCODE_HOME } from "../session/store.ts";

export function directoryHasFiles(dir: string): boolean {
  try { return existsSync(dir) && readdirSync(dir).some((f) => !f.startsWith(".")); } catch { return false; }
}

export function semanticModelCached(): boolean {
  return directoryHasFiles(join(RCODE_HOME, "models"));
}

/** undefined and "auto" mean: semantic if cached, hashed otherwise. */
export function resolveEmbeddings(want: string | undefined, cached = semanticModelCached()): "hash" | "onnx" {
  if (want === "hash") return "hash";
  if (want === "onnx") return "onnx";
  return cached ? "onnx" : "hash";
}
