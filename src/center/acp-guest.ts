/**
 * Host any agent that speaks the Agent Client Protocol, the same protocol `rcode acp` speaks.
 * The agent keeps its own tools and its own sign-in. Permission requests come back to the
 * command center, so the person still approves them. rcode's threat rules do not run inside it.
 */
import { spawn } from "node:child_process";
import type { GuestEvent } from "./guests.ts";

export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "";
  for (const ch of input.trim()) {
    if (quote) { if (ch === quote) quote = ""; else cur += ch; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

type Approval = { id: string; title: string; reason: string; options: Array<{ optionId: string; kind?: string }> };

/** One turn through an ACP agent. Resolves when the turn ends. Failures arrive as a done event. */
export function runAcpGuest(o: {
  argv: string[];
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  onEvent: (e: GuestEvent) => void;
  onApproval: (req: Approval) => Promise<"allow" | "allow-session" | "deny">;
}): Promise<void> {
  const [bin, ...args] = o.argv;
  if (!bin) { o.onEvent({ type: "done", error: "No agent command. Example: grok acp" }); return Promise.resolve(); }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(bin, args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env }); }
    catch (e) { o.onEvent({ type: "done", error: (e as Error).message }); resolve(); return; }
    const input = child.stdin, output = child.stdout;
    if (!input || !output) { o.onEvent({ type: "done", error: "could not start the agent" }); resolve(); return; }
    let next = 1, buf = "", settled = false;
    const pending = new Map<number, (v: any) => void>();
    const finish = (e?: GuestEvent) => { if (settled) return; settled = true; if (e) o.onEvent(e); resolve(); };
    const write = (msg: unknown) => { try { input.write(JSON.stringify(msg) + "\n"); } catch {} };
    const rpc = (method: string, params: unknown) => new Promise<any>((res, rej) => {
      const id = next++;
      pending.set(id, res);
      const stop = () => { pending.delete(id); rej(new Error("stopped")); };
      o.signal?.addEventListener("abort", stop, { once: true });
      write({ jsonrpc: "2.0", id, method, params });
    });
    const kill = () => { try { child.kill("SIGTERM"); } catch {} };
    o.signal?.addEventListener("abort", kill, { once: true });

    const onLine = async (line: string) => {
      let msg: any; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === undefined && msg.id !== undefined) { pending.get(msg.id)?.(msg.result ?? msg.error ?? null); pending.delete(msg.id); return; }
      if (msg.method === "session/update") {
        const u = msg.params?.update ?? {};
        const text = u.content?.text ?? u.content?.content?.text ?? "";
        if (u.sessionUpdate === "agent_message_chunk" && text) o.onEvent({ type: "delta", text });
        if (u.sessionUpdate === "tool_call") o.onEvent({ type: "tool", name: String(u.title ?? u.kind ?? "tool"), summary: "", status: "run" });
        if (u.sessionUpdate === "tool_call_update") o.onEvent({ type: "tool", name: String(u.title ?? "tool"), summary: "", status: u.status === "failed" ? "fail" : "ok" });
        return;
      }
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        const tool = msg.params?.toolCall ?? {};
        const decision = await o.onApproval({ id: String(msg.id), title: String(tool.title ?? "Permission"), reason: "", options: msg.params?.options ?? [] }).catch(() => "deny" as const);
        const options: Approval["options"] = msg.params?.options ?? [];
        const pick = decision === "deny"
          ? options.find((x) => x.kind === "reject_once" || x.optionId === "deny")
          : decision === "allow-session"
            ? options.find((x) => x.kind === "allow_always") ?? options.find((x) => x.kind === "allow_once" || x.optionId === "allow")
            : options.find((x) => x.kind === "allow_once" || x.optionId === "allow");
        write({ jsonrpc: "2.0", id: msg.id, result: pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } } });
      }
    };

    output.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) void onLine(line); }
    });
    child.on("error", (e: any) => finish({ type: "done", error: e?.code === "ENOENT" ? `${bin} is not installed.` : e.message }));
    child.on("close", () => { if (!settled) finish({ type: "done", error: o.signal?.aborted ? "stopped" : "the agent exited" }); });
    input.on("error", () => {});

    void (async () => {
      try {
        await rpc("initialize", { protocolVersion: 1, clientInfo: { name: "rcode-center", version: "0" } });
        const created = await rpc("session/new", { cwd: o.cwd, mcpServers: [] });
        const sessionId = created?.sessionId;
        if (!sessionId) throw new Error("the agent did not open a session");
        await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: o.prompt }] });
        finish({ type: "done" });
        kill();
      } catch (e) { finish({ type: "done", error: (e as Error).message }); kill(); }
    })();
  });
}
