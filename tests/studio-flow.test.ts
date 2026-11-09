import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fauxReset, fauxScript } from "../src/ai/providers/faux.ts";
import { Session, listSessions, sessionsDir } from "../src/session/store.ts";

const made: string[] = [];
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "rcode-flow-"));
  made.push(d);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  spawnSync("git", ["init", "-q"], { cwd: d, env });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: d, env });
  return d;
};

afterAll(() => {
  for (const d of made) {
    rmSync(d, { recursive: true, force: true });
    rmSync(sessionsDir(d), { recursive: true, force: true });
  }
});

beforeEach(() => fauxReset());

function once(ws: WebSocket, pick: (m: any) => boolean, ms = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
    const on = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (pick(m)) { clearTimeout(t); ws.removeEventListener("message", on); resolve(m); }
    };
    ws.addEventListener("message", on);
  });
}

describe("a turn in the command center", () => {
  test("creates a file, shows its diff, seals a receipt, and undo removes it", async () => {
    const { startCenter } = await import("../src/modes/center.ts");
    const cwd = repo();
    const c = await startCenter({ cwd, port: 0, token: "flow-token", model: "faux/test", queueFile: join(cwd, "q.json") });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/ws?token=${c.token}`);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ type: "new", engine: "rcode" }));
      const focus = await once(ws, (m) => m.type === "focus");
      ws.send(JSON.stringify({ type: "mode", thread: focus.id, mode: "auto-edit" }));
      await once(ws, (m) => m.type === "thread" && m.thread?.id === focus.id);
      fauxScript(
        { tools: [{ name: "write", args: { path: "hello.txt", content: "hi from the flow\n" } }] },
        "wrote hello.txt",
      );
      const diff = once(ws, (m) => m.evt?.type === "diff");
      const sealed = once(ws, (m) => m.type === "thread" && m.thread?.id === focus.id && !!m.thread.receipt);
      ws.send(JSON.stringify({ type: "prompt", thread: focus.id, text: "create hello.txt", engine: "rcode" }));
      const d = await diff;
      expect(d.evt.text).toContain("+hi from the flow");
      expect(d.evt.text).toContain("hello.txt");
      expect(d.evt.verdict).toBe("unverified");
      const receipt = (await sealed).thread.receipt;
      expect(receipt.verdict).toBe("unverified");
      expect(receipt.hash).toMatch(/^[0-9a-f]{16,}$/);
      expect(existsSync(join(cwd, "hello.txt"))).toBe(true);

      const undone = once(ws, (m) => m.type === "note" && String(m.text).startsWith("Reverted"));
      ws.send(JSON.stringify({ type: "undo", thread: focus.id }));
      expect((await undone).text).toContain("Reverted");
      expect(existsSync(join(cwd, "hello.txt"))).toBe(false);
      ws.close();
    } finally { c.stop(); }
  }, 30_000);
});

describe("mission sessions", () => {
  test("a queued mission is kept for review and is never the session -c continues", async () => {
    const cwd = repo();
    const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
    const mine = Session.create(cwd);
    mine.appendMessage(user("fix the parser") as never);
    await Bun.sleep(20);
    const mission = Session.create(cwd, { origin: "mission" });
    mission.appendMessage(user("rename the photos") as never);
    const all = listSessions(cwd);
    expect(all.some((s) => s.origin === "mission")).toBe(true);
    const latest = Session.latest(cwd);
    expect(latest).toBeDefined();
    expect(readFileSync(latest!, "utf8")).not.toContain('"origin":"mission"');
  });
});
