# Research: pi (earendil-works/pi) — "minimal extensible agent harness"

Source: `/Users/rudycelekli/Downloads/rcode/reference/pi` (MIT). All paths below are relative to that root unless absolute.
Studied: `packages/ai`, `packages/agent`, `packages/coding-agent`, `packages/tui`, docs under `packages/coding-agent/docs/`, root `AGENTS.md`.
Purpose: inform the design of **rcode** (TypeScript/Bun, open source).

---

## 0. TL;DR

pi is a layered monorepo: a **provider-neutral LLM library** (`pi-ai`), a **~960-line agent loop** (`pi-agent-core`), a
**coding-agent product** (`pi-coding-agent`: sessions, tools, extensions, modes) and a **standalone differential-rendering TUI**
(`pi-tui`). Its most distinctive ideas:

1. **The transcript is the source of truth for prompt + tools.** System prompt and tool loadout are carried as `SystemMessage`s
   *inside* the message list (with named `sections` patches and `toolsAdded`/`toolsRemoved` deltas). Replaying them yields current
   state; providers that support mid-conversation system messages get cache-friendly in-place updates.
2. **Sessions are append-only JSONL trees** (`id`/`parentId`); branches, compaction, context edits and summaries are all just entries.
   Model context is a *projection* rebuilt from the session manager before every request.
3. **Everything is an extension hook**: ~30 typed events with gate/transform/notify semantics, including raw provider payload,
   headers, stream events, `context` rewriting, `turn_end` continuation, tool blocking and result rewriting.
4. **Tiny default tool set** (read, bash, edit, write; optional grep/find/ls/powershell) with carefully engineered truncation,
   fuzzy edit matching, per-file mutation queues and pluggable "operations" for remote execution.
5. **Same AgentSession behind every mode** (TUI, print, JSONL event stream, JSONL RPC, in-process SDK).

---

## 1. Architecture

### 1.1 Package layout

| Package | Path | Role | Size (src .ts files) |
|---|---|---|---|
| `@earendil-works/pi-ai` | `packages/ai` | Unified LLM API: providers, wire-protocol adapters ("APIs"), model catalog, auth/OAuth, streaming events, cost | 209 |
| `@earendil-works/pi-agent-core` | `packages/agent` | Generic agent loop + stateful `Agent` class with steering/follow-up queues | 6 |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | The `pi` CLI: AgentSession, SessionManager, tools, extensions, skills, compaction, modes | 263 |
| `@earendil-works/pi-tui` | `packages/tui` | Terminal UI framework: differential renderer, editor, markdown, keys | 46 |
| `pi-schema` | `packages/schema` | JSON-Schema builders + eval-free validator (closures) | 43 |
| `pi-codemode` | `packages/codemode` | QuickJS/WASM sandbox where model-written JS calls tools | 17 |
| `pi-mcp` | `packages/mcp` | Standalone MCP client (stdio + Streamable HTTP), no official SDK | 28 |
| `pi-durable` | `packages/durable` | Experimental crash-resumable harness (commit-before-show) | 100 |
| `pi-env` | `packages/env` | Remote execution env (Rust daemon over SSH) for durable | 9 |
| `chord` | `packages/chord` | Multi-process object/plugin runtime (v2 in progress) | 293 |
| `pi-telemetry`, `evals` | | Telemetry contracts; vitest-evals behavioral evals | |

Dependency direction: `ai` <- `agent` <- `coding-agent` -> `tui`. `ai` has no knowledge of tools-as-code; `agent` has no knowledge of
files/sessions; `coding-agent` owns persistence and product policy. This separation is clean and worth copying verbatim.

Inside `packages/coding-agent/src`:
- `core/agent-session.ts` (4565 lines) — the orchestrator: wires Agent hooks to SessionManager, extensions, compaction, retry, model runtime.
- `core/agent-session-runtime.ts` — replaces the active AgentSession on new/resume/fork/switch.
- `core/session-manager.ts` (2029) — JSONL tree storage and context projection.
- `core/extensions/{types,runner,loader}.ts` — extension API (types.ts is 2353 lines).
- `core/tools/*` — built-in tools.
- `core/compaction/*` — compaction and branch summarization.
- `core/system-prompt.ts`, `core/resource-loader.ts`, `core/skills.ts`, `core/prompt-templates.ts`.
- `modes/interactive/interactive-mode.ts` (7264), `modes/print-mode.ts`, `modes/rpc/*`, `core/sdk.ts`.
- `extensions/{codemode,tool-search,mcp,llama}` — built-in extensions shipped with the CLI (loaded as `builtin:<name>`).

### 1.2 Message types (agent level)

`packages/agent/src/types.ts` defines `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`. Apps extend the
union via **declaration merging**. The coding agent adds (`packages/coding-agent/src/core/messages.ts`):
`bashExecution` (user `!cmd` output), `custom` (extension-injected), `branchSummary`, `compactionSummary`. A single
`convertToLlm()` maps these into `user` messages with prefixes like
`"The conversation history before this point was compacted into the following summary:\n\n<summary>..."`.

### 1.3 The agent loop (`packages/agent/src/agent-loop.ts`)

Entry points: `agentLoop(prompts, context, config, signal, streamFn)` and `agentLoopContinue(...)` (retry from a context whose last
message is user/toolResult). Both return an `EventStream<AgentEvent, AgentMessage[]>` (async iterable + `result()` promise).

Control flow of `runLoop`:

```
pending = getSteeringMessages()               // user typed while waiting
outer: while (true)
  inner: while (hasMoreToolCalls || pending.length)
     if (lastCompletedTurn) {                 // not the first turn
        snapshot = prepareNextTurn(lastTurn)  // compaction, prompt/tool refresh (may replace context/model/thinking)
        if (!pending.length) pending = getSteeringMessages()  // catch-up poll after slow prep
        emit turn_start
     }
     for m in declareToolChanges(context, [...prepared, ...pending]): emit message_start/end; push
     update = prepareRequest({context, model, thinkingLevel})  // called before EVERY request
     msg = streamAssistantResponse(...)       // transformContext -> convertToLlm -> normalizeContext -> streamFn
     if msg.stopReason in (error, aborted): finishTurn; emit turn_end, agent_end; return   // hard exit
     toolCalls = msg.content.filter(toolCall)
     if toolCalls:
        batch = msg.stopReason == "length" ? failToolCallsFromTruncatedMessage(...)  // never run truncated args
                                           : executeToolCalls(...)
        hasMoreToolCalls = !batch.terminate
     decision = finishTurn(turn)              // {action:"end"} | {action:"continue"} | undefined
     emit turn_end
     if decision.end: emit agent_end; return
     pending = getSteeringMessages()
  followUps = getFollowUpMessages(); if any: pending = followUps; continue outer
  if explicitContinuation: continue outer     // one context-only turn
  break
emit agent_end
```

