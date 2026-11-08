import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "../src/tools/bash.ts";
import { sandboxBackend } from "../src/tools/sandbox.ts";
import { PermissionPolicy } from "../src/permissions/policy.ts";

const backend = sandboxBackend();
const d = mkdtempSync(join(tmpdir(), "rcode-sbx-"));
const ctx = (sandbox: boolean) => ({ cwd: d, signal: new AbortController().signal, toolCallId: "t", state: new Map<string, unknown>(sandbox ? [["sandbox", { enabled: true, network: false }]] : []), agent: {} as any });
const out = (r: any) => (r.content[0] as any).text as string;

describe.if(!!backend)(`sandbox (${backend})`, () => {
  test("writes inside the project are allowed", async () => {
    const r = await bashTool.execute({ command: "echo hi > inside.txt && cat inside.txt" }, ctx(true));
    expect(out(r)).toContain("hi");
    expect(r.isError).toBeFalsy();
  });
  test("writes outside the project are blocked, with an escape hint", async () => {
    const target = join(homedir(), `.rcode-sandbox-probe-${Date.now()}`);
    const r = await bashTool.execute({ command: `echo x > ${target}` }, ctx(true));
    expect(r.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(out(r)).toContain("unsandboxed:true");
  });
  test("network is blocked (except localhost)", async () => {
    const r = await bashTool.execute({ command: "curl -sS -m 5 https://example.com -o /dev/null", timeout: 20 }, ctx(true));
    expect(r.isError).toBe(true);
  });
  test("unsandboxed escapes the sandbox", async () => {
    const target = join(d, "..", `rcode-sbx-out-${Date.now()}`);
    const r = await bashTool.execute({ command: `echo x > ${target}`, unsandboxed: true }, ctx(true));
    expect(r.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
    rmSync(target, { force: true });
  });
});

describe("sandbox permissions", () => {
  test("sandboxed ask mode runs normal commands without asking; unsandboxed asks; catastrophic still denied", async () => {
    let asked = 0;
    const p = new PermissionPolicy("ask", { allow: [], deny: [] }, async () => { asked++; return "allow"; });
    p.sandboxed = true;
    expect((await p.decide({ tool: bashTool as any, args: { command: "make build" }, toolCallId: "1" })).action).toBe("allow");
    expect(asked).toBe(0);
    await p.decide({ tool: bashTool as any, args: { command: "npm install", unsandboxed: true }, toolCallId: "1" });
    expect(asked).toBe(1);
    expect((await p.decide({ tool: bashTool as any, args: { command: "rm -rf /" }, toolCallId: "1" })).action).toBe("deny");
    p.sandboxed = false;
    await p.decide({ tool: bashTool as any, args: { command: "make build" }, toolCallId: "1" });
    expect(asked).toBe(2);
  });
});

describe("guards", () => {
  test("freeze-tests, no-skip, strict-tdd", async () => {
    const { Guards } = await import("../src/core/guards.ts");
    const g = new Guards(["freeze-tests"]);
    expect(g.check("edit", { path: "src/a.test.ts", edits: [] })?.action).toBe("deny");
    expect(g.check("edit", { path: "src/a.ts", edits: [] })).toBeUndefined();
    expect(g.check("write", { path: "tests/test_x.py", content: "" })?.action).toBe("deny");
    const ns = new Guards(["no-skip"]);
    expect(ns.check("edit", { path: "a.test.ts", edits: [{ old_text: "it('x'", new_text: "it.skip('x'" }] })?.action).toBe("deny");
    expect(ns.check("edit", { path: "a.test.ts", edits: [{ old_text: "a", new_text: "b" }] })).toBeUndefined();
    const tdd = new Guards(["strict-tdd"]);
    expect(tdd.check("edit", { path: "src/a.ts", edits: [] })?.action).toBe("deny");
    tdd.check("bash", { command: "bun test" });
    expect(tdd.check("edit", { path: "src/a.ts", edits: [] })).toBeUndefined();
    tdd.resetTurn();
    expect(tdd.check("write", { path: "src/b.ts", content: "" })?.action).toBe("deny");
  });
});
