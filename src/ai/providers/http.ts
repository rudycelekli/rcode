import { isRetryable, sleep } from "../util.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) { super(message); }
}

/** POST JSON with retry/backoff on 429/5xx (before any stream bytes are consumed). */
export async function httpPost(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal, maxRetries = 4): Promise<Response> {
  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    } catch (e: any) {
      if (signal?.aborted || attempt >= maxRetries) throw e;
      await sleep(backoff(attempt++), signal);
      continue;
    }
    if (res.ok && res.body) return res;
    const text = await res.text().catch(() => "");
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? text; } catch {}
    const ra = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    if (attempt < maxRetries && isRetryable(res.status, msg)) {
      await sleep(Math.min(retryAfterMs ?? backoff(attempt), 60_000), signal);
      attempt++;
      continue;
    }
    throw new HttpError(res.status, `HTTP ${res.status}: ${msg.slice(0, 2000)}`, retryAfterMs);
  }
}

const backoff = (n: number) => Math.min(1000 * 2 ** n, 30_000) * (0.75 + Math.random() * 0.5);
