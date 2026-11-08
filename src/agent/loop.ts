/**
 * The rcode agent loop.
 *
 *  prompt → [maybeCompact] → stream LLM → (tool calls?) → gate → run (shared ∥, exclusive →) → results
 *         → steering injected after batch → repeat … → would stop? → follow-ups / onStop gate → end
 *
 * Invariants:
 *  - Never throws to the caller; provider failures end the run with stopReason "error".
 *  - Every tool call gets exactly one result, in the order the model issued them.
 *  - If the response stopped on "length", all its tool calls fail (args may be truncated).
 *  - Repeated identical failing calls are interrupted (loop guard).
 */
import { z } from "zod";
import { stream } from "../ai/index.ts";
import type { AssistantMessage, Message, ToolCallPart, ToolResultMessage, ToolSchema, UserContent, Usage } from "../ai/types.ts";
import { addUsage, emptyUsage } from "../ai/types.ts";
import { isContextOverflow } from "../ai/util.ts";
import type { AgentConfig, AgentEvent, AgentRef, Tool, ToolResult } from "./types.ts";

export type Listener = (e: AgentEvent) => void;

const schemaCache = new WeakMap<Tool, ToolSchema>();
export function toolSchema(t: Tool): ToolSchema {
  let s = schemaCache.get(t);
  if (!s) {
    const json = (t.jsonSchema ? { ...t.jsonSchema } : z.toJSONSchema(t.schema, { target: "draft-7", io: "input" })) as Record<string, unknown>;
    delete json.$schema;
    s = { name: t.name, description: t.description, parameters: json };
    schemaCache.set(t, s);
  }
  return s;
}

export class Agent {
  messages: Message[] = [];
  usage: Usage = emptyUsage();
  private listeners = new Set<Listener>();
  private abortCtl?: AbortController;
  private running = false;
  readonly state: Map<string, unknown>;

  constructor(public config: AgentConfig) {
    this.state = config.state ?? new Map();
  }

