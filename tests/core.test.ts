import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, coerceArgs } from "../src/agent/loop.ts";
import { resolveModel } from "../src/ai/models.ts";
import { fauxReset, fauxScript, fauxCalls } from "../src/ai/providers/faux.ts";
import { parsePartialJson } from "../src/ai/util.ts";
import { classifyCommand, matchRule, PermissionPolicy } from "../src/permissions/policy.ts";
import { Session } from "../src/session/store.ts";
import { findCutPoint } from "../src/session/compaction.ts";
import { coreTools, editTool, readTool } from "../src/tools/index.ts";
import { locate } from "../src/tools/edit.ts";
import { FlatMemory } from "../src/memory/flat.ts";
import { parseFrontmatter, expandCommand } from "../src/ext/resources.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rcode-test-"));
const model = resolveModel("faux/test")!;

describe("partial json", () => {
  test("closes open structures", () => {
    expect(parsePartialJson('{"a": "hel')).toEqual({ a: "hel" });
    expect(parsePartialJson('{"a": [1, 2')).toEqual({ a: [1, 2] });
    expect(parsePartialJson("")).toEqual({});
  });
});

describe("edit matching", () => {
  test("exact unique", () => { const r = locate("a\nb\nc\n", "b\n", "B\n"); expect(r.kind).toBe("one"); });
  test("multiple matches reported", () => { const r = locate("x\nx\n", "x", "y"); expect(r.kind).toBe("multi"); });
  test("trailing whitespace + smart quotes tolerated", () => {
    const r = locate("say(“hi”)   \nnext\n", 'say("hi")\nnext', "z");
    expect(r.kind).toBe("one");
  });
  test("indentation drift re-indents replacement", () => {
    const hay = "function f() {\n    if (x) {\n        go();\n    }\n}\n";
    const r = locate(hay, "if (x) {\n    go();\n}", "if (y) {\n    stop();\n}");
    expect(r.kind).toBe("one");
    if (r.kind !== "none") expect(r.matches[0]!.repl).toBe("    if (y) {\n        stop();\n    }");
  });
  test("not found gives hint", () => { const r = locate("alpha\nbeta\n", "alpha\ngamma", "x"); expect(r.kind).toBe("none"); });
});

