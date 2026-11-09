import { describe, expect, test } from "bun:test";
import { compare, formatAhead, type Release } from "../src/ahead/check.ts";
import { UPSTREAMS, type Upstream } from "../src/ahead/ledger.ts";

const row = (over: Partial<Upstream> = {}): Upstream => ({ id: "claude", repo: "anthropics/claude-code", ride: "guest", seen: "v1", ours: "We keep the receipts.", ...over });

describe("staying ahead of the tools we ride", () => {
  test("a newer release is called out, the reviewed one is quiet, and a failed lookup is not a release", () => {
    const latest: Record<string, Release | { error: string }> = {
      claude: { tag: "v2", name: "v2", published: "2026-11-09", url: "https://example.test/v2" },
      codex: { tag: "v1", name: "v1", published: "2026-11-01", url: "https://example.test/v1" },
      t3: { error: "GitHub returned 403 for pingdotgg/t3code" },
    };
    const gaps = compare([row(), row({ id: "codex", seen: "v1" }), row({ id: "t3", ride: "watch", seen: "v0" })], latest);
    expect(gaps.map((g) => g.status)).toEqual(["shipped", "current", "unreachable"]);
    expect(gaps[0]!.url).toBe("https://example.test/v2");
    expect(gaps[2]!.detail).toContain("403");
    expect(formatAhead(gaps)).toContain("New since we last looked");
    expect(formatAhead([gaps[1]!])).toContain("Nothing new");
  });

  test("the ledger names the four tools and a real release tag", () => {
    expect(UPSTREAMS.map((u) => u.id)).toEqual(["claude", "codex", "acp", "t3"]);
    for (const u of UPSTREAMS) expect(u.seen.length).toBeGreaterThan(3);
  });

  test("fetch rejects a repository name that is not owner/name", async () => {
    const { fetchLatest } = await import("../src/ahead/check.ts");
    expect(await fetchLatest("https://evil.example/x", fetch)).toEqual({ error: "Bad repository name." });
  });
});
