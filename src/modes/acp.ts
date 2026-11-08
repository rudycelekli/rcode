/**
 * Agent Client Protocol (ACP) server over stdio — JSON-RPC 2.0, newline-delimited.
 * Lets ACP clients (Zed, t3code's ACP driver, goose desktop, …) drive rcode with no per-client code.
 *
 * Implemented: initialize, session/new, session/load, session/prompt, session/cancel, session/set_mode,
 * agent→client session/update notifications (message/thought chunks, tool_call(+_update), plan)
 * and session/request_permission requests mapped onto rcode's permission policy.
 */
import { createInterface } from "node:readline";
import type { AgentEvent } from "../agent/types.ts";
import type { UserContent } from "../ai/types.ts";
import { AgentSession } from "../core/session.ts";
import type { Asker } from "../permissions/policy.ts";

type Json = Record<string, any>;

export async function runAcp(base: { cwd: string; model?: string; minimal?: boolean }): Promise<number> {
  const send = (o: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  const sessions = new Map<string, AgentSession>();
  const waiting = new Map<number | string, (r: any) => void>();
  let outId = 1000;
  const request = (method: string, params: Json) => new Promise<any>((resolve) => { const id = outId++; waiting.set(id, resolve); send({ id, method, params }); });
  const update = (sessionId: string, u: Json) => send({ method: "session/update", params: { sessionId, update: u } });

  const kindOf = (tool: string) => (tool === "read" || tool === "ls" ? "read" : tool === "edit" || tool === "write" ? "edit" : tool === "bash" ? "execute" : tool === "grep" || tool === "glob" ? "search" : tool === "web_fetch" ? "fetch" : tool === "task" ? "think" : "other");

  const makeAsker = (sessionId: string): Asker => async (req) => {
    const r = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: `perm-${Date.now()}`, title: `${req.tool.name}: ${req.summary}`, kind: kindOf(req.tool.name), rawInput: req.args },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "allow-session", name: "Always allow", kind: "allow_always" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });
    const o = r?.outcome;
    return o?.outcome === "selected" ? (o.optionId as any) : "deny";
  };

  const wire = (sid: string, s: AgentSession) => s.subscribe((e: AgentEvent) => {
    switch (e.type) {
      case "message_update":
        if (e.delta?.kind === "text") update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta.text } });
        else if (e.delta?.kind === "thinking") update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta.text } });
        break;
      case "tool_start":
        update(sid, { sessionUpdate: "tool_call", toolCallId: e.toolCallId, title: `${e.name}${e.summary ? ": " + e.summary : ""}`, kind: kindOf(e.name), status: "in_progress", rawInput: e.args,
          locations: typeof e.args.path === "string" ? [{ path: e.args.path }] : undefined });
        break;
      case "tool_end": {
        const textOut = e.result.content.map((c) => (c.type === "text" ? c.text : "")).join("").slice(0, 20000);
        const d: any = e.result.details;
        const content: Json[] = [{ type: "content", content: { type: "text", text: textOut } }];
        if (d?.diff && d?.path) content.unshift({ type: "diff", path: d.path, oldText: null, newText: null, unifiedDiff: d.diff });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: e.toolCallId, status: e.result.isError ? "failed" : "completed", content });
        if (e.name === "todo" && d?.todos) update(sid, { sessionUpdate: "plan", entries: d.todos.map((t: any) => ({ content: t.content, priority: "medium", status: t.status })) });
        break;
      }
    }
  });

  const toContent = (blocks: any[]): { text: string; images: UserContent[] } => {
    let text = "";
    const images: UserContent[] = [];
    for (const b of blocks ?? []) {
      if (b.type === "text") text += b.text;
      else if (b.type === "image") images.push({ type: "image", mimeType: b.mimeType, data: b.data });
      else if (b.type === "resource" && b.resource?.text) text += `\n<file path="${b.resource.uri}">\n${b.resource.text}\n</file>\n`;
      else if (b.type === "resource_link") text += `\n[${b.name ?? b.uri}](${b.uri})`;
    }
    return { text, images };
  };

  const create = async (cwd: string, resume?: string) => {
    const holder: { id?: string } = {};
    const s = await new AgentSession({ cwd, model: base.model, minimal: base.minimal, resume, asker: (r) => makeAsker(holder.id!)(r) }).init();
    holder.id = s.session.id;
    sessions.set(s.session.id, s);
    wire(s.session.id, s);
    return s;
  };

  const handlers: Record<string, (p: Json) => Promise<any> | any> = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: false } },
      agentInfo: { name: "rcode", version: "0.1.0" },
      authMethods: [],
    }),
    authenticate: () => ({}),
    "session/new": async (p) => { const s = await create(p.cwd ?? base.cwd); return { sessionId: s.session.id, modes: modes(s) }; },
    "session/load": async (p) => {
      const { listSessions } = await import("../session/store.ts");
      const f = listSessions(p.cwd ?? base.cwd, 500).find((x) => x.id === p.sessionId)?.file;
      if (!f) throw new Error(`session ${p.sessionId} not found`);
      const s = await create(p.cwd ?? base.cwd, f);
      sessions.set(p.sessionId, s);
      for (const m of s.messages) {
        if (m.role === "user") update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: m.content.map((c) => (c.type === "text" ? c.text : "")).join("") } });
        else if (m.role === "assistant") for (const c of m.content) if (c.type === "text") update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: c.text } });
      }
      return { modes: modes(s) };
    },
    "session/prompt": async (p) => {
      const s = sessions.get(p.sessionId);
      if (!s) throw new Error(`unknown session ${p.sessionId}`);
      const { text, images } = toContent(p.prompt);
      await s.prompt(text, images);
      const last = [...s.messages].reverse().find((m) => m.role === "assistant");
      const sr = last?.role === "assistant" ? last.stopReason : "stop";
      return { stopReason: sr === "aborted" ? "cancelled" : sr === "length" ? "max_tokens" : sr === "error" ? "refusal" : "end_turn" };
    },
    "session/cancel": (p) => { sessions.get(p.sessionId)?.abort(); return null; },
    "session/set_mode": (p) => { sessions.get(p.sessionId)?.setMode(p.modeId); return {}; },
  };

  const modes = (s: AgentSession) => ({
    currentModeId: s.mode,
    availableModes: [
      { id: "ask", name: "Ask", description: "Approve edits and commands" },
      { id: "auto-edit", name: "Auto-edit", description: "Edits auto-approved; risky commands ask" },
      { id: "full", name: "Full access", description: "No prompts (catastrophic commands still refused)" },
      { id: "plan", name: "Plan", description: "Read-only research and planning" },
    ],
  });

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    if (msg.method === undefined && msg.id !== undefined) { const w = waiting.get(msg.id); waiting.delete(msg.id); w?.(msg.result ?? null); continue; }
    const h = handlers[msg.method];
    if (!h) { if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }); continue; }
    // Run without blocking the read loop (cancel must arrive while prompt is running).
    Promise.resolve().then(() => h(msg.params ?? {})).then(
      (result) => { if (msg.id !== undefined) send({ id: msg.id, result }); },
      (e) => { if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: (e as Error).message } }); },
    );
  }
  for (const s of sessions.values()) await s.dispose();
  return 0;
}
