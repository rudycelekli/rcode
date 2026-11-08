import type { Context, Model, StreamOptions } from "./types.ts";
import { AssistantStream } from "./stream.ts";
import { streamAnthropic } from "./providers/anthropic.ts";
import { streamOpenAIChat } from "./providers/openai-chat.ts";
import { streamOpenAIResponses } from "./providers/openai-responses.ts";
import { streamGoogle } from "./providers/google.ts";
import { streamOllama } from "./providers/ollama.ts";

export * from "./types.ts";
export * from "./models.ts";
export { AssistantStream } from "./stream.ts";
export { isContextOverflow } from "./util.ts";

/** Stream a completion. Never throws: failures arrive as a final error message. */
export function stream(model: Model, ctx: Context, opts: StreamOptions = {}): AssistantStream {
  switch (model.api) {
    case "anthropic-messages": return streamAnthropic(model, ctx, opts);
    case "openai-chat": return streamOpenAIChat(model, ctx, opts);
    case "openai-responses": return streamOpenAIResponses(model, ctx, opts);
    case "google-gemini": return streamGoogle(model, ctx, opts);
    case "ollama": return streamOllama(model, ctx, opts);
  }
}

/** One-shot helper: returns final text (used for summaries, titles, judges). */
export async function complete(model: Model, ctx: Context, opts: StreamOptions = {}): Promise<{ text: string; error?: string; message: import("./types.ts").AssistantMessage }> {
  const m = await stream(model, ctx, opts).result();
  const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
  return { text, error: m.stopReason === "error" || m.stopReason === "aborted" ? m.errorMessage : undefined, message: m };
}
