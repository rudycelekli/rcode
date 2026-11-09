/**
 * Strip credential-shaped substrings before anything is written to a receipt,
 * a handoff, or the local telemetry log. The original tool call is unchanged.
 */
const PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "sk-ant-…"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-…"],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, "gh_…"],
  [/\bAKIA[0-9A-Z]{8,}\b/g, "AKIA…"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "xox-…"],
  [/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*\S+/gi, (m) => m.replace(/[=:]\s*\S+/, (x) => x.slice(0, 1) + "…")],
];

export function redact(input: string): string {
  let s = input;
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep as any);
  return s;
}
