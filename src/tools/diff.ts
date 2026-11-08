/** Minimal line diff (Myers via LCS on trimmed window) producing unified hunks. */
export function unifiedDiff(a: string, b: string, path = "file", context = 3): string {
  const A = a.split("\n"), B = b.split("\n");
  // Trim common prefix/suffix to keep LCS small.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  type Op = { t: " " | "-" | "+"; s: string };
  let ops: Op[];
  if (a2.length * b2.length > 4_000_000) {
    ops = [...a2.map((s) => ({ t: "-" as const, s })), ...b2.map((s) => ({ t: "+" as const, s }))];
  } else {
    const n = a2.length, m = b2.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a2[i] === b2[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push({ t: " ", s: a2[i]! }); i++; j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: "-", s: a2[i++]! });
      else ops.push({ t: "+", s: b2[j++]! });
    }
    while (i < n) ops.push({ t: "-", s: a2[i++]! });
    while (j < m) ops.push({ t: "+", s: b2[j++]! });
  }
  const full: Op[] = [...A.slice(0, pre).map((s) => ({ t: " " as const, s })), ...ops, ...A.slice(A.length - suf).map((s) => ({ t: " " as const, s }))];
  // Build hunks
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  let aLine = 1, bLine = 1;
  const lineNos: Array<[number, number]> = [];
  for (const o of full) { lineNos.push([aLine, bLine]); if (o.t !== "+") aLine++; if (o.t !== "-") bLine++; }
  while (k < full.length) {
    if (full[k]!.t === " ") { k++; continue; }
    let start = Math.max(0, k - context), end = k;
    while (end < full.length) {
      if (full[end]!.t !== " ") { end++; continue; }
      let run = 0;
      while (end + run < full.length && full[end + run]!.t === " ") run++;
      if (run > context * 2 || end + run >= full.length) { end = Math.min(full.length, end + context); break; }
      end += run;
    }
    const slice = full.slice(start, end);
    const [as, bs] = lineNos[start]!;
    const ac = slice.filter((o) => o.t !== "+").length, bc = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${as},${ac} +${bs},${bc} @@`);
    for (const o of slice) out.push(o.t + o.s);
    k = end;
  }
  return out.join("\n");
}

export function diffStats(d: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of d.split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) added++; else if (l.startsWith("-") && !l.startsWith("---")) removed++; }
  return { added, removed };
}
