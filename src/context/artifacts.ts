/**
 * Content-addressed artifact store. Oversized tool outputs are saved in full and the model sees a
 * shaped excerpt plus an `artifact://<id>` reference it can page through with the read tool.
 * (Pattern from REA's evidence store and headroom's CCR: never silently lose data.)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RCODE_HOME } from "../session/store.ts";

export const ARTIFACT_PREFIX = "artifact://";
const dir = () => join(RCODE_HOME, "artifacts");

export function saveArtifact(content: string, label = "output"): string {
  const id = `${label.replace(/[^\w-]/g, "").slice(0, 20)}-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  mkdirSync(dir(), { recursive: true });
  const p = join(dir(), `${id}.txt`);
  if (!existsSync(p)) writeFileSync(p, content);
  return ARTIFACT_PREFIX + id;
}

export function artifactPath(ref: string): string | undefined {
  if (!ref.startsWith(ARTIFACT_PREFIX)) return undefined;
  const id = ref.slice(ARTIFACT_PREFIX.length).replace(/[^\w-]/g, "");
  const p = join(dir(), `${id}.txt`);
  return existsSync(p) ? p : undefined;
}

export function readArtifact(ref: string): string | undefined {
  const p = artifactPath(ref);
  return p ? readFileSync(p, "utf8") : undefined;
}
