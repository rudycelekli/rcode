/**
 * rcode AI layer — provider-neutral message + streaming types.
 *
 * Design rules (learned from pi / goose / jcode):
 *  - Once a stream starts it never throws: errors and aborts arrive as a final
 *    assistant message with stopReason "error" | "aborted".  ("errors are data")
 *  - A "Provider" owns auth + catalog; an "Api" is a wire protocol. Many providers
 *    share one Api (e.g. every OpenAI-compatible endpoint).
 *  - Usage always carries cache read/write so cost is exact.
 */

export type Role = "user" | "assistant" | "toolResult";

export interface TextPart { type: "text"; text: string }
export interface ImagePart { type: "image"; mimeType: string; data: string /* base64 */ }
export interface ThinkingPart { type: "thinking"; thinking: string; signature?: string; redacted?: boolean }
export interface ToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

export type UserContent = TextPart | ImagePart;
export type AssistantContent = TextPart | ThinkingPart | ToolCallPart;

export interface UserMessage { role: "user"; content: UserContent[]; timestamp: number }

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: UserContent[];
  isError: boolean;
  /** Structured, UI-only details (diffs, exit codes…). Never sent to the model. */
  details?: unknown;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema (object) */
  parameters: Record<string, unknown>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Context {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolSchema[];
}

export interface StreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: ThinkingLevel;
  /** Stable key for provider-side prompt caching (session id). */
  cacheKey?: string;
  headers?: Record<string, string>;
}

export type StreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; index: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; index: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_start"; index: number; id: string; name: string; partial: AssistantMessage }
  | { type: "toolcall_delta"; index: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; index: number; toolCall: ToolCallPart; partial: AssistantMessage }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message: AssistantMessage };

export type ApiId = "anthropic-messages" | "openai-chat" | "openai-responses" | "google-gemini" | "ollama";

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: ApiId;
  baseUrl: string;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  /** How reasoning is configured: adaptive+effort (Claude 4.6+/5.x), fixed budget (older), or effort-only (OpenAI). */
  thinkingMode?: "adaptive" | "budget" | "effort" | "always";
  vision: boolean;
  /** $ per million tokens */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Env vars checked (in order) for an API key. */
  envKeys: string[];
  headers?: Record<string, string>;
  /** Provider quirks */
  compat?: {
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    supportsReasoningEffort?: boolean;
    supportsDeveloperRole?: boolean;
  };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function computeCost(model: Model, u: Usage): Usage {
  const m = 1_000_000;
  u.cost.input = (u.input * model.cost.input) / m;
  u.cost.output = (u.output * model.cost.output) / m;
  u.cost.cacheRead = (u.cacheRead * model.cost.cacheRead) / m;
  u.cost.cacheWrite = (u.cacheWrite * model.cost.cacheWrite) / m;
  u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite;
  return u;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

export function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}
