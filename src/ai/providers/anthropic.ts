/**
 * Anthropic Messages API via the official @anthropic-ai/sdk (streaming raw events).
 *  - Claude 4.6+/5.x: adaptive thinking + output_config.effort (budget_tokens & temperature are rejected).
 *  - Older models (e.g. Haiku 4.5): thinking.budget_tokens.
 *  - Tools use eager_input_streaming; partial JSON is parsed leniently and validated by the agent loop.
 *  - Prompt caching: breakpoints on system, last tool, last user message.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Context, Message, Model, StreamOptions } from "../types.ts";
import { computeCost } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";
import { parsePartialJson } from "../util.ts";

const BUDGET: Record<string, number> = { minimal: 1024, low: 4000, medium: 10000, high: 24000, xhigh: 32000, max: 48000 };
const EFFORT: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

const clients = new Map<string, Anthropic>();
function client(model: Model, apiKey?: string): Anthropic {
  const k = `${model.baseUrl}|${apiKey ?? ""}`;
  let c = clients.get(k);
  if (!c) {
    const isOAuth = apiKey?.startsWith("sk-ant-oat");
    c = new Anthropic({
      baseURL: model.baseUrl,
      ...(isOAuth ? { authToken: apiKey, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } } : apiKey ? { apiKey } : {}),
      maxRetries: 4,
    });
    clients.set(k, c);
  }
  return c;
}

function convertMessages(messages: Message[], model: Model): Anthropic.MessageParam[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map((c) => c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }) });
    } else if (m.role === "assistant") {
      const content: any[] = [];
      for (const c of m.content) {
        if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
        // Thinking blocks are passed back unchanged; the API drops (unbilled) any it can't read.
        else if (c.type === "thinking" && c.signature && m.provider === "anthropic") content.push(c.redacted ? { type: "redacted_thinking", data: c.signature } : { type: "thinking", thinking: c.thinking, signature: c.signature });
        else if (c.type === "toolCall") content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        ...(m.isError ? { is_error: true } : {}),
        content: m.content.map((c) => c.type === "text" ? { type: "text", text: c.text || "(empty)" } : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }),
      };
      const last = out[out.length - 1];
      // All results of one parallel batch must share one user turn.
      if (last?.role === "user" && last.content.every((b: any) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  // Two rolling message breakpoints (+ system + tools = 4, the API max): the last and second-to-last
  // user turns, so a large parallel tool batch can't push the previous breakpoint out of the lookback window.
  let marked = 0;
  for (let i = out.length - 1; i >= 0 && marked < 2; i--) {
    if (out[i].role === "user") { const b = out[i].content; if (b.length) { b[b.length - 1].cache_control = { type: "ephemeral" }; marked++; } }
  }
  return out;
}

export function streamAnthropic(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  (async () => {
    try {
      const mode = model.thinkingMode ?? (model.reasoning ? "adaptive" : undefined);
      const level = opts.thinking ?? "medium";
      const params: any = {
        model: model.id,
        max_tokens: opts.maxTokens ?? model.maxOutput,
        system: [{ type: "text", text: ctx.systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: convertMessages(ctx.messages, model),
        stream: true,
      };
      if (ctx.tools?.length) {
        params.tools = ctx.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
        params.tools[params.tools.length - 1].cache_control = { type: "ephemeral" };
      }
      if (mode === "adaptive" || mode === "always") {
        // Thinking cannot be disabled on current models; "off" maps to the lowest effort.
        params.thinking = { type: "adaptive", display: "summarized" };
        params.output_config = { effort: level === "off" ? "low" : EFFORT[level] ?? "medium" };
      } else if (mode === "budget" && level !== "off") {
        params.thinking = { type: "enabled", budget_tokens: BUDGET[level] ?? 8000 };
        params.max_tokens = Math.max(params.max_tokens, params.thinking.budget_tokens + 4096);
      }
      const stream: AsyncIterable<any> = (await client(model, opts.apiKey).messages.create(params, { signal: opts.signal, headers: { ...model.headers, ...opts.headers } })) as any;
      b.start();
      for await (const d of stream) {
        switch (d.type) {
          case "message_start": {
            const u = d.message?.usage ?? {};
            b.usage({ input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 });
            break;
          }
          case "content_block_start": {
            const cb = d.content_block;
            if (cb.type === "text") b.text(d.index, cb.text ?? "");
            else if (cb.type === "thinking") b.thinking(d.index, cb.thinking ?? "");
            else if (cb.type === "redacted_thinking") b.msg.content[d.index] = { type: "thinking", thinking: "", signature: cb.data, redacted: true };
            else if (cb.type === "tool_use") b.toolStart(d.index, cb.id, cb.name);
            break;
          }
          case "content_block_delta": {
            const dl = d.delta;
            if (dl.type === "text_delta") b.text(d.index, dl.text);
            else if (dl.type === "thinking_delta") b.thinking(d.index, dl.thinking);
            else if (dl.type === "signature_delta") b.thinking(d.index, "", dl.signature);
            else if (dl.type === "input_json_delta") b.toolDelta(d.index, dl.partial_json);
            break;
          }
          case "content_block_stop":
            if (b.msg.content[d.index]?.type === "toolCall") b.toolEnd(d.index, parsePartialJson);
            break;
          case "message_delta": {
            const sr = d.delta?.stop_reason;
            if (sr) {
              b.msg.stopReason = sr === "tool_use" ? "toolUse" : sr === "max_tokens" ? "length" : sr === "refusal" ? "error" : "stop";
              if (sr === "refusal") b.msg.errorMessage = `Model declined (${d.delta?.stop_details?.category ?? "refusal"})`;
            }
            if (d.usage?.output_tokens !== undefined) b.usage({ output: d.usage.output_tokens });
            break;
          }
        }
      }
      computeCost(model, b.msg.usage);
      if (b.msg.stopReason === "error") out.push({ type: "error", message: b.msg });
      else b.finish();
    } catch (e: any) {
      b.fail(e?.status ? new Error(`HTTP ${e.status}: ${e.message}`) : e, !!opts.signal?.aborted);
    }
  })();
  return out;
}