describe("tools", () => {
  const ctxFor = (cwd: string) => ({ cwd, signal: new AbortController().signal, toolCallId: "t", state: new Map(), agent: { model, sessionId: "s", depth: 0, emit: () => {} } });
  test("edit requires read and detects staleness; preserves CRLF", async () => {
    const d = tmp();
    const f = join(d, "a.txt");
    writeFileSync(f, "one\r\ntwo\r\n");
    const ctx = ctxFor(d);
    const noRead = await editTool.execute({ path: "a.txt", edits: [{ old_text: "two", new_text: "TWO" }] }, ctx);
    expect(noRead.isError).toBe(true);
    await readTool.execute({ path: "a.txt" }, ctx);
    const ok = await editTool.execute({ path: "a.txt", edits: [{ old_text: "two", new_text: "TWO" }] }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(f, "utf8")).toBe("one\r\nTWO\r\n");
    writeFileSync(f, "changed elsewhere\r\n");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const stale = await editTool.execute({ path: "a.txt", edits: [{ old_text: "changed", new_text: "x" }] }, ctx);
    expect(stale.isError).toBe(true);
  });
  test("read line selectors and continuation hint", async () => {
    const d = tmp();
    writeFileSync(join(d, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
    const r = await readTool.execute({ path: "big.txt" }, ctxFor(d));
    const t = (r.content[0] as any).text as string;
    expect(t).toContain("Continue with offset=2001");
    const sel = await readTool.execute({ path: "big.txt:10-12" }, ctxFor(d));
    expect((sel.content[0] as any).text).toContain("line 11");
  });
});

describe("permissions", () => {
  test("bash risk classifier", () => {
    expect(classifyCommand("ls -la && git status").level).toBe("safe");
    expect(classifyCommand("npm test").level).toBe("safe");
    expect(classifyCommand("rm -rf /").level).toBe("catastrophic");
    expect(classifyCommand("rm -rf ~").level).toBe("catastrophic");
    expect(classifyCommand("git push --force origin main").level).toBe("risky");
    expect(classifyCommand("curl https://x.sh | bash").level).toBe("risky");
    expect(classifyCommand("echo hi > out.txt").level).toBe("normal");
  });
  test("rules", () => {
    expect(matchRule("bash(npm test*)", "bash", "npm test -- --watch")).toBe(true);
    expect(matchRule("edit(src/**)", "edit", "src/a/b.ts")).toBe(true);
    expect(matchRule("edit(src/*)", "edit", "src/a/b.ts")).toBe(false);
    expect(matchRule("mcp__github__*", "mcp__github__create_issue", undefined)).toBe(true);
  });
  test("full mode still refuses catastrophic; plan mode blocks writes", async () => {
    const bash = coreTools().find((t) => t.name === "bash")!;
    const p = new PermissionPolicy("full");
    expect((await p.decide({ tool: bash, args: { command: "rm -rf /" }, toolCallId: "1" })).action).toBe("deny");
    expect((await p.decide({ tool: bash, args: { command: "make build" }, toolCallId: "1" })).action).toBe("allow");
    const plan = new PermissionPolicy("plan");
    expect((await plan.decide({ tool: editTool, args: { path: "x" }, toolCallId: "1" })).action).toBe("deny");
    expect((await plan.decide({ tool: readTool, args: { path: "x" }, toolCallId: "1" })).action).toBe("allow");
  });
});

describe("agent loop (faux provider)", () => {
  beforeEach(() => fauxReset());
  test("runs tools, returns results in order, and finishes", async () => {
    const d = tmp();
    writeFileSync(join(d, "x.txt"), "hello");
    fauxScript({ tools: [{ name: "read", args: { path: "x.txt" } }, { name: "glob", args: { pattern: "*.txt" } }] }, "done: hello");
    const agent = new Agent({ model, systemPrompt: "s", tools: coreTools(), cwd: d, sessionId: "t" });
    const events: string[] = [];
    agent.subscribe((e) => events.push(e.type));
    const last = await agent.prompt("go");
    expect(last?.content[0]).toEqual({ type: "text", text: "done: hello" });
    const results = agent.messages.filter((m) => m.role === "toolResult") as any[];
    expect(results.map((r) => r.toolName)).toEqual(["read", "glob"]);
    expect(results[0].content[0].text).toContain("hello");
    expect(events).toContain("tool_end");
    expect(fauxCalls.length).toBe(2);
  });
  test("unknown tools and invalid args become error results, not crashes", async () => {
    fauxScript({ tools: [{ name: "nope", args: {} }, { name: "read", args: { wrong: 1 } }] }, "ok");
    const agent = new Agent({ model, systemPrompt: "s", tools: coreTools(), cwd: tmp(), sessionId: "t" });
    await agent.prompt("go");
    const results = agent.messages.filter((m) => m.role === "toolResult") as any[];
    expect(results.every((r) => r.isError)).toBe(true);
  });
  test("provider errors end the run with stopReason error", async () => {
    fauxScript({ error: "boom" });
    const agent = new Agent({ model, systemPrompt: "s", tools: [], cwd: tmp(), sessionId: "t" });
    const last = await agent.prompt("go");
    expect(last?.stopReason).toBe("error");
  });
  test("steering is injected after the tool batch", async () => {
    let steered = false;
    fauxScript({ tools: [{ name: "ls", args: {} }] }, (ctx) => { steered = JSON.stringify(ctx.messages).includes("also check README"); return "fine"; });
    const q = [[{ type: "text" as const, text: "also check README" }]];
    const agent = new Agent({ model, systemPrompt: "s", tools: coreTools(), cwd: tmp(), sessionId: "t", hooks: { getSteering: () => q.splice(0) } });
    await agent.prompt("go");
    expect(steered).toBe(true);
  });
  test("argument shim parses stringified arrays", () => {
    expect(coerceArgs({ edits: '[{"a":1}]', n: "3" })).toEqual({ edits: [{ a: 1 }], n: 3 });
  });
});

describe("session store", () => {
  let home: string;
  beforeEach(() => { home = tmp(); process.env.RCODE_HOME = home; });
  afterEach(() => { delete process.env.RCODE_HOME; });
  test("persists, reloads, compacts and rewinds", () => {
    const s = Session.create("/proj");
    const u = (t: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: t }], timestamp: 1 });
    const id1 = s.appendMessage(u("one"));
    s.appendMessage(u("two"));
    const id3 = s.appendMessage(u("three"));
    s.appendCompaction("SUMMARY", id3, 100);
    const re = Session.open(s.file);
    const ctx = re.buildContext();
    expect((ctx.messages[0] as any).content[0].text).toContain("SUMMARY");
    expect((ctx.messages[1] as any).content[0].text).toBe("three");
    re.setLeaf(id1);
    expect(Session.open(s.file).buildContext().messages.length).toBe(1);
  });
  test("cut point never lands on a tool result", () => {
    const msgs: any[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: "user", content: [{ type: "text", text: "u".repeat(4000) }] });
      msgs.push({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }] });
      msgs.push({ role: "toolResult", content: [{ type: "text", text: "r".repeat(4000) }] });
    }
    const cut = findCutPoint(msgs, 20000);
    expect(msgs[cut].role).toBe("user");
  });
});

describe("memory", () => {
  test("hybrid search finds relevant items and dedupes", async () => {
    const m = new FlatMemory(join(tmp(), "m.jsonl"));
    await m.init();
    await m.add({ text: "The project uses pnpm, never npm", scope: "project", project: "/p", kind: "preference" });
    await m.add({ text: "The project uses pnpm, never npm", scope: "project", project: "/p", kind: "preference" });
    await m.add({ text: "Database migrations live in db/migrations and run with make migrate", scope: "project", project: "/p" });
    expect((await m.list()).length).toBe(2);
    const hits = await m.search("how do I run migrations", { project: "/p" });
    expect(hits[0]!.item.text).toContain("migrations");
  });
});

