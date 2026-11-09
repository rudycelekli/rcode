import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpEvents, splitCommand } from "../src/center/acp-guest.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rcode-acp-"));

describe("any ACP agent", () => {
  test("splits a command without a shell", () => {
    expect(splitCommand('grok acp')).toEqual(["grok", "acp"]);
    expect(splitCommand('  "my agent" --flag "a b" ')).toEqual(["my agent", "--flag", "a b"]);
    expect(splitCommand("")).toEqual([]);
  });

  test("a new protocol update is shown, and thinking still streams as text", () => {
    expect(acpEvents({ sessionUpdate: "agent_thought_chunk", content: { text: "hmm" } })).toEqual([{ type: "delta", text: "hmm" }]);
    expect(acpEvents({ sessionUpdate: "plan" })[0]).toMatchObject({ type: "note", key: "acp:plan" });
    expect(acpEvents({ sessionUpdate: "tool_call", title: "bash" })[0]).toMatchObject({ type: "tool", status: "run" });
  });

  test("a turn streams text, and a tool ask is approved from the center", async () => {
    const dir = tmp();
    const agent = join(dir, "agent.ts");
    writeFileSync(agent, `
let promptId = 0;
for await (const line of console.Console ? [] : []) {}
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl; while ((nl = buf.indexOf("\\n")) >= 0) {
    const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const m = JSON.parse(raw);
    const send = (o) => console.log(JSON.stringify(o));
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
    else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
    else if (m.method === "session/prompt") {
      promptId = m.id;
      send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from agent" } } } });
      send({ jsonrpc: "2.0", method: "session/request_permission", id: 7, params: { toolCall: { title: "bash: ls" }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
    } else if (m.id === 7) send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
}
`);
    const { startCenter } = await import("../src/modes/center.ts");
    const cwd = tmp();
    const c = await startCenter({ cwd, port: 0, token: "acp-token", queueFile: join(cwd, "q.json") });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/ws?token=${c.token}`);
      const seen: any[] = [];
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        seen.push(m);
        if (m.type === "approval") ws.send(JSON.stringify({ type: "approval", id: m.id, decision: "allow" }));
      };
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ type: "prompt", text: "say hello", engine: "agent", command: `${process.execPath} ${agent}` }));
      const start = Date.now();
      while (Date.now() - start < 8000 && !seen.some((m) => m.evt?.type === "turn")) await new Promise((r) => setTimeout(r, 20));
      expect(seen.some((m) => m.type === "approval" && String(m.title).includes("bash"))).toBe(true);
      expect(seen.filter((m) => m.evt?.type === "delta").map((m) => m.evt.text).join("")).toContain("hello from agent");
      expect(seen.some((m) => m.evt?.type === "note" && String(m.evt.text).includes("threat rules"))).toBe(true);
      ws.close();
    } finally { c.stop(); }
  });
});
