/**
 * Scripted provider for deterministic tests and demos ("faux/<anything>").
 * Queue responses with fauxScript(); each LLM call consumes one. A response is either a string
 * (assistant text) or a list of tool calls, or a function of the context.
 */
import type { Context, Model, StreamOptions } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";

export type FauxStep = string | { tools: Array<{ name: string; args: Record<string, unknown> }>; text?: string } | { error: string } | ((ctx: Context) => FauxStep);

const queue: FauxStep[] = [];
export const fauxCalls: Context[] = [];
export function fauxScript(...steps: FauxStep[]) { queue.push(...steps); }
export function fauxReset() { queue.length = 0; fauxCalls.length = 0; }

export function streamFaux(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  fauxCalls.push(structuredClone(ctx));
  queueMicrotask(() => {
    if (opts.signal?.aborted) return b.fail(new Error("aborted"), true);
    let step: FauxStep = queue.shift() ?? "(faux: no scripted response)";
    while (typeof step === "function") step = step(ctx);
    b.start();
    if (typeof step === "string") { b.text(0, step); }
    else if ("error" in step) { return b.fail(new Error(step.error), false); }
    else {
      let i = 0;
      if (step.text) b.text(i++, step.text);
      for (const t of step.tools) { b.toolStart(i, `faux_${Math.random().toString(36).slice(2, 8)}`, t.name); b.toolDelta(i, JSON.stringify(t.args)); b.toolEnd(i, () => t.args); i++; }
    }
    const chars = JSON.stringify(ctx.messages).length + ctx.systemPrompt.length;
    b.usage({ input: Math.ceil(chars / 4), output: 10 });
    b.finish();
  });
  return out;
}

