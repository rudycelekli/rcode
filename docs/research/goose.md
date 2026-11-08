# goose (aaif-goose/goose) — Deep Research Report

Reference clone: `/Users/rudycelekli/Downloads/rcode/reference/goose`
Version studied: workspace `1.58.0` (HEAD `5bad61a feat(live-voice): configurable GPT-Live endpoint, model and key`).
License: Apache-2.0. Originally Block's goose, now governed by AAIF (Agentic AI Foundation).
Purpose of this report: extract architecture, patterns and lessons for **rcode** (TypeScript/Bun, open source).

> Important freshness note: much of the public folklore about goose is out of date. In this version:
> - There is **no `agent.rs` agent loop** anymore (AGENTS.md still points at `crates/goose/src/agents/agent.rs`, which does not exist). The loop is now a **pluggable state machine of "operations"** (`crates/goose-agent/src/machine.rs` + `crates/goose/src/agents/state_machine/`).
> - There is **no `goosed` HTTP/OpenAPI server crate** anymore. The desktop app spawns `goose serve` and speaks **ACP (Agent Client Protocol) over WebSocket/HTTP**. `AGENTS.md` explicitly forbids reintroducing the old generated OpenAPI client (`ui/desktop/src/api`).
> - The **lead/worker model was removed** from code (only blog posts remain); multi-model is now "/model switch mid-session" + per-subagent provider/model overrides.
> - The old "LLM tool router / vector tool selection" is gone; the answer to "too many tools" is now **Code Mode** (JS sandbox calling tools) + **dynamic extension enable/disable** via the `extensionmanager` platform extension.

---

## 1. Architecture

### 1.1 Workspace crates (`Cargo.toml`: `members = ["crates/*"]`)

| Crate | Role |
|---|---|
| `crates/goose` | The core: services, state-machine operations, extension manager, providers (the "def" + CLI/ACP-backed ones), ACP server, sessions (SQLite), recipes, scheduler, security, permission, hooks, skills, plugins, live voice, gateway, dictation. Not a stable API. |
| `crates/goose-agent` | **Generic, provider/storage-agnostic agent state machine**: `StateMachine`, `Operation`/`Inference` traits, `ToolApproval`, pre/post tool hooks, stop hook, subagent operation, tool-call state tracking. Compiles to `wasm32` (note the `MaybeSend`/`?Send` cfgs). |
| `crates/goose-provider-types` | Provider trait (`base.rs`), conversation/message model, wire formats (`formats/{anthropic,openai,openai_responses,google,ollama,databricks,snowflake}.rs`), canonical model registry (`canonical/`), cache semantics, retry config, `GooseMode`, `Permission` enum. |
| `crates/goose-providers` | Reusable HTTP providers: `anthropic.rs`, `openai.rs`, `openai_compatible.rs`, `google.rs`, `ollama.rs`, `openrouter.rs`, `databricks*.rs`, `snowflake.rs`, `azure_foundry.rs`, `local_inference.rs`, **declarative providers** (`declarative/definitions/*.json`, 53 files), live/realtime voice (`openai_live*.rs`, `live_transport_websocket.rs`), `typesafe.rs` + `decision.rs` (small "decision" classifier model API). |
| `crates/goose-context-management` | Compaction prompt templates + structured summary parsing/rendering (`summarize.rs`, `structured.rs`, `prompts/compaction*.md`). |
| `crates/goose-mcp` | Bundled in-process MCP servers: `computercontroller` (xlsx/docx/pdf/computer_control + macOS `peekaboo`), `memory`, `autovisualiser`, `tutorial`. |
| `crates/goose-cli` | `goose` binary (clap). Subcommands: `session`, `run`, `acp`, `serve`, `recipe`, `schedule`, `skills`, `plugin`, `gateway`, `roam`, `term`, `review`, `local-models`, `configure`, `doctor`, `info`, `mcp`, `update`, `completion`. |
| `crates/goose-local-inference` | llama.cpp / MLX / candle local inference, HF model management, **text tool-call emulation** for tiny models (`tool_emulation.rs`, `tool_parsing.rs`, `native_tool_parsing.rs`). |
| `crates/goose-sdk`, `goose-sdk-types` | "GDK": ACP wire types + `_goose/unstable/*` custom request types; optional uniffi cdylib for Python/Kotlin. |
| `crates/goose-roaming` | Standalone iroh/QUIC P2P transport for ACP with mutual ed25519 key trust (SSH-known-hosts style). |
| `crates/goose-acp-macros` | Macros for ACP custom-method dispatch. |
| `crates/goose-download-manager` | Model/asset downloads. |
| `crates/goose-test`, `goose-test-support` | MCP record/replay harness (`goose-test/src/bin/capture.rs`, `crates/goose/tests/mcp_replays/`), OTEL/session test support. |

Other top-level: `ui/desktop` (Electron+React+Vite), `ui/goose-acp` (npm launcher `@aaif/goose-acp` with per-platform optional binary packages), `ui/goose-acp-client`, `ui/text` (deprecated ACP TUI), `documentation/` (Docusaurus), `evals/harbor/` (terminal-bench harness), `workflow_recipes/`, `services/`, `oidc-proxy/`.

### 1.2 How CLI / desktop / server relate

```
                ┌────────────────────────── goose (single Rust binary) ──────────────────────────┐
 terminal ──►   │ goose session / goose run     → in-process StateMachineServices (CLI platform) │
 Zed/IDE  ──►   │ goose acp   (ACP over stdio)  → crates/goose/src/acp/server.rs::run()          │
 Desktop  ──►   │ goose serve (ACP over HTTP+WS, X-Secret-Key/token auth, optional TLS)          │
 phone/peer ─►  │ goose roam  (ACP over iroh QUIC P2P)                                           │
 Telegram ──►   │ goose gateway (crates/goose/src/gateway/telegram.rs, pairing)                  │
                └────────────────────────────────────────────────────────────────────────────────┘
```

- Desktop: `ui/desktop/src/gooseServe.ts` finds the bundled `goose` binary (`resources/bin/goose`), picks a free localhost port, spawns `goose serve` with a per-launch `serverSecret`, optional self-signed TLS with cert-fingerprint pinning (`backendCertificateVerifier.ts`), readiness polling, startup diagnostics. The renderer talks ACP through `ui/desktop/src/acp/gooseAcpClient.ts` / `acpConnection.ts`. `gooseServeLeaseRegistry.ts` shares one backend across windows. `remoteBackends.ts` supports connecting to remote goose servers (multi-hop).
- `goose serve` auth: `crates/goose/src/acp/transport/auth.rs` — constant-time compare of `X-Secret-Key` header or `?token=` query; origin policy allowing loopback/`file://` (`transport/mod.rs`). `--dangerously-unauthenticated` exists as a flag.
- There is also a stand-alone `goose-acp` bin (`crates/goose/src/bin/goose-acp.rs`) = ACP stdio server with `--with-builtin`.
- npm distribution: `ui/goose-acp` publishes `@aaif/goose-acp`, a thin launcher that resolves a platform-specific optional dependency `@aaif/goose-binary-*` and forwards args/stdio/signals (`npx goose acp`, `npx goose serve`). A good pattern for shipping a native binary through npm — relevant if rcode ever ships compiled Bun binaries.

CLI command map (`crates/goose-cli/src/cli.rs`, handlers in `crates/goose-cli/src/commands/`):

| Command | Purpose / notable flags |
|---|---|
| `goose session` | Interactive REPL (`session/` module: rustyline-style input, streaming buffer, thinking display, paste handling, elicitation prompts). `--resume`, `--session-id`, `--with-extension`, `--with-streamable-http-extension`, `--with-builtin`, `--container`, `--max-turns`, `--max-tool-repetitions`. |
| `goose run` | Headless: `-t/--text`, `-i/--instructions` file or stdin, `--recipe`, `--param k=v`, `--sub-recipe`, `--explain`, `--render-recipe`, `--output-format` (text/json/stream-json), `--no-session`, `--quiet`, `--provider`, `--model`, `--system`. Used by evals. |
| `goose acp` / `goose serve` | ACP over stdio / HTTP+WS (`--tls-cert-path`, `--tls-key-path`, `--allowed-origin`, `--dangerously-unauthenticated`). |
| `goose recipe` | validate, deeplink encode/open. |
| `goose schedule` (`sched`) | add/list/remove/run-now/sessions for cron jobs. |
| `goose skills`, `goose plugin` | manage skills and Open Plugins / Gemini-format plugins. |
| `goose gateway` | Telegram bot gateway (`--bot-token`). |
| `goose roam` | P2P share/connect. |
| `goose term` | Terminal-integrated session tied to the current terminal window. |
| `goose review` | Local code review with `.agents/checks/*.md` reviewers (`--checks-only`, `--severity`, `--summary-only`, `--no-orchestrate`). |
| `goose local-models` (`lm`) | Download/manage local GGUF/MLX models. |
| `goose configure`, `doctor`, `info`, `mcp <name>`, `update`, `completion` | Setup wizard, health check, info, run a bundled MCP server standalone, self-update, shell completions. |

Config lives in `~/.config/goose/config.yaml` (secrets in OS keyring unless `GOOSE_DISABLE_KEYRING`). Extension entries look like (from `evals/harbor/config_template.yaml`):