  get isRunning() { return this.running; }
  subscribe(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit = (e: AgentEvent) => { for (const l of this.listeners) { try { l(e); } catch {} } };
  abort() { this.abortCtl?.abort(); }

  private async push(m: Message) {
    this.messages.push(m);
    await this.config.hooks?.onMessage?.(m);
  }

  /** Run one user prompt to completion. */
  async prompt(content: string | UserContent[]): Promise<AssistantMessage | undefined> {
    if (this.running) throw new Error("Agent is already running; use steering instead.");
    this.running = true;
    this.abortCtl = new AbortController();
    const signal = this.abortCtl.signal;
    const cfg = this.config;
    const hooks = cfg.hooks ?? {};
    const userContent: UserContent[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    let last: AssistantMessage | undefined;
    let stopReason = "stop";
    const failCounts = new Map<string, number>();
    const ref: AgentRef = { model: cfg.model, sessionId: cfg.sessionId, depth: cfg.depth ?? 0, emit: this.emit };

    try {
      this.emit({ type: "agent_start" });
      await this.push({ role: "user", content: userContent, timestamp: Date.now() });
      this.emit({ type: "user_message", content: userContent });

      let turn = 0;
      let overflowRetried = false;
      while (true) {
        if (signal.aborted) { stopReason = "aborted"; break; }
        if (turn >= (cfg.maxTurns ?? 200)) { stopReason = "max_turns"; this.emit({ type: "notice", level: "warn", text: `Stopped after ${turn} turns (maxTurns).` }); break; }
        turn++;
        this.emit({ type: "turn_start", turn });

        await hooks.maybeCompact?.(this.messages, last?.usage);
        const ctxMessages = hooks.transformContext ? await hooks.transformContext(this.messages) : this.messages;

        const s = stream(cfg.model, { systemPrompt: cfg.systemPrompt, messages: ctxMessages, tools: cfg.tools.map(toolSchema) }, {
          apiKey: cfg.apiKey, signal, thinking: cfg.thinking, cacheKey: cfg.sessionId, maxTokens: cfg.maxTokens,
        });
        let started = false;
        for await (const ev of s) {
          if (ev.type === "start") { started = true; this.emit({ type: "message_start", message: ev.partial }); }
          else if (ev.type === "text_delta") this.emit({ type: "message_update", message: ev.partial, delta: { kind: "text", text: ev.delta } });
          else if (ev.type === "thinking_delta") this.emit({ type: "message_update", message: ev.partial, delta: { kind: "thinking", text: ev.delta } });
          else if (ev.type === "toolcall_delta") this.emit({ type: "message_update", message: ev.partial, delta: { kind: "toolcall", text: ev.delta } });
        }
        const msg = await s.result();
        if (!started) this.emit({ type: "message_start", message: msg });

        if (msg.stopReason === "error" && isContextOverflow(msg.errorMessage) && !overflowRetried && hooks.onContextOverflow) {
          overflowRetried = true;
          this.emit({ type: "notice", level: "warn", text: "Context overflow — compacting and retrying." });
          if (await hooks.onContextOverflow(this.messages)) { turn--; continue; }
        }

        last = msg;
        this.usage = addUsage(this.usage, msg.usage);
        await this.push(msg);
        this.emit({ type: "message_end", message: msg });

        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          stopReason = msg.stopReason;
          if (msg.stopReason === "error") this.emit({ type: "notice", level: "error", text: msg.errorMessage ?? "Unknown provider error" });
          // Close any dangling tool calls so the transcript stays valid.
          for (const tc of msg.content.filter((c): c is ToolCallPart => c.type === "toolCall")) {
            await this.push(errorResult(tc, msg.stopReason === "aborted" ? "Aborted by user." : "Not executed: the request failed."));
          }
          break;
        }

        const calls = msg.content.filter((c): c is ToolCallPart => c.type === "toolCall");
        const results: ToolResultMessage[] = [];
        if (calls.length) {
          if (msg.stopReason === "length") {
            for (const tc of calls) results.push(errorResult(tc, "Output limit reached before this tool call finished; arguments may be truncated. Retry with smaller steps (e.g. split large writes)."));
          } else {
            results.push(...(await this.runTools(calls, signal, ref, failCounts)));
          }
          for (const r of results) await this.push(r);
        }
        this.emit({ type: "turn_end", turn, message: msg, toolResults: results });

        // Steering: user messages typed during the turn are injected after the tool batch.
        const steering = hooks.getSteering?.() ?? [];
        for (const c of steering) { await this.push({ role: "user", content: c, timestamp: Date.now() }); this.emit({ type: "user_message", content: c, steering: true }); }

        if (calls.length || steering.length) continue;

        // The model wants to stop.
        const follow = hooks.getFollowUp?.() ?? [];
        if (follow.length) {
          for (const c of follow) { await this.push({ role: "user", content: c, timestamp: Date.now() }); this.emit({ type: "user_message", content: c }); }
          continue;
        }
        const keepGoing = await hooks.onStop?.(this.messages);
        if (keepGoing) {
          const c: UserContent[] = [{ type: "text", text: keepGoing }];
          await this.push({ role: "user", content: c, timestamp: Date.now() });
          this.emit({ type: "user_message", content: c });
          continue;
        }
        stopReason = msg.stopReason === "length" ? "length" : "stop";
        break;
      }
    } catch (e) {
      stopReason = "error";
      this.emit({ type: "notice", level: "error", text: `Agent loop error: ${e instanceof Error ? e.stack ?? e.message : e}` });
    } finally {
      this.running = false;
      this.emit({ type: "agent_end", messages: this.messages, usage: this.usage, stopReason });
    }
    return last;
  }

  /** Execute a batch: consecutive shared tools run in parallel; exclusive tools run alone. Results in call order. */
  private async runTools(calls: ToolCallPart[], signal: AbortSignal, ref: AgentRef, failCounts: Map<string, number>): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = new Array(calls.length);
    const groups: Array<{ shared: boolean; idx: number[] }> = [];
    for (let i = 0; i < calls.length; i++) {
      const tool = this.config.tools.find((t) => t.name === calls[i]!.name);
      const shared = (tool?.concurrency ?? (tool?.effects.readOnly ? "shared" : "exclusive")) === "shared";
      const g = groups[groups.length - 1];
      if (shared && g?.shared) g.idx.push(i);
      else groups.push({ shared, idx: [i] });
    }
    for (const g of groups) {
      await Promise.all(g.idx.map(async (i) => { results[i] = await this.runOne(calls[i]!, signal, ref, failCounts); }));
    }
    return results;
  }

