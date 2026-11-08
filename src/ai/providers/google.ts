/** Google Gemini (generativelanguage v1beta streamGenerateContent, SSE). */
import type { Context, Model, StreamOptions } from "../types.ts";
import { computeCost } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";
import { sseEvents } from "../util.ts";
import { httpPost } from "./http.ts";

/** Gemini rejects some JSON-schema keywords. */
function cleanSchema(s: any): any {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (["additionalProperties", "$schema", "default", "examples", "$ref", "$defs", "const"].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function convert(ctx: Context) {
  const contents: any[] = [];
  const names = new Map<string, string>();
  for (const m of ctx.messages) {
    if (m.role === "user") contents.push({ role: "user", parts: m.content.map((c) => c.type === "text" ? { text: c.text } : { inlineData: { mimeType: c.mimeType, data: c.data } }) });
    else if (m.role === "assistant") {
      const parts: any[] = [];
      for (const c of m.content) {
        if (c.type === "text" && c.text) parts.push({ text: c.text });
        else if (c.type === "toolCall") { names.set(c.id, c.name); parts.push({ functionCall: { name: c.name, args: c.arguments ?? {} }, ...(c.id.includes("|sig:") ? { thoughtSignature: c.id.split("|sig:")[1] } : {}) }); }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n");
      const part = { functionResponse: { name: m.toolName, response: m.isError ? { error: text } : { output: text } } };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts.every((p: any) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return contents;
}

const BUDGET: Record<string, number> = { minimal: 512, low: 2048, medium: 8192, high: 16384, max: 32768 };

export function streamGoogle(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  (async () => {
    try {
      const body: any = {
        systemInstruction: { parts: [{ text: ctx.systemPrompt }] },
        contents: convert(ctx),
        generationConfig: { maxOutputTokens: opts.maxTokens ?? model.maxOutput, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) },
      };
      if (model.reasoning) body.generationConfig.thinkingConfig = { includeThoughts: true, ...(opts.thinking && opts.thinking !== "off" ? { thinkingBudget: BUDGET[opts.thinking] } : {}) };
      if (ctx.tools?.length) body.tools = [{ functionDeclarations: ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: cleanSchema(t.parameters) })) }];
      const url = `${model.baseUrl}/v1beta/models/${model.id}:streamGenerateContent?alt=sse`;
      const res = await httpPost(url, body, { "x-goog-api-key": opts.apiKey ?? "", ...model.headers, ...opts.headers }, opts.signal);
      b.start();
      let textIdx = -1, thinkIdx = -1, n = 0;
      for await (const ev of sseEvents(res.body!, opts.signal)) {
        const d = JSON.parse(ev.data);
        if (d.error) throw new Error(d.error.message);
        const cand = d.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          if (p.text !== undefined && p.thought) { if (thinkIdx < 0) thinkIdx = b.msg.content.length; b.thinking(thinkIdx, p.text); }
          else if (p.text !== undefined) { if (textIdx < 0 || b.msg.content[textIdx]?.type !== "text") textIdx = b.msg.content.length; b.text(textIdx, p.text); }
          else if (p.functionCall) {
            const i = b.msg.content.length;
            const id = `call_${Date.now()}_${n++}${p.thoughtSignature ? `|sig:${p.thoughtSignature}` : ""}`;
            b.toolStart(i, id, p.functionCall.name);
            const args = JSON.stringify(p.functionCall.args ?? {});
            b.toolDelta(i, args);
            b.toolEnd(i, () => p.functionCall.args ?? {});
            textIdx = -1;
          }
        }
        if (cand?.finishReason) b.msg.stopReason = cand.finishReason === "MAX_TOKENS" ? "length" : "stop";
        const u = d.usageMetadata;
        if (u) {
          const cached = u.cachedContentTokenCount ?? 0;
          b.usage({ input: (u.promptTokenCount ?? 0) - cached, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: cached, reasoning: u.thoughtsTokenCount });
        }
      }
      computeCost(model, b.msg.usage);
      b.finish();
    } catch (e) {
      b.fail(e, !!opts.signal?.aborted);
    }
  })();
  return out;
}
