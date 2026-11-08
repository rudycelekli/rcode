/**
 * OpenAI Chat Completions wire protocol. Covers OpenAI, OpenRouter, Groq, xAI,
 * DeepSeek, Mistral, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM…
 */
import type { Context, Message, Model, StreamOptions } from "../types.ts";
import { computeCost } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";
import { parsePartialJson, sseEvents } from "../util.ts";
import { httpPost } from "./http.ts";

function convert(model: Model, ctx: Context): any[] {
  const sysRole = model.compat?.supportsDeveloperRole && model.reasoning ? "developer" : "system";
  const out: any[] = [{ role: sysRole, content: ctx.systemPrompt }];
  for (const m of ctx.messages as Message[]) {
    if (m.role === "user") {
      const hasImage = m.content.some((c) => c.type === "image");
      out.push({
        role: "user",
        content: hasImage
          ? m.content.map((c) => c.type === "text" ? { type: "text", text: c.text } : { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } })
          : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      });
    } else if (m.role === "assistant") {
      const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
      const calls = m.content.filter((c) => c.type === "toolCall") as any[];
      const msg: any = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      if (text || calls.length) out.push(msg);
    } else {
      const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n") || "(empty)";
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: text });
      const imgs = m.content.filter((c) => c.type === "image") as any[];
      if (imgs.length && model.vision) out.push({ role: "user", content: [{ type: "text", text: `Images from tool ${m.toolName}:` }, ...imgs.map((c) => ({ type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } }))] });
    }
  }
  return out;
}

const EFFORT: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", max: "high" };

export function streamOpenAIChat(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  (async () => {
    try {
      const body: any = { model: model.id, messages: convert(model, ctx), stream: true, stream_options: { include_usage: true } };
      const field = model.compat?.maxTokensField ?? (model.provider === "openai" ? "max_completion_tokens" : "max_tokens");
      body[field] = opts.maxTokens ?? model.maxOutput;
      if (ctx.tools?.length) body.tools = ctx.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      if (model.reasoning && opts.thinking && opts.thinking !== "off" && model.compat?.supportsReasoningEffort !== false) {
        if (model.provider === "openrouter") body.reasoning = { effort: EFFORT[opts.thinking] };
        else body.reasoning_effort = EFFORT[opts.thinking];
      } else if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.cacheKey && model.provider === "openai") body.prompt_cache_key = opts.cacheKey;

      const headers: Record<string, string> = { ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}), ...model.headers, ...opts.headers };
      if (model.provider === "openrouter") { headers["HTTP-Referer"] ??= "https://github.com/rcode-dev/rcode"; headers["X-Title"] ??= "rcode"; }
      const res = await httpPost(`${model.baseUrl}/chat/completions`, body, headers, opts.signal);
      b.start();
      // index mapping: content parts are appended in arrival order
      let textIdx = -1, thinkIdx = -1;
      const toolIdx = new Map<number, number>();
      const next = () => b.msg.content.length;
      for await (const ev of sseEvents(res.body!, opts.signal)) {
        if (ev.data === "[DONE]") break;
        const d = JSON.parse(ev.data);
        if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error));
        if (d.usage) {
          const cached = d.usage.prompt_tokens_details?.cached_tokens ?? 0;
          b.usage({ input: (d.usage.prompt_tokens ?? 0) - cached, output: d.usage.completion_tokens ?? 0, cacheRead: cached, reasoning: d.usage.completion_tokens_details?.reasoning_tokens });
        }
        const ch = d.choices?.[0];
        if (!ch) continue;
        const delta = ch.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          if (thinkIdx < 0) thinkIdx = next();
          b.thinking(thinkIdx, reasoning);
        }
        if (typeof delta.content === "string" && delta.content) {
          if (textIdx < 0) textIdx = next();
          b.text(textIdx, delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const k = tc.index ?? 0;
          if (!toolIdx.has(k)) {
            const i = next();
            toolIdx.set(k, i);
            b.toolStart(i, tc.id ?? `call_${Date.now()}_${k}`, tc.function?.name ?? "");
          }
          const i = toolIdx.get(k)!;
          const p: any = b.msg.content[i];
          if (tc.function?.name && !p.name) p.name = tc.function.name;
          if (tc.function?.arguments) b.toolDelta(i, tc.function.arguments);
        }
        if (ch.finish_reason) {
          b.msg.stopReason = ch.finish_reason === "tool_calls" ? "toolUse" : ch.finish_reason === "length" ? "length" : "stop";
        }
      }
      for (const i of toolIdx.values()) b.toolEnd(i, parsePartialJson);
      computeCost(model, b.msg.usage);
      b.finish();
    } catch (e) {
      b.fail(e, !!opts.signal?.aborted);
    }
  })();
  return out;
}
