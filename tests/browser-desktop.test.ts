import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTool } from "../src/tools/browser.ts";
import { desktopTool } from "../src/tools/desktop.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";

const dir = mkdtempSync(join(tmpdir(), "rcode-cli-"));
function fakeCli(name: string, stdout: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${p}.args"\ncat > "${p}.stdin"\nprintf '%s' '${stdout}'\n`);
  chmodSync(p, 0o755);
  return p;
}
const ctx = { cwd: dir, signal: new AbortController().signal, toolCallId: "t", state: new Map(), agent: { sessionId: "abc", depth: 0 } as any };

describe("browser tool", () => {
  process.env.RCODE_AGENT_BROWSER = fakeCli("agent-browser", "- button Save [ref=e1]");
  test("builds argv with isolated session and literal text marker", async () => {
    const r = await browserTool.execute({ action: "fill", ref: "@e2", text: "--json" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(readFileSync(process.env.RCODE_AGENT_BROWSER + ".args", "utf8").trim().split("\n")).toEqual(["--session", "rcode-abc", "fill", "@e2", "--", "--json"]);
  });
  test("snapshot output is wrapped as untrusted", async () => {
    const r = await browserTool.execute({ action: "snapshot" }, ctx);
    expect((r.content[0] as any).text).toContain("<untrusted_page_content>");
  });
  test("eval sends JS via stdin", async () => {
    await browserTool.execute({ action: "eval", text: "document.title" }, ctx);
    expect(readFileSync(process.env.RCODE_AGENT_BROWSER + ".stdin", "utf8")).toBe("document.title");
  });
  test("refuses secrets", async () => {
    const r = await browserTool.execute({ action: "fill", ref: "@e9", text: "sk-abcdefghijklmnopqrstuv" }, ctx);
    expect(r.isError).toBe(true);
  });
  test("missing argument is a clean error", async () => {
    const r = await browserTool.execute({ action: "click" }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe("desktop tool", () => {
  process.env.RCODE_AGENT_DESKTOP = fakeCli("agent-desktop", '{"ok":true,"data":{"tree":"window Notes [ref=@s1:e1]"}}');
  test("renders the JSON envelope and types via stdin", async () => {
    const snap = await desktopTool.execute({ action: "snapshot", app: "Notes" }, ctx);
    expect((snap.content[0] as any).text).toContain("window Notes");
    await desktopTool.execute({ action: "type", ref: "@s1:e2", text: "hello" }, ctx);
    expect(readFileSync(process.env.RCODE_AGENT_DESKTOP + ".args", "utf8").trim().split("\n")).toEqual(["type", "@s1:e2", "--stdin"]);
    expect(readFileSync(process.env.RCODE_AGENT_DESKTOP + ".stdin", "utf8")).toBe("hello");
  });
});

describe("per-action permissions", () => {
  test("browser: snapshot free, localhost free, external domain asks, desktop actions ask even in auto-edit", async () => {
    const asked: string[] = [];
    const p = new PermissionPolicy("auto-edit", { allow: [], deny: [] }, async (req) => { asked.push(req.summary); return "allow-session"; });
    expect((await p.decide({ tool: browserTool as any, args: { action: "snapshot" }, toolCallId: "1" })).action).toBe("allow");
    expect((await p.decide({ tool: browserTool as any, args: { action: "open", url: "http://localhost:3000" }, toolCallId: "1" })).action).toBe("allow");
    await p.decide({ tool: browserTool as any, args: { action: "open", url: "https://example.com/a" }, toolCallId: "1" });
    await p.decide({ tool: browserTool as any, args: { action: "open", url: "https://example.com/b" }, toolCallId: "1" });
    await p.decide({ tool: browserTool as any, args: { action: "open", url: "https://other.org" }, toolCallId: "1" });
    expect(asked.length).toBe(2); // once per domain
    const before = asked.length;
    await p.decide({ tool: desktopTool as any, args: { action: "click", ref: "@s1:e1" }, toolCallId: "1" });
    expect(asked.length).toBe(before + 1);
    const plan = new PermissionPolicy("plan");
    expect((await plan.decide({ tool: desktopTool as any, args: { action: "click", ref: "@x" }, toolCallId: "1" })).action).toBe("deny");
  });
});