Key details:
- **Tool declaration diffing** (`declareToolChanges`): `context.tools` = what the runtime *can execute*; system messages in the
  transcript declare what the model *may call*. Before each request the diff becomes a `SystemMessage` with `toolsAdded/toolsRemoved`,
  inserted before the first non-system pending message. Changing tools mid-session never rewrites history.
- **Truncated output safety**: if `stopReason === "length"`, every tool call in the message is failed with
  `"...the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call..."` because the streaming
  JSON salvage parser could produce args that validate but are incomplete.
- **Streaming**: on provider `start` the partial assistant message is pushed into `context.messages` and replaced in-place on every
  delta (`message_update` carries both the raw `AssistantMessageEvent` and a shallow copy of the partial). On `done`/`error` the final
  message replaces the partial and `message_end` fires.
- **Tool execution** (`executeToolCalls`): default **parallel**. Preparation is sequential (find tool -> `prepareArguments` shim ->
  `validateToolArguments` against JSON schema -> `beforeToolCall` hook which may `{block, reason, terminate}`); then allowed calls run
  concurrently. `tool_execution_end` fires in completion order, but tool-result *messages* are emitted in assistant source order
  (deterministic transcript). Any tool with `executionMode: "sequential"` forces the whole batch sequential.
- **Early termination**: a batch terminates the run only if *every* finalized result sets `terminate: true` (used for structured-output
  "final answer" tools).
- **Errors never throw out of the loop**: unknown tool, validation error, blocked call, thrown error -> `isError: true` tool result.
  `afterToolCall` can override `content/details/isError/usage/terminate/structuredContent` field-by-field (no deep merge).
- **Partial updates**: tools get `onUpdate(partial)`; updates after the tool promise settles are dropped (`acceptingUpdates` flag);
  updates are awaited before `tool_execution_end` so ordering is consistent.
- `runToolCall()` is exported so tools that call other tools (codemode) go through the same validate/hook pipeline (permission hooks
  apply to nested calls).

### 1.4 The stateful `Agent` (`packages/agent/src/agent.ts`, 623 lines)