  private async runOne(tc: ToolCallPart, signal: AbortSignal, ref: AgentRef, failCounts: Map<string, number>): Promise<ToolResultMessage> {
    const t0 = Date.now();
    const tool = this.config.tools.find((t) => t.name === tc.name);
    const hooks = this.config.hooks ?? {};
    const finish = (r: ToolResultMessage) => { this.emit({ type: "tool_end", toolCallId: tc.id, name: tc.name, result: r, durationMs: Date.now() - t0 }); return r; };

    if (!tool) {
      this.emit({ type: "tool_start", toolCallId: tc.id, name: tc.name, args: tc.arguments });
      return finish(errorResult(tc, `Unknown tool "${tc.name}". Available: ${this.config.tools.map((t) => t.name).join(", ")}`));
    }
    let parsed = tool.schema.safeParse(tc.arguments ?? {});
    if (!parsed.success) {
      // Argument shim: weaker models often send nested arrays/objects as JSON strings, or numbers as strings.
      const fixed = coerceArgs(tc.arguments ?? {});
      const retry = tool.schema.safeParse(fixed);
      if (retry.success) { parsed = retry; tc.arguments = fixed; }
    }
    let summary: string | undefined;
    try { summary = parsed.success ? tool.summarize?.(parsed.data) : undefined; } catch {}
    this.emit({ type: "tool_start", toolCallId: tc.id, name: tc.name, args: tc.arguments, summary });
    if (!parsed.success) {
      return finish(errorResult(tc, `Invalid arguments for ${tc.name}:\n${z.prettifyError(parsed.error)}\nReceived: ${JSON.stringify(tc.arguments).slice(0, 500)}`));
    }
    if (signal.aborted) return finish(errorResult(tc, "Aborted by user."));

    // Loop guard: identical call that already failed 3 times.
    const sig = `${tc.name}:${JSON.stringify(tc.arguments)}`;
    if ((failCounts.get(sig) ?? 0) >= 3) {
      return finish(errorResult(tc, "This exact call has failed 3 times. Stop repeating it: re-read the relevant state, change approach, or ask the user."));
    }

    const decision = (await hooks.beforeToolCall?.({ tool, args: parsed.data as any, toolCallId: tc.id })) ?? { action: "allow" as const };
    if (decision.action !== "allow") {
      const reason = decision.action === "deny" ? decision.reason : decision.reason ?? "Requires approval";
      return finish(errorResult(tc, `Blocked: ${reason}`));
    }

    let result: ToolResult;
    try {
      result = await tool.execute(parsed.data, {
        cwd: this.config.cwd, signal, toolCallId: tc.id, state: this.state, agent: ref,
        onUpdate: (p) => this.emit({ type: "tool_update", toolCallId: tc.id, ...p }),
      });
    } catch (e) {
      result = { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
    const modified = await hooks.afterToolCall?.({ tool, args: parsed.data as any, toolCallId: tc.id, result });
    if (modified) result = modified;
    if (result.isError) failCounts.set(sig, (failCounts.get(sig) ?? 0) + 1);
    return finish({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: result.content.length ? result.content : [{ type: "text", text: "(no output)" }], details: result.details, isError: !!result.isError, timestamp: Date.now() });
  }
}

export function coerceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      const t = v.trim();
      if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) { try { out[k] = JSON.parse(t); continue; } catch {} }
      if (/^-?\d+(\.\d+)?$/.test(t)) { out[k] = Number(t); continue; }
      if (t === "true" || t === "false") { out[k] = t === "true"; continue; }
    }
    out[k] = v;
  }
  return out;
}

export function errorResult(tc: ToolCallPart, text: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text }], isError: true, timestamp: Date.now() };
}
