# jcode: Deep-Dive Research Report

Source: `/Users/rudycelekli/Downloads/rcode/reference/jcode` (1jehuang/jcode, MIT, Rust 2024 edition,
package version `0.99.1`, shallow clone, HEAD dated 2026-11-08). Tagline: "High-performance coding
agents. Run dozens of agents in parallel without melting your machine." YC S26 company.

All paths below are relative to the repo root unless absolute.

---

## 0. TL;DR

- **One long-lived daemon hosts every agent.** `jcode serve` owns all sessions, providers, the MCP
  pool, swarm state and file-touch tracking, and listens on a Unix socket. TUIs are thin clients
  that reconnect when the connection drops. A swarm "worker" is an in-process `Agent` struct
  inside a tokio task (`Arc<Mutex<Agent>>`), not a child process. That design explains the
  headline number: about **3.3 MB per additional session** versus 170 to 195 MB for Claude Code
  or Codex (those run one process per session). See the README bench and
  `scripts/bench_headless_memory.py`.
- **Memory discipline is treated as a product feature.** The repo tunes jemalloc and glibc malloc,
  drops transcript snapshots as soon as a provider request is sent, caps every cache, hibernates
  idle sessions (discards derived caches), tracks a documented memory budget, and exposes debug
  memory-attribution endpoints.
- **Agent loop:** a provider-agnostic `EventStream` drives a turn loop
  (`crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs`). Cancellation uses `tokio::select!`
  on a `graceful_shutdown` signal. Tools run in spawned tasks and are **auto-backgrounded after
  3 s** by default. New user input is queued as a **soft interrupt** and injected at safe points,
  so it never cancels the turn.
- **Swarm:** a `swarm` tool (spawn, DM, broadcast, channels, plan, await_members). There are
  **no locks or worktrees in practice**. The server watches `FileTouch` bus events. When agent A
  modifies a file that agent B previously touched, the server queues a soft-interrupt alert for
  both sides. Inside the daemon, a per-path tokio mutex serializes read-modify-write edits.
- **Providers:** direct, hand-rolled transports for Anthropic (including Claude Max OAuth through
  the "Claude Code OAuth contract"), OpenAI Responses (including ChatGPT/Codex OAuth and WebSocket
  v2 with prewarm), Gemini Code Assist OAuth, Copilot, Cursor, Antigravity, Bedrock, Azure,
  OpenRouter, and many OpenAI-compatible presets. Model routes take a prefix
  (`claude-oauth:`, `claude-api:`, `jcode:`, `openrouter:`). There is a multi-account pool with
  priority tiers and automatic failover.
- **Surfaces:** ratatui TUI, `jcode run` headless, a debug socket, a versioned "harness API"
  (NDJSON) with Rust and TypeScript SDKs, an ACP (JSON-RPC) server mode, and MCP client support
  (stdio pool plus remote HTTP/SSE with OAuth). Self-update ships through GitHub releases with
  channels. The project is huge: about **946K lines of Rust** across about 90 workspace crates,
  about 309K of them in test files.

---

## 1. Architecture

### 1.1 Crate layout

Root `Cargo.toml` declares a workspace of about 90 crates. The root crate is thin: `src/main.rs`
(241 lines), `src/lib.rs` and `src/cli/**` (about 51K lines: arg parsing, login, ACP, cloud, SSH,
self-dev). The weight lives in three "spine" crates:

| Crate | Approx. LOC | Role |
|---|---:|---|
| `crates/jcode-tui` | 278K | ratatui client, app state, rendering, info widgets, pickers |
| `crates/jcode-app-core` | 191K | `Agent`, server/daemon, tools, swarm, update, ambient |
| `crates/jcode-base` | 163K | session storage, providers/auth, MCP, memory, compaction, config, prompt, bus |
| `jcode-provider-*-runtime` | 2K to 16K each | per-provider HTTP/WS runtimes (anthropic, openai, gemini, copilot, cursor, openrouter, antigravity, grok-build) |
| `jcode-sdk` / `jcode-harness-api(-server)` | 14K / 4K / 11K | client SDK, stable v1 protocol, bridge |
| `jcode-protocol` | 7K | internal client/daemon wire protocol (`Request`/`ServerEvent`, 92 request variants) |
| `jcode-tui-markdown`, `jcode-tui-mermaid`, `jcode-render-core` | 10K / 13K / 5K | markdown + syntect, mermaid to PNG, LaTeX |
| `jcode-telemetry-core` | 8K | telemetry client |
| `jcode-command-risk` | 3K | bash destructive-command classifier |
| `jcode-codemode` | small | QuickJS sandbox for the `codemode` tool |
| `*-types` crates | small | serde DTOs (session, memory, tool, usage, side-panel, ...) |

