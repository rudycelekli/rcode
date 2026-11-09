import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = () => mkdtempSync(join(tmpdir(), "rcode-center-"));

function once(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type}`)), 8000);
    const on = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === type) { clearTimeout(t); ws.removeEventListener("message", on); resolve(m); }
    };
    ws.addEventListener("message", on);
  });
}

describe("command center", () => {
  test("the page is local-only and the socket reports the folder and an empty mission list", async () => {
    const { startCenter } = await import("../src/modes/center.ts");
    const cwd = tmp();
    const queueFile = join(cwd, "queue.json");
    const c = await startCenter({ cwd, port: 0, token: "center-test-token", queueFile });
    try {
      expect((await fetch(`http://127.0.0.1:${c.port}/`)).status).toBe(401);
      const page = await (await fetch(c.url)).text();
      expect(page).toContain("Missions");
      expect(page).toContain("Claude plan");
      expect(page).toContain("Codex plan");
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/ws?token=${c.token}`);
      const ready = once(ws, "ready");
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      const hello = await ready;
      expect(hello.cwd).toBe(cwd);
      expect(hello.jobs).toEqual([]);
      expect(hello.models).toContain("claude-cli/sonnet");
      const queued = once(ws, "queue");
      ws.send(JSON.stringify({ type: "queue-add", text: "rename the photos by date" }));
      const q = await queued;
      expect(q.jobs[0].prompt).toBe("rename the photos by date");
      expect(q.jobs[0].status).toBe("pending");
      ws.close();
    } finally { c.stop(); }
  });
});
