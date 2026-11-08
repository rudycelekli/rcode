# oh-my-pi (omp): deep research report

Studied: `can1357/oh-my-pi` at `reference/oh-my-pi` (workspace version `18.18.1`, MIT, published by Stencil Labs).
It is a heavily extended fork of Mario Zechner's `pi-mono`. The tagline is "a coding agent with the IDE wired in".
The repo was read only; nothing in it was modified.

Paths below are relative to the repo root unless they are absolute. "Upstream pi" means `badlogic/pi-mono`
(packages `ai`, `agent`, `coding-agent`, `tui`). That baseline comes from general knowledge of pi-mono, not from a diff
inside this repo, which has no upstream git history to compare against.

---

## 0. Scale and shape at a glance

| Area | Size (approx. LOC) | Notes |
|---|---|---|
| `packages/coding-agent/src` | ~558k TS (1,547 `.ts` files, 332 `.md` prompt/doc files) | The CLI product |
| `packages/tui/src` | ~204k TS | Terminal UI library plus tool renderers |
| `packages/ai/src` | ~142k TS | Multi-provider LLM client, auth, dialects, judgment |
| `packages/catalog/src` | ~42k TS + `models.json` | Model catalog, pricing, compat rules (KDL) |
| `packages/utils/src` | ~39k TS | Logger, streams, archives (`ar`), temp files |
| `packages/agent/src` | ~22k TS | Agent loop, compaction, tokenizer, speculation |
| `crates/*` (excluding vendor) | ~720k Rust in total; README says "~80k lines of Rust core" (most of the rest is ported coreutils/findutils/sed/jq in `pi-builtins`) | N-API native addon |
| `docs/*.md` | ~30k lines across about 90 docs | Unusually thorough contributor docs, with file pointers |

Headline claims from `README.md`: 60+ providers, 31 built-in tools, 14 LSP operations, 28 DAP operations, ~80k lines of Rust core,
and a bash 5.3 engine with 46–58 in-process coreutils.

Two facts frame everything below.
1. **Almost everything is configurable, and almost every behavior has a setting, a doc and an edge-case history.**
   The cost is enormous surface area. `session/agent-session.ts` is 15,880 lines, `modes/interactive-mode.ts` is 9,970,
   `sdk.ts` is 5,981, and `config/settings.ts` is 4,371.
2. **The core idea is "benchmaxxed tools".** The tool formats (hashline edits, selector-suffixed reads, grouped grep output)
   were tuned against model benchmarks (`packages/typescript-edit-benchmark`, `src/if-bench`, `packages/metaharness`).
   README claims include Grok Code Fast 1 going from 6.7% to 68.3% on edits, and a 61% output-token drop on Grok 4 Fast.

---

## 1. Architecture

### 1.1 Package layout (TypeScript, Bun runtime)

From `AGENTS.md` and `packages/`:

| Package | npm name | Role |
|---|---|---|
| `packages/ai` | `@oh-my-pi/pi-ai` | Streaming LLM client. Provider adapters live in `src/providers/*`, including Anthropic, OpenAI Responses/Completions/Codex, Google/Vertex/Gemini CLI/Antigravity, Bedrock, Cursor, Copilot, GitLab Duo, Devin and Kimi. Auth lives in `src/auth/*` (credential pools, rotation, affinity, sqlite store), with an auth broker and gateway. Also here: textual tool-call dialects (`src/dialect/*`), the "judgment" classifier runtime (`src/judgment/*`), and embeddings, images, speech, transcription, video and rerank |
| `packages/catalog` | `@oh-my-pi/pi-catalog` | Bundled `models.json`, provider descriptors, model identity, thinking/effort mapping (`effort.ts`, `model-thinking.ts`), pricing (`pricing.ts`, including time-of-day tariffs), and compat rules written in KDL (`src/compat/rules/`) |
| `packages/agent` | `@oh-my-pi/pi-agent-core` | `Agent` class (`agent.ts`), the loop (`agent-loop.ts`, 4,171 lines), compaction (`compaction/*`), speculative tool execution (`speculative-execution.ts`), append-only cache-stable context (`append-only-context.ts`), tokenizer, telemetry/OTel |
| `packages/coding-agent` | `@oh-my-pi/pi-coding-agent` | The `omp` CLI: sessions, tools, LSP, DAP, MCP, extensions, TUI modes, RPC/ACP, plan mode, subagents, memory |
| `packages/tui` | `@oh-my-pi/pi-tui` | Differential terminal renderer, editor, overlays, Kitty/sixel images, tool-result renderers (`src/tools/*`), charts, LaTeX, mermaid |
| `packages/natives` | `@oh-my-pi/pi-natives` | JS loader and typings (`native/index.d.ts`) for the Rust N-API addon |
| `packages/omptype` | `@oh-my-pi/omptype` | An ArkType-compatible schema validator with a lazy JIT runtime, used for tool schemas |
| `packages/utils` | `@oh-my-pi/pi-utils` | Logger, streams, temp files, the archive registry `ar`, env/worker-host helpers |
| `packages/snapcompact` | `@oh-my-pi/snapcompact` | A compaction strategy that renders old history as dense bitmap PNG frames for vision models |
| `packages/mnemopi` | `@oh-my-pi/pi-mnemopi` | Local SQLite memory backend |
| `packages/stats` | `omp-stats` | Local observability dashboard (`omp stats`) |
| `packages/collab-web` | — | Web guest client for `/collab` live session sharing |
| `packages/browser-relay` | — | Chrome extension that lets the agent adopt your existing tabs |
| `packages/wire` | `@oh-my-pi/pi-wire` | Generated RPC wire types |
| `packages/metaharness`, `packages/typescript-edit-benchmark` | — | Harness and edit benchmarks |

`python/robomp` is a separate bot that manages PRs, with its own prompts.

### 1.2 Rust crates (`crates/`) and why they exist

Source: `docs/native-crates.md`, `docs/natives-architecture.md`.

| Crate | Role |
|---|---|
| `pi-natives` | The single N-API `cdylib` the JS side loads. It depends on every crate below. Modules include `grep.rs`, `glob.rs`, `fd.rs`, `edit.rs` (`EditSession`/`EditStore`), `ast.rs`, `highlight.rs`, `pty.rs`, `shell.rs`, `tty_writer.rs`, `clipboard.rs`, `pdf.rs`, `html.rs`, `sixel.rs`, `mermaid/`, `tokens.rs`, `vcs.rs`, `iso.rs`, `summary.rs`, `audio.rs`, `desktop/` |
| `pi-edit` | Edit engine. Parses and applies the `hashline`, `apply_patch`, `patch`, `replace` and `sloppy` modes (`src/modes/*`). Also holds fuzzy matching (`fuzzy.rs`, 1,839 lines), snapshots and registers (`store.rs`), streaming previews (`session.rs`, `stream_json.rs`) and path policy. Model-facing prompts live in `prompts/*.md` and Lark grammars for constrained decoding in `grammars/*.lark` |
| `pi-diff` | jsdiff-compatible Myers, line and word diffs plus structured patches |
| `pi-ast` | tree-sitter/ast-grep registry, matching and rewriting, "block" resolution (used by hashline `N*` anchors), and code summarization for `read`. Rarer grammars are WASM modules downloaded on first use |
| `pi-walker` | Parallel, ignore-aware walker with a per-directory listing cache, glob and content search. Async over tokio, with permits |
| `pi-vfs` | Injectable async filesystem, so builtins and walkers can operate on `scheme://` internal URLs |
| `pi-shell` | **An embedded bash 5.3 engine**: lexer/parser, IR, VM scheduler with safepoints, bash builtins, process spawner with job objects and process groups, persistent sessions, and an output "minimizer" with per-command TOML filters (`src/minimizer/defs/*.toml`: apt, make, gcc, helm, …) |
| `pi-builtins` | In-process coreutils (cat, sed, sort, xargs, ls, find, rg/grep, fd, jq via jaq, diff, ast-grep/sg, ps, top, …) that the embedded shell runs with no fork/exec |
| `pi-vcs` | In-process git (gitoxide) and Jujutsu (jj-lib) |
| `pi-iso` | Workspace isolation for subagents: APFS clones, btrfs/ZFS snapshots, Linux reflink, overlayfs, Windows block clone and ProjFS, falling back to a git worktree or recursive copy |
| `pi-predict` | Composer word prediction (ngram, SmolLM, macOS spelling) |
| `pi-voice` | Microphone and playback, Opus/WebRTC (live voice mode, speech-to-text) |

**Why Rust.** The docs and README give these reasons:
- **Portability.** "Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist". The same binary runs on Windows without WSL.
- **Latency.** In-process ripgrep and glob avoid a fork/exec per call.
- **Correctness under cancellation.** See `docs/natives-rust-task-cancellation.md`.
- **Robust edit application.** Diff, fuzzy matching and tree-sitter all live together in Rust.
- **TUI responsiveness.** `crates/pi-natives/src/tty_writer.rs` moves blocking `write(2)` calls to a TTY onto an OS thread. The comment explains why: Bun's `process.stdout.write` blocks, and `O_NONBLOCK` can't be set through `bun:ffi` because of the variadic ABI. JS enqueues frames without blocking and polls `pending()` so it can skip frames under backpressure.

TS keeps orchestration, providers, prompts, sessions and UI. Rust takes anything CPU-, IO- or syscall-bound.

### 1.3 Worker model

