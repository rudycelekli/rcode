import type { z } from "zod";
import type { AssistantMessage, Message, Model, ThinkingLevel, ToolResultMessage, UserContent, Usage } from "../ai/types.ts";

/** Declared side-effects of a tool. Drives permissions, concurrency and UI. (pattern from REA's effects audit) */
export interface ToolEffects {
  readOnly?: boolean;
  writesFiles?: boolean;
  runsProcess?: boolean;
  network?: boolean;
  destructive?: boolean;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  toolCallId: string;
  /** Stream partial output to the UI (e.g. bash stdout). */
  onUpdate?: (partial: { text?: string; details?: unknown }) => void;
  /** Session-scoped shared state (read tracking, todos…). */
  state: Map<string, unknown>;
  agent: AgentRef;
}

export interface AgentRef {
  model: Model;
  sessionId: string;
  depth: number;
  emit: (e: AgentEvent) => void;
}

export interface ToolResult {
  content: UserContent[];
  details?: unknown;
  isError?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Short label for the UI. */
  label?: string;
  description: string;
  schema: S;
  /** Raw JSON Schema sent to the model instead of converting `schema` (MCP tools). */
  jsonSchema?: Record<string, unknown>;
  /** "shared" tools run in parallel with each other; "exclusive" run alone, in order. */
  concurrency?: "shared" | "exclusive";
  effects: ToolEffects;
  /** One-line summary of a call for UIs/permission prompts. */
  summarize?: (args: z.infer<S>) => string;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export type PermissionDecision = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask"; reason?: string };

export interface BeforeToolCall { tool: Tool; args: Record<string, unknown>; toolCallId: string }

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_update"; message: AssistantMessage; delta?: { kind: "text" | "thinking" | "toolcall"; text: string } }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_start"; toolCallId: string; name: string; args: Record<string, unknown>; summary?: string }
  | { type: "tool_update"; toolCallId: string; text?: string; details?: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; result: ToolResultMessage; durationMs: number }
  | { type: "user_message"; content: UserContent[]; steering?: boolean }
  | { type: "turn_end"; turn: number; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "compaction"; before: number; after: number; summary: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "agent_end"; messages: Message[]; usage: Usage; stopReason: string };

export interface AgentHooks {
  /** Rewrite the context right before each LLM call (memory injection, pruning…). */
  transformContext?: (messages: Message[]) => Promise<Message[]> | Message[];
  /** Gate a tool call: allow / deny / ask (permission layer plugs in here). */
  beforeToolCall?: (c: BeforeToolCall) => Promise<PermissionDecision> | PermissionDecision;
  /** Observe/modify a tool result. */
  afterToolCall?: (c: BeforeToolCall & { result: ToolResult }) => Promise<ToolResult | void> | ToolResult | void;
  /** Called when the provider reports context overflow. Return true if context was reduced and the turn should retry. */
  onContextOverflow?: (messages: Message[]) => Promise<boolean>;
  /** Proactive compaction check before each turn. */
  maybeCompact?: (messages: Message[], lastUsage?: Usage) => Promise<void>;
  /** Steering messages (user typed while agent works) — injected after the current tool batch. */
  getSteering?: () => UserContent[][];
  /** Follow-up messages — injected when the agent would otherwise stop. */
  getFollowUp?: () => UserContent[][];
  /** Stop-time gate (goose /goal style): return text to keep going, or undefined to stop. */
  onStop?: (messages: Message[]) => Promise<string | undefined> | string | undefined;
  /** Persist each new message as it is finalized. */
  onMessage?: (m: Message) => void | Promise<void>;
}

export interface AgentConfig {
  model: Model;
  apiKey?: string;
  systemPrompt: string;
  tools: Tool[];
  thinking?: ThinkingLevel;
  maxTurns?: number;
  cwd: string;
  sessionId: string;
  depth?: number;
  hooks?: AgentHooks;
  /** Shared state map for tools (survives across prompts). */
  state?: Map<string, unknown>;
  maxTokens?: number;
}