- Holds `AgentState` (model, thinkingLevel, tools, messages, `isStreaming`, `streamingMessage`, `pendingToolCalls`, `errorMessage`).
- `prompt()` throws if already running: callers must use `steer(msg)` (inject after current turn's tool calls) or `followUp(msg)`
  (inject when the agent would otherwise stop). Each queue has `QueueMode = "all" | "one-at-a-time"` (default one-at-a-time).
- **Abort**: one `AbortController` per run (`runWithLifecycle`); `abort()` aborts it; the signal flows to the stream function, to
  `beforeToolCall/afterToolCall`, and to each tool's `execute`. Sequential batches stop after the current tool; parallel thunks
  check `signal.aborted` before starting and return `"Operation aborted"` results. If the executor throws, `handleRunFailure`
  synthesizes an assistant message with `stopReason: "aborted" | "error"` and emits the normal tail of events, so listeners always see a
  well-formed sequence.
- Listeners are **awaited** in order (`processEvents`), so persistence listeners can't fall behind the loop; the run is idle only after
  `agent_end` listeners settle.
- `proxy.ts`: a stream function for routing LLM calls through a server, with a bandwidth-reduced event protocol (no `partial` field).

---

## 2. Provider abstraction (`packages/ai`)

### 2.1 Three concepts

- **API** (wire protocol) = a module under `src/api/` exporting `stream` and `streamSimple`
  (`KnownApi`: `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`,
  `bedrock-converse-stream`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `pi-messages`).
- **Provider** = runtime unit owning catalog + auth + dispatch (`src/providers/*.ts`, ~45 of them: anthropic, openai, google, groq,
  openrouter, bedrock, copilot, xai, deepseek, mistral, cerebras, together, fireworks, zai, moonshot, qwen, xiaomi, ...). Most
  OpenAI-compatible vendors share `openai-completions` with per-model `compat` overrides.
- **Models** collection (`src/models.ts`) = registry of providers; resolves auth, merges headers, normalizes context, dispatches.

```ts
// packages/ai/src/models.ts
export interface Provider<TApi extends Api = Api> {
  readonly id: string; readonly name: string;
  readonly baseUrl?: string; readonly headers?: ProviderHeaders;
  readonly auth: ProviderAuth;                         // apiKey and/or oauth
  getModels(): readonly Model<TApi>[];                 // sync, last-known
  getAllModels?(): readonly ProviderModel<TApi>[];     // chat | image | classifier
  refreshModels?(context: RefreshModelsContext): Promise<void>;  // dynamic providers (llama.cpp, OpenRouter)
  filterModels?(models, credential): readonly Model<TApi>[];
  stream<T extends TApi>(model: Model<T>, context: TranscriptContext, ...): AssistantMessageEventStream;
  ...
}
```

Lazy loading: provider factories import only their catalog plus a `lazyApi()` wrapper (`src/api/*.lazy.ts`); the heavy SDK
(`@anthropic-ai/sdk`, `openai`, `@google/genai`, AWS) is dynamically imported on first request. `builtinModels()` from
`@earendil-works/pi-ai/providers/all` registers everything.

The catalog is **generated** (`packages/ai/catalog/` definitions -> `src/models.generated.ts`), never hand-edited.

### 2.2 Core types (abridged quotes from `packages/ai/src/types.ts`)

```ts
export interface TextContent { type: "text"; text: string; textSignature?: string }
export interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface ImageContent { type: "image"; data: string /* base64 */; mimeType: string }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: JsonObject;
  thoughtSignature?: string /* Google */; namespace?: string; argumentsError?: string /* invalid JSON from model */ }

export interface SystemMessage { role: "system"; content: string | TextContent[];
  sections?: Record<string, string | null>;  // named prompt sections; later messages patch by name, null removes
  toolsAdded?: Tool[]; toolsRemoved?: ToolReference[]; timestamp: number }
export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
export interface AssistantMessage { role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: ProviderId; model: string; responseModel?: string; responseId?: string;
  providerThinkingLevel?: string; thinkingLevel?: ModelThinkingLevel; diagnostics?: ...;
  usage: Usage; stopReason: StopReason; deferred?: DeferredHandle; errorMessage?: string;
  timestamp: number; durationMs?: number }
type ToolResultMessage = { role: "toolResult"; toolCallId; toolName; content: (TextContent|ImageContent)[];
  details?: JsonRepresentation<TDetails> /* UI-only */; usage?: Usage; nestedCalls?: NestedToolCalls;
  isError: boolean; timestamp: number; durationMs?: number }

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number; reasoning?: number /* subset of output */; totalTokens: number;
  cost: { input; output; cacheRead; cacheWrite; total; totalFromProvider?: boolean } }

export interface Tool<TParameters extends object = object> { name: string; description: string;
  parameters: TParameters /* JSON Schema */; constrainedSampling?: false | ConstrainedSamplingConfig }

export interface Model<TApi extends Api> extends BaseModel<TApi> { reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap; promptCache?: ModelPromptCache; contextWindow: number; maxTokens: number;
  samplingParams?; samplingParamsByThinkingLevel?; compat?: /* per-API compat flags */ }
```

Notable: `Context { systemPrompt?, messages, tools? }` is only accepted at the public edge. `normalizeContext()` folds prompt and
tools into a leading system message and produces a **branded** `TranscriptContext` so raw contexts cannot reach provider code.

### 2.3 Streaming event protocol

```ts
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial }
  | { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

Contract (documented on `StreamFunction`): once a stream is returned, **failures must be encoded in the stream** as a final
assistant message with `stopReason: "error" | "aborted"` and `errorMessage`; nothing throws/rejects. `partial` is a shared live object
(not a snapshot). `EventStream` (`src/utils/event-stream.ts`) is a tiny push-queue async iterator (two-stack FIFO) with a
`result()` promise; `AssistantMessageEventStream` additionally stamps `durationMs` with a monotonic clock.
Tool-call args stream as JSON text deltas parsed by `parseStreamingJson()` / `repairJson()` (`src/utils/json-parse.ts`,
`streaming-json.ts`) so UIs can render partial arguments.

### 2.4 Token and cost accounting

`calculateCost(model, usage)` in `src/models.ts`: catalog per-million rates, **tiered pricing** (`cost.tiers[].inputTokensAbove`
selected by total input incl. cache), Anthropic 1h cache writes at 2x base input (`cacheWrite1h`). OpenRouter uses provider-billed
cost when present (`totalFromProvider: true`). Tool results can carry their own `usage` (nested LLM calls) which is added to session
totals but not to context accounting. `calculateContextTokens(usage)` (`utils/estimate.ts`) drives auto-compaction.
`utils/overflow.ts` has a regex catalog of context-overflow errors across ~25 providers (plus silent-overflow heuristics, e.g. Xiaomi
returning `length` with 0 output) — reusable as-is.

### 2.5 Thinking / reasoning

Unified levels: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Each model has `thinkingLevelMap` mapping pi
levels to provider values (`null` = unsupported). `getSupportedThinkingLevels()` and `clampThinkingLevel()` (search upward, then
downward) handle model switches. `streamSimple(..., { reasoning })` is the provider-neutral entry; `stream()` accepts each API's full
native options (Anthropic `thinkingEnabled/thinkingBudgetTokens/effort`, OpenAI `reasoningEffort/reasoningSummary`, Google
`thinking.budgetTokens`). Anthropic adapter supports adaptive thinking (`thinking: {type:"adaptive"}` + effort), budget thinking,
redacted thinking replay (`redacted_thinking`), interleaved-thinking beta, and mid-conversation effort markers.

**Cross-provider handoff** (`src/api/transform-messages.ts`): same provider+API+model keeps thinking blocks/signatures; different model
drops thinking (signatures are model-bound; plain-text thinking would be read as reply). Also: tool-call ID normalization per provider,
images downgraded to placeholders for non-vision models, images split out of error tool results for Anthropic/Bedrock, errored/aborted
assistant messages skipped entirely, and **synthetic "No result provided" tool results inserted for orphaned tool calls** (e.g. user
interrupted mid-tool).

### 2.6 Prompt caching

- `StreamOptions.cacheRetention: "none" | "short" | "long"` (default short) + `sessionId`.
- Anthropic (`api/anthropic-messages.ts` `getCacheControl`/`buildParams`): `cache_control: {type:"ephemeral", ttl?: "1h"}` on the system
  block, the **last tool definition**, and the **last user/system message block** (rolling breakpoint). Summarization calls disable
  cache writes.
- OpenAI completions/responses/codex: `prompt_cache_key = sessionId`, `prompt_cache_retention: "24h"` for long.
- Cache-preserving tool changes: models with `supportsMidConvoSystemMessages` + `supportsMidConvoToolChanges` get Anthropic
  `inline-tools` beta blocks (`tool_addition`/`tool_removal`) so the top-level tool list never changes; OpenAI Responses uses
  `additional_tools` items. Everyone else gets `collapseSystemMessages()` (prompt re-flattened into one leading message).
- `coding-agent/src/core/cache-warmer.ts`: **idle cache warming** — re-sends the prefix at ~90% of TTL only when expected savings
  >= $0.05 (with a measured 15% idle-continuation probability). Records `usage` entries of kind `cache_warm`.

### 2.7 Auth and OAuth

`src/auth/types.ts`: `Credential = ApiKeyCredential | OAuthCredential` (one per provider). `CredentialStore` has a single serialized
write path `modify(providerId, fn)` so concurrent OAuth refreshes cannot double-rotate a token (file lock cross-process in the CLI's
`AuthStorage`). Resolution order: provider auth headers -> `model.headers` -> request `headers` -> `transformHeaders` (Models-only).
OAuth flows in `src/auth/oauth/`: anthropic (Claude Pro/Max — note adapter injects `"You are Claude Code, Anthropic's official CLI for
Claude."` as the first system block for OAuth tokens), openai-codex / chatgpt, github-copilot (device code), xai, kimi, meta,
openrouter, radius; PKCE and localhost callback server helpers. `AuthPrompt` union (`text | secret | select | manual_code`) lets each
UI (TUI, RPC) render login. `getApiKey` on the agent is re-resolved per request for short-lived tokens.

Testing: `providers/faux.ts` (`fauxProvider`, `fauxAssistantMessage`, `fauxToolCall`, `setResponses`) — scripted provider used by the
coding-agent test harness (`test/suite/harness.ts`). No real API calls in tests.

---

## 3. Tools (`packages/coding-agent/src/core/tools/`)

Default active set: **read, bash, edit, write** (`createCodingTools`). Also registered: **grep, find, ls** (read-only set) and
**powershell** (Windows). Built-in extensions add **codemode**, **tool_search**, MCP tools and llama.cpp management.

Every tool is a `ToolDefinition` (extension type) wrapped into an `AgentTool` by `tool-definition-wrapper.ts`, with:
`promptSnippet` (one line in the system prompt tool list), `promptGuidelines` (bullets merged into the rules section),
`prepareArguments` (compat shim before validation), `constrainedSampling`, `outputSchema`/`structuredContent` (for codemode),
`renderCall/renderResult/renderShell` (TUI), and a pluggable **`*Operations` interface** (readFile/writeFile/exec...) so the same tool can
run over SSH/containers.

| Tool | Schema | Notable implementation |
|---|---|---|
| `read` | `{path, offset?, limit?}` (1-indexed) | Text truncated to **2000 lines or 50KB** (`truncate.ts` `DEFAULT_MAX_LINES/BYTES`) via `truncateHead`. Streams large files in chunks keeping only displayable lines. Actionable notices: `[Showing lines 1-2000 of 9000. Use offset=2001 to continue.]`; single line > 50KB -> tells model to use `sed -n 'Np' file \| head -c 51200`. Images (jpg/png/gif/webp/bmp) returned as image blocks, auto-resized per model `inputLimits`, EXIF orientation fixed; placeholder text if model lacks vision. `structuredContent` = text or image for scripts. |
| `bash` | `{command, timeout?}` (seconds, no default timeout) | Spawns `shell -c` **detached** (process group) so abort/timeout `killProcessTree`s everything; tracks detached PIDs to kill on exit. `OutputAccumulator` streams with a UTF-8 decoder, keeps a bounded rolling tail, and spills full output to a temp file when truncated (**tail** truncation, 2000 lines/50KB): `[Showing lines X-Y of Z. Full output: /tmp/...]`. Throttled `onUpdate` for live output. Distinguishes "shell exited but background children kept pipes open" on timeout (#11613). Options: `commandPrefix` (e.g. `shopt -s expand_aliases`), `spawnHook` (rewrite cmd/cwd/env), exposes `PI_*` env vars (model, session). Non-zero exit -> error result. |
| `edit` | `{path, edits: [{oldText, newText}]}` | Multi-edit in one call; every `oldText` matched against the **original** file (not incrementally); must be unique and non-overlapping, else specific errors (`Found 3 occurrences of edits[1]... provide more context`, `edits[0] and edits[2] overlap... merge them`). Matching: exact first, then **fuzzy** (`normalizeForFuzzyMatch`: NFKC, strip trailing whitespace per line, smart quotes -> ASCII, Unicode dashes -> `-`, exotic spaces -> space). Fuzzy matches are widened to whole lines and applied to the original so untouched lines keep bytes. BOM stripped and restored; CRLF preserved by splicing replacements into the original (`applyReplacementsToOriginal`). Diff computed **before** write. `prepareArguments` accepts edits as a JSON string, a single object, or legacy top-level `oldText/newText` (models like Opus 4.6/GLM-5.1 do this). Returns `details: {diff, patch, firstChangedLine}`. `constrainedSampling: {type:"json_schema", strict:"prefer"}`. |
| `write` | `{path, content}` | `mkdir -p` parent then write. |
| `grep` | `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?=100}` | Runs **ripgrep** with `--json --no-config` (tool contract must not depend on user rg config), strips leading `./` from globs, lines truncated to 500 chars, 50KB cap. |
| `find` | `{pattern, path?, limit?=1000}` | Runs **fd**; fetches `limit+1` results to tell "exactly N" from "more than N" (#7121); git-aware ignore handling (`--no-require-git` outside repos). |
| `ls` | `{path?, limit?=500}` | Sorted, `/` suffix for dirs, dotfiles included, notice `Use limit=1000 for more`. |
| `powershell` | like bash | Shares `createLocalShellOperations`. |

Cross-cutting tricks:
- **`withFileMutationQueue(path, fn)`** (`file-mutation-queue.ts`): per-realpath promise chain so parallel tool calls touching the same
  file serialize while different files run concurrently. Abort is checked after each await rather than rejecting from an abort listener
  (which would release the lock while I/O is in flight).
- **`ensureTool("rg" | "fd")`** (`utils/tools-manager.ts`) downloads binaries from GitHub releases if missing.
- Every truncation message tells the model **exactly how to continue** (offset, limit, temp file path).
- Tool results are normalized for images after extension hooks (`normalizeToolResultImages`).
- **Tool exposure** model: `direct | model-only | codemode | deferred | hidden`, plus `namespace`, MCP-style `annotations`
  (`readOnlyHint`, `destructiveHint`...), `reachesTools(input)` and `prepareLoadout()` (lets an orchestrator tool hide declarations of
  tools it fronts). `tool_search` (BM25) activates deferred tools on demand; `codemode` runs model-written JS in QuickJS where
  `tools.<name>(args)` calls tools through the same hook pipeline (nested calls get IDs `<parent>/<n>`, recorded as bounded
  `nestedCalls` on the parent result, never as transcript entries).

---

## 4. Session model

### 4.1 Storage

- Path: `~/.pi/agent/sessions/--<cwd-with-separators-replaced>--/<timestamp>_<uuid>.jsonl`.
- **JSONL, append-only, tree-structured** (`docs/session-format.md`, `src/core/session-manager.ts`). Version 3 (v1 linear and v2 auto-
  migrated on load).
- Line 1: header `{"type":"session","version":3,"id","timestamp","cwd","parentSession?"}`.
- Every other entry: `{type, id (8-hex), parentId, timestamp(ISO)}` plus payload. Entry types:
  `message` (any AgentMessage incl. system messages carrying prompt sections/tool deltas), `model_change`, `thinking_level_change`,
  `usage` (non-context spend, e.g. `cache_warm`), `compaction` (`summary`, `firstKeptEntryId`, `tokensBefore`, `systemMessage`
  checkpoint, `usage`, `details: {readFiles, modifiedFiles}`), `context_edit` (`targetId`, `replacement | null` — branch-relative,
  non-destructive edit/omission of an earlier entry's model-visible content), `branch_summary` (`fromId`, `summary`), `custom`
  (extension state, not in context), `custom_message` (extension message, in context, `display` flag), `label` (bookmark),
  `session_info` (name).
- Lazy file creation: nothing hits disk until the first user/assistant message (`_hasConversation`), then the buffered entries are
  written with `openSync(..., "wx")` and later entries are `appendFileSync`. On write failure the in-memory append is rolled back so no
  entry can point to a missing parent.
- **Leaf** = current position. On load, leaf = last entry in the file (`_buildIndex`). `branch(id)` moves the leaf; the next append
  becomes a child -> in-place branching without new files. `resetLeaf()` allows a new root (re-editing the first message).

### 4.2 Context building (projection)

`buildContextEntries()` walks leaf -> root; with the latest `compaction` on the path it emits: compaction entry, non-system entries from
`firstKeptEntryId` to the compaction, then everything after. `buildSessionProjection()` applies the latest `context_edit` per target.
`buildSessionContext()` converts entries to messages (compaction -> system checkpoint + `compactionSummary`; branch_summary ->
`branchSummary`; custom_message -> `custom`; usage/custom/context_edit -> nothing).
In `AgentSession._installAgentRequestProjection` the agent's `prepareRequest` hook **replaces the context with the session projection
before every provider request** — SessionManager, not the in-memory agent array, is authoritative.

### 4.3 Compaction (`src/core/compaction/compaction.ts`, docs/compaction.md)

- Trigger: `contextTokens > contextWindow - reserveTokens` (default reserve 16384). Checked after tool results are appended and before
  the next assistant response (`prepareNextTurn`), before new user prompts, and as **overflow recovery**: a provider overflow error or
  early `length` stop selects one compact-and-retry (the failed attempt is omitted via `context_edit`, not deleted).
- Cut point: walk back accumulating estimated tokens until `keepRecentTokens` (default 20k). Valid cuts: user, assistant,
  bashExecution, custom messages — never at a tool result. If a single user-message span exceeds the budget, it's a "split turn": two
  summaries (history + turn prefix) are generated and merged.
- Summarization: serialize messages to text inside `<conversation>` (so the model doesn't continue it), structured template
  (`## Goal / ## Constraints & Preferences / ## Progress (Done/In Progress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical
  Context`), iterative update mode with `<previous-summary>` ("PRESERVE all existing information..."). `/compact [instructions]`
  appends "Additional focus". A `length` stop is rejected (partial summary must not become a checkpoint). Uses the session retry policy.
  Cumulative read/modified file lists tracked in `details`.
- Extensions: `session_before_compact` can cancel or supply their own summary; `session_compact`/`session_compact_failed` notify.

### 4.4 Resume, fork, clone, tree

- `-c/--continue` -> `SessionManager.continueRecent(cwd)`; `/resume` (fuzzy session selector with search, rename, delete via `trash`);
  `--session <id>`; `/import <jsonl>`.
- `/tree` (`components/tree-selector.ts`, 1439 lines): navigate any entry in the tree with filters (no-tools, user-only, labeled);
  moving away offers an LLM **branch summary** of the abandoned path (from old leaf back to common ancestor), appended as a
  `branch_summary` entry at the new position.
- `/fork`: new session file from an earlier user message (`createBranchedSession(leafId)` copies only the root->leaf path, re-chaining
  around label entries); header records `parentSession`. `/clone`: duplicate at current position.
- `AgentSessionRuntime` replaces the whole AgentSession (and re-runs project trust if cwd changes) on new/resume/fork/switch;
  extension contexts captured before replacement are invalidated with an explicit error message.
- Export: `/export` HTML (ANSI-to-HTML renderer, tool renderers) or JSONL; `/share` uploads.

---

## 5. Extensibility

### 5.1 Extensions

TypeScript modules loaded **in-process with jiti** (`core/extensions/loader.ts`; virtual modules in compiled/Bun binaries), so `.ts`
works without a build step. Default export: `export default function (pi: ExtensionAPI) {...}` (may be async).

Locations: `~/.pi/agent/extensions/*.ts|*/index.ts|*/package.json{pi.extensions}`, project `.pi/extensions/...` (only after project
trust), `settings.json` `extensions: [...]`, packages, `-e <path|npm:|git:>` for one run, `builtin:<name>`.

`ExtensionAPI` methods (docs/extensions.md "ExtensionAPI Methods"): `on(event, handler)`, `registerTool`, `registerCommand`,
`registerShortcut`, `registerFlag`, `registerProvider/unregisterProvider`, `registerVirtualModel` (model routers), `registerMcpServer`,
`registerMessageRenderer`, `registerEntryRenderer`, `registerToolRenderer`, `registerMarkdownTransformer`, `sendMessage` (custom message,
optional trigger), `sendUserMessage`, `appendEntry` (persist state), `setSessionName`, `setLabel`, `exec`, `get/setActiveTools`,
`getAllTools`, `setModel`, `get/setThinkingLevel`, `events` (inter-extension bus), `getCommands`, `getSettings`.

`ExtensionContext` (`ctx`): `ui` (select/confirm/input/editor/notify/setStatus/setWidget/setFooter/setHeader/setTitle/setEditorText/
pasteToEditor/addAutocompleteProvider/setEditorComponent/custom(...) full-screen components/theme APIs/onTerminalInput), `mode`, `hasUI`,
`cwd`, `isProjectTrusted()`, `sessionManager`, `modelRegistry`, `model`, `thinkingLevel`, `signal`, `isIdle/abort/hasPendingMessages`,
`shutdown`, `getContextUsage`, `compact`, `getSystemPrompt`, `executeTool`, `tools`. Command contexts add `newSession`, `fork`,
`navigateTree`, `switchSession`, `reload`, `waitForIdle`, `getSystemPromptOptions`.

**Events** (`ExtensionEvent` union in `core/extensions/types.ts:1426`):

| Group | Events | Can do |
|---|---|---|
| Startup/resources | `project_trust`, `resources_discover`, `mcp_servers_change` | decide trust, add resource paths |
| Session | `session_start{reason}`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_before_tree`, `session_tree`, `session_shutdown{reason}` | cancel switch/fork/compact/tree; supply custom summaries |
| Input | `input` | intercept, transform, or fully handle user text |
| Agent | `before_agent_start` (mutate `systemPromptOptions`, inject a custom message, or replace the whole system prompt), `agent_start`, `agent_end`, `agent_before_settle` (append entries + request continuation), `agent_settled`, `ui_prompt_start/end` | |
| Turn | `turn_start`, `turn_end` (append entries, request continuation) | |
| Message | `message_start`, `message_update`, `message_end` (replace finalized message, same role) | |
| Request | `context` (rewrite AgentMessage[]), `context_with_system` (rewrite full transcript), `before_provider_headers` (mutate), `before_provider_request` (inspect/replace raw payload), `after_provider_response` (status+headers), `provider_stream_event` (raw parsed events), `cache_warming_decision` | |
| Tools | `tool_call` (block `{block, reason, terminate}` or mutate `event.input` in place), `tool_execution_start/update/end`, `tool_result` (replace content/details/isError/usage/structuredContent) | |
| Model | `model_select`, `thinking_level_select` | |
| User shell | `user_bash` (supply custom operations or full result for `!cmd`) | |

Handler composition (docs/extensions.md "Handler Composition"): load order then registration order; patterns are *notification*,
*in-place mutation*, *chained transformation* (each handler gets the previous return), *gate* (first block wins), *actionable
boundary* (`turn_end`/`agent_before_settle` see proposed entries), *last override* (cache warming).

Lifecycle distinction worth copying: `agent_end` closes one low-level run; retries, overflow recovery, compaction retries, and queued
messages can start more; **`agent_settled`** is the true idle signal.

Example permission gate from the docs (Codex-like approval using MCP annotations):
```ts
pi.on("tool_call", async (event, ctx) => {
  const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
  const needsApproval = hints?.destructiveHint === true ||
    (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
  if (needsApproval && !(await ctx.ui.confirm("Allow tool call?", event.toolName)))
    return { block: true, reason: `${event.toolName} was not approved` };
});
```

### 5.2 Skills (`core/skills.ts`, docs/skills.md)

Implements the Agent Skills spec: directories with `SKILL.md` (frontmatter `name`, `description`, `license`, `compatibility`,
`metadata`, `allowed-tools`, `disable-model-invocation`). Discovered recursively from `~/.pi/agent/skills`, `.pi/skills`,
`~/.agents/skills`, and project `.agents/skills` up to the repo root. Only name/description/location go into the prompt
(`formatSkillsForPrompt`, `<available_skills><skill><name/><description/><location/></skill>...`), with the instruction "Use the read
tool to load a skill's file when the task matches its description. Resolve relative paths against the skill's directory". `/skill:name
args` force-loads the skill and appends args. Name collisions: first wins with a warning.

### 5.3 Prompt templates (`core/prompt-templates.ts`)

`~/.pi/agent/prompts/*.md` and `.pi/prompts/*.md` -> `/name` commands. Frontmatter `description`, `argument-hint`. Substitutions:
`$1`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:-default}`, `${@:N}`, `${@:N:L}`; shell-like quoting rules. Expanded before the text
becomes a user message (extensions see raw input first via `input`).

### 5.4 Themes

JSON themes (`modes/interactive/theme/`). Default `system` theme **derives colors from the terminal's reported fg/bg and 16 ANSI
colors** (OSC 10/11/4 queries, 100ms wait) with OKLCH lightness adjusted for WCAG 4.5:1 contrast, and rebuilds on light/dark change.
`"theme": "light/dark"` auto-switches. Color math in `tui/src/oklab.ts`, `colors.ts`.

### 5.5 Packages (`core/package-manager.ts`, 2967 lines)

`pi install npm:@x/y@1.0.0 | git:github.com/u/r@v1 | ./local`. Conventional dirs `extensions/ skills/ prompts/ themes/` or a `pi`
manifest in package.json (globs). Pinned versions, git ref reconciliation, per-package changelog display after updates, `-e` cache
under `~/.pi/agent/tmp/extensions/`, failures are non-fatal at startup. Gallery discovery via `pi-package` keyword.
Supply-chain hygiene: an `install-lock/` with an allowlist of deps permitted to run lifecycle scripts; installs use `--ignore-scripts`.

### 5.6 Trust

`core/trust-manager.ts`: project resources (`.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`,
`.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, project `.agents/skills`) load only after a trust decision. Explicitly **not** a sandbox:
tools run with full user permissions and there are no per-call approvals by default (docs/security.md recommends containers).

---

## 6. Modes and protocols

All modes construct an `AgentSessionRuntime` (`core/agent-session-runtime.ts`) and talk to the same `AgentSession`.

- **Interactive** (`modes/interactive/interactive-mode.ts`): TUI. Enter while streaming = **steer**, Alt+Enter = **follow-up**
  (Ctrl+Q on Windows), Escape = abort (queued messages return to the editor), `!cmd` / `!!cmd` (excluded from context) user shell,
  `@` fuzzy file reference, Ctrl+L model selector, Ctrl+P cycle model, Ctrl+O expand tool output, image paste, external editor.
  Slash commands: `/settings /model /thinking /scoped-models /login /logout /new /resume /name /session /tree /fork /clone /compact
  /import /copy /export /share /bug /trust /mcp /reload /hotkeys /changelog /quit` + extension commands, templates, skills.
- **Print** (`modes/print-mode.ts`): `pi -p "prompt"` prints final text; `pi --mode json "prompt"` streams events as JSONL (first line
  is the session header). Handles SIGTERM/SIGHUP with graceful dispose, kills tracked detached children, respects stdout backpressure.
- **JSON event shape** (docs/json.md): `agent_start`, `turn_start`, `message_start/update/end`, `tool_execution_*`, `turn_end`,
  `agent_end{messages, willRetry}`, `agent_settled{aborted}`, plus queue, compaction and retry events. Strict LF framing; docs warn
  against Node `readline` (splits on U+2028/2029).
- **RPC** (`modes/rpc/rpc-mode.ts`, `rpc-types.ts`, `rpc-client.ts`): long-lived `pi --mode rpc`. stdin commands
  `{id?, type: ...}`: `prompt{message, images?, streamingBehavior?: "steer"|"followUp"}`, `steer`, `follow_up`, `abort`, `clear_queue`,
  `new_session`, `get_state`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`,
  `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`,
  `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries{since?}`, `get_tree`,
  `get_last_assistant_text`, `set_session_name`, `get_messages`, `get_commands`. Responses
  `{id, type:"response", command, success, data?}`; events are the JSON-mode events. Extension UI is bridged:
  `{type:"extension_ui_request", id, method: "select"|"confirm"|"input"|"editor"|"notify"|"setStatus"|"setWidget"|"setTitle"|"set_editor_text", ...}`
  answered by `{type:"extension_ui_response", id, value | confirmed | cancelled}`. A typed `RpcClient` is exported.
- **SDK** (`core/sdk.ts`, docs/sdk.md): `const { session } = await createAgentSession({ cwd, model, thinkingLevel, sessionManager:
  SessionManager.inMemory(), settingsManager, resourceLoader, tools, customTools, ... }); session.subscribe(ev => ...); await
  session.prompt("..."); session.steer(); session.followUp(); session.abort(); session.dispose()`. `prompt()` while streaming must
  specify steer vs follow-up (rejects otherwise). 14 typechecked examples in `packages/coding-agent/examples/sdk/`.

---

## 7. TUI implementation (`packages/tui`)

- **Component model**: `interface Component { render(width): string[]; handleInput?(data); handleMouse?(ev); invalidate() }`.
  Lines must not exceed `width` (enforced). Components cache by width. The TUI appends SGR + OSC 8 reset to every line so styles never
  bleed. Built-ins: Text, TruncatedText, Input, Editor, Markdown (+LaTeX), Loader, SelectList, SettingsList, Image (Kitty/iTerm2),
  Box, Container, VStack/HStack/ScrollView, MouseRegion.
- **Two renderers behind one `TUI` interface**: `TuiMainScreen` (writes into normal scrollback; native terminal scrolling/selection)
  and `TuiAltScreen` (alternate buffer, app-owned viewport with mouse wheel, scrollbars, drag-select + OSC 52 copy, OSC 133 prompt
  jumps, search).
- **Differential rendering** (`tui-main-screen.ts doRender`): render whole tree to lines, composite overlays, find first/last changed
  line vs `previousLines`; cases: first render (just print), width change -> full clear+redraw (rewrap), height change -> full redraw
  (except Termux keyboard toggles), content shrink -> optional clear, changes only in deleted tail -> clear rows, change above viewport ->
  full redraw, otherwise move cursor to first changed line and rewrite to end. All writes wrapped in **CSI ?2026 synchronized output**
  and chunked via `BoundedTerminalWriter`. Kitty image placements are tracked and deleted when their lines change.
  `PI_TUI_DEBUG_REDRAW=1` logs every full redraw reason.
- **Render scheduling** (`tui.ts`): `requestRender()` coalesces via `process.nextTick` and throttles to **16ms min interval**; user input
  triggers an immediate render that preempts a pending throttled frame.
- **Input**: `StdinBuffer` (`stdin-buffer.ts`, adapted from OpenTUI) reassembles partial escape sequences (10ms escape timeout, 50ms
  sequence timeout), bracketed paste, terminal replies. `keys.ts` (1511 lines) parses legacy + **Kitty keyboard protocol** (negotiated in
  `terminal.ts`) into `KeyId`s; `matchesKey(data, "ctrl+shift+p")`. `keybindings.ts`: global registry extended via declaration merging,
  user-overridable; AGENTS.md forbids hardcoded key checks.
- **Editor** (`components/editor.ts`, 2483 lines): multi-line with word wrap, vertical scroll, emacs keys, kill ring + yank-pop
  (`kill-ring.ts`), undo stack, char-jump (Ctrl+]), history, slash/file autocomplete (`autocomplete.ts`, fuzzy), large paste collapsed
  to `[paste #1 +50 lines]` markers, fake cursor + IME-aware `Focusable` positioning. The coding agent wraps it as `custom-editor.ts`
  and extensions can replace it (`ctx.ui.setEditorComponent`).
- Rendering the transcript: `chat-viewport.ts`, `tui-renderer.ts`, components like `assistant-message.ts`, `tool-execution.ts`,
  `bash-execution.ts`, `diff.ts`; tool-specific renderers in `core/tools/renderers/*` (shared with HTML export).

---

## 8. System prompt and context files

Built in `packages/coding-agent/src/core/system-prompt.ts` as **ordered named sections** (become `SystemMessage.sections`; each non-
preamble section wrapped in `<name>...</name>` so later patches are recognizable):

1. `preamble`: "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and
   modify code." (replaced wholesale by `--system-prompt`/`SYSTEM.md`).
2. `tools`: `- read: Read file contents` ... from each tool's `promptSnippet` + "Additional tools may be available."
3. `rules`: deduplicated bullets: shell fallback rule if no grep/find/ls ("Use bash for file operations like ls, rg, find"), each
   tool's `promptGuidelines` (e.g. "Use read to examine files instead of cat or sed.", "Use edit for targeted changes. Batch changes to
   one file in a single call.", "Each edits[].oldText must exactly and uniquely match..."), extension guidelines, then "Be concise in
   your responses" and "Show file paths clearly when working with files".
4. `docs`: absolute paths to pi's own README/docs/examples with "read only when the user asks about the harness itself" and a topic ->
   doc map (self-documenting harness; lets the agent write its own extensions).
5. `addendum`: `APPEND_SYSTEM.md` / `--append-system-prompt`.
6. `project_context`: "Project-specific instructions and guidelines:" + `<project_instructions path="...">` per file.
7. `skills`: available skills block.
8. `cwd`.
9. Custom sections from extensions (`before_agent_start` -> `systemPromptOptions.sections`).

`diffSystemPromptSections(previous, current)` produces a minimal patch, so a skill reload or tool change appends a small system message
instead of invalidating the cached prefix.

**Context files** (`core/resource-loader.ts loadProjectContextFiles`): per directory, the first existing of
`AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD`. Order: global `~/.pi/agent/AGENTS.md` first, then every ancestor from
filesystem root down to cwd (deduped). Git-worktree aware: a nested linked worktree's own AGENTS.md shadows the main repo's copy so
the same context isn't applied twice. `SYSTEM.md`/`APPEND_SYSTEM.md` from `.pi/` (project, trusted only) or `~/.pi/agent/`.
Context files load after the trust decision.

---

## 9. Assessment

### 9.1 Strengths worth copying (ranked)

1. **Layering: ai / agent-core / product / tui as separate packages.** The loop is ~960 lines with hook points
   (`transformContext`, `convertToLlm`, `prepareRequest`, `prepareNextTurn`, `finishTurn`, `beforeToolCall`, `afterToolCall`,
   `getSteeringMessages`, `getFollowUpMessages`). Everything product-specific (compaction, persistence, virtual models) is layered via
   these hooks. Reason: testable with a faux provider, reusable for non-coding agents, and keeps the 4.5k-line orchestrator out of the loop.
2. **"Failures are data" stream contract.** Providers never throw after returning a stream; every error/abort becomes an assistant
   message with `stopReason` and `errorMessage`; tool failures become `isError` results. Reason: the UI, persistence, and retry logic
   handle one shape; no unhandled rejections in a long-running TUI.
3. **Append-only JSONL tree sessions with non-destructive edits.** Branching, compaction, recovery omissions (`context_edit`), branch
   summaries and labels are all entries; context is a projection. Reason: crash-safe-ish appends, full audit/billing history, cheap
   branching, trivially diffable/exportable. Lazy file creation avoids empty session litter.
4. **Prompt + tool loadout as transcript system messages with section patches.** Reason: cache-preserving dynamic tools/skills,
   faithful replay of what the model actually saw at each point, and clean cross-provider collapse for providers that can't do it.
5. **Steering vs follow-up queues as first-class loop concepts** (with "one-at-a-time" mode and catch-up polls after long
   preparation). Reason: users can redirect a running agent without aborting; maps directly to Enter vs Alt+Enter.
6. **Tool engineering details**: actionable truncation notices with continuation offsets and temp-file spill; tail truncation for bash,
   head for read; multi-edit with exact-then-fuzzy matching, uniqueness/overlap errors, CRLF/BOM preservation; per-file mutation
   queue enabling safe parallel tools; process-group kill; `length`-stop tool-call failure; `prepareArguments` shims for model quirks
   and old sessions; `limit+1` trick. Reason: these are the failure modes that actually burn tokens and user trust.
7. **Extension event model with explicit composition semantics** (notify / mutate / chain / gate / boundary) and the
   `agent_end` vs `agent_settled` distinction. Raw provider payload/header/stream hooks make debugging and custom routing possible
   without forking. Reason: permission systems, custom compaction, observability, and model routing all become plugins.
8. **Pluggable `*Operations` per tool** (remote FS/exec) and `spawnHook`. Reason: SSH/container/sandbox execution without rewriting tools.
9. **Mode parity with documented protocols**: strict JSONL framing guidance, typed RPC client, extension UI bridging over RPC.
   Reason: IDE integrations and non-TS hosts for free.
10. **Differential TUI with synchronized output, main-screen scrollback mode, coalesced 16ms rendering**, Kitty keyboard protocol,
    terminal-palette-derived theme with WCAG contrast. Reason: flicker-free streaming that preserves native terminal scrollback/selection.
11. **Cost/overflow knowledge bases**: tiered pricing, 1h cache write pricing, provider-billed cost, overflow regex catalog, idle
    cache warming with expected-savings threshold. Reason: directly reusable domain knowledge.
12. **Self-documenting harness**: system prompt points the model at pi's own docs/examples so it can build extensions on request.

### 9.2 Weaknesses / gaps (ranked)

1. **No permission model or sandbox by default.** Tools run with full user permissions; no approval prompts; trust only gates resource
   loading. Safety is delegated to "run it in a container" or a user-written `tool_call` extension. rcode should ship a built-in policy
   layer (read-only/ask/auto per tool, path allowlists, annotations-driven defaults) and optional OS sandboxing.
2. **Extensions run in-process with full privileges** (jiti-loaded TS). A buggy or malicious extension can crash or own the agent;
   no capability scoping or isolation. Consider worker/process isolation or capability-scoped APIs for third-party plugins.
3. **Complexity concentration**: `agent-session.ts` 4565 lines, `interactive-mode.ts` 7264, `extensions/types.ts` 2353,
   `package-manager.ts` 2967. Boundary drafts, recovery omission, virtual-model routing, nested-call runners all interleave in one class.
   Hard to reason about; ordering rules are documented in prose because they're hard to see in code.
4. **Leaf position is not persisted.** On load the leaf is the last entry in the file; navigating `/tree` without appending anything
   is lost on restart. A `leaf` pointer entry (or header update) would fix it.
5. **Durability is weak in the main CLI**: `appendFileSync` without fsync; a crash mid-turn loses the in-flight assistant message;
   durable execution exists only in the separate experimental `pi-durable` package.
6. **Token estimation is heuristic** for cut points (no tokenizer); compaction relies on provider-reported usage plus estimates.
7. **Minimal default toolset trade-offs**: no built-in web fetch/search, no todo/plan tool, no subagent/task tool, no LSP/diagnostics
   integration, no notebook support. Users must find extensions/MCP. grep/find/ls aren't active by default (model uses bash instead).
8. **Edit tool is replace-only**: no patch/diff input format, no line-range edits, no "expected file hash" staleness check (a file
   changed externally between read and edit is silently edited if the text still matches). Fuzzy normalization can apply to the wrong
   place only if unique-in-normalized-space, which is safe, but there's no indentation-insensitive matching tier.
9. **Bash has no default timeout** and no output-based interactivity detection (a command waiting on stdin hangs until abort).
10. **Heavy surface for a "minimal" harness**: ~45 providers, chord/durable/env side projects, codemode WASM, MCP, llama.cpp management.
    The core ideas are small but the repo is not; onboarding cost is high.
11. **Anthropic OAuth impersonation** (injecting the Claude Code identity string) is a fragile, ToS-sensitive dependency.
12. Node-centric runtime assumptions (`process.nextTick`, `child_process`, jiti); Bun is supported for the binary but not idiomatically.

---

## 10. The 15 most important source files

| # | File | Why read it |
|---|---|---|
| 1 | `packages/agent/src/agent-loop.ts` | The entire agent loop: turns, streaming into context, parallel/sequential tool execution, hooks, steering/follow-up, truncation safety. |
| 2 | `packages/agent/src/types.ts` | `AgentLoopConfig` hook contracts, `AgentTool`, `AgentEvent`, `AgentMessage` declaration-merging pattern. |
| 3 | `packages/agent/src/agent.ts` | Stateful `Agent`: queues, abort controller per run, awaited listeners, failure synthesis. |
| 4 | `packages/ai/src/types.ts` | Message/content/usage/stop-reason/event types, `SystemMessage` sections + tool deltas, `Model`, `StreamOptions`. |
| 5 | `packages/ai/src/models.ts` | `Provider` interface, `Models` collection, auth/header merge order, `calculateCost`, thinking-level clamping. |
| 6 | `packages/ai/src/api/anthropic-messages.ts` | Reference adapter: cache_control placement, adaptive/budget thinking, redacted thinking, inline tool changes, OAuth. |
| 7 | `packages/ai/src/api/transform-messages.ts` | Cross-provider handoff rules, orphaned tool-call repair, image downgrades. |
| 8 | `packages/ai/src/utils/event-stream.ts` | Minimal async-iterable push stream with `result()` promise and monotonic timing. |
| 9 | `packages/coding-agent/src/core/agent-session.ts` | Orchestrator: session projection per request, extension hook wiring, compaction/overflow recovery, retry, tool loadout. |
| 10 | `packages/coding-agent/src/core/session-manager.ts` | JSONL tree format, lazy persistence, branch/fork, `buildSessionContext` projection. |
| 11 | `packages/coding-agent/src/core/compaction/compaction.ts` | Cut-point selection, split-turn handling, structured summary prompts, iterative updates. |
| 12 | `packages/coding-agent/src/core/tools/edit.ts` + `edit-diff.ts` | Multi-edit, exact->fuzzy matching, uniqueness/overlap errors, line-ending/BOM preservation, diffs. |
| 13 | `packages/coding-agent/src/core/tools/bash.ts` + `output-accumulator.ts` + `truncate.ts` | Process-group spawn/kill, streaming bounded output, temp-file spill, truncation notices. |
| 14 | `packages/coding-agent/src/core/system-prompt.ts` (+ `resource-loader.ts` `loadProjectContextFiles`) | Sectioned system prompt, section diffing, AGENTS.md discovery. |
| 15 | `packages/coding-agent/src/core/extensions/types.ts` (+ `docs/extensions.md`) | Full extension API surface: events, results, ctx, tool definition/exposure. |

Honorable mentions: `packages/tui/src/tui-main-screen.ts` (differential renderer), `packages/tui/src/tui.ts` (render scheduling,
focus, overlays), `packages/tui/src/components/editor.ts`, `packages/coding-agent/src/modes/rpc/rpc-types.ts` (protocol),
`packages/coding-agent/src/core/tools/file-mutation-queue.ts`, `packages/ai/src/utils/overflow.ts`,
`packages/coding-agent/src/core/cache-warmer.ts`, `packages/coding-agent/docs/session-format.md`, `docs/compaction.md`.

---

## 11. Concrete recommendations for rcode

1. Adopt the three-layer split (`rcode-ai`, `rcode-agent`, `rcode` CLI) and pi's loop hook set nearly verbatim; keep the loop under
   1k lines and test it with a faux provider from day one.
2. Use pi's `AssistantMessageEvent` protocol and "failures are data" contract; normalize at the edge with a branded transcript type.
3. Store sessions as append-only JSONL trees, but **persist the leaf pointer** and fsync on turn boundaries; consider pi-durable's
   commit-before-show for assistant output.
4. Carry system prompt/tool loadout as sectioned system messages; diff sections to preserve the prompt cache.
5. Port the tool details (truncation notices, fuzzy multi-edit, mutation queue, process-group kill, length-stop failure) and add what
   pi lacks: default bash timeout, stale-file detection on edit (mtime/hash from last read), a todo/plan tool, and a subagent tool.
6. Ship a built-in permission layer (per-tool policies + annotations + path scopes) instead of leaving it to extensions; keep pi's
   `tool_call` gate semantics so extensions can extend it.
7. Keep the extension event taxonomy and composition table; consider running third-party extensions in a worker with a capability API.
8. Reuse pi-tui's differential-render algorithm and CSI 2026 batching; main-screen mode by default for native scrollback.
9. Split the orchestrator early (projection, compaction, retry, tool loadout as separate modules) to avoid a 4.5k-line `AgentSession`.
