import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "rcode-gw-"));
process.env.RCODE_HOME = home;
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({ gateway: { web: { token: "tok_test_123456" } } }));

describe("gateway", () => {
  test("pairing codes: 8 chars, unambiguous, single live code per user, max 3 pending, hashed at rest", async () => {
    const { createPairCode, pairCode, loadState } = await import("../src/gateway/server.ts");
    const c1 = createPairCode("u1", "alice")!;
    expect(c1).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(createPairCode("u1")).toBeUndefined();
    createPairCode("u2"); createPairCode("u3");
    expect(createPairCode("u4")).toBeUndefined();
    expect(JSON.stringify(loadState())).not.toContain(c1);
    expect(pairCode("WRONGCOD")).toBeUndefined();
    expect(pairCode(c1.toLowerCase())).toBe("alice");
    expect(loadState().telegramAllowed).toContain("u1");
  });

  test("web channel: approvals are bound to the conversation that raised them", async () => {
    const { fauxScript, fauxReset } = await import("../src/ai/providers/faux.ts");
    const { runGateway } = await import("../src/gateway/server.ts");
    fauxReset();
    const cwd = mkdtempSync(join(tmpdir(), "rcode-gw-cwd-"));
    mkdirSync(join(cwd, ".rcode"), { recursive: true });
    writeFileSync(join(cwd, ".rcode", "config.json"), JSON.stringify({ gateway: { web: { token: "tok_test_123456" } } }));
    fauxScript({ tools: [{ name: "bash", args: { command: "touch approved.txt" } }] }, "done");
    const port = 17000 + Math.floor(Math.random() * 2000);
    void runGateway({ cwd, model: "faux/x", port, web: true, mode: "ask" });
    await Bun.sleep(400);
    const open = (c: string) => new Promise<WebSocket>((res) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok_test_123456&c=${c}`); w.onopen = () => res(w); });
    const a = await open("A"), b = await open("B");
    const msgsA: any[] = [];
    a.onmessage = (e) => msgsA.push(JSON.parse(String(e.data)));
    a.send(JSON.stringify({ type: "prompt", text: "make the file" }));
    let approval: any;
    for (let i = 0; i < 50 && !approval; i++) { await Bun.sleep(50); approval = msgsA.find((m) => m.type === "approval"); }
    expect(approval?.detail).toContain("touch approved.txt");
    b.send(JSON.stringify({ type: "approval", id: approval.id, decision: "allow" })); // wrong conversation → ignored
    await Bun.sleep(300);
    expect(await Bun.file(join(cwd, "approved.txt")).exists()).toBe(false);
    a.send(JSON.stringify({ type: "approval", id: approval.id, decision: "allow" }));
    let final: any;
    for (let i = 0; i < 60 && !final; i++) { await Bun.sleep(50); final = msgsA.find((m) => m.type === "final"); }
    expect(final?.text).toBe("done");
    expect(await Bun.file(join(cwd, "approved.txt")).exists()).toBe(true);
    const unauth = await fetch(`http://127.0.0.1:${port}/`);
    expect(unauth.status).toBe(401);
    a.close(); b.close();
  });
});
