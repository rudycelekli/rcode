/** Shared streaming helpers: SSE parsing, lenient partial-JSON parsing, overflow detection. */

export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        let event: string | undefined;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
    if (buf.trim()) {
      const data = buf.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (data.length) yield { data: data.join("\n") };
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
  }
}

/** Parse possibly-incomplete JSON (streaming tool args). Returns {} when hopeless. */
export function parsePartialJson(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {};
  try { return JSON.parse(s); } catch {}
  // Close open strings / brackets.
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let fixed = s;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/[,:]\s*$/, "");
  fixed += stack.reverse().join("");
  try { return JSON.parse(fixed); } catch { return {}; }
}

const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds the context window/i,
  /too many tokens/i,
  /input is too long/i,
  /reduce the length of the messages/i,
  /request too large/i,
  /token limit/i,
  /context window/i,
];
export function isContextOverflow(msg: string | undefined): boolean {
  return !!msg && OVERFLOW_PATTERNS.some((r) => r.test(msg));
}

export function isRetryable(status: number, msg = ""): boolean {
  return status === 429 || status === 408 || status === 409 || status >= 500 || /overloaded|rate limit|timeout|ECONNRESET/i.test(msg);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
  });