`docs/CRATE_OWNERSHIP_BOUNDARIES.md` states the motivation openly. Crates are split **for compile
speed** (shrinking the root crate's recompile surface), not for architectural purity. Rules:
`*-types` crates may depend only on serde, chrono and other type crates, which
`scripts/check_dependency_boundaries.py` enforces. Provider runtimes were moved out of
`jcode-base` so that "provider edits compile only this crate plus a binary relink" (see header of
`crates/jcode-provider-cursor-runtime/src/lib.rs`). Runtimes register into
`jcode_base::provider::external` at the composition root.

Build profiles (`Cargo.toml`): `release` uses **`opt-level = 1`, `codegen-units = 256`** (fast
builds). `release-lto` uses thin LTO. The `selfdev` profile uses `opt-level = 0`. The animation
crate `jcode-tui-anim` is pinned to `opt-level = 3` even in dev, because the decorative donut
animation otherwise dominates idle CPU.

### 1.2 Process model: a single daemon with many clients

From `docs/SERVER_ARCHITECTURE.md` and `crates/jcode-app-core/src/server.rs`:

```
jcode serve  (daemon, setsid-detached)
 ├─ /run/user/$UID/jcode.sock        main socket (newline-delimited JSON)
 ├─ /run/user/$UID/jcode-debug.sock  debug/test socket
 ├─ jcode-daemon.lock                flock: one daemon per socket
 ├─ ~/.jcode/servers.json            registry (server gets an adjective name: "blazing")
 ├─ Provider template (forked per session)
 ├─ SharedMcpPool (one process per MCP server, shared by ALL sessions)
 └─ Sessions: fox, bear, owl ...      (Arc<Mutex<Agent>> per session)
```

- Running `jcode` with no server present spawns `jcode serve` detached via `setsid()`, waits for
  the socket, then connects. Killing a client never affects the server or other clients.
- **Idle shutdown:** 5 minutes with no clients and no live headless swarm workers
  (`IDLE_TIMEOUT_SECS = 300` in `crates/jcode-app-core/src/server.rs`, checked every 10 s).
- **Hot reload:** `/reload` makes the server `exec()` into the new binary (same PID, same socket).
  Clients reconnect with exponential backoff (1 s to 30 s) and resume their session from disk.
  A `RestartSnapshot` (`crates/jcode-app-core/src/restart_snapshot.rs`) records which sessions to
  auto-restore, including after crashes less than 24 h old.
- **`jcode run`** (headless one-shot) builds an `Agent` **in-process** with no server. Only the
  `swarm` tool needs a daemon. In that case `server_spawn::register_on_demand_server_spawner`
  lazily starts `jcode serve --temporary-server --owner-pid <pid>`, which exits about 10 s after
  the owning run ends.
- **Ownership markers:** `~/.jcode/active_pids/<session_id>` holds the owning PID (the daemon PID
  in server mode). `streaming_pids` markers separately track active generation, which feeds
  presence UIs such as the macOS menu-bar indicator.
- **Remote working dir:** the client sends its cwd on subscribe. `--remote-working-dir` decouples
  client and server paths for SSH-forwarded sockets (`src/cli/ssh_transport.rs`, `NATIVE_SSH.md`).
- Transport is abstracted by `crates/jcode-transport` (Unix socket on Unix, named pipe on Windows,
  same API).

### 1.3 Why many agents are cheap: concrete techniques

1. **In-process agents, not processes.** `create_headless_session`
   (`crates/jcode-app-core/src/server/headless.rs`) calls `provider_template.fork()`,
   `Registry::new(provider)`, `Agent::new_with_parent_and_initial_working_dir(...)`, and stores the
   result in the shared `SessionAgents` map. A worker therefore costs one `Agent` struct, its
   transcript, and a tool registry (`HashMap<String, Arc<dyn Tool>>`). No new runtime, no new
   HTTP client stack, and no new MCP children. One multi-thread tokio runtime
   (`src/main.rs:140`) serves everything.
2. **Shared MCP pool** (`crates/jcode-base/src/mcp/pool.rs`): "Instead of each session spawning
   its own set of MCP servers (N sessions x M servers = N x M processes), sessions share a single
   pool (M processes total)." Sessions hold cheap `McpHandle` clones. Requests are correlated by
   JSON-RPC id, and failed connects get a 30 s cooldown.
3. **Allocator tuning** (`src/main.rs`):
   - jemalloc (optional feature): `malloc_conf = "dirty_decay_ms:1000,muzzy_decay_ms:1000,narenas:4"`.
     The comment records that default settings caused 1.4 GB RSS.
   - glibc fallback: `mallopt(M_ARENA_MAX, 4)` and a pinned `M_MMAP_THRESHOLD = 256 KiB`, so large
     transient buffers (history JSON, provider payloads) are mmapped and returned to the OS on free.
     Both values are env-tunable (`JCODE_GLIBC_ARENA_MAX`, `JCODE_GLIBC_MMAP_THRESHOLD`).
4. **Drop request snapshots early.** In `turn_streaming_mpsc.rs`, once `complete_split` returns
   the stream, the code explicitly `drop`s `stamped`, `messages_with_memory`, `memory_pending`,
   `messages` and `split_prompt`. It also calls `self.session.release_provider_messages_cache()`
   before the network wait: "Do not retain the session's second, derived copy for the entire
   network wait and response stream."
5. **History caps on tool output** (`cap_tool_output_for_history`) and a **context-overflow
   guard** that *refuses* oversized tool output instead of truncating it
   (`Registry::guard_context_overflow` in `crates/jcode-app-core/src/tool/mod.rs`). The model must
   narrow the query or re-call with `accept_large_output: true`.
6. **Idle hibernation** (`docs/SESSION_HIBERNATION.md`, `agent/idle_hibernation.rs`,
   `server/idle_hibernation.rs`). After 30 min idle (`[session] hibernation_idle_secs = 1800`), the
   daemon drops idle sessions' provider-message caches and tool-output indexes, and the TUI drops
   prepared frames, highlight caches, the markdown renderer and image state. Authoritative state
   stays. One sweep purges retained heap. Measured: a 64 MiB provider-cache fixture released
   about 63 MiB RSS.
7. **Hard-capped caches with a written memory budget** (`docs/MEMORY_BUDGET.md`):
   markdown highlight cache <= 256 entries, mermaid render cache <= 64, image-state <= 12,
   on-disk PNG cache <= 50 MiB / 3 days. Changing any cap requires a doc update in the same PR.
8. **Memory attribution as an operability feature:** `:debug memory`, `agent:memory`,
   `server:memory-incident`, and a runtime memory log (`crates/jcode-base/src/runtime_memory_log.rs`)
   with a timeline analyzer script (`scripts/analyze_runtime_memory_log.py`).
9. **Bounded swarm capacity:** `swarm_max_concurrent_agents = 32` by default (hard cap 1000),
   a stalled-worker watchdog (600 s), and idle-worker reaping.
10. **Render-side frugality:** unfocused or deep-idle TUIs stop decorative animation and drop the
    tick rate to 5 s (`crates/jcode-tui/src/tui/redraw_schedule.rs`). The code comment says
    a swarm of unfocused sessions would otherwise each render a 3D scene "saturating every core".
11. **No embedding model by default.** The ONNX embedding stack (about 87 MB) moved behind the
    opt-in `embeddings` feature, and memory recall became a remote "Jev decisions" call (section 6).

**Caveat on the benchmark.** The README compares N headless sessions *inside one jcode daemon*
with N separate `claude -p` processes (`scripts/bench_headless_memory.py`). The comparison is
honest, but the win is architectural (process-per-session versus task-per-session), not
micro-optimization. rcode can get the same win in Bun by hosting agents as objects inside one
daemon process.

---

## 2. Agent loop, streaming, tools, cancellation, paths

### 2.1 Agent struct

`crates/jcode-app-core/src/agent.rs` (`pub struct Agent`, line about 266) holds: `provider:
Arc<dyn Provider>`, `registry: Registry`, `session: Session`, a skills registry, allowed and
disabled tool sets, `soft_interrupt_queue`, `background_tool_signal`, `graceful_shutdown`
(an `InterruptSignal`), `cache_tracker`, `kv_cache_monitor`, `locked_tools`, `agents_md_snapshot`,
`prompt_skills_snapshot`, `pending_alerts`, and more. The agent submodules live in
`crates/jcode-app-core/src/agent/` (`turn_streaming_mpsc.rs` 1851 lines, `turn_execution.rs`,
`turn_loops.rs`, `response_recovery.rs` 1144 lines, `compaction.rs`, `interrupts.rs`, ...).

### 2.2 Turn loop (`run_turn_streaming_mpsc`)

Pseudocode reconstructed from `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs`:

```
enter runtime_activity session guard; take session lease
StreamingGuard (presence) ; register turn in turn_cancel_registry (global, by session id)
loop {
  if graceful_shutdown -> break          // never open a new request after cancel (#732)
  if session migrated -> break
  repair_missing_tool_outputs()           // synthesize missing tool_result blocks
  tools = tool_definitions()  (locked snapshot for cache stability)
  split_prompt = build_system_prompt_split()   // static part + dynamic part
  provider.prewarm(tools, static)              // e.g. OpenAI WS prewarm
  (messages, compaction_event) = messages_for_provider()   // may apply background compaction
  memory_pending = build_memory_prompt_nonblocking_shared(...)  // last turn's async result
  record_client_cache_request(messages)        // detect append-only violations
  session.release_provider_messages_cache()
  messages_with_memory = messages + [memory as trailing user msg]   // preserves cache prefix
  select! { keepalive tick | graceful_shutdown -> return | complete_split(...) -> stream }
     on context-limit error: auto-compact and retry (bounded MAX_CONTEXT_LIMIT_RETRIES)
  drop(request snapshots)
  loop { select! { keepalive | graceful_shutdown -> break | stream.next() } ... accumulate
         TextDelta / Thinking / ToolUseStart / ToolInputDeltaFor / ToolUseEnd / usage }
  append assistant message; persist
  for each tool_call (sequentially):
     validate (malformed -> error tool_result, counts toward malformed-round bound)
     validate_tool_allowed
     spawn tool task via runtime_activity::spawn_session(registry.execute(...))
     select! (biased) { tool done | wait_for_tool_handoff(bg signal, shutdown, 3s budget) }
        -> done: cap output, emit ToolDone, add tool_result (+duration)
        -> reload: abort, write "[interrupted by server reload]" results for remaining tools, save, return
        -> budget/Alt+B: adopt into background manager, tool_result says "moved to background (task_id ...)"
  inject soft interrupts at safe point; continue loop if tools ran / continuation needed
}
```

Notable behaviors:

- **Stream events** (`crates/jcode-message-types/src/lib.rs` `StreamEvent`): `TextDelta`,
  `TextSuffixReplace`, `ToolUseStart`, `ToolInputDelta` and `ToolInputDeltaFor{id}` (keyed so that
  parallel calls stream independently), `ToolUseEnd(For)`, `ToolUseSignature(For)` (Gemini thought
  signatures), `ToolResult` (provider-executed tools), `GeneratedImage`, `ThinkingStart` / deltas,
  usage, and others.
- **Keepalive ticker** sends events to clients during long waits, so UI liveness is decoupled from
  provider cadence.
- **Recovery logic:** incomplete-turn continuations, empty post-tool continuations, malformed
  tool-call rounds, a "stranded tool use" stop-reason, and `TurnStopped{LimitReached}` when
  continuations run out (`tool_handoff.rs::incomplete_turn_stop`).
- **Tool calls within a turn execute sequentially** (the `tool_index` loop). Parallelism is
  explicit, through the `batch` tool (up to 10 concurrent sub-calls) or `codemode`
  (`Promise.all` in QuickJS).

### 2.3 Tool execution pipeline (`Registry::execute`, `crates/jcode-app-core/src/tool/mod.rs:989`)

1. `runtime_activity` guard plus `inflight::mark_tool_in_flight(tool_call_id)`, so the repair path
   does not mistake a slow tool for a lost one and inject a duplicate result.
2. Name resolution: strip `functions.` and map OAuth or Claude Code aliases
   (`jcode_tool_types::resolve_tool_name`). Unknown tools return "Did you mean: ...? Available
   tools: ..." instead of a bare error (issue #104, models hallucinating `ToolSearch`).
3. Session policy (allowed/disabled sets, MCP gating, SDK custom callback tools).
4. Hooks: `pre_tool_transform`, then the `pre_tool` gate (exit 2 or JSON deny blocks, and it can
   rewrite input or attach context), then execute, then `post_tool` (observer) and
   `post_tool_feedback` (output fed back to the model). Configured in `[hooks]`, see `docs/HOOKS.md`.
5. Structured lifecycle logging (`TOOL_LIFECYCLE` events include `touched_paths`, which are parsed
   from `file_path`/`path`/`paths` and from `apply_patch` headers).
6. Telemetry `record_tool_execution`.
7. `guard_context_overflow`: refuse output above a threshold of remaining budget, state the price,
   and allow `accept_large_output`.

### 2.4 Background handoff (3 s default)

`crates/jcode-app-core/src/agent/tool_handoff.rs` plus `[tools] auto_background_timeout_ms = 3000`
(`crates/jcode-base/src/config/default_file.rs:430`). Any tool still running after 3 s is
*adopted* by `crate::background::global()` without being killed. The model receives a tool_result
with a `task_id` and `BACKGROUND_WAIT_GUIDANCE` ("make progress on other useful work ... do not
duplicate the running task"). The `bg` tool exposes `wait` and `output` for these tasks. The
exceptions are `ask_user` and `bg action=wait`, which stay foreground. Users can force a handoff
with **Alt+B**. Bash emits `JCODE_PROGRESS` and `JCODE_CHECKPOINT` markers plus heuristic progress
parsing (percentages, "x/y", byte ratios) to drive progress cards
(`crates/jcode-app-core/src/tool/bash.rs`).

### 2.5 Cancellation

- `graceful_shutdown: InterruptSignal` is awaited in every `select!` (before the stream opens,
  during streaming, and during tool waits). It is checked at the loop head so that no new request
  starts after Esc.
- `turn_cancel_registry::register_active_turn(session_id, signal)` is a **process-global
  registry**, so a cancel routed through *any* control handle for the session aborts the in-flight
  stream. This fixed stale handles after reattach or reload (issue #428).
- On reload, tool tasks are aborted, but `bash` gets a 750 ms grace period. Wait-like tools
  (`bg wait`, `swarm await_members`) return a "resume by rerunning the same call" message instead
  of an error.
- Bash children run in their own process group, and `ProcessGroupKillGuard` sends `SIGKILL` to
  the group on drop.
- **Soft interrupt** (`docs/SOFT_INTERRUPT.md`, `crates/jcode-agent-runtime`): user messages typed
  mid-turn, swarm DMs and file-conflict alerts are queued in a `std::sync::Mutex` queue and
  appended to history at safe points (after the assistant message is recorded, between tools,
  after tools). They never cancel the turn, and the prompt-cache prefix is preserved.

### 2.6 File paths

- `ToolContext.resolve_path` (`crates/jcode-tool-core/src/lib.rs:141`) keeps absolute paths as-is
  and joins relative paths onto the session `working_dir`. The daemon **never chdirs**, because one
  process hosts sessions in many repos. Every session carries its own working dir (and an
  `original_working_dir`).
- There is no path sandbox. Absolute paths anywhere are allowed.
- `file_lock.rs`: per-canonical-path `tokio::sync::Mutex` held across read-modify-write.
  `lock_all` sorts paths so multi-file edits cannot deadlock. Map entries nobody holds are pruned.
  The lock exists because `batch` runs edits concurrently. Since every session lives in one
  daemon, it also serializes edits across agents.

---

## 3. Providers, OAuth, model routing

### 3.1 Provider abstraction

`crates/jcode-provider-core/src/lib.rs:81` `trait Provider`: `complete(messages, tools, system,
resume_session_id) -> EventStream`, `complete_split(..., system_static, system_dynamic, ...)`
(the default implementation folds the dynamic part into messages), `prewarm(tools,
system_static)`, `fork()` (cheap per-session clone), `name/model`, credential introspection
(`active_resolved_credential` returns `ApiKey` or `Oauth`), and `set_oauth_account(label)`.
`MultiProvider` (`crates/jcode-base/src/provider/multi_provider.rs`) multiplexes runtimes and
handles account selection and failover.

Implemented providers: Anthropic (API key and Claude OAuth), OpenAI (API key and ChatGPT/Codex
OAuth, Responses API, WebSocket v2), Gemini (Code Assist OAuth), GitHub Copilot (token exchange,
premium-request modes), Cursor (direct ChatService over HTTP/2), Antigravity, Grok build, AWS
Bedrock, Azure OpenAI (Entra ID or key), OpenRouter, a "jcode" managed subscription gateway, and
OpenAI-compatible presets (Fireworks, Novita, MiniMax, and others) plus arbitrary profiles via
`jcode provider add <name> --base-url ... --api-key-stdin`.

### 3.2 Subscription OAuth: how it uses Claude and ChatGPT plans (`OAUTH.md`)

**Claude Max/Pro.** Run `jcode login --provider claude` (stored in `~/.jcode/auth.json`), or reuse
existing credentials after asking: `~/.claude/.credentials.json`, the macOS Keychain item
`Claude Code-credentials` (copied once into `~/.jcode/auth.json` to avoid repeat Keychain
prompts), `CLAUDE_CODE_OAUTH_TOKEN`, OpenCode or pi auth files. Requests impersonate the
**"Claude Code OAuth contract"**:

- `POST /v1/messages?beta=true`, `User-Agent: claude-cli/1.0.0`,
  `anthropic-beta: oauth-2025-04-20,claude-code-20250219`
- First system block: `You are Claude Code, Anthropic's official CLI for Claude.`
- Tool-name remap on the wire: `bash`->`Bash`, `read`->`Read`, `write`->`Write`, `edit`->`Edit`,
  `glob`->`Glob`, `grep`->`Grep`, `subagent`->`Agent`, `schedule`->`ScheduleWakeup`,
  `skill_manage`->`Skill`. Responses are mapped back, and other tools pass through under their own
  names.
- The old `claude` CLI subprocess transport has been removed.
- There are probe scripts and dated docs for this: `scripts/anthropic_oauth_identity_probe.py`,
  `docs/ANTHROPIC_OAUTH_IDENTITY_PROBE_2026_11_05.md`.

**ChatGPT/Codex.** Run `jcode login --provider openai` (PKCE flow, callback at
`localhost:1455/auth/callback`, paste fallback, stored in `~/.jcode/openai-auth.json`), or reuse
`~/.codex/auth.json` after a trust prompt. Subscription requests go to
`https://chatgpt.com/backend-api/codex/responses` with `originator: codex_cli_rs` and
`chatgpt-account-id`. API keys use `/v1/responses` (the base is overridable via
`JCODE_OPENAI_API_BASE`). It even implements **banked Codex rate-limit reset redemption**
(`/reset usage limits openai`, a two-step confirm, an idempotent `redeem_request_id`).

**Gemini.** Native Google OAuth against the Code Assist backend (`~/.jcode/gemini_oauth.json`,
with `~/.gemini/oauth_creds.json` as an import source).

**Trust model for external credentials:** jcode asks before reading another tool's file,
remembers the approval per path, never moves or rewrites the file, and rejects symlinks.

**`auth-test`:** `jcode auth-test --all-configured` runs discovery, refresh, a real smoke prompt
expecting `AUTH_TEST_OK`, and a tool-enabled smoke prompt. This is a useful pattern to copy.

### 3.3 Model routing and accounts

- **Route prefixes** disambiguate auth paths for the same model: `claude-oauth:claude-opus-5-5` vs
  `claude-api:...` vs `openrouter:...` vs `jcode:...`.
- **Model discovery policy** (`AGENTS.md`): hardcoded model arrays are offline fallbacks only.
  Providers with catalogs must discover new IDs live, support cached prefetch plus forced refresh,
  keep the last good catalog on failure, scope caches per endpoint, and push updates into
  long-lived sessions. Regression tests must discover an arbitrary future model ID.
- **Account pool and priorities** (`docs/ACCOUNT_ROUTING.md`, `~/.jcode/account-pool.json`): Claude
  Max and OpenAI Pro default to tier P1, standard plans to P2, free plans and metered API keys to
  P3. Fresh sessions pick a ready account from the best tier. Failover cycles within a tier first,
  then moves down. `Ctrl+Alt+J` / `Ctrl+Alt+K` hot-swap OAuth accounts mid-chat.
- **Server-side failover** for SDK and Desktop clients (`crates/jcode-app-core/src/server/turn_failover.rs`):
  on a rate-limit or usage error it switches to the next pool-approved route and re-runs the turn
  without duplicating the user message, up to 3 distinct accounts (`MAX_SERVER_FAILOVERS`). The
  TUI does the same with a cancellable countdown.
- **Per-agent models:** `set_subagent_model`, `set_agent_model`, and swarm spawn
  `model`/`provider` overrides. Headless workers inherit the coordinator's exact auth route via
  `model_switch_request_for_session_route`.
- **Swarm effort:** `/effort swarm` appends "Use swarms to get things done in parallel." to each
  user message and runs the root at `swarm_root_effort` (default `low`).

### 3.4 Prompt-cache engineering (worth copying)

- **Split system prompt**: a static part (cacheable) and a dynamic part.
- **Freeze the tool list** after the first request (`locked_tools`), with exactly one allowed
  rebuild when MCP tools register late (`mcp_late_register_resolved`). Late tools and skills are
  then **announced in the transcript** rather than rewriting the prefix.
- **Snapshot AGENTS.md and the skills list** at session start (`agents_md_snapshot`,
  `prompt_skills_snapshot`), so tool writes do not invalidate the cache mid-session.
- **Memory recall is injected as a trailing user message** ("preserves cache prefix").
- **KV-cache monitor** (`crates/jcode-base/src/kv_cache_monitor.rs`, `agent.rs` `begin/finish_kv_cache_monitor_request`):
  hashes the static system part, tools, and per-message content. On a provider-reported miss it
  classifies the cause (compaction, daily rollover, account failover, harness-caused) and emits
  `ServerEvent::KvCacheMiss`. The TUI shows a "cache cold" notification and a footer.
- **OpenAI WebSocket prewarm** (`docs/OPENAI_WEBSOCKET.md`): while the user types, it sends
  `response.create` with `generate:false, input:[], store:false` to warm the static prefix.
- **Tiny system prompt**: `crates/jcode-base/src/prompt/system_prompt.md` is only about 1.5 KB
  (identity, autonomy, "use todo extensively", "commit as you go", "prefer swarm coordination over
  branches and worktrees", "edit with edit/apply_patch not sed").

---

## 4. Tools

Registered in `Registry::base_tools` and `Registry::new` (`crates/jcode-app-core/src/tool/mod.rs:410-600`).
`[tools] profile` selects `full` (default), `acp`, `minimal`/`lite` (bash, read, write, edit,
multiedit, apply_patch, patch, agentgrep, glob, grep, ls) or `none`.

| Tool | File | Notable details |
|---|---|---|
| `read` | `tool/read.rs` | default 5000 lines, max line length 2000; publishes `FileTouch{op:Read}`; images go to the side pane |
| `write` | `tool/write.rs` | file lock, `FileTouch`, unified diff attached |
| `edit` | `tool/edit.rs` (758) | **`edits[]` array or single old/new**, applied atomically to an in-memory copy (any failure aborts all), uniqueness check with "found N times" guidance, `flexible_match_hint` for near misses, compact "42- / 42+" diff, 3-line context after the edit, optional `intent` field, config-edit notice, edit stats |
| `apply_patch` / `patch` | `tool/apply_patch.rs`, `patch.rs` | Codex `*** Begin Patch` envelope and unified diff; `lock_all` on touched paths |
| `bash` | `tool/bash.rs` (1502) | 120 s default timeout, 30K output cap, **destructive gate** (`bash_destructive_gate.rs` + `jcode-command-risk`: blast-radius assessment; catastrophic targets such as `/`, `$HOME`, credential stores and devices are denied; risky commands need a `justification` field, which forces a reflection a blind retry cannot satisfy), process-group kill, stdin prompt detection (poll every 500 ms, then the TUI asks the user), progress markers, reload-persistable foreground jobs, cargo wrapping in the jcode repo, a hint when bash is used to edit files in place, per-session env overrides (`SetSessionEnv`) |
| `agentgrep` | `tool/agentgrep.rs` + external crate `1jehuang/agentgrep v0.2.0` | modes grep/find/outline/smart (a DSL); matches include structural context (enclosing functions); **results adaptively trimmed based on what the agent has already seen** (`context.rs` collects exposure from prior read/bash output); 5 s foreground budget; cancellation through an `AtomicBool` token on drop |
| `batch` | `tool/batch.rs` | 1 to 10 independent sub-calls run concurrently with per-subcall progress events; no nesting |
| `codemode` (opt-in) | `tool/codemode.rs` + `crates/jcode-codemode` | model-written JS in embedded **QuickJS**; `await tools.<name>(args)`, `listTools`, `describeTool`, per-session `store/load`; 64 MB heap, 300 s, 2000 tool calls; no fs/net/timers; calls route through `Registry::execute`, so policies and hooks still apply |
| `todo` | `tool/todo.rs` (1648) | **phases -> lanes -> items** hierarchy with name-keyed incremental updates, `lane_after` prerequisites, `completely_blocked{reason}`, confidence and "hill-climbable" assessments (feedback loop, coverage, evidence); drives auto-continuation and the swarm plan |
| `bg` | `tool/bg.rs` | list/wait/output/cancel background tasks |
| `swarm` | `tool/communicate.rs` (3149) | see section 5 |
| `memory` | `tool/memory.rs` | remember/list/search/recall/forget/tags/links (section 6) |
| `session_search`, `conversation_search` | `tool/session_search*.rs` | search past sessions and the current transcript |
| `webfetch`, `websearch` | DuckDuckGo, Bing, SearXNG, Kagi, custom; per-session proxy env |
| `browser`, `browser_fast` | Chromium control plus a native host/extension, "browser handoff" |
| `open`, `side_panel`/`panel`, `applet`, `user_response`/`ask_user` | UI-affecting tools |
| `mcp`, `mcp_search`, `mcp_call`, `mcp__server__tool` | deferred MCP loading for providers that support it; adaptive result budget (8K tokens, JSON-shape-preserving squeeze) in `crates/jcode-base/src/mcp/budget.rs` |
| `skill_manage` | SKILL.md skills from `~/.jcode/skills`, project dirs, `.claude/skills` |
| `schedule`, `goal`, `gmail`, `calendar`, `macos_computer_use` | ambient and productivity features |
| `selfdev`, `desktop_selfdev`, `debug_socket`, `compile_remote`, `jcode_docs` | self-development (build, test, reload its own binary) |
| `discover` | sponsored tool discovery, opt-in via `[sponsors] enabled` |

Cross-cutting tool conventions:

- Most tools accept an **`intent`** string (short "why"), which feeds file-touch summaries, the
  swarm activity feed and UI labels.
- Input parsing is lenient (`serde_coerce.rs`, aliases such as `pattern`->`query`,
  `file_path`->`file`, `script`/`source`/`js`->`code`).
- Tool outputs can carry images, a title, and an attached unified diff
  (`tool/file_diff.rs::attach`) for rich UI rendering.

---

## 5. Multi-agent / swarm

Docs: `docs/SWARM_ARCHITECTURE.md`. Code: `crates/jcode-app-core/src/tool/communicate.rs`,
`crates/jcode-app-core/src/server/swarm*.rs`, `comm_*.rs`, `crates/jcode-swarm-core`.

### 5.1 Model

- **Implicit swarm:** two or more sessions in the same repo, hosted by the same server, are
  auto-grouped under a `swarm_id`. They can DM each other or broadcast. The `swarm` tool lets an
  agent spawn teammates, which turns it into a coordinator.
- **One-level fan-out:** only the root may spawn, so workers cannot spawn grandchildren
  ("bounded by construction"). Ancestry is encoded by `report_back_to_session_id`. Stop permission
  covers your own subtree (`force=true` otherwise). Orphans are reparented to the grandparent,
  then the coordinator.
- **Coordinator slot** per swarm, used only for the single shared `VersionedPlan`
  (propose/approve/assign/task-control).
- **Advertised actions** (`ADVERTISED_SWARM_ACTIONS`): `launch`, `spawn`, `message`, `status`,
  `plan_status`, `list`, `summary`, `await_members`, `stop`, `resume`, `retry`, `list_models`,
  `list_swarms`. Legacy actions still execute for old transcripts.
- **`launch`:** "The coordinator's todo list is the plan". Each lane becomes one item owned by one
  worker, and the worker's own todo list *is* the lane (prepopulated before work starts). The plan
  driver runs as a managed background task by default (`background: true`).
- **Spawn modes** (`agents.swarm_spawn_mode`): `inline` (default: in-process, rendered as a live
  **gallery of worker viewports** in the coordinator's TUI via the `inline_tail` output tap),
  `visible` (opens a new terminal window via `crates/jcode-terminal-launch`, which supports Kitty
  and others, plus a configurable `SPAWN_HOOK`), `headless`, and `auto`.
- **Automatic worker output:** when an owned worker finishes a turn, the server forwards a bounded
  output tail to the coordinator. Workers need no "report" tool call.
- **Lifecycle states:** spawned, ready, running, blocked, completed, failed, stopped, crashed.
  Heartbeats and staleness sweeps run in `swarm.rs` (`touch_swarm_task_progress`,
  `refresh_swarm_task_staleness`). Dead members' assignments are **salvaged** and the coordinator
  is notified. Recovery verbs: retry, reassign, replace, salvage.
- **Read levels:** status snapshot (lock-free, available while the target is busy), summary
  (activity feed of tool intents), and full context (heavy, restricted to coordinator or target).
- **Cross-swarm:** labels (`~/.jcode/state/swarm-labels.json`) and DM-only cross-swarm messaging.
  Broadcasts, channels and shared context never cross swarm boundaries.
- **Persistence:** swarm runtime state survives reloads and crashes via daemon snapshots
  (`server/swarm_persistence.rs`).
- **Delivery semantics:** every notification becomes a soft interrupt injected at safe points.
  Idle or completed agents do **not** auto-wake on messages; only explicit assign, wake or
  respawn does that.

### 5.2 Conflict avoidance: optimistic, no locks, no worktrees

- The doc says worktrees are "optional" and describes Worktree Managers. **In code, the swarm tool
  does not create worktrees** (worktree references live in selfdev and compile_remote only), and
  the system prompt says "Prefer swarm coordination over branches and git worktrees unless
  isolation is needed." The doc also states: "The system is optimistic by default (no locks)."
- **File-touch conflict detection** (`crates/jcode-app-core/src/server.rs:1967` and
  `server/file_touch_service.rs`):
  1. `edit`/`write`/`apply_patch`/`read` publish `BusEvent::FileTouch{session_id, path, op,
     intent, summary, detail(preview of the diff)}` on a global `Bus`.
  2. The server keeps a forward index (`path -> Vec<FileAccess>`) and a reverse index
     (`session -> paths`). Touches expire after 30 min, with cleanup every 5 min.
  3. On a **modification**, it finds prior touches by *peers in the same swarm*
     (`latest_peer_touches`) and sends both a `ServerEvent::Notification{FileConflict}` and a
     **soft-interrupt alert** to the modifying agent (and the earlier toucher), for example:
     `"⚠ File activity: src/x.rs — <scope> — fox previously edited this file: edited lines 40-52 — intent: ..."`.
     Reads are tracked but never trigger alerts.
  4. Agents decide whether it matters, check the diff, and DM each other.
- **Write atomicity:** the in-daemon per-path mutex (`tool/file_lock.rs`) prevents torn
  read-modify-write races between concurrent edits, including across agents, because they share
  the process.

### 5.3 Takeaways for rcode

The trio of "agents as in-process objects, a file-touch bus, and alerts as soft interrupts" is
cheap and effective. The gaps: no semantic merge, no lease or claim on files, worktree isolation
documented but not wired, and no way to coordinate across daemons or machines except the cloud
features.

---

## 6. Sessions, compaction, forking, memory

### 6.1 Session storage

- Paths: `~/.jcode/sessions/<id>.json` (full snapshot) plus `~/.jcode/sessions/<id>.journal.jsonl`
  (append-only journal). See `crates/jcode-base/src/session/storage_paths.rs`.
- Session id format: `session_<animal>_<unixms>_<hex>` (for example
  `session_dove_1787768816557_7698eab3bda993d0`). The friendly short name is the animal.
- **Journal entries** (`session/journal.rs` `SessionJournalEntry`): a full `meta` block plus
  `append_messages`, `append_env_snapshots`, `append_memory_injections` and
  `append_replay_events`. Large compaction state (OpenAI encrypted context, potentially MBs) is
  written once and then flagged `compaction_unchanged: true` to avoid overflowing the journal cap.
- **Checkpointing** (`session/persistence.rs`): when metadata changes in a way that requires a
  snapshot, or the journal exceeds `MAX_SESSION_JOURNAL_BYTES`, it writes the full snapshot
  (`storage::write_json_fast`) and deletes the journal. Loading replays the journal idempotently
  (it skips entries already folded in, using `updated_at`), dedupes messages by id, salvages
  "glued" lines, backs up corrupt journals to `.corrupt.jsonl`, and makes **pre-wipe backups**
  when a snapshot would shrink drastically (`guard_snapshot_shrink`). `drain_saves_for_shutdown`
  makes sure exit cannot land mid-checkpoint.
- **Leases:** `crates/jcode-storage/src/session_lease.rs` plus `migration_lease_block` stop a turn
  when the session has been transferred elsewhere (cloud move).
- Resume: `jcode --resume fox`, a rich session picker with previews (`crates/jcode-tui-session-picker`),
  and `session_list_cache` / `recent_session_index` for speed. `jcode-import-core` imports and ranks
  history from other tools.

### 6.2 Compaction

`crates/jcode-base/src/compaction.rs` (1832) plus `crates/jcode-compaction-core` (constants):

- **Background, non-blocking:** at 80% of budget (`COMPACTION_THRESHOLD = 0.80`) a summarization
  task starts while the user keeps chatting. When it is ready it swaps in. At 95%
  (`CRITICAL_THRESHOLD`) it waits up to 15 s for the pending summary.
- The manager stores no messages. It tracks `compacted_count` (prefix length) and keeps a rolling
  char-count estimate for the live suffix.
- Defaults: `DEFAULT_TOKEN_BUDGET = 200_000`, keep the last 10 turns (minimum 2), 4 chars/token,
  `SYSTEM_OVERHEAD_TOKENS = 18_000`, images cost 1600 tokens. Image decay: after 12 tool images or
  48 MB, keep 6.
- Modes: **reactive** (fixed threshold), **proactive** (EWMA token-growth prediction), **semantic**
  (embedding-detected topic shifts; falls back to proactive).
- **Emergency paths:** truncate tool results to 4000 chars and images to 1KB placeholders on
  payload-too-large or image-rejection errors, then retry. Context-limit errors trigger
  auto-compact and retry.
- Provider-native compaction: preserves OpenAI `encrypted_content` and `/compact` endpoints.
- Per-session **context cap** (`set_context_cap`), persisted and restored on resume; the effective
  budget is min(model window, cap).

### 6.3 Forking, splitting, transfer

- **`/fork` maps to `Request::Split`** (`server/client_actions.rs::handle_split`). It clones the
  session to a new id with `parent_id` and never awaits the agent lock (`try_lock`, falling back to
  the last persisted snapshot), so forking works mid-stream. The client then opens the fork in a
  new terminal window (Kitty, for example) with an optional startup "fork prompt".
- **`Request::Transfer`**: loads the parent and creates a compacted handoff session
  (`crates/jcode-base/src/compaction_transfer.rs`).
- Cloud handoff and moves (`src/cli/cloud_move.rs`, `docs/CLOUD_SESSION_HANDOFF.md`) migrate
  sessions between machines using leases.
- **The `fork-prompt-session-*.json` files at the repo root** are stray development artifacts, not
  runtime data (nothing in the code reads them). They are structured exports of a jcode session
  ("dove", gpt-5.6-sol, 2026-08-26) that fixed a TUI bug where the fork startup prompt vanished
  when the cloned history rendered (commit `5670e8878` "fix(tui): keep fork startup prompt
  visible"). The two files show two candidate formats for summarizing a session as context for a
  fork:
  - `fork-prompt-session-rich-summary.json`: `session`, `request{original, follow_up_user_messages}`,
    `todos_final`, `todo_history`, `intent_transcript`, `key_findings`, `decisions`,
    `changes{commit, behavior_before/after}`, `verification{regression_test, runtime_checks}`,
    `outcome{summary, remaining_work, blockers, confidence, final_response}`.
  - `fork-prompt-session-todos-and-intents.json`: a compact `todos` list (with
    `confidence`/`completion_confidence`) plus `user_intents` and a `transcript` of tool-call
    intents.

  They suggest the author is experimenting with **intent-based session summaries** (built from the
  `intent` field on every tool call plus the todo history) as a cheaper alternative to a full
  transcript clone or LLM summary. That idea is worth stealing.

### 6.4 Memory systems

`docs/MEMORY_ARCHITECTURE.md`, `crates/jcode-base/src/memory*.rs`, `jev.rs`, `memory_jev.rs`, `memory_agent.rs`:

- **Storage:** a local JSON graph at `~/.jcode/memory/global.json` and
  `~/.jcode/memory/projects/<cwd-hash>.json` (tags, relationships, categories, trust, sources,
  superseded entries). Exact duplicates reinforce instead of duplicating.
- **Recall = "Jev Decisions"**: the code sends bounded batches (24 memories at most, 64 KiB per
  request, 8 KiB of focused context, a 60 s deadline) to a remote *typed-relevance classifier*
  (TypeSafe Jev, via OpenRouter, TypeSafe, AI/ML API or the jcode gateway). Each candidate gets a
  probability; the default threshold is 0.8, and at most 5 are injected. **No embeddings, BM25 or
  LLM reranker.** Any batch failure invalidates the selection (no partial results), and the
  provider choice never falls back silently (to avoid spending BYOK credit unexpectedly).
- **Async coordinator:** one context update per fresh user turn. Results are consumed on a *later*
  turn (non-blocking), expire after 2 min, are deduplicated per session, and are re-validated
  before injection (memory still exists and its content is unchanged).
- **Learning is separate:** the agent writes facts through the `memory` tool. An optional sidecar
  LLM can extract memories at session end (`memory_sidecar_enabled`).
- Privacy note: the docs state openly that recall sends memories off-machine.
- Other memory-like features: `session_search` (past sessions), the `goal` tool, ambient mode
  "gardening" of the memory graph (`docs/AMBIENT_MODE.md`, a single background agent that wakes
  on its own schedule and is subscription-first).

---

## 7. TUI

### 7.1 Stack

ratatui 0.30 plus crossterm 0.29 (`event-stream`), pulldown-cmark plus syntect for markdown,
`ratatui-image` (Kitty, Sixel, iTerm2, halfblocks) for inline images, a mermaid-to-PNG renderer
(`crates/jcode-tui-mermaid`), and LaTeX math (`crates/jcode-render-core/src/math.rs`). The client
is a thin socket client (`crates/jcode-tui/src/tui/backend.rs`). `App` is a god object, and
`TuiState` has 114 methods (`docs/TUISTATE_TRAIT_DECOMPOSITION.md` plans to split it).

### 7.2 Rendering performance tricks

- **Adaptive redraw cadence** (`crates/jcode-tui/src/tui/redraw_schedule.rs`): from animation FPS
  down to 250 ms idle and 5 s deep idle (no stream and no input for 30 s). Animation-only repaints
  are partial. Animation stops when the terminal is unfocused.
- **Paced stream reveal** (`crates/jcode-tui-core/src/stream_buffer.rs`): arrival is decoupled
  from reveal by a proportional controller (`BASE_REVEAL_CPS = 180`, `REVEAL_BACKLOG_GAIN = 3.0`,
  `MAX_REVEAL_CPS = 960`, step clamp 50 ms), so Anthropic's bursty deltas look as smooth as
  OpenAI's token-level deltas. Reasoning and answer text share one ordered, segment-aware backlog.
- **Prepared-frame caches** (`crates/jcode-tui/src/tui/ui_prepare.rs`, 2764): memoized assistant
  markdown aux data (2048-entry LRU), a TTL plus cheap-signature cache for the header (which was
  costing 30 to 50 ms per frame by probing auth files and goal JSON, and showed up as input lag),
  and a deferred mermaid render with epoch-based staleness.
- **Frame metrics and slow-frame logging** (`ui_frame_metrics.rs`, `TUI_SLOW_FRAME`), plus a
  `tui_bench` binary (`src/bin/tui_bench.rs`).
- **No-wrap chrome rule** (`AGENTS.md`): UI chrome rows never wrap. They truncate by Unicode
  display cells.
- **Hibernation** keeps the last frame and the input draft while dropping all derived caches.
- Startup: the README claims 19.1 ms to first visible input (versus 3.5 s for Claude Code). This
  is plausible because the daemon is already warm (provider, MCP and registry are not constructed
  in the client). Scripts: `scripts/bench_startup.py`, `bench_startup_visible_ready.py`,
  `check_startup_budget.sh`.

### 7.3 UX features

Inline images and LaTeX, mermaid diagrams, side panel/diagram pane/diff pane, a resume picker with
preview, an info widget (usage limits bar, git, swarm graph, memory, model, cloud, timeline),
swarm worker gallery viewports, a live todo band with per-worker status (spinner, tokens,
throughput, current intent), a prompt-cache-cold notification, an account picker with priority
dimming, an `/account` hot-swap, Alt+B to background a tool, Esc to cancel, typing mid-turn as a
soft interrupt, `/fork`, `/reload`, `/effort swarm`, `/telemetry`, `/reset usage limits`, a
shift+enter handling doc, configurable colors, a copy-mode pane with drag autoscroll, voice input
(`crates/jcode-voice`), a macOS menu-bar presence indicator, a global hotkey, and desktop
notifications.

---

## 8. SDK and integration surfaces

- **Internal protocol:** `crates/jcode-protocol/src/wire.rs`, newline-delimited JSON
  `Request`/`ServerEvent` over the Unix socket. Requests include `message`, `cancel`,
  `soft_interrupt`, `background_tool`, `rewind`, `split`, `transfer`, `compact`, `set_model`,
  `set_route`, `set_context_cap`, `set_session_env`, `comm_*` (swarm), `agent_task`, `run_subagent`,
  `subscribe`, `get_history` and others (92 variants). A separate **debug socket** accepts textual
  commands (`message:`, `create_session:`, `agent:memory`, `server:memory`), which is how
  benchmarks and tests drive the daemon.
- **Harness API v1** (`crates/jcode-harness-api`): a stable, versioned NDJSON protocol
  (`{"v":1,"id":42,"req":"set_context_cap",...}`). `jcode api-bridge` (shipped inside the release
  binary, from `crates/jcode-harness-api-server`) exposes `$XDG_RUNTIME_DIR/jcode-api.sock` and
  translates onto the internal daemon socket. Clients opt into features such as
  `supports_server_failover`.
- **SDKs:** Rust (`crates/jcode-sdk`: launch, auth, ssh, cloud, worktrees, turn_retry, structured
  output) and **TypeScript** (`sdk/typescript`, `@1jehuang/jcode-sdk`, Node 20+). Per-platform
  runtime binaries ship as optional npm packages (`sdk/npm/{darwin,linux,win32}-{arm64,x64}`).
  `launch()` starts a private daemon and bridge with isolated state; `connect()` attaches to the
  user's global daemon. Schema drift is guarded on both sides (a Rust test checks the TS tag sets
  and vice versa).
- **ACP:** `src/cli/acp.rs` (2053 lines), JSON-RPC 2.0 over stdio, protocol version 1, with
  `session/new|load|resume|prompt|cancel|close|set_config_option|set_model|set_reasoning_effort`
  and streamed `session/update` notifications. Profiles are `standard`, `extended` and `full`. A
  matching tool profile `acp` exists.
- **MCP:** client only. There is a stdio shared pool plus remote HTTP/SSE with OAuth
  (`crates/jcode-base/src/mcp/remote.rs`, `oauth.rs`, `docs/MCP_REMOTE.md`), a schema cache,
  deferred `mcp_search`/`mcp_call` for providers with native deferred tool loading, and the
  adaptive result budget. `jcode mcp` CLI manages servers. There is no MCP server mode exposing
  jcode itself.
- **Headless:** `jcode run "<prompt>"` (in-process), `--socket` for isolation, and
  `--no-update`.
- **Hooks:** `[hooks]` lifecycle commands (section 2.3), a spawn hook for headed sessions, and
  `post_tool_feedback` for linters such as vale.
- **Other surfaces:** Jcode Desktop (separate repo), an iOS app and mobile push/cloud continuation,
  SSH remote daemons, cloud sessions on AWS (`docs/JCODE_CLOUD_AWS.md`), a Telegram bridge, and
  Gmail/Calendar integrations.

---

## 9. Telemetry, packaging, distribution, self-update

- **Telemetry** (`TELEMETRY.md`, `crates/jcode-telemetry-core`, `telemetry-worker/` (a Cloudflare
  Worker with D1, Analytics Engine and R2)): install, upgrade, auth_success, session/turn/tool
  summaries, onboarding steps, feedback, retention helpers, and per-turn timing. It does not
  include prompts or code. **Opt-in full transcript sharing** (secret-redacted on both client and
  worker, 8 MiB cap, 30-day R2 lifecycle). **Controversial:** since the policy dated 2026-10-14,
  *default* telemetry may include the **OAuth account email** for model providers. There is a
  one-time status-line notice, and a SHA-256 presence check happens before the raw email is sent.
  Opt-outs: `/telemetry`, `JCODE_NO_TELEMETRY`, `DO_NOT_TRACK`. The telemetry send path was once a
  1.4 s session-creation stall because synchronous HTTP held a global lock
  (`docs/SESSION_CREATION_LATENCY.md`); it now goes through a bounded background worker.
- **Install:** `curl -fsSL https://jcode.sh/install | bash` (`scripts/install.sh`), PowerShell for
  Windows, and a Nix flake (`flake.nix`). npm platform packages exist for the SDK.
- **Binary layout** (`AGENTS.md`): `~/.local/bin/jcode` is a symlink to
  `~/.jcode/builds/{stable,current,canary}/jcode`, which points to the immutable
  `~/.jcode/builds/versions/<version>/jcode`. The daemon runs from
  `~/.jcode/builds/shared-server/jcode`, a symlink into `versions/` that is repointed on update or
  self-dev.
- **Self-update** (`crates/jcode-app-core/src/update*.rs`, `crates/jcode-update-core`,
  `docs/UPDATE_CHANNELS.md`): channels are `stable` (default), `preview` (`v1.0.0-preview.N`
  GitHub prereleases, highest N with a platform asset and a `SHA256SUMS` match) and `main` (source
  build). There is no automatic downgrade. Rate limiting, GitHub auth, and Termux special cases are
  handled. After an update the daemon `exec`s into the new binary, sessions survive, and clients
  re-exec if they are stale.
- **Self-dev:** running jcode inside its own repo enables `selfdev` tools. The agent edits, builds
  (`cargo build --profile selfdev`, a build queue, optional remote compile over SSH with
  clang+mold+sccache handling), tests, then reloads the shared daemon and continues all sessions.
- **CI:** `.github/workflows/` has ci, release, preview, publish-typescript-sdk, windows-smoke,
  freebsd-smoke, cloud-acceptance, signing-helper-validation, and release-recovery workflows.
  Guardrail scripts check code-size budget, panic budget, swallowed-error budget, test-size budget,
  startup budget and dependency boundaries.

---

## 10. Strengths and weaknesses

### 10.1 Strengths worth copying (ranked)

1. **A daemon that hosts N agents as in-process objects** with thin, reconnecting clients. This is
   the source of the roughly 3 MB per session, instant startup, survival across client crashes,
   and hot reload. In Bun: one daemon process, agents as objects with their own AbortControllers,
   clients over a Unix socket with NDJSON.
2. **Soft interrupts as the universal delivery mechanism.** User follow-ups, agent DMs and
   file-conflict alerts are all appended at safe points without cancelling the turn or breaking
   the cache prefix.
3. **File-touch bus with peer-modification alerts** plus an in-process per-path RMW mutex. This
   gives optimistic multi-agent editing in one repo without worktrees, and it is cheap to build.
4. **Auto-background long tools** (3 s budget, adopt rather than kill, return a task_id with
   guidance, Alt+B to force). This keeps the agent productive and the UI responsive.
5. **Prompt-cache discipline:** static/dynamic system split, frozen tool list with one late-MCP
   rebuild, frozen AGENTS.md and skills snapshots, memory as a trailing user message, late tools
   announced in the transcript, plus a **KV-cache miss classifier** surfaced to the user.
6. **Shared MCP pool** (M processes, not N x M) and an **adaptive, JSON-shape-preserving MCP
   result budget**.
7. **Memory hygiene as a product feature:** allocator tuning, early drops of request snapshots,
   capped caches with a written budget, idle hibernation, and memory attribution endpoints.
8. **Edit tool ergonomics:** atomic multi-edit, a flexible-match hint, compact diffs and context
   after edit, an `intent` field, an attached unified diff, and context-overflow *refusal* (rather
   than truncation) with an explicit opt-in.
9. **A deterministic destructive-bash gate** (blast-radius classifier, deny for catastrophic
   targets, a justification field for risky commands) instead of interactive permission prompts.
10. **The account pool:** route prefixes, plan-based priority tiers, failover within and across
    tiers, hot-swap keys, and server-side failover for API clients.
11. **Streaming smoothness:** a reveal-rate controller that normalizes provider burstiness, plus an
    adaptive redraw cadence with unfocused and deep-idle throttling.
12. **Structured todo planning** (phases, lanes and items, with `lane_after` and
    `completely_blocked`) that doubles as the swarm plan (`launch` maps lanes to workers).
13. **`codemode`**: model-written JS calling tools inside a QuickJS sandbox. It is natural in a
    TS/Bun stack (use `node:vm` or QuickJS-wasm).
14. **Journaled session storage** (snapshot plus JSONL journal, idempotent replay, corruption
    salvage, pre-wipe backups).
15. **A stable versioned harness API** with SDKs whose schema-drift tests run in both languages,
    plus ACP. `auth-test` end-to-end smoke tests per provider.
16. **Model-discovery policy:** live catalogs, last-good fallback, and tests for future model IDs.

### 10.2 Weaknesses and gaps (ranked)

1. **Massive scope and size.** About 946K lines of Rust across 90 crates, with Gmail, Calendar,
   Telegram, iOS, cloud, browser, voice, sponsors and ambient features. The cost shows in a
   114-method `TuiState`, an `App` god object, many docs that describe plans rather than reality,
   and the release profile at `opt-level = 1` to keep builds tolerable. rcode should stay focused.
2. **Single daemon = shared fate.** One process holds every session. A memory blowup, deadlock or
   panic outside a task boundary affects all agents, and the per-path edit lock and many global
   registries are process-global. Bun has the same risk; mitigate with watchdogs and the option to
   isolate risky sessions.
3. **No real isolation for multi-agent work.** Worktrees and Worktree Managers are documented but
   not wired into the swarm tool. Conflict handling is advisory alerts only, with no claims or
   leases on files and no merge support.
4. **Sequential tool execution per turn.** Parallel tool calls from the model run one after
   another unless the model uses `batch` or `codemode`. rcode can run independent parallel tool
   calls concurrently by default.
5. **No interactive permission model.** It is effectively YOLO apart from the bash destructive gate
   and optional `pre_tool` hooks, and there is no path sandbox. `SAFETY_SYSTEM.md` is a design that
   only ambient mode uses.
6. **ToS and fragility risk in subscription OAuth.** It impersonates the Claude Code identity line,
   user agent and tool names, and the Codex originator. Probe scripts track breakage. rcode should
   isolate this behind clearly separated adapters and accept that it can break.
7. **Privacy posture:** default telemetry can include the OAuth email; memory recall sends memories
   to a remote classifier (Jev) and has no local fallback; there is sponsored "discovery" (opt-in).
8. **Memory recall depends on a niche paid remote service.** Free users lose semantic recall.
9. **Swarm depth limited to one level** by design. That is good for boundedness but limits
   recursive decomposition.
10. **Windows second-class** (Unix-socket-first; the docs mark the bridge as untested).
11. **Doc and code drift:** several docs reference old `src/...` paths that are now in crates, and
    some docs describe removed or planned features (task-graph swarm mode removed, worktree
    managers not implemented).

---

## 11. The 20 most important source files

| # | Path | Why it matters |
|---|---|---|
| 1 | `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs` | The core turn loop: request build, cache monitoring, streaming select, tool execution and handoff, cancellation, recovery |
| 2 | `crates/jcode-app-core/src/agent.rs` | `Agent` struct and its state (tool lock, snapshots, soft-interrupt queue, KV-cache monitor) |
| 3 | `crates/jcode-app-core/src/agent/tool_handoff.rs` | 3 s auto-background policy, reload-interrupt semantics, incomplete-turn stop |
| 4 | `crates/jcode-app-core/src/tool/mod.rs` | Tool `Registry`: registration, name resolution, policy, hooks, context-overflow refusal |
| 5 | `crates/jcode-app-core/src/server.rs` | Daemon main: socket, idle timeout, bus event loop including the FileTouch conflict alerts |
| 6 | `crates/jcode-app-core/src/server/client_lifecycle.rs` | Per-client request dispatch for all 92 protocol requests |
| 7 | `crates/jcode-app-core/src/server/headless.rs` | How a worker session is created in-process (provider fork, registry, MCP pool) |
| 8 | `crates/jcode-app-core/src/server/swarm.rs` | Swarm membership, ancestry, heartbeats, salvage, status broadcast debouncing |
| 9 | `crates/jcode-app-core/src/tool/communicate.rs` | The `swarm` tool: spawn, launch, DM, broadcast, plan, await_members |
| 10 | `crates/jcode-app-core/src/server/file_touch_service.rs` | Forward/reverse file-touch indexes used for conflict detection |
| 11 | `crates/jcode-app-core/src/tool/file_lock.rs` | Per-path async RMW mutex with deadlock-free multi-lock |
| 12 | `crates/jcode-app-core/src/tool/edit.rs` | Atomic multi-edit with diffs, hints and FileTouch publishing |
| 13 | `crates/jcode-app-core/src/tool/bash.rs` + `bash_destructive_gate.rs` | Shell execution, process groups, progress markers, destructive gate |
| 14 | `crates/jcode-provider-core/src/lib.rs` | `Provider` trait, `EventStream`, credential and route primitives |
| 15 | `crates/jcode-base/src/provider/multi_provider.rs` (+ `account_failover.rs`) | Provider multiplexing, account pool, failover |
| 16 | `crates/jcode-base/src/compaction.rs` (+ `crates/jcode-compaction-core/src/lib.rs`) | Background, proactive and semantic compaction plus emergency truncation |
| 17 | `crates/jcode-base/src/session/persistence.rs` (+ `journal.rs`) | Snapshot+journal persistence, replay, corruption salvage |
| 18 | `crates/jcode-base/src/mcp/pool.rs` (+ `budget.rs`) | Shared MCP process pool and adaptive result budget |
| 19 | `crates/jcode-tui-core/src/stream_buffer.rs` + `crates/jcode-tui/src/tui/redraw_schedule.rs` | Smooth streaming reveal and adaptive redraw cadence |
| 20 | `src/main.rs` | Allocator tuning (jemalloc/glibc), multicall entry points, tokio runtime |

Honorable mentions: `crates/jcode-base/src/kv_cache_monitor.rs`, `crates/jcode-app-core/src/tool/agentgrep.rs`,
`crates/jcode-app-core/src/tool/codemode.rs`, `crates/jcode-app-core/src/tool/todo.rs`,
`src/cli/acp.rs`, `crates/jcode-harness-api/src/requests.rs`, `crates/jcode-base/src/memory_jev.rs`,
`crates/jcode-app-core/src/server/turn_failover.rs`.

---

## 12. Concrete recommendations for rcode (TypeScript/Bun)

1. Make **`rcode serve` a single daemon** (Bun, Unix socket, NDJSON). Agents are plain objects
   with an `AbortController` each. Clients are thin and auto-reconnect. Do hot reload with
   persisted sessions rather than `exec`, since Bun cannot exec in place: spawn the new daemon,
   hand off the socket, and let clients reconnect.
2. Build a **global event bus** with `FileTouch` events from read/edit/write/patch, a per-path
   async mutex (one `Map<string, Promise>` chain), and peer-modification alerts delivered as
   **soft interrupts**.
3. Run **parallel tool calls concurrently by default** (jcode's gap), while keeping a `batch`-like
   explicit tool for models that serialize calls.
4. **Auto-background after N seconds** with a task id and `bg wait/output`.
5. **Freeze the cacheable prefix** (system static part, tools, AGENTS.md, skills). Announce late
   additions in the transcript. Add a KV-cache miss classifier event.
6. Use a **shared MCP pool** across sessions, with a JSON-shape-preserving result squeeze.
7. Store **snapshot plus JSONL journal** sessions. `/fork` clones without waiting for the agent
   lock. Try **intent-based fork summaries** (tool-call intents plus todo history, as in the
   `fork-prompt-session-*.json` experiments).
8. Treat memory as a budget from day one: cap caches, drop request snapshots after send, hibernate
   idle sessions, and expose a `/debug memory` endpoint. In JS, watch for retained closures over
   message arrays.
9. Use a **deterministic destructive-command classifier** plus *optional* interactive permissions
   (jcode's gap), and keep paths resolved per session with no `process.chdir`.
10. Keep scope tight: a versioned harness API plus a TS SDK plus ACP covers integrations, so skip
    the Gmail, sponsors and cloud sprawl.