```yaml
GOOSE_PROVIDER: anthropic
GOOSE_MODEL: claude-sonnet-4-6
GOOSE_THINKING_EFFORT: "off"
extensions:
  developer: { bundled: true, enabled: true, name: developer, type: builtin, timeout: 300 }
  todo:      { bundled: true, enabled: true, name: todo, type: platform }
  summon:    { bundled: true, enabled: false, name: summon, type: platform }
  github:    { enabled: true, name: github, type: stdio, cmd: npx, args: ["-y", "@modelcontextprotocol/server-github"], envs: {}, env_keys: [GITHUB_TOKEN], timeout: 300 }
```
(The `github` line is illustrative of the stdio shape; `env_keys` names secrets pulled from the keyring.)

### 1.3 The agent loop — location and flow

**Generic engine:** `crates/goose-agent/src/machine.rs` (355 lines) and `operation.rs`.

```rust
pub enum Step<'a, S, E> { Operation(Arc<dyn Operation<S,E>>), Inference(Arc<dyn Inference<S,E>>) }

pub async fn run(&self, runtime, session_id, emit) -> Result<S> {
    loop {
        let session = runtime.load(session_id).await?;          // reload persisted state every step
        let mut result = self.step(&session, emit).await?;       // first applicable op wins
        self.apply(runtime, &session, &mut result.effects, emit).await?; // persist effects
        match result.status { Continuing => {}, Yielded | Cancelled => break }
    }
    self.finalize(runtime, session_id, emit).await              // cancellation cleanup
}
```

`step()` iterates the ordered step list; each `Operation::run()` returns `NotApplicable` or `Applied(StepResult{effects, status})`. The **first applicable operation produces effects and the loop restarts from a freshly loaded session**. If none apply, the final `Step::Inference` (the LLM call) runs. If nothing applies at all → `Yielded` (turn over). This is effectively a **production-rule system over the persisted conversation**: every decision is derived from the saved transcript ("a pipeline rebuilt from the persisted conversation reaches the same conclusion" — `Operation::set_message_meta` docs). This makes turns **resumable after crash or after waiting for a tool confirmation** (`services.rs::resume_turn`).

Operations also contribute to the inference request: `inference_tools()`, `prompt_parts()` (system prompt sections) and `moim_parts()` (per-turn context block). Duplicate tool names across operations are a hard error (`add_tools_to_inference_input`). `finalize()` on cancel synthesizes "Tool call was interrupted before completing" error responses for any open tool calls so the transcript stays valid.

**Goose's concrete pipeline:** `crates/goose/src/agents/state_machine_builder.rs::build_state_machine()` — order matters:

