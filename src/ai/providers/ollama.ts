/**
 * Native Ollama /api/chat (NDJSON stream). Used instead of the OpenAI-compatible endpoint because
 * only the native API honors options.num_ctx — otherwise Ollama silently truncates the prompt to
 * its default window (2–4k tokens), dropping the system prompt and tool definitions.
 */
import type { Context, Model, StreamOptions } from "../types.ts";
import { computeCost } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";
import { httpPost } from "./http.ts";

function convert(ctx: Context): any[] {
  const out: any[] = [{ role: "system", content: ctx.systemPrompt }];
  for (const m of ctx.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), images: m.content.filter((c) => c.type === "image").map((c: any) => c.data) });
    } else if (m.role === "assistant") {
      const content = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
      const calls = m.content.filter((c) => c.type === "toolCall") as any[];
      out.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) } : {}) });
    } else {
      out.push({ role: "tool", tool_name: m.toolName, content: m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") || "(empty)" });
    }
  }
  return out;
}

export function streamOllama(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  (async () => {
    try {
      const base = model.baseUrl.replace(/\/v1\/?$/, "");
      const body: any = {
        model: model.id,
        messages: convert(ctx),
        stream: true,
        options: { num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? Math.min(model.contextWindow, 32768)), num_predict: opts.maxTokens ?? model.maxOutput, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) },
      };
      if (ctx.tools?.length) body.tools = ctx.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      if (model.reasoning) body.think = opts.thinking !== "off";
      const res = await httpPost(`${base}/api/chat`, body, { ...model.headers, ...opts.headers }, opts.signal);
      b.start();
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", textIdx = -1, thinkIdx = -1, n = 0;
      const onAbort = () => reader.cancel().catch(() => {});
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const d = JSON.parse(line);
          if (d.error) throw new Error(d.error);
          const msg = d.message ?? {};
          if (msg.thinking) { if (thinkIdx < 0) thinkIdx = b.msg.content.length; b.thinking(thinkIdx, msg.thinking); }
          if (msg.content) { if (textIdx < 0) textIdx = b.msg.content.length; b.text(textIdx, msg.content); }
          for (const tc of msg.tool_calls ?? []) {
            const i = b.msg.content.length;
            const args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : tc.function?.arguments ?? {};
            b.toolStart(i, `call_${Date.now().toString(36)}_${n++}`, tc.function?.name ?? "");
            b.toolDelta(i, JSON.stringify(args));
            b.toolEnd(i, () => args);
          }
          if (d.done) {
            b.usage({ input: d.prompt_eval_count ?? 0, output: d.eval_count ?? 0 });
            if (d.done_reason === "length") b.msg.stopReason = "length";
          }
        }
      }
      opts.signal?.removeEventListener("abort", onAbort);
      computeCost(model, b.msg.usage);
      b.finish();
    } catch (e) {
      b.fail(e, !!opts.signal?.aborted);
    }
  })();
  return out;
}