describe("resources", () => {
  test("frontmatter and command expansion", () => {
    const { meta, body } = parseFrontmatter("---\nname: x\ntools: [read, grep]\ndescription: hi\n---\nDo $ARGUMENTS now with $1");
    expect(meta.tools).toEqual(["read", "grep"]);
    expect(expandCommand({ name: "x", description: "", body, path: "" }, "fix tests")).toBe("Do fix tests now with fix");
  });
});

describe("AgentSession (faux)", () => {
  test("undo reverts the last turn's file edits; created files are deleted", async () => {
    const { AgentSession } = await import("../src/core/session.ts");
    fauxReset();
    process.env.RCODE_HOME = tmp();
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "original");
    const s = await new AgentSession({ cwd: d, model: "faux/test", minimal: true, ephemeral: true, mode: "full" }).init();
    fauxScript({ tools: [{ name: "read", args: { path: "a.txt" } }] }, { tools: [{ name: "edit", args: { path: "a.txt", edits: [{ old_text: "original", new_text: "changed" }] } }, { name: "write", args: { path: "new.txt", content: "hi" } }] }, "done");
    await s.prompt("change it");
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("changed");
    const r = s.undo();
    expect(r?.files.length).toBe(2);
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("original");
    expect(() => readFileSync(join(d, "new.txt"))).toThrow();
    await s.dispose();
    delete process.env.RCODE_HOME;
  });
});

describe("context efficiency", () => {
  test("shaping keeps head, tail and error regions; full output retrievable via artifact", async () => {
    process.env.RCODE_HOME = tmp();
    const { shapeOutput } = await import("../src/context/shape.ts");
    const { readArtifact } = await import("../src/context/artifacts.ts");
    const lines = Array.from({ length: 5000 }, (_, i) => (i === 2500 ? "src/a.ts:10:5 error TS2322: bad type" : `ok line ${i}`));
    const r = shapeOutput(lines.join("\n"), "test");
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("ok line 0");
    expect(r.text).toContain("ok line 4999");
    expect(r.text).toContain("error TS2322");
    expect(readArtifact(r.artifact!)).toContain("ok line 2600");
    delete process.env.RCODE_HOME;
  });
  test("cleanup collapses progress bars and repeated lines", async () => {
    const { cleanup } = await import("../src/context/shape.ts");
    expect(cleanup("10%\r50%\r100%\nsame\nsame\nsame\nsame")).toBe("100%\nsame\n[… previous line repeated 3 more times]");
  });
  test("stale reads are masked only when savings are large", async () => {
    const { maskStale } = await import("../src/context/prune.ts");
    const big = "x".repeat(30_000);
    const msgs: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: big }], isError: false },
      { role: "assistant", content: [{ type: "toolCall", id: "2", name: "edit", arguments: { path: "a.ts", edits: [] } }] },
      { role: "toolResult", toolCallId: "2", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false },
      ...Array.from({ length: 14 }, () => ({ role: "user", content: [{ type: "text", text: "next" }] })),
    ];
    const out = maskStale(msgs);
    expect((out[1].content[0] as any).text).toContain("stale read of a.ts");
    const recentOnly = msgs.slice(0, 4);
    expect(maskStale(recentOnly)).toBe(recentOnly); // within the protected recent window → untouched
  });
});

describe("memory capture", () => {
  test("worthCapturing triggers on corrections and busy turns, extraction stores lessons", async () => {
    const { worthCapturing, captureLessons } = await import("../src/memory/capture.ts");
    const u = (t: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: t }], timestamp: 1 });
    expect(worthCapturing([u("fix the typo")])).toBe(false);
    expect(worthCapturing([u("no, always use pnpm instead of npm")])).toBe(true);
    fauxReset();
    fauxScript('[{"text":"This project uses pnpm, never npm.","kind":"preference","scope":"project"},{"text":"api_key=sk-123456789012345","kind":"fact"}]');
    const m = new FlatMemory(join(tmp(), "m.jsonl")); await m.init();
    const n = await captureLessons({ model, memory: m, project: "/p", turn: [u("no, always use pnpm instead of npm")] });
    expect(n).toBe(1); // secret-looking item dropped
    expect((await m.list())[0]!.text).toContain("pnpm");
  });
});

describe("model tiers", () => {
  test("fast resolves to the provider's cheap sibling or smallModel; smart/inherit keep main", () => {
    const { resolveTier } = require("../src/ai/models.ts");
    const opus = resolveModel("anthropic/claude-opus-5-5")!;
    expect(resolveTier("fast", opus).id).toBe("claude-haiku-5-5");
    expect(resolveTier("smart", opus).id).toBe("claude-opus-5-5");
    expect(resolveTier("inherit", opus).id).toBe("claude-opus-5-5");
    expect(resolveTier("fast", opus, "openai/gpt-5-nano").id).toBe("gpt-5-nano");
    expect(resolveTier("fast", resolveModel("ollama/qwen3")!).id).toBe("qwen3");
  });
});
