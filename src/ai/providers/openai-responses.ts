/** OpenAI Responses API — needed for GPT-5 / o-series reasoning with tool use. Stateless (store:false). */
import type { Context, Model, StreamOptions } from "../types.ts";
import { computeCost } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";
import { parsePartialJson, sseEvents } from "../util.ts";
import { httpPost } from "./http.ts";

function convert(ctx: Context): any[] {
  const input: any[] = [];
  for (const m of ctx.messages) {
    if (m.role === "user") {
      input.push({ role: "user", content: m.content.map((c) => c.type === "text" ? { type: "input_text", text: c.text } : { type: "input_image", image_url: `data:${c.mimeType};base64,${c.data}` }) });
    } else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "thinking" && c.signature && m.provider === "openai") {
          try { input.push(JSON.parse(c.signature)); } catch {}
        } else if (c.type === "text" && c.text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: c.text }] });
        else if (c.type === "toolCall") {
          const [callId, itemId] = c.id.split("|");
          input.push({ type: "function_call", call_id: callId, ...(itemId ? { id: itemId } : {}), name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
        }
      }
    } else {
      const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n") || "(empty)";
      input.push({ type: "function_call_output", call_id: m.toolCallId.split("|")[0], output: text });
    }
  }
  return input;
}

const EFFORT: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", max: "high" };

export function streamOpenAIResponses(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  (async () => {
    try {
      const body: any = {
        model: model.id,
        instructions: ctx.systemPrompt,
        input: convert(ctx),
        stream: true,
        store: false,
        max_output_tokens: opts.maxTokens ?? model.maxOutput,
      };
      if (ctx.tools?.length) body.tools = ctx.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      if (model.reasoning) {
        body.reasoning = { effort: EFFORT[opts.thinking && opts.thinking !== "off" ? opts.thinking : "low"] ?? "medium", summary: "auto" };
        body.include = ["reasoning.encrypted_content"];
      }
      if (opts.cacheKey) body.prompt_cache_key = opts.cacheKey;
      const headers = { authorization: `Bearer ${opts.apiKey ?? ""}`, ...model.headers, ...opts.headers };
      const res = await httpPost(`${model.baseUrl}/responses`, body, headers, opts.signal);
      b.start();
      const itemIdx = new Map<string, number>();
      for await (const ev of sseEvents(res.body!, opts.signal)) {
        const d = JSON.parse(ev.data);
        switch (d.type) {
          case "response.output_item.added": {
            const it = d.item;
            const i = b.msg.content.length;
            itemIdx.set(it.id, i);
            if (it.type === "function_call") b.toolStart(i, `${it.call_id}|${it.id}`, it.name);
            else if (it.type === "reasoning") b.thinking(i, "");
            else if (it.type === "message") b.text(i, "");
            break;
          }
          case "response.output_text.delta": b.text(itemIdx.get(d.item_id)!, d.delta); break;
          case "response.reasoning_summary_text.delta": b.thinking(itemIdx.get(d.item_id)!, d.delta); break;
          case "response.function_call_arguments.delta": b.toolDelta(itemIdx.get(d.item_id)!, d.delta); break;
          case "response.output_item.done": {
            const it = d.item;
            const i = itemIdx.get(it.id)!;
            if (it.type === "function_call") b.toolEnd(i, (s) => parsePartialJson(s || it.arguments || ""));
            else if (it.type === "reasoning") {
              const p: any = b.msg.content[i];
              if (p) p.signature = JSON.stringify({ type: "reasoning", id: it.id, encrypted_content: it.encrypted_content, summary: it.summary ?? [] });
            }
            break;
          }
          case "response.completed":
          case "response.incomplete": {
            const r = d.response;
            const u = r.usage ?? {};
            const cached = u.input_tokens_details?.cached_tokens ?? 0;
            b.usage({ input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, reasoning: u.output_tokens_details?.reasoning_tokens });
            if (r.status === "incomplete") b.msg.stopReason = "length";
            break;
          }
          case "response.failed": throw new Error(d.response?.error?.message ?? "response failed");
          case "error": throw new Error(d.message ?? JSON.stringify(d));
        }
      }
      // Drop empty reasoning-without-signature placeholders
      b.msg.content = b.msg.content.filter((c: any) => !(c?.type === "thinking" && !c.thinking && !c.signature));
      computeCost(model, b.msg.usage);
      b.finish();
    } catch (e) {
      b.fail(e, !!opts.signal?.aborted);
    }
  })();
  return out;
}
