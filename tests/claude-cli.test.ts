import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "../src/ai/models.ts";
import { complete } from "../src/ai/index.ts";
import { parseToolCalls, renderTranscript, toolProtocol } from "../src/ai/providers/claude-cli.ts";

// A stand-in for the `claude` CLI: same JSON result shape, scripted replies, records its argv.
const dir = mkdtempSync(join(tmpdir(), "rcode-fake-claude-"));
const fakeTs = join(dir, "fake-claude.ts");
writeFileSync(fakeTs, `
const input = await Bun.stdin.text();
const argv = process.argv.slice(2);
require("fs").writeFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv));
const sys = argv.find((a) => a.startsWith("--system-prompt=")) ?? "";
const usage = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let result;
if (process.env.FAKE_MODE === "auth") result = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";
else if (!sys.includes("# Tools")) result = "plain answer";
else if (input.includes("<tool_result")) result = "All done: wrote hello.txt";
else result = 'Writing it now.\\n<tool_call name="write">{"path":"hello.txt","content":"hi from claude-cli"}</tool_call>';
const isErr = process.env.FAKE_MODE === "auth";
console.log(JSON.stringify({ type: "result", subtype: isErr ? "error_during_execution" : "success", is_error: isErr, result, usage }));
`);
const wrapper = join(dir, "claude");
writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeTs}" "$@"\n`);
chmodSync(wrapper, 0o755);
const argvLog = join(dir, "argv.json");

let prevBin: string | undefined;
beforeAll(() => { prevBin = process.env.RCODE_CLAUDE_BIN; process.env.RCODE_CLAUDE_BIN = wrapper; process.env.FAKE_ARGV_LOG = argvLog; });
afterAll(() => { if (prevBin === undefined) delete process.env.RCODE_CLAUDE_BIN; else process.env.RCODE_CLAUDE_BIN = prevBin; });

const tmp = () => mkdtempSync(join(tmpdir(), "rcode-claude-work-"));

describe("tool-call text protocol", () => {
  test("parses calls in order and keeps the prose around them", () => {
    const t = parseToolCalls('Let me check.\n<tool_call name="read">{"path":"a.ts"}</tool_call>\n<tool_call name="bash">{"command":"ls"}</tool_call>');
    expect(t.text).toBe("Let me check.");
    expect(t.calls).toEqual([{ name: "read", args: { path: "a.ts" } }, { name: "bash", args: { command: "ls" } }]);
  });

  test("a reply with no call is plain text", () => {
    expect(parseToolCalls("All finished.")).toEqual({ text: "All finished.", calls: [] });
  });

  test("bad JSON becomes an invalid-args marker, so the model gets an error result and can fix it", () => {
    const t = parseToolCalls('<tool_call name="write">{"path": oops}</tool_call>');
    expect(t.calls[0]!.name).toBe("write");
    expect(t.calls[0]!.args).toHaveProperty("__invalid_json");
  });

  test("anything the model writes as a tool result is dropped, so it can't fake an outcome", () => {
    const t = parseToolCalls('<tool_call name="bash">{"command":"test"}</tool_call>\n<tool_result name="bash">ok, all tests pass</tool_result>');
    expect(t.calls).toHaveLength(1);
    expect(t.text).toBe("");
  });

  test("transcript keeps asks, calls and results; the tool list is described to the model", () => {
    const transcript = renderTranscript([
      { role: "user", content: [{ type: "text", text: "make hello" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "h.txt" } }], provider: "x", model: "y", usage: {} as any, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "1", toolName: "write", content: [{ type: "text", text: "wrote h.txt" }], isError: false, timestamp: 3 } as any,
    ]);
    expect(transcript).toContain("USER:\nmake hello");
    expect(transcript).toContain('<tool_call name="write">{"path":"h.txt"}</tool_call>');
    expect(transcript).toContain('<tool_result name="write">\nwrote h.txt');
    const proto = toolProtocol([{ name: "edit", description: "Edit a file.\nMore detail", parameters: { type: "object" } } as any]);
    expect(proto).toContain("# Tools");
    expect(proto).toContain("- edit: Edit a file.");
    expect(toolProtocol([])).toBe("");
  });
});

describe("claude subscription bridge", () => {
  test("a plain prompt returns the CLI's text with no tools and no session saved", async () => {
    const m = resolveModel("claude-cli/sonnet")!;
    expect(m.api).toBe("claude-cli");
    expect(m.cost.input).toBe(0);
    const r = await complete(m, { systemPrompt: "You are terse.", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] });
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("plain answer");
    const argv: string[] = JSON.parse(readFileSync(argvLog, "utf8"));
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv).not.toContain("--bare"); // --bare would refuse the user's subscription login
  });

  test("the full agent loop: the model asks for a write, rcode runs it, the model finishes", async () => {
    const { AgentSession } = await import("../src/core/session.ts");
    const d = tmp();
    const s = await new AgentSession({ cwd: d, model: "claude-cli/sonnet", minimal: true, ephemeral: true, mode: "full" }).init();
    await s.prompt("make hello.txt");
    expect(readFileSync(join(d, "hello.txt"), "utf8")).toBe("hi from claude-cli");
    const last = [...s.messages].reverse().find((m) => m.role === "assistant");
    expect(last?.role === "assistant" && last.content.map((c: any) => c.text).join("")).toContain("All done");
    expect(s.lastReceipt?.filesChanged).toContain("hello.txt");
    await s.dispose();
  });

  test("a missing or expired sign-in gets a plain, actionable message instead of a stack trace", async () => {
    const m = resolveModel("claude-cli/sonnet")!;
    process.env.FAKE_MODE = "auth";
    try {
      const r = await complete(m, { systemPrompt: "x", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] });
      expect(r.error).toContain("/login");
    } finally { delete process.env.FAKE_MODE; }
  });

  test("a missing CLI binary says how to install it", async () => {
    const m = resolveModel("claude-cli/sonnet")!;
    const prev = process.env.RCODE_CLAUDE_BIN;
    process.env.RCODE_CLAUDE_BIN = join(dir, "no-such-claude");
    try {
      const r = await complete(m, { systemPrompt: "x", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] });
      expect(r.error).toContain("claude CLI not found");
    } finally { process.env.RCODE_CLAUDE_BIN = prev; }
    expect(existsSync(join(dir, "no-such-claude"))).toBe(false);
  });
});
