import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addWorktree, claudePlanUsage, codexThreadCount, htmlFences, parseAdb, parseSimctl, remoteHost, sandboxDocument, spillPaste, turnDiff } from "../src/center/studio.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, env });

describe("studio", () => {
  test("a visual answer is fenced html inside a page that cannot reach the network", () => {
    const html = htmlFences("See this\n```html\n<h1>Hi</h1>\n<script>fetch('https://x')</script>\n```\n");
    expect(html).toHaveLength(1);
    const doc = sandboxDocument(html[0]!);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<h1>Hi</h1>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
  });

  test("a long paste is cut and the rest is kept to attach", () => {
    const r = spillPaste("a".repeat(20), 10);
    expect(r.spill).toHaveLength(20);
    expect(r.keep).toContain("attached file");
    expect(r.keep).not.toBe(r.spill);
    expect(spillPaste("short").spill).toBeUndefined();
  });

  test("only booted simulators and authorized phones count", () => {
    const ios = parseSimctl(JSON.stringify({ devices: { iOS: [{ name: "iPhone 16", udid: "A1", state: "Booted" }, { name: "iPad", udid: "B2", state: "Shutdown" }] } }));
    expect(ios.map((d) => d.name)).toEqual(["iPhone 16"]);
    expect(parseAdb("List of devices attached\nemulator-5554\tdevice\noffline-1\toffline\n")).toEqual([{ id: "emulator-5554", name: "emulator-5554", kind: "android" }]);
  });

  test("plan usage is token counts, and a codex index is a thread count", () => {
    const rows = claudePlanUsage(JSON.stringify({ modelUsage: { "claude-x": { inputTokens: 10, outputTokens: 4, costUSD: 0.2 }, "claude-y": { inputTokens: 3, outputTokens: 1, costUSD: 0 } }, dailyActivity: [{ messageCount: 9 }] }));
    expect(rows[0]).toEqual({ model: "claude-x", input: 10, output: 4, cost: 0.2 });
    expect(JSON.stringify(rows)).not.toContain("messageCount");
    expect(codexThreadCount('{"id":"a"}\n{"id":"b"}\n\n')).toBe(2);
    expect(claudePlanUsage("not json")).toEqual([]);
    expect(remoteHost("git@github.com:acme/app.git")).toBe("github.com");
    expect(remoteHost("https://gitlab.com/acme/app.git")).toBe("gitlab.com");
  });

  test("a turn's diff is the working tree, and a copy is a worktree with its own branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "rcode-studio-"));
    try {
      git(dir, ["init", "-q"]);
      writeFileSync(join(dir, "a.txt"), "one\n");
      git(dir, ["add", "a.txt"]);
      git(dir, ["commit", "-qm", "init"]);
      writeFileSync(join(dir, "a.txt"), "two\n");
      const diff = turnDiff(dir, ["a.txt"]);
      expect(diff).toContain("-one");
      expect(diff).toContain("+two");
      expect(turnDiff(dir, ["../etc/passwd"])).not.toContain("root:");
      const copy = addWorktree(dir, "wip");
      expect(copy.ok).toBe(true);
      if (copy.ok) {
        expect(copy.path.endsWith("-wip")).toBe(true);
        git(dir, ["worktree", "remove", "--force", copy.path]);
        git(dir, ["branch", "-D", "rcode/wip"]);
      }
      expect(addWorktree(dir, "../x").ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