All workers re-enter the single CLI entry. `cli.ts` calls `declareWorkerHostEntry()` and dispatches hidden argv selectors such as
`__omp_worker_stats_sync`, `__omp_worker_tab` and `__omp_worker_js_eval`. This makes compiled `bun --compile` binaries work without extra
entrypoints (documented in `AGENTS.md`, issues #1011/#1027/#1150). `omp --smoke-test` validates it in CI.

### 1.4 How the agent loop works

Files: `packages/agent/src/agent.ts` (`class Agent`) and `packages/agent/src/agent-loop.ts`.

- **Entrypoints.** `agentLoop()`, `agentLoopContinue()` and their `*Detailed` variants return an `EventStream<AgentEvent, AgentMessage[]>`.
  Events: `agent_start/agent_end`, `turn_start/turn_end`, `message_start/update/end`, `tool_execution_start/update/end`, `tool_stream_update`.
- **`runLoopBody()`** (agent-loop.ts:1214). An outer `while (true)` keeps going while follow-up messages are queued. An inner loop
  runs `while (hasMoreToolCalls || pendingMessages.length > 0)`. Each iteration:
  1. Checks the deadline. The `--max-time` deadline is armed in bounded `setTimeout` slices because of the 2^31 ms overflow.
  2. Parks on a process-wide pause gate (`/pause`).
  3. Drains steering messages into context.
  4. Runs `syncContextBeforeModelCall`, then resolves the tool-choice directive, including **soft tool requirements**:
     reminder messages first, then escalation to a forced `toolChoice` after `MAX_SOFT_TOOL_ESCALATIONS = 3`.
  5. Calls `prepareProviderCall`, then `streamAssistantResponse`.
  6. Runs `executeToolCalls`, emits `turn_end`, and decides whether to continue.
- **Resume of an unpaired tail.** `unpairedToolCallTail()` detects a trailing assistant message whose tool calls have no results,
  for example after a crash or a retry. It re-executes those calls before the first model call, and keeps steering parked so the
  tool_use/tool_result pairing is never broken.
- **Tool concurrency** (agent-loop.ts:~3908). Each tool declares `concurrency: "shared" | "exclusive" | (args) => …`.
  Shared calls run in parallel. An exclusive call waits for all prior shared calls and the last exclusive one (`Promise.all([lastExclusive, ...sharedTasks])`).
  `edit` is exclusive. Reads, greps and similar calls are shared.
- **Interruptibility.** Steering never hard-kills a side-effecting tool. Pure waits (`wait`, `vibe`) are `interruptible` and
  see an `AbortSignal.any([external, steering, irc])`. Everything else sees only the external abort, plus a cooperative
  `ctx.steeringSignal`. A long `bash` can, for example, auto-background itself when the user types.
- **Speculative tool execution** (`speculative-execution.ts`, 968 lines). A tool can declare
  `speculation: { finalized: { assess, execute, commit, discard } }`. While the assistant message is still streaming, any tool call
  whose JSON args have closed can start before `message_end`. `ReadTool` implements this for local reads (`tools/read.ts:1161`):
  it records a byte digest so the commit can verify nothing changed. The `task` tool's `speculativeLaunch` spawns each subagent
  as soon as its `tasks[]` item closes in the stream.
- **Intent injection.** `injectIntentIntoSchema()` adds an `intent` field to tool schemas ("capitalized 2–6-word present-participle intent").
  `extractIntent()` strips it before execution and the UI shows it as a live caption.
- **Robustness ladders built into the loop:**
  - `MAX_PAUSED_TURN_CONTINUATIONS = 8`.
  - DSML/Harmony leak nudges (`MAX_DSML_LEAK_NUDGES = 2`), for models that leak tool markup into text.
  - Tool-call ID repair (`ensureUniqueToolCallIds`).
  - "Tool not found" responses with fuzzy name suggestions (`suggestToolNames`).
  - Coercion of malformed tool results (`coerceToolResult`).
  - Synthetic tool results for aborted or skipped calls, so pairing always holds.
- **Append-only context** (`append-only-context.ts`). The system prompt and tool specs are frozen into a `StablePrefix`. Messages only
  ever append, so provider prefix caches hit as often as possible. Tool identity is fingerprinted so the prefix is rebuilt only on a real change, such as an MCP reconnect.
- **Higher-level session.** `packages/coding-agent/src/session/agent-session.ts` wraps `Agent` with persistence, compaction,
  TTSR, retries (`turn-recovery.ts`, 3,529 lines), advisors (`session-advisors.ts`), plan mode, memory, todo tracking,
  context promotion, model fallback chains and cache warming. `sdk.ts` exposes `createAgentSession()` for embedding.

### 1.5 Modes and front-ends

`packages/coding-agent/src/modes/`:
- `interactive-mode.ts`: the TUI.
- `print-mode.ts`: headless.
- `rpc/`: JSON-RPC, with a generated wire in `rpc-wire.generated.ts` and an `rpc-client.ts`. See `docs/rpc.md` (1,805 lines).
- `acp/`: Agent Client Protocol for Zed and other editors. Writes go through the editor's save path, shells run in the editor's terminal, and compaction notifications are sent as `_omp/compaction/*`.

Native rendering is also available on "Tern" terminals, which speak the Tern Surface Protocol. Tools can supply semantic `describeCall`/`describeResult` views for them (`docs/tui-core-renderer.md` §5).

---

## 2. What omp adds beyond upstream pi

Upstream pi ships a deliberately minimal core:
- read, write, edit, bash (plus optional grep/find/ls);
- JSONL tree sessions with `/tree`, compaction and branch summaries;
- extensions (`pi.on`, `registerTool`, `registerCommand`), skills, prompt templates and themes;
- RPC, print and SDK modes, and a differential-rendering TUI.

omp keeps those concepts (and a compat shim, `extensibility/plugins/legacy-pi-compat.ts`, 2,905 lines) and adds the following.

### 2.1 Hashline editing (default edit mode)
`crates/pi-edit/src/modes/hashline/*`, `packages/coding-agent/src/edit/index.ts`, `docs/tools/edit.md`.
- **Read output is anchored.** `read`/`grep` emit a header `[path#TAG]`, where TAG is 4 uppercase hex chars derived from the normalized
  whole-file content and recorded in a session-scoped native `EditStore`. Lines are then shown as `LINE:TEXT`. (Earlier
  hashline versions used per-line hashes. The current version uses one file-level snapshot tag plus line numbers.)
- **The edit language is a tiny DSL** with a Lark grammar (`crates/pi-edit/grammars/hashline.lark`) for constrained decoding:
  - `PUT N.=M:` followed by `+line` rows replaces lines N..M inclusive.
  - `PUT N*:` replaces the tree-sitter block that starts at line N.
  - `PUT <N:` / `PUT >N:` / `PUT >$:` insert before, after, or at the tail.
  - `CUT N.=M @name` cuts into a named register. Registers persist across calls and enable cross-file moves.
  - `REM` deletes a file and `MV dest` renames it.
  - Line numbers always refer to the original snapshot, never to positions shifted by earlier hunks.
- **Safety checks:**
  - Stale tags trigger snapshot-chain recovery (`modes/hashline/recovery.rs`). A `pi_diff` line map remaps anchors only through
    lines the intervening change left untouched, and context is validated. Recovery is refused when it is ambiguous, when it would break a file that parsed, or when the body looks like it was written against current line numbers.
  - `edit.enforceSeenLines=true` rejects edits to lines the model never actually saw: elided summary regions, or lines truncated past 512 bytes.
  - Edits to auto-generated files are blocked.
  - Rich error kinds: `stale_tag`, `unseen_lines`, `ambiguous_boundary`, `no_change`, and others.
  - The third identical no-op in a row becomes an error.
  - Overlapping ranges are rejected.
- **Post-write.** Writes go through LSP writethrough (format and diagnostics). If a file that parsed before the edit no longer
  parses, the result carries a warning, and optional LLM auto-repair (`edit/auto-repair.md`) splices in a fix for the broken region.
- **Model routing.** `edit.modelVariants` and `PI_EDIT_VARIANT` select the mode per model. Some families (Kimi, MiMo, MiniMax,
  DeepSeek, StepFun, Codex Spark, GLM Flash) fall back to `replace`. `editPromptVariant: "compact"` selects
  `edit/hashline-compact.md`.

### 2.2 Other edit modes
- `replace`: `path`, `old_string`, `new_string`, `replace_all`. Fuzzy matching (Levenshtein, threshold 0.95) runs in `fuzzy.rs`.
- `patch`: per-path entries carrying unified diffs.
- `apply_patch`: the Codex envelope (`*** Begin Patch`, `*** Update File`, `*** Move to`). Matching is deliberately strict:
  exact, then trailing-whitespace trimmed, then both ends trimmed, then Unicode punctuation normalized. It **never** uses
  similarity matching. Envelope sections are validated in a virtual namespace before any write, so the whole patch is atomic.
- `sloppy`: `*** Edit File:`, `*** Find`, `*** Replace` / `Insert Before` / `Insert After`, with `…` capture groups.
- `ast_edit`: an ast-grep codemod. It is staged and shown as a "(proposed)" card. The model writes a reason to `xd://resolve`
  to apply it atomically, or to `xd://reject`.
- `write` covers create/overwrite, archive members, SQLite rows, and `conflict://N` merge-conflict resolution (`@ours`/`@theirs`/`@base`).

### 2.3 LSP integration ("IDE wired in")
`packages/coding-agent/src/lsp/*`, `docs/lsp-config.md`, `docs/tools/lsp.md`.
- **The `lsp` tool** supports 14 actions: `diagnostics`, `definition`, `references`, `hover`, `symbols`, `rename`, `rename_file`
  (through `workspace/willRenameFiles`, so imports and barrels update before the file moves), `code_actions`, `type_definition`,
  `implementation`, `status`, `reload`, `capabilities`, and raw `request`.
- **Server discovery.** About 55 built-in server definitions live in `lsp/defaults.json` and are auto-detected by root markers.
  Custom clients wrap Biome, SwiftLint and LSP-based linters (`lsp/clients/*`).
- **Writethrough** (`lsp/writethrough.ts`). Every edit and write first syncs the LSP overlay, then writes to disk, then optionally
  formats (`lsp.formatOnWrite`, off by default) and returns diagnostics inline (`lsp.diagnosticsOnWrite`, on by default).
  Diagnostics that arrive late are queued as deferred diagnostics, versioned by a per-file mutation counter so stale ones are dropped.
  A tsserver-specific `reloadProjects` barrier runs after file creation.
- **Shared servers.** An `lspmux` daemon broker (`lsp/mux/daemon.ts`) shares warm language servers across omp instances in the same project.
- **Prompt rule.** The system prompt says "Language server available: MUST use lsp for definitions… NEVER text-search/edit for code intelligence", and
  "Exported symbol changes: MUST run lsp references first."

### 2.4 Debugger (DAP)
`packages/coding-agent/src/dap/*` and `tools/debug.ts`. The README advertises 28 operations: breakpoints, stepping, threads, stack,
variables, evaluation. Adapters include lldb-dap, dlv and debugpy.

### 2.5 Subagents: the `task` tool
`packages/coding-agent/src/task/*` (`executor.ts` is 5,564 lines), `docs/tools/task.md`, `docs/task-agent-discovery.md`.
- **Call shape.** A batch is `{ context, tasks: [{ name?, agent?, model?, task, solutionSpace, effort?, outputSchema?, schemaMode?, tools?, isolated? }] }`.
  `solutionSpace` ("how open-ended is this") is the sole input to the child's auto-thinking classifier.
- **Bundled agents** (`src/prompts/agents/*.md`, with frontmatter):
  - `task`: the general worker.
  - `scout`: read-only, `model: "@smol"`, with a JTD output schema of `summary` plus `files[]`.
  - `reviewer`: `model: "@slow"`, verdict plus P0–P3 findings.
  - `security-reviewer`.
  - `seance`: consults another session's transcript.
  - `init`: generates AGENTS.md.
  Custom agents come from project, user and plugin directories.
- **Structured output.** Children must finish through a hidden `yield` tool. They get up to three reminders, and the last forces
  `toolChoice = yield`. Output is validated against the JTD/JSON schema (permissive or strict), with retries.
- **Output as URLs.** Results are addressable: `agent://<id>` returns the markdown output, `agent://<id>/findings/0/path`
  extracts a JSON path, and `history://<id>` returns a concise transcript.
- **Async by default** when `async.enabled` is on: jobs go to an `AsyncJobManager`, results auto-deliver as injections, and
  `wait`, `proc://<id>` and `write proc://<id>/kill` control them. Concurrency comes from a session `Semaphore`
  (`task.maxConcurrency`, default 32), and `task.workerThreads` defaults to 4.
- **Isolation.** `isolated: true` creates a copy-on-write workspace through `pi-iso` (or an `ovnfs` checkout), then captures root and
  nested patches or a branch and merges them back, with recovery artifacts on failure.
- **Lifecycle.** Agents stay alive after finishing: they are `idle`, get parked after `task.agentIdleTtlMs`, and are revived by
  `write agent://<id>` or from the Agent Hub (`Alt+A`).
- **IRC.** Peers can DM each other with `write agent://<peer>`. The subagent system prompt has strict etiquette: blocking questions
  only, no FYI messages.
- **Per-child policy.** Children get an isolated settings snapshot with `tools.approvalMode` forced to `yolo`. Tools come from agent
  frontmatter, and `task` is auto-added below the depth limit. Model, service-tier and OAuth account-pool overrides can be set per agent name.
- **Prompt caching across siblings.** A `taskPromptCacheKey` (`<parent cache key>:<agent name>`) lets sibling subagents share provider prompt caches.

### 2.6 Plan mode
`packages/coding-agent/src/plan-mode/*`, prompt `src/prompts/system/plan-mode-active.md`.
- The working tree is read-only. The plan is written to `local://<slug>-plan.md`, a session-local artifact.
- Approval happens **only** by writing the slug to `xd://propose`. The model is told never to ask for approval in prose.
- "Plan: execution spec, not design doc… A competent implementer unfamiliar with the conversation MUST execute top-to-bottom with ZERO design decisions."
- Every asserted path or symbol must have been read this session; unverified claims are flagged inline.
- Plan-mode subagents get only `read`/`grep`/`glob`/`web_search`/`ast_grep`.
- Approval can clear or compact the conversation and hand the plan to a different model (the `plan` role).
- Related features:
  - `prewalk` hands off from a planning model to a cheaper implementer.
  - `/goal` and guided-goal modes.
  - `/vibe` is a director mode: the main session gets read-only tools and drives persistent "fast"/"good" worker sessions.

### 2.7 Time-Traveling Stream Rules (TTSR)
`session/ttsr-coordinator.ts`, `export/ttsr.ts`, `docs/ttsr-injection-lifecycle.md`.
- Rules carry a regex `condition`, an `astCondition` (ast-grep pattern), or a judged `question`, and a scope (text, thinking, tool args, path globs).
- The model stream is monitored live. On a match, the stream is **aborted mid-token**, the rule is injected as a system reminder, and the turn is retried from the same point.
- AST conditions match against a reconstructed source digest from edit and write tool args (`matcherDigest` / `matcherEntries`).
- Injections persist as `ttsr_injection` session entries, so they survive compaction.
- The benefit: course correction without paying context tax for every rule on every turn. Rules can come from any supported tool's rule format (see 2.15).

### 2.8 Search tools
- `grep` (native Rust). Rust regex is tried first, then PCRE2 for lookaround and backreferences, then literal recovery for malformed patterns.
  Output is a prefix-folded directory tree with `#TAG` headers, `*LINE:` for matches and ` LINE:` for context. Pages hold 20 files.
  Lines are capped at 512 bytes, with a window centered on the match and a `[col N]` marker. Results are marked `useless` when empty, so compaction can drop them.
- `glob`: native, gitignore-aware, results capped at 200, grouped tree output, streamed snapshots every 200 ms.
- `find` (`tools/jfind/*`) is **semantic grep**. A four-phase cascade follows can1357's `jegrep`:
  1. Lexical keyword pre-ranking (IDF).
  2. Filename judgments over a tagged tree, 64 per batch.
  3. 384-byte passage "sketches" from 8 KB windows, packed 46 per request.
  4. Full-passage verification of sketches scoring at least 0.45.
  All of it runs on a cheap "judge" model (TypeSafe `jev-1.14.0` System One), with 16 requests in flight and a 20 s budget. The output is calibrated relevance scores (τ = 0.20). It is enabled only when such a judge model is configured.
- `ast_grep`: structural queries over 50+ tree-sitter grammars.
- `web_search`: a chain of 24 providers ("auto"), with site-aware extraction (GitHub, arXiv, Stack Overflow, registries) to markdown. The URLs it returns go straight into `read`.

### 2.9 Code execution: `eval`
`tools/eval.ts`, `src/eval/{py,js}/*`, `docs/tools/eval.md`, `docs/python-repl.md`.
- Persistent Python (a Jupyter-style kernel) and Bun-worker JS cells, with input `{language, code, title?, timeout?, reset?}`.
- Kernels can **call back into agent tools** over a loopback bridge (`read()`, `grep()`, …). Bridges also exist for:
  - `agent()` / `completion()` / `workpool()`, which spawn subagents from code;
  - `judge()`, bulk LLM classification (the `jevify` keyword);
  - `budget`;
  - `browser.open(...)` (Puppeteer tabs with stealth on, CDP or relay to the user's Chrome);
  - `computer.*` (desktop windows, screenshots, accessibility tree, native input).
- Magic keywords `workflowz` and `jevify` inject contracts for deterministic multi-agent workflows written as eval code.

### 2.10 Memory
`docs/memory.md`, `src/memories`, `src/memory-backend`, `src/hindsight`, `src/mnemopi`, `src/sharpshooter`.
- Backends: `off` (default), `local` (summaries and lessons from persisted sessions), `hindsight` (remote), `mnemopi` (local SQLite), and
  `sharpshooter` (friction-gated decision files).
- Tools: `retain`, `recall`, `reflect`, `memory_edit`, and `learn`. `learn` captures a lesson and can promote it to a managed skill through `manage_skill`.
- Each session is compressed into a "mental model" loaded on the next session's first turn. Memory is project-scoped by default.

### 2.11 MCP
`src/mcp/*` (`manager.ts` is 2,371 lines), `docs/mcp-*.md`.
- Supports stdio and HTTP transports, OAuth credential storage, and Smithery search and login.
- Config is discovered from `.omp/mcp.json`, `~/.omp/agent/mcp.json`, and the formats of `.claude/`, `.cursor/`, `.vscode/` and `opencode.json`.
- **MCP tools mount as `xd://` devices** rather than top-level schemas (2.13). They are given approval tier `write` whatever their annotations say.

### 2.12 Todo
`tools/todo.ts`, `session/todo-tracker.ts`.
- One op per call (`init | start | done | drop | block | unblock | rm | append | view`) over **phased** task lists.
- Todo snapshots are restored per branch. A "mid-run todo nudge" and completion reminders exist.
- The system prompt says "NEVER make a todo-only turn: send `todo` in the same response as the turn's real call".

### 2.13 xd:// tool devices (lazy tool surface)
`tools/xdev.ts`, `internal-urls/xd-protocol.ts`; settings `tools.xdev`, `tools.xdevDocs`.
- The top-level schema holds only "essential" tools (`essential-tools.ts`): read, write, bash, edit, glob, find, eval, task, wait, learn, manage_skill, context_notes and new_context.
- Discoverable tools (grep, lsp, MCP tools, extension tools, …) are mounted as devices. `read xd://` lists them, `read xd://<tool>` returns their docs and schema, and `write xd://<tool>` with JSON content executes one. Invalid args return the schema in the error.
- This keeps tool definitions small and stable, which helps prompt caching, and lets MCP servers mount and unmount without invalidating the prefix.

### 2.14 Internal URL schemes
`src/internal-urls/*`. Built-in schemes include:
`agent://`, `artifact://`, `attachment://`, `cfg://`, `conflict://`, `history://`, `issue://`/`pr://` (GitHub as a filesystem), `mr://` (GitLab), `local://`
(session scratch), `mcp://`, `memory://`, `omp://` (harness docs), `out://`, `proc://`, `rule://`, `security://`, `skill://`, `ssh://`, `vault://`, `xd://`.
Every FS-shaped tool, including bash's in-process coreutils through `pi-vfs`, resolves them. `read pr://1428` therefore behaves like a file read, and `grep` can walk a diff.

### 2.15 Discovery of other tools' config ("inherits what your other tools wrote")
`src/discovery/*` has providers for `claude`, `claude-plugins`, `codex`, `cursor` (MDC), `cline`, `windsurf`, `gemini`, `opencode`, `github` (Copilot
`applyTo`), `vscode`, `agents-md`, `.agent(s)`, and native `.omp`. Capabilities (`src/capability/*`) are typed: `context-file`, `rule`, `skill`, `hook`,
`mcp`, `slash-command`, `tool`, `extension`, `system-prompt`, `settings` and `ssh`. Within a capability, the first provider by priority wins per name.

### 2.16 Advisor / watchdog
`src/advisor/*`, `docs/advisor-watchdog.md`.
- One or more reviewer models on separate contexts read every turn of the main agent and inject notes inline, marked as aside, concern or blocker.
- `WATCHDOG.md` / `WATCHDOG.yml` configure the roster and tools. The default advisor toolset is read/grep/glob.

### 2.17 Other notable additions
- **Auto thinking** (`auto-thinking/classifier.ts`). A judge model classifies each prompt's open-endedness into
  `low|medium|high|xhigh|max`; small on-device judges get a three-way `trivial|moderate|hard` question instead. The result is clamped to the model's range.
- **Magic keywords** (`modes/magic-keywords.ts`): `ultrathink`, `chillax`, `orchestrate`, `workflowz` and `jevify`. They match only in prose, not inside code.
- **Snapcompact.** History is archived as PNG bitmap text frames, with per-model font and shape choices measured by evals (see section 5).
- **Context notes and `new_context`**: experimental notes-backed context windows with `history://current/full` recovery.
- **checkpoint / rewind**: prune exploratory context and keep a report.
- **`/collab`**: E2E-sealed live session sharing through a relay, joined with `omp join` or a browser. **`/btw`**: side questions.
- **`omp commit`**: atomic commit splitting with dependency ordering. **`/review`**: parallel reviewer subagents with P0–P3 findings.
- **Speech**: STT push-to-talk on Space, TTS, and live voice (`pi-voice`).
- **Secrets obfuscation** (`secrets/obfuscator.ts`): env-pattern and `secrets.yml` values are replaced with `$$HASH$$` tokens before text reaches providers.
- **Security scan** tool (Codex Security cloud scans), IDA binary views inside `read`, video frames, PDFs, archives, SQLite and profiler summaries.
- **Approval modes**: `always-ask | always-ask-cached | write | yolo`. **The default is `yolo`.** Tools declare a `read | write | exec` tier, `bash.patterns`
  allow/deny/prompt rules exist, and compound-command classification is opt-in.
- **Telemetry**: OpenTelemetry export (`telemetry-export-otlp.ts`) and the local `omp stats` dashboard.

---

## 3. Provider and model layer

### 3.1 Providers
`packages/ai/src/providers/*` and `README.md`. Roughly:
- **Frontier APIs**: Anthropic (OAuth or key), OpenAI, OpenAI Codex (OAuth, websocket transport), Google Gemini/Vertex/Antigravity (OAuth), xAI, SuperGrok,
  DeepSeek, Mistral, Groq, Cerebras, SambaNova, Fireworks, Together, Bedrock (SigV4 implemented in-house in `aws-sigv4.ts`, plus an eventstream
  parser), Azure OpenAI, OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, and others.
- **Coding-plan subscriptions**: Cursor, GitHub Copilot, GitLab Duo, Devin, Kimi Code, MiniMax, Z.AI/GLM, Qwen Portal, Alibaba, OpenCode Zen/Go, Kilo, ZenMux, and others.
- **Local**: Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, and Apple Foundation Models.
- **Wire APIs** that can be declared in `models.yml`: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`,
  `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, plus judge APIs.
- **Server-side shims** (`anthropic-messages-server.ts`, `openai-chat-server.ts`, `openai-responses-server.ts`) let omp act as an **auth gateway**
  (`omp auth-gateway`) that other clients talk to. The `pi-native` transport (`docs/toolconv/pi-native.md`) is a lossless pi-ai to gateway path.
- **Textual tool-call dialects** (`packages/ai/src/dialect/*`) cover Anthropic, DeepSeek, Gemini, Gemma, GLM, Harmony, Hermes, Kimi, MiniMax, Qwen3/Qwen-XML and XML,
  for models or endpoints without reliable native tool calling. Each has a `.md` prompt and a streaming parser (`owned-stream.ts`).
  omp's own in-band format was removed in v16.2.2.

### 3.2 Model registry and catalog
- `packages/catalog/src/models.json` is the bundled catalog, regenerated with `bun run gen:models`.
- Compat behavior is expressed as **KDL rules** (`catalog/src/compat/rules/{auth,classes,providers,runtime,taxonomy}`). Rule axes cover
  context windows, output limits, image tokenization, prompt-cache lookback (Claude: 20 positions), request-size and inline-image budgets, reasoning carry, and Responses websockets.
- `packages/coding-agent/src/config/model-registry.ts` (4,382 lines) and `model-resolver.ts` (2,683) merge the catalog with
  `~/.omp/agent/models.yml` (custom providers, `modelOverrides`, discovery types including `proxy`) and with runtime-discovered models (Ollama `/api/tags`,
  generic `/v1/models`, LiteLLM pricing). Provider-model caches carry a static fingerprint.
- **Auth.** Credentials are resolved in this order: CLI, env, `.env`, `models.yml` (including command-resolved secrets), then OAuth store.
  Round-robin credential pools apply per provider, with session affinity and per-credential backoff (`ai/src/auth/{pool,rotation,affinity,health}.ts`).
  OAuth account pools can be set per subagent.

### 3.3 Routing: roles
Settings live under `modelRoles` in `config.yml` (`docs/models.md` "Role aliases").
- **Chat roles**: `default`, `smol` (cheap fan-out), `slow` (deep reasoning), `vision`, `plan`, `commit`, `tiny` (titles and background work, falling back to `@smol`),
  `memory`, `task`, `advisor`.
- **Model-kind roles**: `image`, `web`, `speech`, `dictation`, `judge`.
- Selectors look like `provider/model[@upstream][:thinkingLevel]`. Comma lists mean "first available". `@role` aliases are allowed, and `*` means `@default`.
- **Fallback chains**: `retry.fallbackChains`, keyed by role, model or provider wildcard. They switch model on 429s or quota errors and restore after a cooldown.
- **Context promotion**: on overflow, switch to an explicitly configured `contextPromotionTarget` with a larger window **before** compacting.
- **Path-scoped** `enabledModels` / `disabledProviders` for per-repo model sets. **Model presets**: `/modelpreset save|switch`.
  `Ctrl+P` cycles models within a role, and `Alt+P` picks a temporary one.

### 3.4 Thinking levels
`catalog/src/effort.ts` defines `minimal | low | medium | high | xhigh | max`. `model-thinking.ts` maps them onto each provider's
budgets or effort enums and clamps to the model's supported range. `auto` uses the judge classifier (section 2.17). `Shift+Tab` cycles levels.
On per-message-effort Claude models, `chillax` can lower effort mid-turn without invalidating the cache.

### 3.5 Caching
- **Static-first system prompt blocks.** Block 0 holds the cwd-independent instructions. Everything derived from the cwd goes into a trailing `<project-context>` block.
  The Anthropic cache breakpoint sits on the last block before it, so subagents running in different worktrees share the cached static prefix
  (`docs/system-prompt-customization.md`).
- The append-only context and stable tool fingerprint from 1.4.
- **Cache-lifetime catalog** (`promptCache: { short: 300, long: 3600 }`), with long retention by default for Anthropic OAuth.
  **Cache warming** (`providers.cacheWarming`) refreshes the cache at `min(90% of TTL, TTL − 10s)`.
  Idle compaction is timed to land 5 s before the warmer's refresh, so the summary request still reads the cached prefix.
- **Cache-aware pruning.** Superseded or useless results are blanked only when the suffix after them is within the model's cache lookback
  (counting positions the way Anthropic does), or after the cache has expired.
- `/fresh` resets provider stream and cache state without touching the transcript. `providerPromptCacheKey` is inherited by forks, and
  `taskPromptCacheKey` is shared by sibling subagents.

### 3.6 Cost
- Costs come from catalog pricing per request; server-reported costs are preferred when available. Recorded costs are never repriced.
- **Time-based tariffs.** DeepSeek has peak and off-peak rates, and some prices change on a date. The status-line cost segment shows ↑ or ↓ for the active model's current tariff.
- `model_usage` session entries track side calls (titles, judges, advisors), so `/usage` and stats are complete. Per-subagent cost appears on Agent Hub cards.

---

## 4. Tools

### 4.1 Full list
Registry: `packages/coding-agent/src/tools/index.ts`, the `BUILTIN_TOOLS` and `HIDDEN_TOOLS` maps.

| Tool | Load mode | Concurrency / approval | Schema (key fields) | Notes |
|---|---|---|---|---|
| `read` | essential | shared / read tier | `{ path }` with selector suffixes | See 4.2 |
| `write` | essential | write | `{ path, content }` | Atomic temp+rename. Archive members, SQLite rows, `conflict://`, `xd://` device transport |
| `edit` | essential | **exclusive** / write | hashline: `{ input }`; replace: `{path, old_string, new_string, replace_all?}`; patch; apply_patch; sloppy | See 2.1–2.2 |
| `bash` | essential | exec | `{ command, timeout?(300s), cwd?, pty?, async?, name?, ready?{log,port,host,timeout} }` | Embedded bash 5.3. `name` plus `ready` turns it into a supervised **service** with readiness probes. A leading `cd X &&` becomes `cwd` |
| `eval` | essential | exec | `{ language: "py"\|"js", code, title?, timeout?(30s), reset? }` | Persistent kernels with tool re-entry |
| `glob` | essential | read | `{ path?, hidden?, gitignore?, limit?(≤200) }` | Semicolon multi-path |
| `find` | essential when enabled | read | `{ query, grep_keywords[], path? }` | Semantic, judge-model cascade |
| `grep` | discoverable | read | `{ pattern, path?, case?, gitignore?, skip? }` | Native; context lines set in settings |
| `ast_grep` / `ast_edit` | discoverable | read / write | ast-grep pattern, rewrite, paths | Staged preview, then `xd://resolve` |
| `lsp` | discoverable | read or write by action | `{ action, file?, line?, symbol?, query?, new_name?, apply?, timeout?, payload? }` | `symbol` resolves the column, with `name#N` occurrence selection |
| `debug` | discoverable | exec | DAP ops | |
| `task` | essential | exec | `{ context, tasks[] }` | See 2.5 |
| `wait` | essential | interruptible | wait on jobs, peer messages, steering | |
| `todo` | discoverable | read | one op object | |
| `ask` | interactive only | — | structured questions with options | |
| `web_search` | discoverable | — | `{ query, … }` | |
| `github` | gated | — | repo/PR/issue/search/run-watch | |
| `checkpoint` / `rewind` | gated pair | — | | |
| `context_notes` / `new_context` | experimental | — | `{ text? }` | 16 KiB notebook |
| `retain` / `recall` / `reflect` / `memory_edit` / `learn` / `manage_skill` | backend-gated | — | | |
| `security_scan`, `ida`, `generate_image`, `tts`, `browser`, `computer` | gated | — | | |
| hidden: `think`, `yield`, `goal` | — | — | `yield` ends subagents and carries structured output | |

Every tool can also declare these optional properties (`packages/agent/src/types.ts` `AgentTool`):
`loadMode`, `concurrency`, `speculation`, `interruptible`, `intent`, `approval` (tier plus policy), `approvalCacheTargets`,
`matcherDigest`/`matcherEntries` (for TTSR AST rules), `openArgStream` (streaming arg previews), `lenientArgValidation`,
`deferrable`, `renderCall`/`renderResult`, `docTopics`, and `delegationGuidance`.

### 4.2 `read`: the swiss-army reader
`tools/read.ts` (3,359 lines), `docs/tools/read.md`.
- **Selectors go in the path**, never as separate offset/limit params:
  - `:50`, `:50-80`, `:50+20`, `:-60` (tail), comma lists such as `:5-16,960-973`, `:raw`, `:conflicts`, `:img` (rasterize SVG).
  - A literal filename that happens to look like a selector wins.
  - Single ranges add 1 line of leading and 3 lines of trailing context.
- **Structural summaries.** With no selector, code files of at least 100 lines are summarized through `pi-ast` (declarations kept, bodies elided as `{ … }`).
  A footer lists the concrete elided ranges to re-read. The summary is skipped for prose, files over 2 MiB, or files over 20k lines.
  This is the "reads that summarize files instead of dumping their content" claim.
- **Hashline mode** shows a `[path#TAG]` header plus `N:text` lines. Snapshots and seen lines are recorded in the native `EditStore`.
- **Path recovery.** On a missing path it retries macOS screenshot, NFD and curly-quote variants, then a **unique workspace suffix match**,
  then the active plan basename, then a split of an accidentally delimited list of paths.
- **Dispatch by type.** Directories become a recency-sorted tree (depth 2, 12 entries per directory). Archives can be read as `a.zip:inner/path`.
  SQLite supports `db:table`, `db:table:key`, `?where=` and `?q=SELECT`. JSON supports `?q=<jq>`. Also: PDFs, notebooks (as editable cell text), images
  (`?q=` sends a question to the vision role), video (contact sheet or frame selectors), profiler reports (bottleneck summary),
  ELF/PE/Mach-O through IDA, URLs (reader-mode markdown, with the cache stored as artifacts), and every internal URL scheme.
- **Device files.** Non-regular files (FIFO, char/block devices) are refused, because the read runs on a native thread that cannot be cancelled.
- **Supersede logic.** Re-reading a file prunes older copies of its read results (`read-supersede.ts`).

### 4.3 Edit robustness details (what to copy)
- **Matching ladder** (`crates/pi-edit/src/fuzzy.rs`). `seek_sequence` tries exact, then normalized passes (trim, Unicode punctuation,
  indentation-depth-aware), then a fuzzy line score (≥ 0.92), then a character-level fallback (0.92).
  - It tracks the **dominant fuzzy hit**: a hit at confidence ≥ 0.97 that beats the runner-up by ≥ 0.08.
  - It records occurrence previews: 5 lines of context, up to 5 matches.
  - Levenshtein is computed with a diagonal band (`levenshtein_within`, O(len·max)) and Myers/Hyyrö bit-parallel matching for one pattern against many texts.
  - Thresholds: `DEFAULT_FUZZY_THRESHOLD = 0.95`, `SEQUENCE_FUZZY_THRESHOLD = 0.92`, `CONTEXT_FUZZY_THRESHOLD = 0.8`.
- **Per-mode strictness.** `apply_patch` bans similarity matching entirely. Hashline relies on snapshot tags rather than text matching.
- **Atomicity.** Multi-section calls are parsed and prepared before any write. A later invalid section leaves all files unchanged.
  An OS write failure can still leave a prefix landed, and register state then advances only for that prefix.
- **Streaming previews.** The renderer parses the complete portions of an in-flight patch and computes read-only diffs, skipping transient
  failures. Execution re-validates from scratch.
- **Error responses that help the model resend correctly.** A mismatch reply includes the file's current tag and anchored context, and
  those printed rows count as seen for the resend.
- **Parse-regression check.** A file that parsed before the edit and fails after triggers a warning and optional LLM repair. The edit is not rolled back.
- **File mutation queue** (`tools/file-mutation-queue.ts`) plus racy-stamp detection (`racy-stamp.ts`) catch concurrent external writes.

### 4.4 Native grep and find
`crates/pi-walker` (parallel walker, per-directory listing cache, ignore handling), `crates/pi-natives/src/grep.rs`, and the vendored
`grep-searcher` patched with `Searcher::search_push` so files are searched chunk by chunk without the blocking pool.
The same walker powers the shell's in-process `rg`/`grep`/`fd`/`find`, so `bash` invocations of those are in-process too.

### 4.5 Bash runtime
`tools/bash.ts`, `exec/bash-executor.ts`, `crates/pi-shell`.
- Sessions persist across calls. 46+ coreutils run in-process. PTY mode is used for interactive programs, and output is streamed with artifact spill past
  `tools.artifactSpillThreshold` (`artifact://` ids).
- **Auto-backgrounding** on steering. Optional **interceptor** rules redirect misuse (`grep` to the grep tool, and so on), and a block happens only if the suggested tool is active.
- An opt-in **output minimizer** applies per-command TOML filters for noisy tools such as apt, make, gcc, helm and npm.
- `PI_SESSION_ID`, `PI_SESSION_FILE` and `PI_TOOL_CALL_ID` are injected. `git worktree add` can be rewritten to an ovnfs clone.

---

## 5. Sessions, compaction, branching, resume

### 5.1 Storage
`session/session-manager.ts` (4,846 lines), `docs/session.md`.
- **Location**: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuidv7>.jsonl`. The cwd is canonicalized, so symlink aliases share a bucket.
- **File layout.** The first 256 bytes are a fixed-width title slot, so a title can be rewritten in place without rewriting the file. A header follows
  (`type: "session"`, `version: 3`, `cwd`, `additionalDirectories`, `previousSessionFiles`, `providerPromptCacheKey`, `taskPromptCacheKey`, `parentSession`), then entries.
- **Entries.** Each is `{type, id (8 hex), parentId, timestamp}`, forming a **tree**. An in-memory `leafId` marks the current branch.
  Types: `message`, `model_usage`, `thinking_level_change`, `model_change`, `service_tier_change`, `compaction`, `branch_summary`,
  `reset_boundary` (`/clear`), `custom`, `custom_message`, `label`, `title_change`, `ttsr_injection`, `credential_pin`, `session_init`, `mode_change`, and more.
  Message roles are camelCase: `user`, `developer`, `assistant`, `toolResult`, `bashExecution`, `pythonExecution`, `fileMention`.
- **Blobs.** Content-addressed storage at `~/.omp/agent/blobs/<sha256>` holds images and large payloads, externalized at persist time (`session-persistence.ts`).
- **Indexing.** `history.db` (SQLite) holds titles and an idle-recap journal (`session-index.ts`). Terminal breadcrumbs (`~/.omp/agent/terminal-sessions/<tty>`)
  let `--continue` pick this terminal's session and re-root after a project directory rename (device/inode check).
- **Migrations** (`session-migrations.ts`) and tolerant loading of malformed lines.

### 5.2 Context reconstruction
`buildSessionContext()` in `session-context.ts`:
1. Take the latest compaction on the path and turn it into one `compactionSummary` user message.
2. Append the kept entries from `firstKeptEntryId`, then everything after.
3. Turn `branch_summary` and `custom_message` entries into their message forms.

There is a separate **display transcript** (`transcript: true`) that keeps all scrollback and shows compactions inline as a divider
(`── 📷 compacted · ctrl+o ──`). Only the LLM context resets at a compaction.

### 5.3 Compaction
`packages/agent/src/compaction/*` (`compaction.ts` is 2,459 lines), `docs/compaction.md`.
- **Six triggers**:
  - manual `/compact [instructions]`;
  - overflow recovery;
  - incomplete-output (`stopReason: length`) recovery;
  - post-turn threshold;
  - **mid-turn** threshold at safe tool-loop boundaries (always on for subagents);
  - idle, cache-timed.
- **`compaction.methodOrder`** walks the strategies in order:
  - LLM summary.
  - `handoff`: a document generated for a fresh agent (`docs/handoff-generation-pipeline.md`).
  - `shake`: a mechanical pass that replaces large tool results and fenced/XML blocks with recoverable `artifact://` refs.
  - `snapcompact`: the bitmap archive.
  - Provider-native compaction: OpenAI Responses and Codex remote compaction (`compaction/openai.ts`, `compaction-v2-streaming.ts`), and Anthropic (`compaction/anthropic.ts`).
- **Cut points never land on a `toolResult`.** For a split turn, two summaries are produced (history plus turn prefix) and merged.
  Local summaries are updated incrementally with `<previous-summary>`. Oversized input is folded through budgeted windows, and provider overflow halves the window and re-plans.
- **Pre-compaction pruning** protects the newest 40k tool-output tokens and needs at least 20k of savings. Results under 50 tokens are never blanked.
  Skill reads and the active plan file are never pruned. **Useless-result elision**: tools flag empty results with `useless`, which are blanked to
  `[Uneventful result elided]` on a cache-aware schedule.
- **Progress guard.** Automatic maintenance must reach ≤ 80% of the threshold. Otherwise it tries rescue steps (re-render snapcompact smaller, elide, drop images),
  then blocks auto-continue instead of looping. Consecutive no-output recoveries are capped at three.
- **Payload guard.** A 413 is not automatically treated as a token overflow.
- **Snapcompact** (`packages/snapcompact`) renders discarded history onto PNG frames with bundled pixel fonts, sized per model:
  - Claude: `11on16-bw` at 1568 or 1932 px.
  - Gemini: `8on22-bw` at 2048 px.
  - GPT: 1568 px.
  - Kimi/GLM: `8on16-bw`.
  - Silver16 for CJK.
  The middle is imaged, with HQ/LQ/HQ foveation, and both edges are kept as plain text. Tool output is printed in dim ink. Frames are budgeted against
  catalog image-token rules. The motivation: 200k-token evals showed bitmap frames preserve QA recall at lower billed tokens for vision models. Novel, but niche.

### 5.4 Branching, forking, resume
`docs/tree.md`, `docs/session-operations-export-share-fork-resume.md`.
- `/tree` is a navigator with filters (`default`, `no-tools`, `user-only`, `labeled-only`, `all`), search, labels and bookmarks.
  Selecting a user message re-runs from that point. Leaving a branch can produce a `branch_summary` breadcrumb
  (`compaction/branch-summarization.ts`).
- `/fork` and `AgentSession.fork(entryId)` copy the path into a new file, inheriting the cache key when eligible. `--fork <id|path>` does the same from the CLI.
- Resume: `--resume` (picker with pinning), `--continue` (this terminal's last session), and `/resume`, `/switch`, `/move`. Sessions follow
  directory moves through `previousSessionFiles`.
- `/export` (HTML with themes), `/dump`, `/share` (encrypted by default), `/handoff`, `/seance` (spawn an agent that consults another session).

---

## 6. Extensibility

### 6.1 Extensions (the unified surface)
`src/extensibility/extensions/*` (`types.ts` is 2,515 lines, `runner.ts` is 2,586), `docs/extensions.md` (1,473 lines).
- A TS/JS module default-exports `function (pi: ExtensionAPI)`. Modules are imported concurrently, and their factories run in path order.
  Session actions throw if called during load.
- **API.** `on(event)`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerAssistantThinkingRenderer`,
  `registerAssistantTextRenderer`, `registerTranscriptPresenter`, `registerLinkScheme`, `registerComposerShape`, `sendMessage`, `sendUserMessage`, `appendEntry`,
  `exec`, `get/setActiveTools`, `setModel`, `setThinkingLevel`, `registerProvider` (including command-backed providers), `registerFileWriteFallback`,
  `registerFileDeleteFallback`. It injects `pi.zod`, `pi.arktype` (omptype) and legacy `pi.typebox`.
- **Context.** `ctx.ui.notify/custom`, `ctx.runEphemeralTurn` (side turns), `ctx.startLive`, managed `ctx.setInterval/setTimeout`,
  `ctx.models`, and `ctx.invokeTool`, which delegates to a native built-in and inherits its delegation guidance.
- **Events.**
  - Session: `session_start`, `session_before_switch/branch/compact/tree`, `session_switch/branch/compact/tree`, `session_shutdown`, `session_stop`.
  - Turn and message: `input`, `before_agent_start`, `context`, `before_provider_request`, `agent_start/end`, `turn_start/end`, `message_start/update/end`.
  - Tools: `tool_call` (can return `{block, reason}` or revised args), `tool_result`, `tool_execution_start/update/end`, `tool_approval_requested/resolved`.
  - Other: `before_subagent_spawn`, `auto_compaction_start/end`, `user_bash`, `user_python`, MCP notifications, and `resources_discover`.
- **Tool wrapping.** Registered tools are wrapped by `ExtensionToolWrapper`, which applies interception and the approval gate.
  Tools without a declared `loadMode` become `discoverable` (`xd://`), except built-in names, which stay pinned as essential (`essential-tools.ts`, issue #5764).

### 6.2 Hooks, custom tools, custom commands
- **Hooks** (`extensibility/hooks/*`) are the legacy `HookAPI`. Discovered hook files (for example `.omp/hooks/pre/*.ts`) now load through the extension runner. `--hook` is an alias for `--extension`.
- **Custom tools** (`extensibility/custom-tools/*`) are tool-only modules adapted into extension wrappers.
- **Custom commands** (`extensibility/custom-commands/*`) can be bundled: `review`, `annotate`, `ci-green`. Markdown slash commands come from every discovery provider.

### 6.3 Skills
`src/extensibility/skills.ts`, `docs/skills.md`.
- Skills are listed in the system prompt as `name: description`, with the instruction "Matching skill → MUST read `skill://<name>` first".
- They are read through `skill://` URLs, so the same read and search tools work on them. Skill reads are protected from pruning.
- Agents can `autoloadSkills`. Skillshare and marketplace integration live in `src/skillshare`, `/marketplace` and `/plugins`. The `learn` and `manage_skill` tools let the agent author isolated managed skills.

### 6.4 Plugins and marketplace
`extensibility/plugins/*`, `docs/marketplace.md`, `docs/plugin-manager-installer-plumbing.md`, `docs/gemini-manifest-extensions.md`.
- Installs Claude-style plugins (`claude-plugins.ts`), agent plugins, and Gemini manifest extensions.
- A compatibility shim keeps upstream pi extensions working (`legacy-pi-compat.ts`, `legacy-pi-*-shim.ts`).

### 6.5 Rules and TTSR
Rules come from every discovery provider and carry `globs`, `alwaysApply`, `description`, and TTSR `condition`, `astCondition` or `question`.
They are bucketed into `<generic-rules>` (always apply), `<domain-rules>` (listed with globs, readable via `rule://`), and TTSR stream rules.
`RULES.md` holds "sticky" rules that are carried on every request.

### 6.6 SDK, RPC, ACP
- **SDK**: `sdk.ts` `createAgentSession(options)` (`docs/sdk.md`).
- **RPC**: `docs/rpc.md`, with typed wire types in `packages/wire` and `modes/rpc/wire/rpc-wire.generated.ts`.
- **ACP** for editors.
- **Settings** are declared with `register({ id, type, default, ui: { tab, group, label, description } })`, as in `lsp/settings.ts`.
  The settings UI, CLI (`omp config set`) and docs all derive from these declarations.

---

## 7. TUI and UX

### 7.1 Renderer
`packages/tui/src/tui.ts`, `docs/tui-core-renderer.md`, `docs/tui-runtime-internals.md`.
- **History and viewport are separate.** The product installs a `TerminalFrameProvider` that returns `{ history?: HistoryBatch, viewport: string[] }` each frame.
  History batches have monotonic ids and are written exactly once, then acknowledged. Retries and coalesced renders are therefore safe without comparing scrollback.
  The viewport is diffed row by row against the previous frame. **Finality is an explicit application decision**, never inferred from a row scrolling off the top.
- **Append-only streaming.** Assistant and thinking blocks publish a monotonically extending prefix of stable rows to native scrollback. The open Markdown and partial suffix stay mutable.
- Overlays composite over the viewport and never become history. Writes use synchronized output (DEC 2026), and the hardware cursor is parked at the real content position.
- **Resize policy.** `ResizeScrollbackMode` is one of `rebuild`, `append` or `preserve`.
- **Performance.**
  - `tui.maxFps` frame ceiling, 1–120, with keystroke frames exempt (`frame-rate.ts`).
  - Off-thread native TTY writer with backpressure frame skipping (`tty_writer.rs`).
  - `loop-watchdog.ts`.
  - Kitty graphics and sixel with an image memory budget (`kitty-graphics.ts`, native `sixel_codec.rs`).
  - Native syntax highlighting (`highlight.rs`).
  - `Bun.stringWidth` and `Bun.wrapAnsi` for width math.
- **Rendering features.** Mermaid renders as ASCII (native `mermaid/`), SVG inline, LaTeX converts to Unicode, and Markdown tables auto-chart (`auto-graph`).
  The system prompt teaches the model these visual forms.

### 7.2 UX features
- **Keybindings** (`packages/tui/src/keybindings.ts`, `app-keybindings.ts`, user remaps in `~/.omp/agent/keybindings.yml`). Notable defaults:
  `Ctrl+P` cycle role model, `Alt+P` temporary model, `Alt+M` model selector, `Alt+Shift+P` plan mode, `Ctrl+O` expand tool output,
  `Ctrl+T` thinking visibility, `Shift+Tab` cycle thinking level, `Ctrl+G` external editor, `Ctrl+Q`/`Ctrl+Enter` queue a follow-up,
  `Alt+Up` dequeue, `F5`/`Alt+R` retry, `Alt+A` Agent Hub, `Ctrl+R` history search, `Space` push-to-talk, `Ctrl+L` live voice.
  Vim mode, a kill ring and an emacs-style editor are included.
- **Steering versus follow-up queues**, each with `all` or `one-at-a-time` modes. `Ctrl+C` recovers a cleared draft (bounded history of 100).
- **Agent Hub**: live roster of subagents with activity and cost, transcript viewer, steering, revive and kill.
- **Composer**: word prediction (`pi-predict`), magic-keyword animation, `^provider/model` mentions that create pseudonymous model agents `m1`, `m2`, and image paste including OSC 5522.
- **Status line** segments: cost with tariff arrow, context %, model, and so on. Desktop notifications. Startup splash.
- **Tool cards.** Each tool has a dedicated renderer in `packages/tui/src/tools/*`: grouped trees, diff previews, score gauges for `find`, and LSP cards.
  Intent captions come from the injected `intent` field.

---

## 8. System prompts

Prompts live in static `.md` files with Handlebars. `AGENTS.md` makes this a rule: "never build prompts in code". They are imported with
`import x from "./p.md" with { type: "text" }`. Judge questions are JSON files (`src/prompts/judge/*.json`) with criteria that define score, yes/no or choice answers.

### 8.1 Inventory
`packages/coding-agent/src/prompts/`:
- `system/` (110 files). The main ones are `system-prompt.md` (276 lines), `project-prompt.md`, `subagent-system-prompt.md`, `plan-mode-*.md`, `ttsr-*.md`,
  loop and stop recovery (`tool-call-loop-redirect.md`, `thinking-loop-redirect.md`, `empty-stop-retry.md`, `length-stop-retry.md`,
  `malformed-function-call-retry.md`, `stream-stall-continue.md`), `auto-continue.md`, snapcompact notes, and personalities (`default`, `friendly`, `pragmatic`).
- `tools/` (88 files): one description per tool, rendered live (for example, `read.md` changes with the edit mode).
- `agents/` (8), `advisor/` (6), `goals/` (6), `memories/` (9), `judge/` (7 JSON), `internal-urls/` (17 scheme docs), `security/`, `steering/`, `spotlight/`, and review templates.
- Edit-mode prompts and grammars live in Rust (`crates/pi-edit/prompts/*.md`, `grammars/*.lark`). Compaction prompts are in `packages/agent/src/compaction/prompts/`.
- Dialect prompts are in `packages/ai/src/dialect/*.md`.

### 8.2 Structure of the main prompt (`system-prompt.md`)
The prompt is compressed, RFC-2119 style ("MUST/NEVER"), with `§` section markers:
1. **Preamble.** RFC 2119 keyword definitions. XML tags inside user messages are treated as system-authored.
2. **§ Role**: "You are omp's trusted coding assistant." **# Engineering**: correctness, then six-month maintainability, then boring design. User-reported errors are ground truth.
   Visual output guidance covers mermaid, svg with theme CSS variables, and the auto-charted tables.
3. **# Personality** (pluggable).
4. **§ Runtime**:
   - skills list ("MUST read `skill://<name>` first");
   - `<generic-rules>` and `<domain-rules>`;
   - internal URL list;
   - tool inventory;
   - `xd://` device docs;
   - § Scratchpad (`think`).
5. **§ Tool Policy**:
   - Parallelize independent calls, and retry empty or narrow results differently.
   - When the user says "parallel", MUST use `task`.
   - Prefer specialized tools over shell. `lsp` is mandatory for code intelligence. Use `find` first when the location is unknown.
   - `<critical>`: "NEVER use `sed`|`perl`|`python` via bash to issue individual edits".
   - "NEVER open guessed files". Read ranges, not whole files. AST tools for codemods. ovnfs checkouts instead of `git worktree add`.
   - **# Delegation** (biased by `delegationBias`: gated, eager or inline-first):
     "NEVER open with a scout… NEVER delegate one slice… NEVER babysit".
     Agents lack the conversation, so give them full requirements. Fan out in one `tasks[]` batch.
6. **§ Workflow**:
   1. Scope.
   2. Research before editing: reuse patterns, run `lsp references` before changing an exported symbol.
   3. Decompose with todos, never as a todo-only turn.
   4. Implement: ask before destructive commands.
   5. Verify. The main agent needs a mandatory smoke run ("Tests alone are not proof"), and there are strong anti-test-bloat rules ("NEVER test wiring/copies/forwarding/mock echoes…").
      Subagents are told NOT to verify and to name the checks for the main agent, because parallel builds "storm the CPU".
   6. Cleanup: docs and changelog, remove scaffolds.
7. **§ Delivery** blocks:
   - `<contract>`: never fabricate (unobserved claims get `[INFERENCE]`), no scope creep, clean cutover with no shims.
   - `<completeness>`: no stubs, MVPs or TODOs, and never shrink scope silently.
   - `<evidence-and-output>` and `<yielding>`.
8. **§ Critical**: never yield while actionable work remains, never narrate token or budget limits, never re-audit applied edits with git.

`project-prompt.md` appends `<project-context>`:
- `<workstation>` (env, model);
- `<repo-rules>` (context files: AGENTS.md, CLAUDE.md and the rest);
- `<dir-context>` (nested AGENTS.md files to read before touching those directories);
- `<workspace-tree>` (depth 3, newest first);
- `<workspace-roots>` and the active repo context.

It tells the model never to grep for AGENTS.md, since those files are already loaded. User overrides: `SYSTEM.md`, `SYSTEM_TEMPLATE.md` (Handlebars), `APPEND_SYSTEM.md`, and the
`--system-prompt`, `--system-prompt-template` and `--append-system-prompt` flags (`docs/system-prompt-customization.md`).

### 8.3 Other prompt patterns worth noting
- System interrupts are XML: `<system-interrupt reason="tool_call_loop_detected">`. Identical repeated calls trigger a "NEVER call X with those arguments again".
- Subagent prompt sections are `§ Role`, `§ Context` (the shared batch `context`), `§ Plan` (the approved plan inlined), and `§ Coop` (worktree and IRC peer etiquette).
- Plan mode: "decision-complete > brevity". Unverified claims are marked `unverified — confirm first`, and questions get 2–4 options with a recommended default.

---

## 9. Assessment

### 9.1 Strengths worth copying (ranked)

1. **Snapshot-tagged, line-anchored edits (hashline) with a seen-lines guard.**
   - The model references `[path#TAG]` plus original line numbers instead of retyping old text. This removes the "string not found" retry loop and
     cuts output tokens, which is the biggest measured win in the README.
   - The safety comes from content tags, seen-line enforcement and conservative stale-tag recovery.
   - Keep a `replace` fallback for models that do badly with the DSL. omp routes per model.
2. **Make `read` the one entry point, with selectors in the path and structural summaries.** One tool covers files, ranges, tails, archives, SQLite,
   JSON/jq, PDFs, images, URLs and internal schemes. Summaries with explicit elided-range footers save context and teach the model exactly what to re-read.
   Path recovery (unique suffix match, Unicode variants) removes a whole class of wasted turns.
3. **A stable prompt prefix built for caching.** Static blocks come first and cwd-specific ones last. The context is append-only. Tool fingerprints are stable.
   Rarely used tools are lazy-mounted as `xd://` devices. Pruning respects cache lookback, and compaction is timed to the cache TTL. All of this lowers cost on long sessions. Cheap to adopt early, painful to retrofit.
4. **Tool metadata that drives the scheduler**: `concurrency: shared | exclusive`, `interruptible`, approval tiers, `useless` result flags, and `intent` captions.
   Parallel reads with serialized edits, steering that never kills side effects, and compaction that knows which results are noise all come from small declarations.
5. **Subagents with schemas, addressable outputs and isolation.** `task` takes a batch with shared `context`, children must call `yield` with schema-validated
   output, results are URLs (`agent://id/path`), sibling cache keys are shared, copy-on-write isolation is available, and runs can launch speculatively while the call streams.
6. **LSP writethrough on every edit**: inline diagnostics after each write, rename through `willRenameFiles`, and shared warm servers through a mux daemon.
   This is the main thing that makes the agent "IDE-grade".
7. **TTSR stream rules.** Regex or AST rules that abort and inject only when the model goes off-script, so rules cost context only when they fire.
8. **Compaction as an ordered strategy list with guards**: summary, handoff, shake (artifact refs), mid-turn compaction, the "never cut at toolResult" rule,
   split-turn summaries, and a progress guard that blocks loops. A display transcript that keeps scrollback while the LLM context resets is a UX win.
9. **Native search plus an in-process shell.** Rust grep, glob and walker, with ignore-aware caching and chunked search. The same engines serve the bash builtins, so the agent never depends on host `rg`/`fd`.
   For rcode on Bun, consider NAPI ripgrep-style bindings, or at minimum bundle `rg`.
10. **Prompts as static Handlebars `.md` files.** Each tool's description is rendered from live settings. Judge questions live in JSON. This keeps prompts reviewable and diffable, and allows per-model variants.
11. **Explicit history/viewport TUI contract** with an off-thread writer and an FPS cap. Rows that the app has explicitly finalized go to native scrollback, so terminal selection and search work, and the redraw is diffed.
12. **Reading other tools' config in place** (Claude, Cursor MDC, Cline, Codex AGENTS.md, Copilot `applyTo`, Windsurf, Gemini, OpenCode). Adoption is frictionless.
13. **Recovery prompts for known failure modes**: tool-call loops, thinking loops, empty stops, length stops, malformed function calls, stream stalls, Harmony/DSML leaks, unpaired tool tails.
14. **Model roles** (`default/smol/slow/plan/commit/tiny/judge/advisor`), fallback chains and context promotion. Routing goes by intent instead of one global model.

### 9.2 Weaknesses and gaps (ranked)

1. **Extreme complexity and god objects.** `agent-session.ts` is 15,880 lines, `interactive-mode.ts` 9,970, `sdk.ts` 5,981, `session-maintenance.ts` 6,560, and `task/executor.ts` 5,564.
   The coding-agent package alone is about 558k lines. Docs exist because the behavior is otherwise undiscoverable. The settings matrix is huge (`docs/settings.md` is 1,205 lines), and
   feature interactions (plan × vibe × goal × prewalk × advisor × TTSR × snapcompact) multiply the test burden. rcode should keep a small core and push features into extensions.
2. **The default approval mode is `yolo`**, and subagents are forced to `yolo`. `docs/bash-tool-runtime.md` itself says pattern approval "is not containment".
   There is no sandbox (no seatbelt or landlock profile) by default. That is a security gap for an open-source tool.
3. **Feature sprawl into heavyweight, niche subsystems**: snapcompact bitmap archives, IDA integration, live voice and WebRTC, a desktop computer-use tool,
   a browser relay, collab relay, TTS and image generation, Codex Security scans, and a bundled bash 5.3 reimplementation. Each is impressive, but they raise binary size, the build matrix
   (Bazel, Nix and napi across platforms) and the maintenance load. Several depend on proprietary or Stencil-hosted services (relay, `build.stencil.so`, TypeSafe judge models, `my.omp.sh`).
4. **Semantic `find` and auto-thinking depend on a specific judge model** (TypeSafe System One). Without it, `find` is disabled and auto-thinking falls back. A local embedding index would be a more portable design.
5. **The hashline DSL is novel syntax models must learn.** It needs per-model fallbacks (`replace` for several families), a compact variant, constrained-decoding grammars, and many recovery heuristics ("the parser has limited recovery for common model slips").
   Snapshot tags also make edits depend on prior reads, so tools and subagents that write without reading need `write` or fresh reads.
6. **Reimplementing bash** (`pi-shell`, with the VM and builtins) risks subtle POSIX incompatibilities. It is a large correctness surface compared with spawning the user's real shell plus a fast path for common read-only commands.
7. **The upstream minimalism is gone.** Pi's selling point was a tiny, hackable core. omp has a compat shim, but its own APIs (`ExtensionAPI` is a 2,515-line type file) are hard to learn.
   Legacy layers (hooks to extensions, typebox to zod to arktype/omptype, flat vs batch task shapes) add confusion.
8. **Prompt style is very compressed and MUST/NEVER-heavy.** It works for frontier models, but it is brittle, hard for contributors to reason about, and may over-constrain smaller models.
   Many behaviors are encoded only in prompt prose.
9. **Startup and resource cost.** Many background subsystems: LSP warmup, cache warmers, advisors, memory consolidation, job managers, idle compaction timers. A heavy native addon. Some features need a long-running daemon (lspmux, launch broker).
10. **Docs describe behavior at the level of individual conditions.** That is great for contributors, but it signals that behavior is hard to change safely. Many sentences read like accumulated bug-fix rationale (issue numbers inline).

### 9.3 Recommendations for rcode (TypeScript/Bun)
- **Copy first:**
  - read-with-selectors plus snapshot-tag edits with a replace fallback;
  - tool metadata (concurrency, interruptible, approval tier, useless, intent);
  - static-prefix caching discipline and lazy tool devices;
  - task/yield with JSON-Schema outputs and `agent://` URLs;
  - compaction with method order and progress guard;
  - LSP diagnostics on write;
  - loop-detection interrupts;
  - prompts as Handlebars `.md`.
- **Skip or defer**: snapcompact, the custom bash engine, voice, collab relay, IDA, computer use, and the judge-model `find`. Use ripgrep plus an optional embedding index instead.
- **Do better**: secure-by-default approval (ask on exec, with a sandbox profile), a small core with features as first-party extensions, and session/agent orchestration split into small modules from day one.

---

## 10. The 20 most important source files

| # | Path | Why it matters |
|---|---|---|
| 1 | `packages/agent/src/agent-loop.ts` | The core loop: steering and follow-up queues, soft tool requirements, shared/exclusive tool scheduling, interrupts, unpaired-tail resume, recovery nudges |
| 2 | `packages/agent/src/agent.ts` | `Agent` class: state, queues (steer/followUp), model and thinking setters, subscriptions, append-only context hookup |
| 3 | `packages/agent/src/speculative-execution.ts` | Runs finalized tool calls while the assistant message is still streaming (assess/execute/commit/discard) |
| 4 | `packages/agent/src/append-only-context.ts` | StablePrefix plus AppendOnlyLog for maximal provider prefix-cache hits |
| 5 | `packages/agent/src/compaction/compaction.ts` | Cut-point selection, split-turn summaries, incremental summary updates, handoff generation |
| 6 | `packages/coding-agent/src/session/agent-session.ts` | God object tying the agent to persistence, compaction, TTSR, retries, plan mode, advisors and memory |
| 7 | `packages/coding-agent/src/session/session-manager.ts` | JSONL tree storage, leaf pointer, blobs, fork/branch, title slot |
| 8 | `packages/coding-agent/src/sdk.ts` | `createAgentSession()`: wiring of tools, rules/TTSR, discovery, subagent routers. The embedding API |
| 9 | `packages/coding-agent/src/tools/index.ts` | Tool registry (`BUILTIN_TOOLS`, `HIDDEN_TOOLS`), the `ToolSession` contract, settings-gated tool plans |
| 10 | `packages/coding-agent/src/tools/read.ts` | Universal reader: selectors, summaries, hashline headers, path recovery, speculative reads |
| 11 | `packages/coding-agent/src/edit/index.ts` | Edit tool front-end: mode selection, native EditSession bridge, LSP writethrough, parse-regression and auto-repair |
| 12 | `crates/pi-edit/src/modes/hashline/apply.rs` (with `parser.rs`, `recovery.rs`) | Hashline application, block anchors, registers, stale-tag recovery |
| 13 | `crates/pi-edit/src/fuzzy.rs` | Matching ladder, banded and bit-parallel Levenshtein, dominant-hit logic for replace/patch/sloppy |
| 14 | `packages/coding-agent/src/task/executor.ts` (with `task/index.ts`) | Subagent spawning, child sessions, yield/schema finalization, isolation, lifecycle |
| 15 | `packages/coding-agent/src/lsp/writethrough.ts` (with `lsp/client.ts`) | Sync overlay, write, format, diagnostics on every mutation. The LSP client process lifecycle |
| 16 | `packages/coding-agent/src/system-prompt.ts` + `src/prompts/system/system-prompt.md` | Prompt assembly (static versus project blocks, context files, skills, rules, tool inventory) and the main instructions |
| 17 | `packages/coding-agent/src/extensibility/extensions/runner.ts` (with `types.ts`) | Extension event bus, tool wrapping and interception, UI integration |
| 18 | `packages/coding-agent/src/session/ttsr-coordinator.ts` | Stream-rule matching, abort, inject and retry |
| 19 | `packages/coding-agent/src/config/model-registry.ts` (with `packages/catalog/src/models.json`, `effort.ts`) | Model catalog merge, custom providers, discovery, roles, thinking mapping |
| 20 | `packages/tui/src/tui.ts` (with `crates/pi-natives/src/tty_writer.rs`) | History/viewport frame contract, diffed rendering, off-thread terminal writes |

Honorable mentions:
- `packages/coding-agent/src/tools/jfind/cascade.ts` (semantic find);
- `packages/coding-agent/src/tools/xdev.ts` (tool devices);
- `packages/coding-agent/src/internal-urls/router.ts` (URL schemes);
- `packages/ai/src/dialect/factory.ts` (tool-call dialects);
- `packages/coding-agent/src/session/turn-recovery.ts` (retry and recovery policy);
- `crates/pi-shell/src/minimizer.rs` (shell output compression);
- `packages/snapcompact/src/snapcompact.ts`.
