/**
 * Compare the ledger with the latest public GitHub release of each tool.
 * No token. A failed lookup is reported and is not treated as a new release.
 */
import { UPSTREAMS, type Upstream } from "./ledger.ts";

export interface Release { tag: string; name: string; published: string; url: string }
export interface Gap {
  id: string;
  repo: string;
  ride: Upstream["ride"];
  seen: string;
  status: "current" | "shipped" | "unreachable";
  tag?: string;
  url?: string;
  detail: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchLatest(repo: string, fetchImpl: FetchLike = fetch): Promise<Release | { error: string }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { error: "Bad repository name." };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "rcode" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `GitHub returned ${res.status} for ${repo}` };
    const d = await res.json() as { tag_name?: string; name?: string; published_at?: string; html_url?: string };
    if (!d.tag_name) return { error: `No release for ${repo}` };
    return { tag: d.tag_name, name: String(d.name ?? d.tag_name), published: String(d.published_at ?? "").slice(0, 10), url: String(d.html_url ?? "") };
  } catch (e) { return { error: (e as Error).message || "The lookup failed." }; }
}

export function compare(rows: Upstream[], latest: Record<string, Release | { error: string }>): Gap[] {
  return rows.map((row) => {
    const got = latest[row.id];
    if (!got || "error" in got) return { id: row.id, repo: row.repo, ride: row.ride, seen: row.seen, status: "unreachable", detail: got && "error" in got ? got.error : "No data." };
    if (got.tag === row.seen) return { id: row.id, repo: row.repo, ride: row.ride, seen: row.seen, status: "current", tag: got.tag, url: got.url, detail: row.ours };
    return { id: row.id, repo: row.repo, ride: row.ride, seen: row.seen, status: "shipped", tag: got.tag, url: got.url, detail: `${got.name} (${got.published}) is past ${row.seen || "the last version we reviewed"}. ${row.ours}` };
  });
}

export function formatAhead(gaps: Gap[]): string {
  const lines = ["rcode ahead", "", "A guest or a protocol rides their next version on its own. A watched project is one we look at when it ships."];
  const group = (status: Gap["status"], title: string) => {
    const rows = gaps.filter((g) => g.status === status);
    if (!rows.length) return;
    lines.push("", title);
    for (const g of rows) lines.push(`  ${g.id}  ${g.repo}  ${g.tag ?? g.seen}  ${g.ride}`, `    ${g.detail}`, ...(g.url ? [`    ${g.url}`] : []));
  };
  group("shipped", "New since we last looked:");
  group("current", "Caught up:");
  group("unreachable", "Could not check:");
  if (!gaps.some((g) => g.status === "shipped")) lines.push("", "Nothing new past the versions in the ledger.");
  return lines.join("\n");
}

export async function runAhead(opts: { json?: boolean; upstreams?: Upstream[]; fetchImpl?: FetchLike } = {}): Promise<number> {
  const rows = opts.upstreams ?? UPSTREAMS;
  const latest: Record<string, Release | { error: string }> = {};
  await Promise.all(rows.map(async (row) => { latest[row.id] = await fetchLatest(row.repo, opts.fetchImpl); }));
  const gaps = compare(rows, latest);
  console.log(opts.json ? JSON.stringify(gaps, null, 2) : formatAhead(gaps));
  return 0;
}
