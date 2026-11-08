/**
 * JSONL RPC over stdio — drive rcode from any program (IDEs, GUIs like t3code, other agents).
 *
 * Request:  {"id": 1, "method": "prompt", "params": {"text": "..."}}
 * Response: {"id": 1, "result": {...}}  |  {"id": 1, "error": {"message": "..."}}
 * Events:   {"event": <AgentEvent>}      (streamed while the agent works)
 * Approval: {"event": {"type":"permission_request","requestId":"p1",...}} → client sends
 *           {"id": 7, "method": "permission_response", "params": {"requestId":"p1","decision":"allow"|"allow-session"|"deny"}}
 *
 * Methods: prompt, steer, follow_up, abort, get_state, get_messages, set_model, set_thinking, set_mode,
 *          compact, new_session, fork, list_sessions, resume, list_commands, list_models, shutdown
 */
import { createInterface } from "node:readline";
import { allModels } from "../ai/models.ts";
import { AgentSession, type SessionOptions } from "../core/session.ts";
import { listSessions } from "../session/store.ts";

export async function runRpc(opts: SessionOptions): Promise<number> {
  const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  const pending = new Map<string, (d: "allow" | "allow-session" | "deny") => void>();
  let seq = 0;
  const session = await new AgentSession({
    ...opts,
    asker: (req) => new Promise((resolve) => {
      const requestId = `p${++seq}`;
      pending.set(requestId, resolve);
      write({ event: { type: "permission_request", requestId, tool: req.tool.name, args: req.args, summary: req.summary, reason: req.reason } });
    }),
  }).init();
  session.subscribe((e) => {
    const slim: any = { ...e };
    if (e.type === "message_update") slim.message = undefined;
    if (e.type === "agent_end") slim.messages = undefined;
    write({ event: slim });
  });
  write({ event: { type: "ready", sessionId: session.session.id, model: `${session.model.provider}/${session.model.id}`, cwd: session.cwd } });

  const rl = createInterface({ input: process.stdin });
  const handlers: Record<string, (p: any) => unknown> = {
    prompt: (p) => { void session.prompt(String(p.text ?? "")); return { accepted: true }; },
    steer: (p) => { session.steer(String(p.text)); return { queued: true }; },
    follow_up: (p) => { session.followUp(String(p.text)); return { queued: true }; },
    abort: () => { session.abort(); return { aborted: true }; },
    get_state: () => ({ sessionId: session.session.id, file: session.session.file, model: `${session.model.provider}/${session.model.id}`, thinking: session.thinking, mode: session.mode, running: session.isRunning, usage: session.agent.usage, messages: session.messages.length }),
    get_messages: () => session.messages,
    set_model: (p) => { const m = session.setModel(String(p.model)); return { model: `${m.provider}/${m.id}` }; },
    set_thinking: (p) => { session.setThinking(p.level); return { thinking: p.level }; },
    set_mode: (p) => { session.setMode(p.mode); return { mode: p.mode }; },
    compact: async (p) => { await session.compact(p?.focus); return { ok: true }; },
    new_session: () => { session.newSession(); return { sessionId: session.session.id }; },
    fork: () => ({ file: session.fork() }),
    list_sessions: () => listSessions(session.cwd),
    resume: (p) => { session.resume(String(p.file)); return { sessionId: session.session.id }; },
    list_commands: () => session.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
    list_models: () => allModels().map((m) => ({ ref: `${m.provider}/${m.id}`, name: m.name, contextWindow: m.contextWindow })),
    permission_response: (p) => { const r = pending.get(p.requestId); pending.delete(p.requestId); r?.(p.decision); return { ok: !!r }; },
    shutdown: async () => { await session.dispose(); setTimeout(() => process.exit(0), 10); return { ok: true }; },
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: any;
    try { req = JSON.parse(line); } catch { write({ error: { message: "invalid JSON" } }); continue; }
    const h = handlers[req.method];
    if (!h) { write({ id: req.id, error: { message: `unknown method ${req.method}` } }); continue; }
    try { write({ id: req.id, result: await h(req.params ?? {}) }); } catch (e) { write({ id: req.id, error: { message: (e as Error).message } }); }
  }
  await session.dispose();
  return 0;
}
