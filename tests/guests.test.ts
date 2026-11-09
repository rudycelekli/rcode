import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guestArgs, GUEST_NOTE, parseClaudeLine, parseCodexLine } from "../src/center/guests.ts";

describe("guest engines", () => {
  test("claude and codex commands never take the prompt as a flag, and both stay out of full-access mode", () => {
    expect(guestArgs("claude")).toContain("--permission-mode");
    expect(guestArgs("claude")).toContain("acceptEdits");
    expect(guestArgs("claude")).not.toContain("bypassPermissions");
    const codex = guestArgs("codex");
    expect(codex).toContain("workspace-write");
    expect(codex).not.toContain("danger-full-access");
    expect(codex.at(-1)).toBe("-");
    expect(GUEST_NOTE.claude).toContain("do not cover");
    expect(GUEST_NOTE.codex).toContain("do not cover");
  });

  test("claude stream lines become text, tool calls, and a finished turn", () => {
    expect(parseClaudeLine('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hi"}}}')).toEqual([{ type: "delta", text: "Hi" }]);
    const tool = parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}');
    expect(tool[0]).toMatchObject({ type: "tool", name: "Bash", status: "run" });
    expect(parseClaudeLine('{"type":"result","is_error":true,"result":"OAuth access token has expired"}')[0]).toMatchObject({ type: "done", error: expect.stringContaining("/login") });
    expect(parseClaudeLine("not json")).toEqual([]);
  });

  test("codex stream lines become commands and the reply", () => {
    expect(parseCodexLine('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}')[0]).toMatchObject({ type: "tool", status: "run", summary: "ls" });
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"ls","exit_code":0}}')[0]).toMatchObject({ status: "ok" });
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toEqual([{ type: "delta", text: "done" }]);
    expect(parseCodexLine('{"type":"turn.completed"}')).toEqual([{ type: "done" }]);
    expect(parseCodexLine('{"type":"error","message":"not logged in"}')[0]).toMatchObject({ error: expect.stringContaining("codex login") });
  });

  test("a guest turn streams into the center and warns that rcode is not checking it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rcode-guest-"));
    const script = join(dir, "claude");
    writeFileSync(script, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"pong"}}}' '{"type":"result","is_error":false,"result":"pong"}'\n`);
    chmodSync(script, 0o755);
    const prev = process.env.RCODE_CLAUDE_BIN;
    process.env.RCODE_CLAUDE_BIN = script;
    const { startCenter } = await import("../src/modes/center.ts");
    const cwd = mkdtempSync(join(tmpdir(), "rcode-guest-cwd-"));
    const c = await startCenter({ cwd, port: 0, token: "guest-token", queueFile: join(cwd, "q.json") });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/ws?token=${c.token}`);
      const seen: any[] = [];
      ws.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ type: "prompt", text: "say pong", engine: "claude" }));
      const start = Date.now();
      while (Date.now() - start < 8000 && !seen.some((m) => m.type === "evt" && m.evt?.type === "turn")) await new Promise((r) => setTimeout(r, 20));
      const notes = seen.filter((m) => m.evt?.type === "note").map((m) => m.evt.text).join("\n");
      expect(notes).toContain("do not cover");
      const text = seen.filter((m) => m.evt?.type === "delta").map((m) => m.evt.text).join("");
      expect(text).toContain("pong");
      expect(seen.some((m) => m.type === "thread" && m.thread.guest)).toBe(true);
      ws.close();
    } finally {
      c.stop();
      if (prev === undefined) delete process.env.RCODE_CLAUDE_BIN; else process.env.RCODE_CLAUDE_BIN = prev;
    }
  });
});