1. `SlashCommandOperation` (dispatches `/command` to any op's `run_command`, plus `StatusOperation`)
2. `ToolApprovalOperation` (inspectors → Allow/Deny/Ask; emits ActionRequired confirmation)
3. `PreToolCallHookOperation` (plugin hooks `PreToolUse`)
4. `SkillOperation` (skill tools/slash commands)
5. `RecipeOperation` (recipe commands, structured `final_output` enforcement)
6. `ToolExecutionOperation` (`ops_toolcalling.rs`, 1075 lines — executes extension tool calls; multiple calls streamed concurrently with `futures::stream::select_all`)
7. `RemainingToolCallsOperation` (answers requests no one handled), `UnhandledToolCallsOperation`
8. `SubagentOperation` (foreground subagents, `GOOSE_MAX_CONCURRENT_SUBAGENTS` default 5)
9. `SteerOperation` (injects queued user "steer" messages between model/tool turns)
10. `BangShellOperation` (`!cmd` at kickoff runs shell directly)
11. `ContextRelevanceOperation` (opt-in, observation-only experiment) and `CompactionOperation` (skipped if provider `manages_own_context()`)
12. `ToolPairCompactionOperation` (summarize old tool request/response pairs in batches of 10)
13. `DoctorOperation` (session diagnostics/repair), `ProjectOperation` (project instructions into prompt)
14. `RetryOperation` (recipe success checks: finish / continue / retry), `EmptyResponseOperation`
15. `StopHookOperation` (plugin `Stop` hooks can block ending the turn; capped by `GOOSE_STOP_HOOK_BLOCK_CAP`)
16. `ExitOnErrorOperation`, `MaxTurnsOperation` (`GOOSE_MAX_TURNS`, default 1000)
17. extra operations (e.g. `AutoEffortOperation`), then `Step::Inference(InferenceRunner)`.

**Outer service:** `crates/goose/src/agents/services.rs` (2985 lines) — `StateMachineServices::reply()` is the single entry for a user message: handles elicitation responses, takes a per-session turn guard (`ToolConfirmationCoordinator`), LRU-evicts idle resident sessions (`session_runtime.rs`, `max_sessions`), persists the user message, kicks off async session naming, then `turn()` builds the state machine with `TurnSettings::from_config` and streams `AgentEvent`s. Other entrypoints: `resume_turn`, `run_subagent_turn`, `steer`, `switch_provider`, `update_goose_mode`, `update_thinking_effort`.

**Inference preparation:** `state_machine/inference_preparation.rs` takes an **`ExtensionLease`** snapshot (`extension_manager/lease.rs`: "a held lease is unaffected by selection changes and tool-list changes") so mid-turn extension changes don't corrupt a turn. System prompt is rendered from `crates/goose/src/prompts/system.md` (minijinja) by `prompt_manager.rs`. Per-turn context ("MOIM", `agents/moim.rs`) is appended as a `<turn-context>`-style block containing time, cwd, **turn budget**, extension-provided context; the system prompt tells the model to become more direct as budget shrinks. Tools are sorted by name for prompt-cache stability (`reply_parts.rs::prepare_inference_tools`). Anthropic `cache_control: ephemeral` breakpoints are applied in `goose-provider-types/src/cache_semantics.rs`.

Robustness helpers worth noting:
- `reply_parts.rs::coerce_tool_arguments` — coerces stringly-typed numbers/booleans to the schema type.
- `extension_manager/mod.rs::recover_mangled_tool_name` — maps model-emitted `developer.shell`, `functions.shell`, etc. back to real names.
- `lease.rs` — rewrites MCP tool names that violate OpenAI's `^[a-zA-Z0-9_-]{1,64}$` with a hash suffix to keep them distinct.
- `tool_schema_normalize.rs` (1068 lines) — collapses `oneOf` const unions to `enum`, inlines trivial `$defs` for picky providers.
- `large_response_handler.rs` — tool text > `GOOSE_MAX_TOOL_RESPONSE_SIZE` (200k chars) is written to a temp file and replaced with a pointer message.

### 1.4 Effects, events, and message metadata (the data model behind the loop)

Operations never mutate state directly; they return **effects** that the runtime persists, then the loop reloads.

`crates/goose-agent/src/operation.rs::ConversationEffect`:

| Effect | Meaning |
|---|---|
| `AppendMessage(Message)` | Add a message (assistant reply, tool response, nudge, notice). |
| `ReplaceConversation(Conversation)` | Wholesale rewrite (retry reset, `/clear`). |
| `PatchToolRequestMeta { tool_call_id, patch }` | Annotate a tool request (e.g. approval outcome). |
| `SetMessageOperationNote { message_id, operation, key, value }` | Durable per-operation note on a message — how operations remember "I already did X" (e.g. retry `attempts` counted on the kickoff message, goal `nudged`). |
| `SetMessageVisibility { message_id, user_visible, agent_visible }` | Hide/show to UI vs model independently. |

`crates/goose/src/agents/state_machine/effects.rs::GooseEffect` wraps that and adds `CompactConversation { conversation, usage }`, `SetRecipe`, `SetExtensionState { extension_name, version, value }` (versioned per-extension session state stored in `sessions.extension_data`), `RecordUsage`. Every appended message gets an id `msg_<uuid>` (`ensure_message_ids`).

Streamed to clients: `crates/goose-agent/src/events.rs::AgentEvent { Message, Usage, MessageUsage{message_id, usage}, McpNotification((ext, notification)), HistoryReplaced(Conversation) }`. `HistoryReplaced` is what lets a UI re-render after compaction/retry rather than diffing.

Message metadata (`goose-provider-types/src/conversation/message.rs`): `user_visible`, `agent_visible`, compaction-summary flag, turn-context flag, operation notes, system notifications (`SystemNotificationType::InlineMessage` etc. used for "Running subagent ...", "Goal: ..."), `ActionRequired` content (tool confirmation requests/responses, elicitation). Confirmation responses are stored as invisible user messages (`goose-agent/src/tool_approval.rs::confirmation_response_message`) — the approval decision itself lives in the transcript, which is why a turn can be resumed purely from storage.

Takeaway for rcode: make the transcript the single source of truth (including approvals, retries, operation bookkeeping, visibility), and make the loop a pure function of it. It eliminates whole classes of "in-memory state lost on reconnect" bugs, and makes multi-client attach (desktop + CLI on the same session — see `session_runtime.rs` attachments) feasible.

---

## 2. Extension model (MCP-first)

### 2.1 Four extension kinds (`crates/goose/src/agents/extension.rs::ExtensionConfig`)

| `type` | Transport | Examples |
|---|---|---|
| `platform` | **In-process Rust struct implementing `McpClientTrait`**, with direct access to agent internals (`PlatformExtensionContext`: weak ref to ExtensionManager, ProviderManager, SessionManager, Scheduler) | developer, analyze, todo, summon, extensionmanager, code_execution, skills, apps, chatrecall, summarize, tom, scheduler |
| `builtin` | Real MCP server from `goose-mcp` served in-process over a `tokio::io::DuplexStream` pair (`builtin_extension.rs` registry, `goose-mcp/src/lib.rs::spawn_and_serve`) | computercontroller, memory, autovisualiser, tutorial |
| `stdio` | Child process MCP server (`extension_manager/stdio.rs`), optionally `docker exec` into a container (`--container`) | any MCP server (`npx ...`, `uvx ...`) |
| `streamable_http` | MCP Streamable HTTP, OAuth (pre-registered client id), Unix-domain-socket option (`extension_manager/streamable_http.rs`, 1148 lines) | remote MCP |

Everything — including the core developer tools — is exposed to the agent through the same `McpClientTrait` (`agents/mcp_client.rs`), so tool listing, calling, resources, prompts and notifications are uniform. The MCP client supports **elicitation** (forms routed to UI, `elicitation.rs`, `acp/server/elicitation.rs`) and **roots** (`list_roots`); I found no MCP sampling (`createMessage`) support.

### 2.2 Platform extensions (`crates/goose/src/agents/platform_extensions/mod.rs`)

`PlatformExtensionDef { name, display_name, description, default_enabled, unprefixed_tools, hidden, client_factory }`. `unprefixed_tools: true` means tools appear as first-class names (`shell`, `edit`) rather than `ext__tool`.

- **developer** (`developer/`): only 5 tools — `write`, `edit` (exact unique `before`→`after` replace with a "similar context" hint on miss), `shell` (stdout/stderr separate, 2000-line cap per stream with overflow to temp file, streaming output, Flatpak host-escape handling, `GOOSE_SHELL` override, cmd.exe newline warning), `tree` (gitignore-aware with line counts), `read_image`. **No dedicated read/grep/glob tools** — reading is done via `shell` (`cat`, `rg`), plus `analyze`.
- **analyze** (`analyze/`, feature `tree-sitter`): tree-sitter directory overviews, file details, symbol call graphs for Go/Java/JS/TS/Kotlin/Python/Ruby/Rust/Swift.
- **todo**: `todo_write` (default off).
- **summon**: `load` (pull a recipe/agent/subrecipe into context, or list sources) + `delegate` (subagents; see §4).
- **extensionmanager**: `search_available_extensions`, `manage_extensions` (enable/disable at runtime), `list_resources`, `read_resource`.
- **code_execution** ("Code Mode", feature `code-mode`, uses the `boa_engine` JS interpreter): tools `list_functions`, `get_function_details`, `execute_javascript`. When active, only first-class extension tools stay in the tool list; the model writes `async function run()` calling `await tools.call("ext__tool", {...})`, batching with `Promise.all`. The JS context has no fs/network/env. Accepts an optional `tool_graph` DAG purely for desktop visualization.
- **skills**: discovers `SKILL.md` in `~/.agents/skills`, `<project>/.agents/skills` (+ builtin `goose_doc_guide.md`, `web_search.md`).
- **apps** (MCP Apps): LLM-generated HTML/CSS/JS apps that run in sandboxed desktop windows (`goose_apps/`, `prompts/apps_create.md`).
- **chatrecall**: search past sessions / load summaries (memory across sessions).
- **summarize**: load files/dirs and get an LLM summary in one call.
- **tom** ("Top Of Mind"): injects `GOOSE_MOIM_MESSAGE_TEXT`/`GOOSE_MOIM_MESSAGE_FILE` into every turn.
- **scheduler** (hidden): create/manage scheduled recipes from chat.

### 2.3 Tool naming & routing

- Non-first-class tools are prefixed `"{extension_key}__{tool}"` (`extension_manager/mod.rs:363`). Owner is also stored in tool `_meta` so unprefixed tools still route.
- Routing is by name → owning client; tool annotations (`readOnlyHint`, `destructiveHint`, ...) feed the permission system.
- MCP Apps visibility (`_meta.ui.visibility`) can hide tools from the model and only expose them to UI apps (`reply_parts.rs::is_tool_visible_to_model`).

### 2.4 "Many tools" strategy (what replaced tool routers)

1. **Dynamic extensions**: model is told (system.md) it can enable/disable extensions; `search_available_extensions` + `manage_extensions`. Conversation may reference inactive extensions.
2. **Code Mode** collapses N tool schemas into 3 meta-tools + on-demand detail lookup. Their own benchmark (§8) shows Code Mode as the best configuration (57.3% vs 50.6% on terminal-bench-2 with Sonnet 4.6) at the cost of more input tokens.
3. Per-subagent extension restriction (`delegate(extensions: [...])`).
4. Hooks/allowlists for governance (`documentation/docs/guides/allowlist.md`: `GOOSE_ALLOWLIST` URL to a YAML list of allowed extension commands).
5. Supply-chain check: `agents/extension_malware_check.rs` queries the **OSV** vulnerability DB for npm/PyPI packages launched via `npx`/`uvx` before starting an extension.

---

## 3. Providers

### 3.1 Inventory

Registered in `crates/goose/src/providers/init.rs`:
Amp (ACP), Anthropic, Avian, Azure OpenAI, Azure Foundry, AWS Bedrock, Local Inference (llama.cpp/MLX/candle), ChatGPT Codex (OAuth subscription), **Claude Code via ACP (`claude-agent-acp`)**, Claude Code CLI, **Codex via ACP**, **Copilot via ACP**, Codex CLI, **Cursor Agent**, Databricks (v1+v2), GCP Vertex AI, Gemini CLI, Gemini OAuth, GitHub Copilot, Gondola, Google Gemini API, HuggingFace, Kimi Code, LiteLLM, NanoGPT, Muse Code, Ollama (+ Ollama Cloud), OpenAI, OpenRouter, **Pi via ACP**, SageMaker TGI, Snowflake, Tetrate, xAI (+ xAI OAuth).
Plus **53 declarative JSON providers** in `crates/goose-providers/src/declarative/definitions/` (Groq, Mistral, Together, Fireworks, Cerebras, Perplexity, DeepSeek-likes, Moonshot, Z.ai, LM Studio, llama-swap, Vercel AI Gateway, ...) and user-defined custom providers (`config/declarative_providers.rs`, ACP `_goose/unstable/providers/custom/*`).

Declarative provider example (`groq.json`): `{ name, engine: "openai", display_name, api_key_env, base_url, models: [{name, context_limit, max_tokens}], supports_streaming, preserves_thinking, setup: {category, setup_method: "single_api_key", docs_url} }`. **This is the single most copyable provider idea**: most OpenAI-compatible vendors are pure data.

A notable trend: goose treats **other coding agents as providers** (Claude Code, Codex, Copilot, Cursor, Pi, Amp) through ACP (`providers/acp_tooling.rs`, `acp/provider.rs` 4769 lines). Those providers report `manages_own_context() == true`, so goose disables its own compaction. `acp/handoff.rs` builds a budgeted, redacted "handoff memo" when moving a conversation into an ACP agent that can't resume natively.

### 3.2 Abstraction

`crates/goose-provider-types/src/base.rs::Provider` (async trait):
- `stream(...)` — the one required method; yields partial text but **complete** tool calls.
- `complete(...)`, `get_context_limit(model, override)`, `retry_config()`, `fetch_supported_models()`, `fetch_recommended_models(toolshim)`, `map_to_canonical_model()`.
- Capability hooks: `manages_own_context()`, `supports_builtin_tools()`, `uses_local_session_naming()`, `configure_oauth()`, `refresh_credentials()`, `update_mode()`, `thinking_effort_support()` + `set_thinking_effort()`, `provider_session_id()`/`resume()`.
- `ProviderDescriptor::metadata()` drives setup UI (keys, OAuth flags, setup steps).

`ModelConfig` (`goose-provider-types/src/model.rs`): `model_name, context_limit, temperature, max_tokens, toolshim, toolshim_model, request_params, reasoning, supports_vision, request_headers`.

**Canonical model registry** (`goose-provider-types/src/canonical/`, data in `canonical/data/canonical_models.json`) built from OpenRouter + models.dev (`build_canonical_models` bin) normalizes vendor ids (`claude-sonnet-4-5-20250929` → `anthropic/claude-sonnet-4.5`) and supplies pricing, context limits, vision/reasoning flags. Cost ledger uses it (`providers/canonical_cost.rs`, `usage_ledger` table).

Retry: `goose-provider-types/src/retry.rs::RetryConfig { max_retries, initial_interval_ms, backoff_multiplier, max_interval_ms, transient_only }`.

Thinking effort: `GOOSE_THINKING_EFFORT`, per-session `update_thinking_effort`; experimental **AutoEffort** (`ops_auto_effort.rs`) asks a tiny remote "TypeSafe" decision model to choose effort per turn (needs `TYPESAFE_API_KEY`, `GOOSE_AUTO_EFFORT_ENABLED`).

### 3.3 Tool-call shim for models without native tools

Two mechanisms:
1. **ToolShim** (`crates/goose/src/providers/toolshim.rs`, docs `documentation/docs/guides/tool-shim.md`): when `ModelConfig.toolshim` is on, tools are *removed* from the request and described in the system prompt (`prepare_tools_for_provider` → `modify_system_prompt_for_tool_json`). The main model's text is then sent to a separate **interpreter model** (default Ollama `mistral-nemo`, or local via `GOOSE_TOOLSHIM_BACKEND`/`GOOSE_TOOLSHIM_MODEL`) using structured output to extract tool calls, which are appended to the message. Also parses Kimi-style `<|tool_calls_section_begin|>` tokens and resolves aliases.
2. **Local tiny-model emulation** (`crates/goose-local-inference/src/tool_emulation.rs`, `prompts/tiny_model_system.md`): small local models are prompted to emit `$ command` lines (→ `developer__shell`) and ```` ```execute_javascript ```` fences (→ Code Mode); a markdown parser turns these into tool calls. A neat "only two tools" degradation strategy.

### 3.4 Lead/worker model

Removed from the code base (zero matches for `lead_worker`/`GOOSE_LEAD_MODEL` in `crates/`). Docs now point to `/model` mid-session switching and per-subagent `provider`/`model` overrides (`documentation/docs/guides/multi-model/index.mdx`). Historic design (blog `documentation/blog/2025-08-11-llm-tag-team-lead-worker-model/`): a strong model for the first N turns, cheaper model afterwards, fallback to lead on repeated failures.

### 3.5 Token counting

`crates/goose/src/token_counter.rs`: `tiktoken_rs::o200k_base` for all models (approximation), blake3-keyed LRU cache (1024 entries), OpenAI-style per-message (+4) and per-tool-schema overhead constants (`FUNC_INIT=7, PROP_KEY=3, FUNC_END=12`...). Provider-reported usage is preferred when available; estimation is the fallback. `agents/context_report.rs` (829 lines) builds an exact per-part token breakdown (system prompt sections by `##` heading, each tool owner as marginal prefix cost, messages) — shown in the desktop "Context X-ray" dialog.

### 3.6 Context management / auto-compaction

- Threshold: `GOOSE_AUTO_COMPACT_THRESHOLD` (default **0.8** of context) but capped by `GOOSE_AUTO_COMPACT_TOKEN_LIMIT` (default **225,000** tokens — chosen to stay under OpenAI's >272k long-context price tier) via `capped_compaction_threshold` (`crates/goose/src/context_mgmt/mod.rs`).
- Compaction (`compact_messages`) **does not delete history**: old messages become `user_visible=true, agent_visible=false`; the summary becomes `agent_only`; a continuation assistant message is added ("Do not mention that you read a summary..."; different text for manual compaction vs mid-tool-loop); the last real user text message is re-appended so the model keeps the current ask; the turn-context block is carried. UI keeps full scrollback while the model sees the summary.
- Summary prompt (`crates/goose-context-management/src/prompts/compaction.md`): `<analysis>` scratchpad then a **strict JSON** schema: `user_intent, technical_concepts, files[{path,summary,key_code}], errors_and_fixes (verbatim), problem_solving, user_messages, pending_tasks, current_work, next_step`; rendered back to text (`structured.rs`). Max 2 compactions per context-length error (`MAX_CONTEXT_ERROR_COMPACTIONS`). Manual `/compact` slash command.
- **Tool-pair summarization** (`ops_tool_pair_compaction.rs`, opt-in `GOOSE_TOOL_PAIR_SUMMARIZATION`): once tool calls exceed `tool_call_cutoff` (derived from context limit), the oldest 10 request/response pairs are replaced with LLM summaries.
- Large tool outputs spill to temp files (§1.3); shell output capped at 2000 lines per stream.
- Context-relevance shadow experiment (`ops_context_relevance.rs`): records judgments about which old tool outputs are still relevant, without changing the request — data collection for future pruning.
- Usage ledger records `is_compaction` cost separately.

---

## 4. Recipes, sub-recipes, scheduling, workflows, subagents

### 4.1 Recipes (`crates/goose/src/recipe/mod.rs`)

YAML/JSON agent configs:
```yaml
version: 1.0.0
title: ...
description: ...
instructions: |   # system-prompt addition (minijinja templated, {{recipe_dir}}, {{param}})
prompt: ...       # initial user message (at least one of instructions/prompt)
extensions: [ExtensionConfig...]
settings: { goose_provider, goose_model, temperature, max_turns }
activities: [...]     # clickable "pills" in desktop
parameters: [{ key, input_type: string|number|boolean|date|file|select, requirement, description, default, options }]
response: { json_schema }     # structured output → recipe__final_output tool validates
sub_recipes: [{ name, path, values, sequential_when_repeated, description }]
retry: { max_retries, checks: [{shell command}], on_failure, timeout_seconds, on_failure_timeout_seconds }
author: { contact, metadata }
```
Notable details:
- `file` parameters cannot have defaults ("to prevent importing sensitive user files").
- `retry.checks` are shell success checks; `RetryOperation` reruns the task (fresh context) until checks pass or `max_retries`, running `on_failure` cleanup between attempts.
- `response.json_schema` → `FinalOutputTool` (`agents/final_output_tool.rs`, tool name `recipe__final_output`) validates JSON; the run can't end without it.
- Recipes are shareable as **deeplinks** (`recipe_deeplink.rs`, `goose://recipe?...` base64), validated (`validate_recipe.rs`), stored locally (`local_recipes.rs`, docs `storing-recipes.md`), and can be created from a session (`session-recipes.md`). Desktop shows a **consent modal** for recipes from links (`RecipeConsentModalContainer.tsx`).
- `goose run --recipe x.yaml --param k=v` for headless runs; `--output-format` supports JSON streaming; `--explain`, `--render-recipe`, `--sub-recipe`.
- Recipe slash commands (`slash_commands/recipe_slash_command.rs`) — recipes become `/name`.

### 4.2 Sub-recipes and subagents

Sub-recipes are no longer separate tools; they surface through **summon** (`platform_extensions/summon.rs`, 3009 lines):
- Sources discovered from: session recipe's `sub_recipes`, `.agents/recipes`, `~/.agents/recipes`, **agent markdown files with YAML frontmatter (`name`, `description`, `model`) in `.goose/agents`, `.claude/agents`, `.agents/agents` and the home equivalents** — i.e. goose reads Claude Code subagent definitions as-is. Cached for 60s.
- `delegate` params: `instructions`, `source`, `parameters`, `extensions` (restrict; `[]` = none), `provider`, `model`, `temperature`, `max_turns` (else recipe setting or `GOOSE_SUBAGENT_MAX_TURNS`), `context` (injected into delegate system prompt), `working_dir` (must be within parent's), `resume` (continue a failed/cancelled/completed delegate by id).
- Tool description encodes delegation hygiene: "Delegates cannot coordinate. Same-file work = conflicts... Work (writes): partition files strictly".
- Execution: `SubagentOperation` (`goose-agent/src/subagent.rs` + `state_machine/ops_subagent.rs`) runs delegates in the foreground, **in parallel when multiple delegate calls appear in one assistant message**, bounded by `GOOSE_MAX_CONCURRENT_SUBAGENTS` (5). Background subagents were removed. Subagents are real sessions (`SessionType::SubAgent`, `parent_session_id`), their tool calls stream into the parent UI (`SubagentSessionNotice.tsx`, CLI `[subagent:16] ...`). System prompt `prompts/subagent_system.md`.
- Docs note subagents are **disabled outside Autonomous mode** (`documentation/docs/guides/context-engineering/subagents.mdx`).

### 4.3 Scheduling

`crates/goose/src/scheduler/full.rs` (1779 lines) uses `tokio_cron_scheduler`. `ScheduledJob { id, source (recipe path, copied into scheduled_recipes/), cron, last_run, currently_running, paused, current_session_id, process_start_time, parameters, recipe_base_dir }`. Runs create `SessionType::Scheduled` sessions with `schedule_id`. Managed via `goose schedule` CLI, ACP `_goose/unstable/schedules/*`, desktop `components/schedule/`, and the hidden `scheduler` platform extension (the agent can schedule itself; `agents/schedule_tool.rs`, security tests in `tests/schedule_tool_security.rs`).

### 4.4 Workflows

`workflow_recipes/release_risk_check/` is the pattern: `recipe.yaml` + helper script (`release_risk_report.py`) + `run.sh`. The recipe instructs: run a heuristic script → feed MEDIUM/HIGH items to an LLM with an embedded rubric that encodes the repo's risk map (it explicitly lists `permission/`, `tool_inspection.rs`, `acp/transport/auth.rs`, `session_manager.rs` as CRITICAL). "Workflows" = recipes + scripts + cron, not a DAG engine. `goose review` (`crates/goose-cli/src/commands/review/`, modeled after Amp's review) discovers `**/.agents/checks/*.md` reviewer subagents and `**/.agents/REVIEW.md` overrides, builds a diff, and orchestrates parallel checks.

### 4.5 Hooks, plugins, skills, hints, slash commands

- **Hooks** (`crates/goose/src/hooks/mod.rs`, 2224 lines) follow the **Open Plugins hooks spec**: `<plugin-root>/hooks/hooks.json`, events `PreToolUse, PreToolUseResult, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, UserPromptSubmit, BeforeReadFile, AfterFileEdit, BeforeShellExecution, AfterShellExecution, Stop`; regex `matcher` on tool names; `type: "command"` actions get JSON on stdin; 30s default timeout. Pre hooks can deny, Stop hooks can block ending (bounded).
- **Plugins** (`crates/goose/src/plugins/`): formats `OpenPlugins` and **Gemini** extensions; install metadata, 24h auto-update; plugins can carry MCP servers, hooks, skills.
- **Hints**: `.goosehints` and `AGENTS.md` by default, configurable via `CONTEXT_FILE_NAMES` (e.g. `CLAUDE.md`), nested lookup up to git root (`hints/load_hints.rs`), `@file` imports (`hints/import_files.rs`).
- **Skills**: `SKILL.md` folders; ops_skills makes them available as tools and slash commands.
- Slash commands: built-ins + recipe + skill commands (`slash_commands/`).

### 4.6 Goal and grind modes (cheap "keep going" control)

Implemented inside `RetryOperation` (`crates/goose/src/agents/state_machine/ops_retry.rs`), state stored as versioned extension state (`GoalState`):
- `/goal <text>` — when the model tries to end its turn, goose injects one hidden user nudge: "Before finishing, check whether the following goal has been fully met: **Goal:** ... If not, continue working toward it." (agent-visible, user-invisible, marked `nudged` so it fires once per turn) and shows an inline "Goal: ..." notice. Cleared with `/goal off|clear|none`.
- `/grind <text>` — every time the model tries to stop, inject "Keep working. The grind goal is not yet complete..." until `max_turns` is hit. A brute-force persistence mode.
- Then recipe `retry` checks run (shell success checks); on failure, optional `on_failure` cleanup, reset the conversation to the kickoff message, increment `attempts` note, and go again until `max_retries`.

This "stop-time verifier" pattern is extremely cheap and worth copying: a single operation that intercepts `ends_turn(messages)` and decides finish/nudge/reset.

### 4.7 Slash command inventory

- Agent-level (handled by operations via `run_command`): `/compact`, `/clear` (`ops_compaction.rs`), `/doctor` (`ops_doctor.rs`, runs diagnostics and feeds repair context back), `/status` (`ops_status.rs`), `/goal`, `/grind` (`ops_retry.rs`), `/skills` (`ops_skills.rs`), `/prompts`, `/prompt <name>` (MCP prompts, `ops_toolcalling.rs`), `/summarize`, recipe and skill commands (`slash_commands/recipe_slash_command.rs`, `skill_slash_command.rs`), `!<cmd>` bang shell (`ops_bang_shell.rs`).
- CLI REPL-level (`crates/goose-cli/src/session/input.rs`): `/exit`, `/quit`, `/help`, `/new`, `/edit` (open `$EDITOR`), `/model`, `/mode`, `/recipe` (save session as recipe), `/r`, `/t` (theme), plus the above.
- Because slash commands are dispatched through the same operation list, *any* operation can own commands — a clean extensibility seam.

---

## 5. Permissions, security, sandboxing

### 5.1 Modes (`goose-provider-types/src/goose_mode.rs::GooseMode`)
`Auto` (default! "Automatically approve tool calls"), `Approve` (ask before every call), `SmartApprove` (ask only for sensitive), `Chat` (no tools). Per-session (`sessions.goose_mode` column); `/mode` in CLI; provider can be told (`Provider::update_mode`) — used to map onto Codex `--sandbox read-only` / `--full-auto` / `--yolo` for CLI-wrapped agents (`providers/codex.rs`).

### 5.2 Per-tool permissions
`config/permission.rs::PermissionLevel { AlwaysAllow, AskBefore, NeverAllow }` per tool, persisted (`permission/permission_store.rs`); user answers use `Permission { AlwaysAllow, AllowOnce, Cancel, DenyOnce, AlwaysDeny }`. MCP `readOnlyHint` annotations auto-approve in smart mode (`permission_inspector.rs::apply_tool_annotations`).

**SmartApprove judge** (`permission/permission_judge.rs`): an LLM call with a forced tool `platform__tool_by_tool_permission` returning `read_only_request_ids`; prompt `prompts/permission_judge.md` treats ids/names/args as untrusted data and says ambiguous ⇒ not read-only. Non-read-only decisions are cached as `AskBefore`.

### 5.3 Tool inspection pipeline (`crates/goose/src/tool_inspection.rs`, wired in `services.rs:559-576`)
Ordered inspectors, each returning `Allow | Deny | RequireApproval(reason)`:
1. `SecurityInspector` — **prompt-injection / dangerous-command scanner** (`security/scanner.rs`, `patterns.rs`): ~40 regex `ThreatPattern`s (`rm_rf_root`, `curl_bash_execution`, `ssh_key_exfiltration`, `history_exfiltration`, `crontab_modification`, `systemd_service_creation`, `hosts_file_modification`, PowerShell download-exec, ...) plus optional ML classifiers via a "classification API" (`classification_client.rs`, spec in `documentation/docs/guides/security/classification-api-spec.md`) for command and prompt; scans up to 10 recent user messages; off by default (`SECURITY_PROMPT_ENABLED`).
2. `EgressInspector` — extracts network destinations (curl/wget/ssh/scp/git remotes...) from shell commands, classifies direction, flags outbound.
3. `AdversaryInspector` — **"adversary mode"**: if `~/.config/goose/adversary.md` exists, a second LLM pass (same provider) sees original task + recent messages + the tool call and returns ALLOW/BLOCK per natural-language policy. **Fail-open**. Blocked calls can't be retried.
4. `PermissionInspector` — mode + per-tool levels + smart judge; baseline that the others override.
5. `RepetitionInspector` (`tool_monitor.rs`) — blocks identical repeated calls beyond `--max-tool-repetitions`.

Approval results become `ActionRequired` messages; desktop renders `ToolApprovalButtons.tsx` / `ToolCallConfirmation.tsx`; ACP exposes standard `session/request_permission`.

### 5.4 Sandboxing — the big gap
There is **no OS-level sandbox** for goose's own shell tool (no seatbelt/landlock/bwrap/AppContainer). Isolation options are: run stdio/builtin extensions inside an existing **Docker container** (`--container <id>`, `agents/container.rs`, `extension_manager/stdio.rs::docker_exec`); Code Mode JS (boa) is capability-free; MCP Apps run in sandboxed browser windows; Flatpak packaging. Supply-chain: OSV malware check + admin allowlist. Default mode is fully autonomous.

---

## 6. ACP, server API, sessions, live voice

### 6.1 ACP support (both directions)
- **goose as ACP agent**: `goose acp` (stdio), `goose serve` (HTTP+WebSocket via `agent-client-protocol-http`), `goose roam` (P2P). Server in `crates/goose/src/acp/server.rs` (3860 lines) + `acp/server/*.rs` (new/load/fork/list sessions, prompts, tool calls, elicitation, extensions, providers, recipes, schedules, sources, dictation, live voice, diagnostics, context report, apps, onboarding import). Clients: goose desktop, Zed (`documentation/docs/guides/zed.md`), any ACP client (`test_acp_client.py`).
- **goose as ACP client**: other agents as providers (`acp/provider.rs`, `providers/*_acp.rs`), with `mcp_app_proxy.rs` and handoff memos.
- **Custom extension methods**: 85 `_goose/unstable/*` JSON-RPC methods (`crates/goose-sdk-types/src/custom_requests*.rs`) — config, providers (catalog/inventory/secrets/custom/readiness), recipes (encode/decode/scan/schedule), schedules, sessions (archive/export/import/rename/steer/truncate/fork/project), extensions, tools (list/call/permissions), sources, dictation, prompts, defaults/preferences, onboarding import, diagnostics, context report, apps. JSON schema generated by `crates/goose/src/bin/generate_acp_schema.rs`. This is the **entire desktop API** — desktop is "just an ACP client".

### 6.2 Sessions storage
SQLite via `sqlx` (`crates/goose/src/session/session_manager.rs`, `CURRENT_SCHEMA_VERSION = 18`, `BEGIN IMMEDIATE` to avoid multi-process creation races). Tables:
- `sessions(id, name, description, user_set_name, session_type, working_dir, timestamps, extension_data JSON, current + accumulated token counters incl. cache read/write, accumulated_cost, schedule_id, recipe_json, user_recipe_values_json, provider_name, model_config_json, goose_mode, archived_at, project_id, parent_session_id, system_prompt_override, system_prompt_extras_json, container_id, thread_id)`
- `messages(id, message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json)` — metadata carries `user_visible/agent_visible`, operation notes.
- `usage_ledger(session_id, model, input/output/total/cache tokens, cost, cost_source, is_compaction)`; `threads`; `schema_version`.
- `SessionType { User, Scheduled, SubAgent, Hidden, Terminal, Gateway, Acp }`.
Extras: full-text chat-history search (`chat_history_search.rs`), export to Markdown/HTML (`export_markdown.rs`, `export_html/`), **import from other agents' formats** (`session/import_formats/`, desktop onboarding import scan), LLM session naming (`session_naming.rs`, `prompts/session_name.md`), fork session, truncate conversation (edit & resend), legacy JSONL migration (`legacy.rs`).

### 6.3 Live voice & dictation
- **Live voice** (`crates/goose/src/live_voice/`, feature `live-voice`; providers `goose-providers/src/openai_live*.rs`): browser does WebRTC with an OpenAI realtime-class model (default voice `marin`, endpoint/model/key configurable via `GOOSE_LIVE_VOICE_*`). The voice model is a **conversational front-end that delegates to goose** for tool work; instructions encode an interruption policy and "delegate only complete requests; ask one clarification otherwise; never guess results". Transcript published into the session; input capped (128 msgs / 8192 tokens). UI: `ui/desktop/src/liveVoice/`, `LiveVoiceButton.tsx`.
- **Dictation**: local Whisper (`crates/goose/src/dictation/whisper.rs`, model download management) or provider STT.

### 6.4 Other surfaces
Telegram gateway with pairing codes (`gateway/`), terminal-integrated sessions (`goose term`), P2P roaming with connection cards and mutual key acceptance (`crates/goose-roaming/`), OTEL + Langfuse tracing (`otel/`, `tracing/langfuse_layer.rs`, GenAI semantic conventions in `agents/gen_ai_telemetry.rs`), PostHog telemetry with consent.

### 6.5 ACP custom method catalog (grouped)

All under `_goose/unstable/` (the `unstable` segment is an explicit versioning signal — copy this):

| Group | Methods |
|---|---|
| config | `config/read`, `config/upsert`, `config/remove`, `config/extensions/{list,add,remove}`, `config/prompts/{list,get,save,reset}`, `defaults/{read,save,clear}`, `preferences/{read,save}` |
| providers | `providers/list`, `providers/catalog/{list,template}`, `providers/config/{read,save,delete,status,authenticate}`, `providers/custom/{create,read,update,delete}`, `providers/inventory/refresh`, `providers/readiness/check`, `providers/secrets/{list,delete}`, `providers/setup/catalog/list` |
| session | `session/{info,update,rename,archive,unarchive,export,import,steer}`, `session/conversation/truncate`, `session/extensions/{list,add,remove}`, `session/project/update` (+ standard ACP new/load/list/fork/prompt/cancel) |
| tools | `tools/list`, `tools/call`, `tools/permissions/set` |
| recipes | `recipes/{list,parse,save,delete,scan,encode,decode,schedule}` |
| schedules | `schedules/{list,create,update,delete,pause,unpause}`, `schedules/sessions/list` |
| sources | `sources/{list,create,update,delete,import,export}` (recipes/agents/skills sources) |
| misc | `resources/read`, `context/report`, `diagnostics/get`, `apps/{list,import,export,delete}`, `dictation/{config,transcribe}`, `dictation/models/{list,download,download/progress,cancel,delete}`, `onboarding/import/{scan,apply}` |

85 methods total. Notifications include tool-call updates (`acp/tool_call_notifier.rs`), session name updates, live voice transcript, and MCP app events. Message metadata is attached through ACP `_meta` (`acp/server/message_meta.rs`).

### 6.6 Roaming (P2P) details

`crates/goose-roaming` (standalone, no goose-core dependency): iroh QUIC endpoint whose ed25519 key *is* the node identity (stored hex in a `0600` file). Peers exchange non-secret **connection cards** (pubkey + relay URLs + short fingerprint), each side accepts the other's key into a `TrustBook`; both sides must accept. Over the authenticated stream it carries plain ACP — roaming adds no session semantics. CLI: `goose roam` (share/connect/proxy/full bridge in `crates/goose-cli/src/commands/roam*.rs`). Use cases: drive your desktop agent from a laptop/phone, delegate a one-shot task to a remote machine, bridge a remote agent to a local ACP client — without port forwarding.

---

## 7. Desktop UI notable features (`ui/desktop/src`)

- Electron Forge + Vite + React; i18n (`i18n/messages/{en,es,it,pt,id,...}.json`); RTL support (`rtlChatDirection.test.tsx`).
- Pure ACP client (`acp/*.ts`: `chatSessionController.ts`, `chatSessionStore.ts`, `permissionRequests.ts`, `elicitationRequests.ts`, `recipeParamRequests.ts`, `contextReport.ts`, `liveVoice.ts`, `mcp-apps.ts`).
- Multi-session sidebar with **concurrent live sessions** (`ChatSessionsContainer.tsx`), session list/archive/search, fork, export.
- **Message queue / steering** while the agent runs (`MessageQueue.tsx`, `_goose/unstable/session/steer` → `SteerOperation`).
- **Context X-ray** (`components/context_xray/`: `CapacityMeter`, `BreakdownList`) — exact token attribution per prompt section/tool owner/messages.
- Tool call rendering with arguments, status, confirmation buttons, security notes (`ToolCallWithResponse.tsx`, `ToolCallStatusIndicator.tsx`), thinking blocks (`ThinkingContent.tsx`), subagent notices, inline system notifications (compaction etc.), usage stats per message (`MessageUsageStats.tsx`), credits-exhausted notices.
- **MCP Apps renderer** (`components/McpApps/McpAppRenderer.tsx`, `PipWindow.tsx`) — interactive HTML UI from MCP tools, picture-in-picture; standalone "Apps" view for goose-generated apps.
- Recipes: params modal, consent modal for deeplinked recipes, recipe header, activity pills; schedules UI; skills UI; extensions UI with **deeplink install** (`goose://extension?...`) + `ExtensionInstallModal`, allowlist enforcement (`allowlistFetcher.ts`).
- Settings: providers (incl. OAuth flows, custom providers), models, mode, per-tool permissions, security (prompt injection, adversary), agent-loop knobs (`AgentLoopSettings.tsx`), prompts editor (override system prompt pieces: `_goose/unstable/config/prompts/*`), response styles, keyboard shortcuts, dictation, local inference model manager.
- Live voice button, dictation, `@` mentions popover (files/resources), git branch indicator, launcher view, onboarding (import from other agents), auto-update (`updates.ts`, `githubUpdater.ts`), remote backends, startup diagnostics, file-access mediation in preload (`desktopFileAccess.ts`).

---

## 8. Evals framework (`evals/harbor/`)

- Built on **Harbor** (terminal-bench runner). `cmd.py` is a PEP-723 `uv` script; `agent.py` defines `GooseBinaryAgent` which uploads a local goose binary into each Docker task container, renders `config_template.yaml` with chosen extensions enabled, runs headless, streams JSON. `runner.py`, `reporter.py` (`cmd.py list` comparison table: rate, compute hours, in/out tokens, turns, cost, pass/fail/err/timeout).
- Defaults: dataset `terminal-bench/terminal-bench-2` (89 tasks), `anthropic/claude-sonnet-4-6`, extensions `developer,todo`, concurrency 4, max turns 100.
- Non-goose harnesses (opencode, pi, aider, claude-code) run through stock Harbor configs for apples-to-apples.
- Meta-recipes for analysis: `evals/harbor/recipes/analyze_bench_failure.yaml`, `compare_bench_run.yaml` (goose analyzing its own failed trials).
- Published snapshot (README): goose + Code Mode **57.3%**, goose + summon 55.1%, Harbor's vanilla Goose 55.1%, opencode 52.8%, stock goose 50.6%, pi 47.2%, nemotron-nano 1.1%. Code Mode costs more input tokens (63M vs 62M for stock; cost figures $206 vs n/a).
- Other testing: MCP record/replay (`just record-mcp-tests`, `crates/goose/tests/mcp_replays/`), state-machine API tests (`tests/state_machine_api.rs`), security tests (`git_command_security.rs`, `schedule_tool_security.rs`, `adversary_inspector_tests.rs`, `tool_inspection_permission_precedence.rs`), insta snapshot tests for system prompts (`agents/snapshots/`), Playwright for desktop.

---

## 9. Strengths worth copying (ranked) and weaknesses (ranked)

### 9.1 Strengths to copy into rcode

1. **Operation-pipeline state machine over a persisted transcript** (`goose-agent/src/machine.rs`, `state_machine_builder.rs`). Each concern (approval, hooks, tool exec, subagents, steering, compaction, retry, max-turns, stop hooks) is an isolated `Operation` with `run / inference_tools / prompt_parts / moim_parts / run_command / finalize_cancellation`. Reload-after-every-step makes turns crash-resumable and confirmation waits trivial. In TS: `interface Operation { name; run(session, convo, emit): Promise<Applied|NotApplicable>; tools?(); promptParts?(); turnContext?(); command?(); onCancel?() }` + a 30-line loop.
2. **"Everything is MCP" with three hosting tiers** (in-process platform, in-process MCP server over duplex streams, external stdio/HTTP). Uniform routing, permissions and UI for built-in and third-party tools. In Bun: in-process `McpClient` interface + `InMemoryTransport` from the MCP SDK.
3. **Non-destructive compaction with visibility flags** (`user_visible`/`agent_visible`) + strict-JSON structured summary prompt + re-appending the latest user ask + continuation message variants + token-limit cap (225k) independent of percentage threshold.
4. **Declarative JSON providers** + canonical model registry (pricing/context/vision from OpenRouter/models.dev) + usage/cost ledger including cache tokens and compaction cost.
5. **Code Mode** (JS sandbox exposing `tools.call`, `list_functions`, `get_function_details`) — measurable +6.7pt on terminal-bench-2 in their own evals; also the fallback for tiny models.
6. **Layered tool inspection chain** (regex threat patterns → egress → LLM adversary with user-written markdown policy → permission/smart judge → repetition guard), each returning Allow/Deny/Ask with reasons; judge prompts explicitly treat tool args as untrusted.
7. **ACP as the only client API** (desktop, IDEs, P2P, remote) with namespaced `_vendor/unstable/*` extension methods and a generated schema. rcode should make its server ACP-native from day one so Zed/other ACP clients work for free.
8. **Subagent `delegate` design**: source-based (recipes, Claude-format `.claude/agents/*.md`), ad-hoc, resumable by id, extension restriction, per-delegate model, parallel fan-out bounded at 5, working_dir confinement, and tool-description guidance about file partitioning.
9. **Cross-ecosystem compatibility**: reads `AGENTS.md`/`CLAUDE.md` (configurable), `.claude/agents`, `SKILL.md`, Open Plugins hooks, Gemini extensions, imports other agents' sessions. Cheap adoption wins.
10. **Turn budget in per-turn context** ("as the budget gets low, become more direct") and stable tool ordering for prompt caching; explicit Anthropic cache breakpoints.
11. **Tool-call robustness layer**: mangled-name recovery, argument coercion, schema normalization, OpenAI-safe name hashing, interrupted-call synthesis, large-output spill to file.
12. **Recipes with retry checks + structured final output** — a portable, shareable "agent job" format (deeplinks, params incl. file type, cron scheduling, recipe slash commands).
13. **Steering queue** — user can inject guidance mid-run without cancelling.
14. **Context X-ray** — exact per-section token attribution; great UX/debugging feature.
15. **In-repo benchmark harness** comparing against competitor harnesses, plus recipes that analyze failures.

### 9.2 Weaknesses / gaps (ranked)

1. **No OS sandbox and Autonomous is the default.** Shell runs with full user privileges; only Docker-container mode for extensions. rcode should ship seatbelt (macOS) / bubblewrap+landlock (Linux) with write-scoped workspace + network policy by default.
2. **Security features are opt-in and fail-open** (prompt-injection scanner off by default; adversary fails open; ML classifiers require an external classification API).
3. **Developer toolset is minimal**: no first-class read/grep/glob/multi-edit/patch tools; reading goes through `shell` (harder to permission, cache, and render; no read-before-edit tracking, no LSP diagnostics after edits). Edit is a single exact replace.
4. **Huge, churny core** (`services.rs` 2985 lines, `acp/provider.rs` 4769, `acp/server.rs` 3860, `summon.rs` 3009, `extension_manager/mod.rs` 2732) and **stale docs** (AGENTS.md points to a non-existent `agent.rs`; workflow recipe references `extension_manager.rs` path that no longer exists). Many features feature-flagged and/or experimental (TypeSafe-dependent AutoEffort/context relevance require a third-party key).
5. **Token counting is approximate** (o200k for every model) — fine as fallback but compaction triggers can be off for Claude/Gemini tokenizers.
6. **Subagents disabled outside Autonomous mode**, foreground-only (background subagents removed), no inter-agent coordination primitives.
7. **No git-aware checkpoints/undo** for file edits (no snapshot/rollback system found); recovery relies on the user's VCS.
8. **ToolShim relies on a second (often Ollama) model**, adding latency and a local dependency; quality depends on interpreter.
9. **Lead/worker multi-model routing removed**; no automatic cheap/expensive model routing in core.
10. **Many surfaces = large attack surface** (serve, roam, gateway/Telegram, MCP Apps, scheduler tool that lets the agent schedule itself), mitigated by tests but complex.
11. **MCP coverage gaps**: no sampling support observed; legacy server directory being migrated to the official MCP Registry.

---

## 10. The 20 most important source files

| # | Path (relative to repo root) | One-liner |
|---|---|---|
| 1 | `crates/goose-agent/src/machine.rs` | Generic state-machine engine: ordered steps, first-applicable-wins, reload/apply loop, cancellation finalize. |
| 2 | `crates/goose-agent/src/operation.rs` | `Operation`/`Inference` traits, effects, run status, transcript helpers (`messages_since_kickoff`, `ends_turn`). |
| 3 | `crates/goose/src/agents/state_machine_builder.rs` | Assembles goose's concrete operation pipeline and its ordering. |
| 4 | `crates/goose/src/agents/services.rs` | `StateMachineServices`: `reply`, `resume_turn`, steering, provider switching, turn settings, inspector wiring. |
| 5 | `crates/goose/src/agents/state_machine/ops_toolcalling.rs` | Exposes extension tools and executes tool calls (concurrent streams). |
| 6 | `crates/goose/src/agents/state_machine/ops_llm.rs` + `inference_preparation.rs` | Inference runner and request preparation (lease snapshot, prompt, tools). |
| 7 | `crates/goose/src/agents/extension_manager/mod.rs` | Extension lifecycle, tool prefixing/routing, mangled-name recovery. |
| 8 | `crates/goose/src/agents/extension_manager/lease.rs` | Per-turn immutable snapshot of extensions/tool catalog; OpenAI-safe name rewriting. |
| 9 | `crates/goose/src/agents/extension.rs` | `ExtensionConfig` (stdio/builtin/platform/streamable_http) and related types. |
| 10 | `crates/goose/src/agents/platform_extensions/mod.rs` | Registry of in-process platform extensions and their context. |
| 11 | `crates/goose/src/agents/platform_extensions/developer/{mod,shell,edit}.rs` | Core coding tools: write, edit, shell, tree, read_image. |
| 12 | `crates/goose/src/agents/platform_extensions/summon.rs` | `load`/`delegate` subagents, source discovery (recipes, `.claude/agents`). |
| 13 | `crates/goose/src/agents/platform_extensions/code_execution.rs` | Code Mode: JS (boa) tool orchestration with function catalog. |
| 14 | `crates/goose/src/context_mgmt/mod.rs` | Auto-compaction thresholds, non-destructive compaction, tool-pair summarization. |
| 15 | `crates/goose-context-management/src/prompts/compaction.md` | Structured-JSON compaction prompt. |
| 16 | `crates/goose-provider-types/src/base.rs` | `Provider` trait, model info merging, capability hooks. |
| 17 | `crates/goose/src/providers/toolshim.rs` | Tool-call emulation via interpreter model for non-tool models. |
| 18 | `crates/goose/src/tool_inspection.rs` + `permission/permission_inspector.rs` + `security/scanner.rs` | Inspector chain, permission decisions, injection/threat scanning. |
| 19 | `crates/goose/src/acp/server.rs` (+ `acp/server/*.rs`, `goose-sdk-types/src/custom_requests.rs`) | ACP server: sessions, prompts, permissions, and 85 `_goose/unstable/*` methods. |
| 20 | `crates/goose/src/session/session_manager.rs` | SQLite schema v18 for sessions, messages, usage ledger, threads. |

Honorable mentions: `crates/goose/src/recipe/mod.rs` (recipe schema), `crates/goose/src/hooks/mod.rs` (Open Plugins hooks), `crates/goose/src/agents/moim.rs` (turn-context/budget block), `crates/goose/src/prompts/system.md`, `crates/goose/src/security/adversary_inspector.rs`, `ui/desktop/src/gooseServe.ts`, `evals/harbor/README.md`.

---

## Appendix A — Key configuration knobs (env / config keys)

| Key | Default | Effect |
|---|---|---|
| `GOOSE_MAX_TURNS` | 1000 | Autonomous turn cap per user turn. |
| `GOOSE_SUBAGENT_MAX_TURNS` | — | Subagent turn cap. |
| `GOOSE_MAX_CONCURRENT_SUBAGENTS` | 5 | Parallel delegates. |
| `GOOSE_AUTO_COMPACT_THRESHOLD` | 0.8 | Fraction of context that triggers compaction. |
| `GOOSE_AUTO_COMPACT_TOKEN_LIMIT` | 225000 | Absolute compaction trigger cap. |
| `GOOSE_TOOL_PAIR_SUMMARIZATION` | false | Summarize old tool pairs. |
| `GOOSE_TOOL_CALL_CUTOFF` | derived | Tool pairs kept before summarizing. |
| `GOOSE_MAX_TOOL_RESPONSE_SIZE` | 200000 chars | Spill threshold to temp file. |
| `GOOSE_STOP_HOOK_BLOCK_CAP` | default deny limit | Max Stop-hook blocks per turn. |
| `GOOSE_RECIPE_RETRY_TIMEOUT_SECONDS` / `..._ON_FAILURE_TIMEOUT_SECONDS` | 300 / 600 | Recipe retry command timeouts. |
| `GOOSE_TOOLSHIM`, `GOOSE_TOOLSHIM_BACKEND`, `GOOSE_TOOLSHIM_MODEL` | off / ollama / mistral-nemo | Tool-call emulation. |
| `GOOSE_SHELL` | platform | Shell used by developer `shell`. |
| `CONTEXT_FILE_NAMES` | `.goosehints`, `AGENTS.md` | Hint files to load. |
| `SECURITY_PROMPT_ENABLED`, `SECURITY_*_CLASSIFIER_ENABLED` | false | Injection scanning. |
| `~/.config/goose/adversary.md` | absent | Enables adversary reviewer. |
| `GOOSE_ALLOWLIST` | unset | URL of extension allowlist YAML. |
| `GOOSE_MOIM_MESSAGE_TEXT/FILE` | unset | Top-of-mind injection every turn. |
| `GOOSE_LIVE_VOICE_*` | off | Realtime voice config. |
| `GOOSE_AUTO_EFFORT_ENABLED`, `GOOSE_CONTEXT_RELEVANCE_SHADOW`, `TYPESAFE_API_KEY` | off | Experiments using TypeSafe decision models. |

## Appendix B — Concrete design sketch for rcode inspired by goose

```ts
// core/loop.ts
type Status = "continue" | "yield" | "cancelled";
interface StepResult { effects: Effect[]; status: Status; applied?: string }
interface Operation {
  name: string;
  run(s: Session, c: Conversation, emit: Emit): Promise<StepResult | null>; // null = not applicable
  tools?(s: Session): Promise<Tool[]>;
  promptParts?(s: Session, c: Conversation): Promise<[string, string][]>;
  turnContext?(s: Session, c: Conversation): Promise<string[]>;
  command?(cmd: SlashCommand, s: Session, c: Conversation, emit: Emit): Promise<StepResult | null>;
  onCancel?(s: Session, c: Conversation, emit: Emit): Promise<Effect[]>;
}
export async function runTurn(ops: Operation[], infer: Inference, store: SessionStore, id: string, emit: Emit, signal: AbortSignal) {
  for (;;) {
    const s = await store.load(id);
    let r: StepResult | null = null;
    for (const op of ops) { if (signal.aborted) break; if ((r = await op.run(s, s.conversation, emit))) { r.applied = op.name; break; } }
    r ??= await infer.run(s, await collectInput(ops, s), emit) ?? { effects: [], status: "yield" };
    await store.apply(id, r.effects, emit);
    if (r.status !== "continue") break;
  }
  if (signal.aborted) await finalizeCancellation(ops, store, id, emit); // synthesize interrupted tool results
}
```

Recommended operation order for rcode (adapted): slash-commands → approval (inspector chain) → pre-tool hooks → tool execution (parallel, read-only calls concurrently) → subagents → steering → compaction (structured JSON, visibility flags, 80%/absolute cap) → tool-output pruning → retry/success-checks → stop hooks → max-turns → inference. Add what goose lacks: OS sandbox by default, read/grep/glob/patch tools with read-before-write tracking, git-backed checkpoints/undo, provider-specific tokenizers, background subagents.

## Appendix C — Operation-by-operation reference (pipeline order)

All paths under `crates/goose/src/agents/state_machine/` unless noted. "Owns" lists slash commands / tools the op contributes.

| # | Operation (file, lines) | Applies when | Effect | Owns |
|---|---|---|---|---|
| 0 | `SlashCommandOperation` (`ops_slash_command.rs`, 84) | Kickoff message is `/cmd ...` | Dispatches to every op's `run_command` (+ `StatusOperation`) | routing |
| 1 | `ToolApprovalOperation` (generic `goose-agent/src/tool_approval.rs`, 194; goose impl `tool_approval.rs`, 127) | Open tool requests lacking a decision | Runs inspector chain; Allow → proceed, Deny → declined response ("The user declined to run this tool."), Ask → `ActionRequired` and **yield** | — |
| 2 | `PreToolCallHookOperation` (`pre_tool_hook.rs`, 136; generic `pre_tool_call_hook.rs`, 93) | Approved, not yet hooked | Runs `PreToolUse` plugin hooks; can deny/modify | — |
| 3 | `SkillOperation` (`ops_skills.rs`, 432) | Skill tool calls / `/skills` | Loads skill content | skill tools, `/skills`, skill commands |
| 4 | `RecipeOperation` (`ops_recipe.rs`, 383) | Recipe commands; final-output enforcement | Sets recipe; requires `recipe__final_output` when `response` schema declared | recipe commands, final_output tool |
| 5 | `ToolExecutionOperation` (`ops_toolcalling.rs`, 1075) | Approved tool requests owned by extensions | Executes (concurrent streams), post-hooks, large-output handling, MCP notifications | all extension tools, `/prompts`, `/prompt` |
| 6 | `RemainingToolCallsOperation` (`ops_remaining_tool_calls.rs`, 328) | Requests nobody handled | Answers them (error) so transcript stays valid | — |
| 7 | `UnhandledToolCallsOperation` (`goose-agent/src/unhandled_tool_calls.rs`, 75) | Same, generic layer | Fallback responses | — |
| 8 | `SubagentOperation` (`ops_subagent.rs`, 625; `goose-agent/src/subagent.rs`, 296) | `delegate` calls present | Runs subagent sessions in parallel (≤5), streams their events, returns results | delegate execution |
| 9 | `SteerOperation` (`ops_steer.rs`, 98) | Steer queue non-empty and agent between model/tool turns | Appends queued user guidance; fires `UserPromptSubmit` hook | — |
| 10 | `BangShellOperation` (`ops_bang_shell.rs`, 75) | Kickoff begins with `!` | Synthesizes a direct `shell` tool call | `!cmd` |
| 11 | `ContextRelevanceOperation` (`ops_context_relevance.rs`, 513) | Opt-in shadow mode | Records relevance judgments only | — |
| 12 | `CompactionOperation` (`ops_compaction.rs`, 305) | Over threshold / context error / `/compact` | `CompactConversation` effect; `/clear` resets | `/compact`, `/clear` |
| 13 | `ToolPairCompactionOperation` (`ops_tool_pair_compaction.rs`, 183) | Tool pairs > cutoff and enabled | Summarizes oldest batch of 10 | — |
| 14 | `DoctorOperation` (`ops_doctor.rs`, 83) | `/doctor` | Session diagnostics → repair context | `/doctor` |
| 15 | `ProjectOperation` (`ops_project.rs`, 39) | Session has a project | Adds project instructions to prompt parts | — |
| 16 | `RetryOperation` (`ops_retry.rs`, 279) | Model ended the turn | Goal nudge / grind nudge / recipe success checks → reset & retry | `/goal`, `/grind` |
| 17 | `EmptyResponseOperation` (`ops_empty_response.rs`, 55) | Empty model output and nothing else applied | Reveals fallback message | — |
| 18 | `StopHookOperation` (`stop_hook.rs`, 82; generic `goose-agent/src/stop_hook.rs`, 122) | Turn about to end | `Stop` hooks may block (≤ cap per turn) with reason fed back to model | — |
| 19 | `ExitOnErrorOperation` (`ops_exit_on_error.rs`, 38) | Trailing error | Yields | — |
| 20 | `MaxTurnsOperation` (`ops_maxturns.rs`, 68) | Assistant turn count ≥ max | Ends turn with notice | — |
| 21 | extras: `AutoEffortOperation` (`ops_auto_effort.rs`, 267) | Enabled + supported model | Picks thinking effort per turn via decision model | `/auto-effort-review` |
| 22 | `Step::Inference(InferenceRunner)` (`ops_llm.rs`, 369; generic `goose-agent/src/inference.rs`, 675) | Last message is user/tool and nothing else applied | Streams model response, records usage | — |

Observations:
- Approval runs **before** execution as a separate step, so "ask" naturally becomes "yield and wait"; when the user answers (ACP `request_permission` response or desktop buttons), `resume_turn` restarts the same pipeline and the approval op now finds a decision in the transcript.
- Ops 16–20 are all "end-of-turn arbiters" — a clean place for verification gates, test runners, or lint checks before declaring done.
- Compaction sits *before* inference but *after* tool execution, so a turn that just produced a huge tool result gets compacted before the next model call.

## Appendix D — Test & quality inventory worth emulating

- `crates/goose/tests/state_machine_api.rs` — drives the pipeline with fake providers; `crates/goose/src/agents/state_machine/tests/`.
- `crates/goose/tests/compaction.rs`, `auto_compact_token_limit.rs` — compaction thresholds and behavior.
- `crates/goose/tests/mcp_integration_test.rs` + `mcp_replays/` — recorded MCP sessions replayed deterministically (`just record-mcp-tests`, capture binary `crates/goose-test/src/bin/capture.rs`); also a FastMCP Python test server (`fastmcp_test_server.py`).
- Security: `git_command_security.rs`, `schedule_tool_security.rs`, `adversary_inspector_tests.rs`, `repetition_inspector_tests.rs`, `tool_inspection_manager_tests.rs`, `tool_inspection_permission_precedence.rs`, `permission_persistence.rs`, `acp_transport_auth_test.rs`.
- Process hygiene: `developer_shell_cleanup.rs`, `subprocess_cleanup.rs` (no orphaned children after cancel).
- Providers: `providers.rs`, `declared_cache_pricing.rs`, `declared_vision_registry.rs`, `litellm_default_host.rs`, `tetrate_streaming.rs`, local inference perf/integration tests.
- ACP: `acp_server_test.rs`, `acp_fork_session_test.rs`, `acp_custom_requests_test.rs`, `acp_trace_context_test.rs`, `session_id_propagation_test.rs`.
- Prompt snapshots: `crates/goose/src/agents/snapshots/*.snap` (insta) — any system-prompt change shows up as a reviewable diff. Strongly recommended for rcode (e.g. vitest/bun snapshot of the rendered system prompt for typical configs).
- Desktop: Vitest unit tests next to components, Playwright e2e (`ui/desktop/playwright.config.ts`), integration config (`vitest.integration.config.ts`).
- Repo process: `AGENTS.md` rules (no comments restating code, `anyhow::Result`, clippy `-D warnings`, never overwrite a live binary in place on macOS — unlink/rename first or the OS SIGKILLs running processes with "Code Signature Invalid").

## Appendix E — Prioritized action list for rcode

P0 (architecture, do first)
1. Transcript-as-truth + operation pipeline loop (Appendix B), effects incl. visibility flags and per-operation notes; resumable turns.
2. ACP-native server (stdio + WebSocket) as the only client API; namespace custom methods `_rcode/unstable/*`; generate a JSON schema for them.
3. MCP-everywhere tool layer with in-process MCP servers for built-ins (Bun `InMemoryTransport`), per-turn extension lease, stable sorted tool list, name sanitization/hashing, mangled-name recovery, argument coercion, schema normalization.
4. Default-on OS sandbox (seatbelt / bwrap+landlock) — goose's biggest gap — with an approval mode matrix (auto / smart / approve / chat) per session.

P1 (quality multipliers)
5. Structured-JSON compaction with non-destructive visibility, preserved latest user ask, absolute + relative thresholds, compaction cost accounting; large-output spill to files.
6. Inspector chain: regex threat patterns, egress extraction, optional LLM adversary with user markdown policy (fail-closed option), smart read-only judge treating args as untrusted, repetition guard.
7. Declarative provider JSON + canonical model registry (models.dev) + usage ledger with cache tokens and cost.
8. `delegate` subagents (source-based incl. `.claude/agents/*.md`, resumable, extension-restricted, parallel ≤5, working_dir confinement) — and unlike goose, allow them in non-autonomous modes with inherited approvals.
9. Stop-time arbiters: `/goal` verifier nudge, recipe/job success checks with reset-and-retry, Stop hooks.
10. Code Mode (sandboxed JS `tools.call`) as an opt-in; benchmark it.

P2 (ecosystem & UX)
11. Recipes/jobs format (params incl. file type w/o defaults, structured final output, deeplinks, cron).
12. Open Plugins hooks (`hooks/hooks.json`), `SKILL.md`, configurable context files (`AGENTS.md`, `CLAUDE.md`), session import from Claude Code/Codex/Pi.
13. Context X-ray token attribution, steering queue, turn-budget in per-turn context.
14. In-repo terminal-bench harness (Harbor) comparing rcode configs vs other harnesses; recipes that analyze failed trials.
15. Things goose lacks: first-class read/grep/glob/patch tools with read-before-edit tracking, LSP diagnostics after edits, git-backed checkpoints/undo, provider-specific tokenizers, background subagents.
