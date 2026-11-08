/**
 * Type-aware output shaping (headroom-inspired, native TS). Applied at the tool boundary so the
 * transcript stays byte-stable afterwards (prompt-cache friendly).
 *   - lossless cleanup: strip ANSI, collapse \r progress spinners, squeeze repeated lines
 *   - when still too big: keep head + tail + every "signal" line (errors, warnings, failures, stack frames)
 *   - JSON arrays: keep first/last items and a count
 * Full output is always preserved in the artifact store.
 */
import { saveArtifact } from "./artifacts.ts";

export const SHAPE_MAX_LINES = 400;
export const SHAPE_MAX_BYTES = 40 * 1024;

const SIGNAL = /\b(error|errors|err!|fail(ed|ure|ing)?|fatal|panic|exception|traceback|warning|warn|assert(ion)?|denied|not found|cannot|undefined is not|segfault|timed? ?out|✗|✘|FAIL|ERROR)\b|^\s+at\s|^\s*File ".*", line \d+|^\S+:\d+:\d+/i;

export function cleanup(s: string): string {
  let out = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // Progress bars / spinners rewritten with \r: keep only the final state of each line.
  out = out.split("\n").map((l) => (l.includes("\r") ? l.split("\r").filter(Boolean).pop() ?? "" : l)).join("\n");
  // Squeeze runs of identical lines.
  const lines = out.split("\n");
  const sq: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    sq.push(lines[i]!);
    if (j - i > 2) sq.push(`[… previous line repeated ${j - i - 1} more times]`);
    else if (j - i === 2) sq.push(lines[i]!);
    i = j;
  }
  return sq.join("\n");
}

function shapeJson(s: string): string | undefined {
  const t = s.trim();
  if (!(t.startsWith("[") || t.startsWith("{")) || t.length < SHAPE_MAX_BYTES) return undefined;
  try {
    const v = JSON.parse(t);
    const trim = (x: any, depth: number): any => {
      if (Array.isArray(x)) {
        if (x.length > 12) return [...x.slice(0, 5).map((e) => trim(e, depth + 1)), `… ${x.length - 8} more items …`, ...x.slice(-3).map((e) => trim(e, depth + 1))];
        return x.map((e) => trim(e, depth + 1));
      }
      if (x && typeof x === "object" && depth < 6) return Object.fromEntries(Object.entries(x).map(([k, e]) => [k, trim(e, depth + 1)]));
      if (typeof x === "string" && x.length > 500) return x.slice(0, 400) + `… (${x.length} chars)`;
      return x;
    };
    const out = JSON.stringify(trim(v, 0), null, 1);
    return out.length < t.length * 0.8 ? out : undefined;
  } catch { return undefined; }
}

export interface Shaped { text: string; truncated: boolean; artifact?: string }

/** Shape command/tool output. `keep` = "tail" favors the end (command output), "head" favors the start. */
export function shapeOutput(raw: string, label = "output", keep: "tail" | "head" = "tail"): Shaped {
  const cleaned = cleanup(raw);
  const bytes = Buffer.byteLength(cleaned);
  const lines = cleaned.split("\n");
  if (lines.length <= SHAPE_MAX_LINES && bytes <= SHAPE_MAX_BYTES) return { text: cleaned, truncated: false };
  const artifact = saveArtifact(raw, label);
  const json = shapeJson(cleaned);
  if (json && Buffer.byteLength(json) <= SHAPE_MAX_BYTES) return { text: `${json}\n[JSON condensed; full output: ${artifact} — read it with offset/limit]`, truncated: true, artifact };

  const headN = keep === "head" ? 250 : 60;
  const tailN = keep === "head" ? 60 : 200;
  const keepIdx = new Set<number>();
  for (let i = 0; i < Math.min(headN, lines.length); i++) keepIdx.add(i);
  for (let i = Math.max(0, lines.length - tailN); i < lines.length; i++) keepIdx.add(i);
  let signals = 0;
  for (let i = 0; i < lines.length && signals < 120; i++) {
    if (!keepIdx.has(i) && SIGNAL.test(lines[i]!)) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keepIdx.add(j);
      signals++;
    }
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keepIdx].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`[… ${i - last - 1} lines omitted …]`);
    out.push(lines[i]!.length > 1000 ? lines[i]!.slice(0, 600) + ` … [${lines[i]!.length} chars]` : lines[i]!);
    last = i;
  }
  if (last < lines.length - 1) out.push(`[… ${lines.length - 1 - last} lines omitted …]`);
  let text = out.join("\n");
  if (Buffer.byteLength(text) > SHAPE_MAX_BYTES) text = text.slice(0, SHAPE_MAX_BYTES / 3) + "\n[…]\n" + text.slice(-(SHAPE_MAX_BYTES * 2) / 3);
  return { text: `${text}\n[Output shaped: ${lines.length} lines → kept head, tail and ${signals} error/warning regions. Full output: ${artifact} (read it with offset/limit or grep it).]`, truncated: true, artifact };
}
