# T3 Code (pingdotgg/t3code) — Research Report for rcode

Source studied: `/Users/rudycelekli/Downloads/rcode/reference/t3code` (MIT), HEAD `8a84e942`
("perf(server): skip oversized history during handoff selection (#23821)"). All paths below are
relative to that directory unless absolute. The repo was read only; nothing was modified.

---

## 0. TL;DR

- T3 Code is **not an agent**. It is an "agent harness control surface": a Node/Effect
  **WebSocket server** (`apps/server`, published to npm as `t3`, run with `npx t3`) that spawns and
  drives *other* coding agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi,
  Muse, fx, and any ACP Registry agent), plus three clients: React/Vite **web**
  (`apps/web`), **Electron desktop** that bundles the server (`apps/desktop`), and **React Native
  mobile** (`apps/mobile`).
- The server is **event-sourced on SQLite** (WAL, `statev2.sqlite`). Commands go through a pure
  serialized **Orchestrator** that decides events with no I/O; an **EventSink** commits events +
  projections + command receipt + **outbox effects** in one transaction; an **EffectWorker** then
  runs side effects (start provider turn, capture checkpoint) and feeds results back as commands.
- Each provider has an **adapter** implementing one interface (`ProviderAdapterV2`,
  `packages/provider-core/src/server/ProviderAdapter.ts`) that translates the provider's native
  protocol (Codex `app-server` JSON-RPC, Claude Agent SDK `query()`, Cursor SDK, OpenCode SSE, Pi
  RPC-JSONL, ACP NDJSON-JSON-RPC, Muse MSP) into a normalized stream of ~14 adapter event types,
  plus an explicit **capability matrix** (`OrchestrationV2ProviderCapabilities`) that orchestration
  and UI branch on instead of on provider names.
- Wire protocol: **Effect RPC over WebSocket** (`GET /ws`, JSON serialization), schemas in
  `packages/contracts` (Effect `Schema`). ~200 RPC methods; the core is 21
  `orchestration.*` methods: `dispatchCommand` (idempotent by `commandId`), `subscribeShell`
  (sidebar), `subscribeThread` (snapshot + cursor-resumable event stream), `subscribeCommandOutput`
  (unpersisted live PTY-ish tail), diffs, search, paging.
- Turn checkpoints are **hidden git refs** (`refs/t3/orchestration-v2/checkpoints/...`) made with a
  temporary `GIT_INDEX_FILE` + `write-tree` + `commit-tree` + `update-ref`, never touching the user's
  index/branch. Diffs are computed from checkpoints (they even opt out of Codex's own diff events).
  Revert must coordinate filesystem restore with provider conversation rollback and is refused up
  front if the provider can't roll back.
- Testing is **replay-first**: 103 recorded provider transcripts (NDJSON of `expect_outbound` /
  `emit_inbound` frames) replayed through the real orchestrator, adapter, and projections.
- For rcode: the cheapest path to "a GUI like t3code can drive rcode" is (a) implement **ACP**
  (T3 already has a generic ACP Registry adapter — zero T3 code changes needed), and (b) optionally
  expose a **Codex-app-server-shaped JSON-RPC over stdio** with stable thread/turn/item IDs,
  rollback, fork, steer, interrupt-with-terminal-event, and provider-initiated approval requests —
  the richest shape T3's model was designed around. Details in section 10.

---

## 1. What it is and its architecture

### 1.1 Product framing (from `AGENTS.md`, `README.md`)

"A minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents ... and
serves web, desktop, and mobile clients." Bring-your-own-subscription alternative to Claude
Desktop, Codex App, Cursor Glass, Conductor. Claims 500k users. Non-negotiables listed in
`AGENTS.md`: open core, performance ("sending too much data over websockets, css animations
causing gpu spikes"), **remote-ready** (LAN/Tailscale/T3 Connect tunnel), multi-surface.

Glossary (`docs/internals/glossary.md`) — worth adopting verbatim:
environment (one running server + its machine/credentials/state), project (workspace root),
thread (durable conversation; survives provider exits), turn/run (one user->agent cycle incl.
checkpointing), provider / driver / provider instance / adapter, session (provider runtime attached
to a thread; stop+resume without deleting thread), runtime mode (permission policy), interaction
mode (plan vs default), checkpoint (hidden git ref), command / event / projection / receipt /
outbox / effect worker.

### 1.2 Monorepo layout

Tooling: pnpm workspace + "Vite+" (`vp` CLI), `effect-tsgo` (TS7 Rust checker with Effect
diagnostics), oxlint with a custom plugin (`oxlint-plugin-t3code/`), Node 24+ (server is Node,
not Bun; Bun is used only by some recorder scripts). Roughly 1.07M lines of non-test TS/TSX
across `apps/` + `packages/` (including generated protocol schemas); `apps/server/src` alone is
~258k; ~1,850 test files.

| Path | Role |
|---|---|
| `apps/server` | The product core. Effect-based Node server: HTTP + `/ws` RPC + `/mcp`, orchestration-v2, providers, git/VCS, checkpoints, terminals (node-pty), PR integration, auth, scheduled tasks, previews, device/simulator control. npm package `t3` (`bin: t3`). |
| `apps/web` | React 19 + Vite + TanStack Router + zustand + `@legendapp/list` (virtualized lists) + `@pierre/diffs` (diff rendering) + Shiki. Also served by the server for `npx t3` and hosted at app.t3.codes. |
| `apps/desktop` | Electron 44 + electron-builder + electron-updater. Spawns the bundled server as a child process (`src/backend/DesktopBackendManager.ts`), can act as host for remote clients. |
| `apps/mobile` | Expo / React Native (iOS + Android); remote control of any server. |
| `apps/marketing` | Site. |
| `packages/contracts` | All wire types as Effect `Schema`: `rpc.ts` (WS RPC group, 2.2k lines), `orchestrationV2.ts` (4.3k lines: thread/run/node/turn-item/event/command schemas), `git.ts`, `terminal.ts`, `providerPolicy.ts`, etc. "No heavy runtime logic." |
| `packages/client-runtime` | Shared web+mobile client logic: connection supervisor/registry, RPC session, projection reducers (`state/orchestrationV2Projection.ts`), commands. |
| `packages/provider-core` | Adapter/driver interfaces (`server/ProviderAdapter.ts`, `server/driver`), `IdAllocator`, continuation requests, selection transitions. |
| `packages/provider-{acp,acp-registry,cursor,fx,grok,kiro,muse,opencode,pi}` | One package per provider driver (newer pattern). Codex/Claude/Antigravity drivers still live in `apps/server/src/provider/Drivers` with adapters in `apps/server/src/orchestration-v2/Adapters/`. |
| `packages/effect-codex-app-server` | Typed Effect client for `codex app-server` JSON-RPC over stdio, with **generated** schemas (`src/_generated/{meta,schema,namespaces}.gen.ts`) and a `replay.ts` transport. |
| `packages/effect-acp` | Typed Effect client/agent for the Agent Client Protocol (generated schema), both sides (`agent.ts`, `client.ts`). |
| `packages/source-control-*` | Forge drivers: GitHub (API + `gh`), GitLab (`glab`), Forgejo/Gitea (`fj`/`tea`), Bitbucket, Azure DevOps, GitCafe. |
| `packages/secret-provider-*` | Secret store abstraction incl. 1Password. |
| `packages/ssh`, `packages/tailscale` | Remote access helpers. |
| `native/` | `libghostty-vt` (terminal VT emulation C ABI shared by web-WASM and Android), `resource-monitor` (Rust), `browser-secret` (C), KDE/Hyprland screenshot helpers (Rust). |
| `evals/` | Real-model evals of model-facing text (MCP tool descriptions, titles, PR text, voice cleanup, test-signal). |
| `docs/` | `internals/` (architecture + traps), `orchestration-v2/` (target model design), `user/`, `operations/`. Unusually high quality. |
| `.repos/` | Vendored read-only reference repos (e.g. Effect) for agents to read. |

### 1.3 Runtime topology

```
 web / desktop renderer / mobile
        |  HTTPS + WSS  (cookie | bearer | DPoP token; scopes)
        v
 apps/server  ("environment")
   /ws      Effect RPC (JSON)   -> ws.ts handlers -> services
   /mcp     HTTP MCP server     -> agents call T3 tools (t3-code, t3-code-direct)
   /api/*   auth, assets/attachments, bounded thread snapshot pages
   /oauth/* MCP OAuth for outside agents
        |
   OrchestratorV2 (pure decide) -> EventSink (SQLite txn) -> EffectWorker (I/O)
        |                                                    |
   ProjectionStore (read models)                ProviderSessionManager -> ProviderAdapterV2
                                                             |
                     child processes: `codex app-server`, Claude Agent SDK worker,
                     cursor SDK, `opencode serve`, `pi --rpc`, ACP agents (grok, kiro, fx...)
```

Key rule (`docs/internals/overview.md`): execution stays in the environment that owns the
workspace. Provider processes, terminals, git, files belong to the server. Clients never
substitute their own filesystem/credentials.

---

## 2. Server/client protocol

### 2.1 Transport

- `GET /ws` (`apps/server/src/ws.ts` ~L3496-3600). Upgrade is rejected with HTTP 426
  `orchestration_protocol_incompatible` unless the query param `orchestrationProtocol=2`
  matches `ORCHESTRATION_PROTOCOL_VERSION` (`packages/contracts/src/environment.ts`). Client
  capabilities ride in `clientCapabilities` query param.
- Auth at upgrade: `EnvironmentAuth.authenticateWebSocketUpgrade(request, "rpc")` produces a
  session with **scopes**; `RpcAuthorization.layer(session.scopes, ...)` checks per-method scope
  (`CLIENT_GUARDED_RPC_SCOPES` in contracts, e.g. `orchestration:operate`, `terminal:operate`).
  "Authentication of a socket does not authorize every method on it."
- Framing: `effect/rpc` `RpcServer.makeProtocolWithHttpEffectWebsocket` + `RpcSerialization.layerJson`.
  Effect RPC multiplexes request/response and **streaming** RPCs (`stream: true`) over one socket
  with request ids, chunks, exits, interrupts and pings. Server options:
  `{ disableTracing: true, disableFatalDefects: true }` so one handler defect doesn't kill all
  pending requests. An output window (`withOutputWindow`) applies backpressure.
- The RPC group: `WsRpcGroup` in `packages/contracts/src/rpc.ts` — ~200 methods across server
  config, providers (install/auth/update), keybindings, settings, PRs (≈40 methods), source control,
  projects/files (search entries, search contents, read/write file), VCS (status stream, pull,
  refs, worktrees), review diffs, terminal (open/attach/observe/write/resize/clear/close), preview
  browser, devices/simulators, scheduled tasks, secrets, guest share, auth access stream, telemetry,
  and the orchestration V2 group.

### 2.2 Orchestration V2 RPC methods (`ORCHESTRATION_V2_WS_METHODS`, orchestrationV2.ts L3590)

```
orchestration.dispatchCommand          // idempotent by commandId; returns committed sequence
orchestration.subscribeShell           // stream: sidebar (projects + thread shells)
orchestration.subscribeThread          // stream: snapshot | event | synchronized
orchestration.subscribeCommandOutput   // stream: live command output frames (unpersisted)
orchestration.launchThread             // create thread + workspace strategy + first message
orchestration.getThreadProjection / getTurnItem / getThreadFamily / getThreadTitles
orchestration.getTurnDiff / getFullThreadDiff
orchestration.searchThreads / searchThread / searchThreadStream
orchestration.getArchivedShellSnapshot / getOlderSettledThreads / getWorktreeThreadIds
orchestration.getWorkflowScript / getNativeChildWork / stopWorkflow / forceStopThread
```

### 2.3 Commands (client -> server)

`OrchestrationV2Command` (orchestrationV2.ts L2908) is a tagged union of ~70 commands, every one
carrying a client-generated `commandId` (UUIDv7-ish). Highlights:

- Thread lifecycle: `thread.create`, `thread.archive/unarchive`, `thread.delete`
  (`onlyIfUnused`), `thread.settle/unsettle/auto-settle`, `thread.snooze/unsnooze`,
  `thread.pin/unpin/pin.reorder`, `thread.tag.set`, `thread.visit`, `thread.mark-unread`,
  `thread.metadata.update`, `thread.fork`, `thread.merge_back`, `thread.stop`.
- Settings per thread: `thread.runtime-mode.set`, `thread.interaction-mode.set`,
  `thread.model-selection.set`, `provider.switch`, `provider-session.detach`.
- Messaging: `message.dispatch` with
  `dispatchMode: defer_start{workspaceStrategy} | steer_active{targetRunId} |
  restart_active{targetRunId} | queue_after_active | start_immediately`, plus
  `deliveryIntent: auto|steer|restart`, `freshContext`, attachments, `context` records,
  `modelSelection`, `sourcePlanRef` (implement a proposed plan), continuation fields.
- Queue: `queued-run.start/reorder/cancel/edit`, `queued-message.promote-to-steer`, `queue.resume`.
- Control: `run.interrupt`, `subagent.stop`, `runtime-request.respond` (approvals/questions),
  `thread.user-input.dismiss`, `checkpoint.rollback`.
- Delegation: `delegated_task.request`, `.wake-policy`, `.completion-delivery.*`, remote variants
  for cross-environment peer links.
- PR linking: `thread.pull-request.link/unlink/watch/sync`.

Acknowledgement semantics (`docs/internals/overview.md`): "A command acknowledgement therefore
means the intent committed, not that the provider, checkpoint, or other follow-up work finished."
Duplicate `commandId` returns the same receipt-backed result without re-running side effects.

### 2.4 Events and streams (server -> client)

Domain events (`OrchestrationV2DomainEvent`, L1876) share a base
`{ id, threadId, runId?, nodeId?, driver?, providerInstanceId?, rawEventId?, occurredAt }` and are
mostly **upserts of whole entities**, not deltas:

```
thread.created | thread.{archived,unarchived,deleted,settled,unsettled,snoozed,unsnoozed,
  pinned,unpinned,pin-reordered,active-reordered,tags-updated,visited,marked-unread,
  metadata-updated,pull-request-synced,runtime-mode-updated,interaction-mode-updated,
  model-selection-updated,provider-switched,guest-share-updated,auto-settle-set}
  (all carry the full OrchestrationV2AppThread as payload) | thread.pull-request-link-updated
run.created | run.updated | run.background-work-cancelled
run-attempt.created | run-attempt.updated
node.updated | subagent.updated
provider-session.attached|updated|detached | provider-thread.updated | provider-turn.updated
runtime-request.updated | message.updated | turn-item.updated | plan.updated
checkpoint-scope.created | checkpoint.captured | checkpoint.rollback-requested
context-handoff.updated | context-transfer.created | context-transfer.updated
```

Stored as `{ sequence, commandId, event }` (`OrchestrationV2StoredEvent`). The client reducer
(`packages/client-runtime/src/state/orchestrationV2Projection.ts` ~L369) does
`messages: upsertEntity(base.messages, event.payload)`. Streaming assistant text is sent as
`message.updated` with the **full accumulated text** and `streaming: true`, coalesced in a 50 ms
window (`ThreadLiveEventCoalescer.ts`, `Adapters/ProviderTextDeltaCoalescer.ts`). This makes every
event idempotent and lets a client drop intermediate frames.

`subscribeThread` input: `{ threadId, afterSequence?, requestCompletionMarker?,
acceptBoundedSnapshot?, acceptDeferredWork?, acceptCompactTurnItems?, acceptDedupedBodies?,
acceptCompactIds? }` — opt-in flags let new clients receive smaller payloads while old clients
keep working. Output items (`OrchestrationV2ThreadStreamItem`, L3908):

```
{ kind: "snapshot", snapshotSequence, projection, historyCursor?, hasMoreHistory?, ... }
{ kind: "event", sequence, event }
{ kind: "synchronized" }                      // caught up; now live
{ kind: "unknown-event", sequence, eventType } // forward-compat: newer server, older client
```

`subscribeShell` streams `snapshot | project.updated | project.removed | thread.updated |
thread.removed | synchronized`, each with `sequence`, for the sidebar only (no transcripts).

The projection a thread snapshot carries (`OrchestrationV2ThreadProjection`, L2023):
`thread, runs, attempts, nodes, subagents, providerSessions, providerThreads, providerTurns,
runtimeRequests, messages, plans, turnItems, checkpointScopes, checkpoints, contextHandoffs,
contextTransfers, visibleTurnItems, updatedAt`.

Turn item union (`OrchestrationV2TurnItem`, L1606) — this is the UI timeline vocabulary:
`notification, user_message, assistant_message, reasoning, proposed_plan, todo_list,
user_input_request, file_change, command_execution, file_search, web_search, dynamic_tool/mcp,
approval_request, checkpoint, run_interrupt_request, run_interrupt_result, system_notice, error,
compaction, handoff, fork, thread_created`.

Live command output is deliberately **not** an event: adapters push `command_output.delta` to
`CommandOutputHub.ts`, which keeps one bounded tail per running command and serves it only via
`subscribeCommandOutput` to clients that expanded that row. Frames:
`{ kind: "replace"|"append", text, truncated, running }`. Rationale in
`docs/internals/performance-regressions.md`: routing output through `turn_item.updated` "would
flood the event store and block ingestion for every other thread."

### 2.5 Session/thread model (the execution graph)

From `docs/orchestration-v2/README.md` and contracts:

```
AppThread                      (ThreadId; projectId; providerInstanceId; modelSelection;
  Run 1  (RunId, ordinal)        runtimeMode; interactionMode; branch; worktreePath;
    RunAttempt (initial|steering_restart|retry|provider_recovery)       lineage; forkedFrom)
      root ExecutionNode (root_turn)
        assistant_message / reasoning / plan / todo_list / tool_call /
        approval_request / user_input_request / hook / system nodes
        subagent node -> ProviderThread -> child root node
  Run 2 ...
ProviderSession  (live process)  ProviderThread (native conversation handle)  ProviderTurn
```

Invariants worth copying: app IDs are primary, provider IDs are refs scoped by
provider+session+thread; only root-run completion completes a user-visible turn; child/subagent
completion never closes the parent; `turn/completed` (not a status-idle notification) is the
authoritative terminal; interrupt acks as a request and the interrupted terminal arrives later;
rollback is expressed in app run count and reconciled with provider snapshot; provider switches
create explicit, auditable `ContextHandoff` artifacts (no hidden prompt hacks); forks record
lineage first and lazily resolve via native fork or portable context on the first run.

`OrchestrationV2RuntimeRequest` (L1216): `{ id, nodeId, providerTurnId, nativeRequestRef, kind:
command|file-read|file-change|mcp-elicitation|permission|dynamic_tool_call|user_input|auth_refresh,
status: pending|resolved|expired|cancelled, responseCapability: live{providerSessionId} |
message | not_resumable{reason}, decision?, feedback?, answers? }`. Decisions:
`accept | acceptForSession | acceptAlways | decline | cancel`
(`packages/contracts/src/providerPolicy.ts`). `responseCapability` is the clever bit: a request
answered by a live RPC response vs one answered by sending a new user message (Codex async
questions) vs one that died with the process.

### 2.6 Persistence and event sourcing

- `apps/server/src/persistence/Sqlite.ts`: node SQLite client with reader worker and checkpoint
  worker; `busy_timeout=5000` (CLI and server write from separate processes), `journal_mode=WAL`,
  `synchronous=NORMAL`, `checkpoint_fullfsync=ON`, `temp_store=MEMORY`, `auto_vacuum=INCREMENTAL`,
  128 MiB `journal_size_limit`; deletes `sqlite_stat1` and re-`ANALYZE`s schema so the planner
  prefers indexes.
- 80 numbered migrations (`persistence/Migrations/001..080`). V2 core in
  `055_OrchestrationV2.ts`: `orchestration_v2_events(sequence AUTOINCREMENT, event_id, command_id,
  thread_id, run_id, node_id, provider, raw_event_id, event_type, occurred_at, payload_json)` with
  per-thread/run/node/command indexes; `orchestration_v2_command_receipts(command_id PK,
  result_sequence, status, error)`; projection tables `orchestration_v2_projection_{threads,runs,
  run_attempts,nodes,...}` with hot columns + `payload_json`.
- Effect outbox (`orchestration-v2/EffectOutbox.ts`): `provider-turn.start | .interrupt | .steer |
  .restart`, `provider-session.detach`, `provider-runtime.continue`, `runtime-request.respond`,
  `provider-thread.rollback`, `checkpoint.capture`, `thread-title.generate`,
  `delegated-tasks.stop`, plus cleanup effects (terminal, preview, attachment, scheduled tasks).
- **Event log is not the source of truth long-term.** `ProjectionMaintenance.ts` prunes events
  older than about a day once projections cover them (keeping high-water marks, `thread.created`,
  `running` run updates, etc.). Projections cannot be rebuilt from the log. Clients whose cursor
  is below the pruned-through sequence fall back to a snapshot. This is a pragmatic hybrid:
  event sourcing for idempotency, ordering and reconnect replay; state tables for durability.
- Retained events must stay decodable forever-ish (schema changes affect startup replay). They use
  `Schema.withDecodingDefault`, `catchDecoding`, and `ForwardCompatibleUnion` heavily.
- DB file: `<T3 home>/userdata/statev2.sqlite` (V1 `state.sqlite` imported once by
  `orchestration-v2/legacy/`).

### 2.7 Effect usage

The whole server is Effect (v4-style API: `effect/Schema`, `effect/rpc`, `effect/sql`,
`Context.Service`, `Layer`, `Stream`, `Effect.fn("Service.op")` for spans). Conventions
(`docs/internals/effect-services.md`, `AGENTS.md` "Taste"):
features are services, transports thin ("a ws.ts RPC handler, HTTP route, or MCP tool decodes
input, calls one service method, and maps errors"); tagged errors per failure
(`Schema.TaggedError`); `DrainableWorker` for deterministic tests; `it.effect` on `TestClock`; lint
rules ban sleeps/polling/timeouts in tests. Observability via OTLP spans
(`/api/observability/v1/traces`).

---

## 3. UX features

- **Threads & sidebar**: projects grouped by repository identity across environments; threads
  pinned, tagged, snoozed, settled (auto-settle after PR merge/inactivity, server-owned in
  `ThreadSettlementService.ts`), archived; fuzzy thread search with open-score decay
  (`OrchestrationV2ThreadOpens`); FTS message search (migration 069).
- **Composer**: rich text, context chips (`[label](t3-context://v1/<kind>/<contextId>)`,
  `docs/internals/composer-context-references.md`), image/file attachments stored outside the
  workspace, dictation (local whisper via `transcribe-cpp`), slash commands from provider catalogs,
  `/goal`, `/compact`. Follow-up behavior: **Queue or Steer** while running, `mod+Enter` flips
  per message; `mod+Alt+Enter` starts in background and opens a new composer.
- **Diffs**: per-turn diff from checkpoints (only the turn's own work; files pulled/merged by git
  are excluded via `listAuthoredPaths`), full-thread diff, branch comparison, per-commit review,
  find-in-diff across folded files, virtualized rendering for huge diffs.
- **Checkpoints / revert**: every root run ends with a checkpoint; `checkpoint.rollback` restores
  files and rolls back the provider conversation in one coordinated operation
  (`CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts`).
- **Worktrees**: thread launch workspace strategy `root | existing_worktree | worktree{baseRef,
  branch, startFromOrigin}`; worktree directory default `<T3 home>/worktrees`; branch naming
  settings; submodules init; automatic cleanup after inactivity/settlement; `t3.json`
  `runOnWorktreeCreate` setup scripts; `mod+shift+x` workspace picker, `mod+shift+l` reuse previous
  worktree.
- **Terminal**: server-owned PTYs (node-pty) attachable from any client; 5,000 lines / 8 MiB
  scrollback retained per terminal; renderer is libghostty-vt in WASM (web) and native (Android);
  replay strips terminal query/response traffic so restored history doesn't inject junk.
- **Approvals / permission modes**: `RuntimeMode = approval-required | auto-accept-edits | auto |
  full-access` (UI: Supervised / Auto-accept edits / Auto / Full access), default full-access,
  admin-capped via managed policy. Providers advertise `supportedRuntimeModes`; an unoffered stored
  mode runs as Supervised (`RuntimePolicy.ts`). T3 explicitly refuses to *emulate* a mode the
  provider can't enforce natively. Subagent approvals surface in the parent thread.
- **Plan mode**: `ProviderInteractionMode = default | plan`; providers emitting proposed plans map
  to a `proposed_plan` turn item / plan artifact with markdown; "implement plan" dispatches with
  `sourcePlanRef`. Toggle hidden unless provider supports it (`showInteractionModeToggle`).
- **Questions**: `user_input_request` items, structured multi-select answers, non-blocking async
  questions that survive restart.
- **Subagents & delegation**: native subagents rendered as child threads; T3-owned delegated tasks
  via MCP `delegate_task` on any provider instance; workflows; background tasks with continuation
  wakeups.
- **Provider switching mid-thread** with context handoff summaries; **fork** from any run;
  **merge-back** fork deltas.
- **Multi-project / multi-environment**: one client connected to several servers at once
  (`packages/client-runtime/src/connection/registry.ts`); host picker `mod+shift+h`.
- **Keybindings**: fully remappable (`apps/server/src/keybindings.ts` persisted server-side,
  `docs/user/keybindings.md`): model `mod+shift+m`, effort `mod+shift+e`, permissions
  `mod+shift+a`, workspace `mod+shift+x`, branch `mod+shift+g`, provider cycle
  `mod+shift+up/down`, send first queued `mod+Shift+Enter`, dictation `mod+shift+d`, copy PR
  `mod+shift+c/k`, find in diff `mod+f`. Command palette.
- **Extras**: scheduled tasks + webhooks, guest share links (HMAC tokens, read-only + proposed
  messages), embedded preview browser with automation (Playwright core), device/simulator manager,
  usage-limit tracking with auto-resume at reset, resource telemetry, MCP Apps (interactive tool
  UIs), import of existing Claude/Codex/Pi sessions from disk (`project/AgentSessionImporter.ts`).

---

## 4. Provider / agent adapters

### 4.1 The adapter contract

`packages/provider-core/src/server/ProviderAdapter.ts` (713 lines) is the single most
important file for rcode. Shape:

```ts
class ProviderAdapterV2 extends Context.Service<..., {
  instanceId; driver;
  getCapabilities(): Effect<OrchestrationV2ProviderCapabilities>;
  planSelectionTransition(input): Effect<ProviderSelectionTransitionPlan>; // model/mode switch plan
  openSession(input: { threadId, providerSessionId, modelSelection, runtimePolicy,
                       resumeFromSession?, initialNativeThreadId? })
    : Effect<ProviderAdapterV2SessionRuntime, ProviderAdapterV2Error, Scope>;
}>

interface ProviderAdapterV2SessionRuntime {
  events: Stream<ProviderAdapterV2Event>;  subscribeEvents?;
  hasPendingBackgroundWork?; backgroundTasksEndWithProcess?;
  getModelContextWindow?; canReuseContextUsage?;
  ensureThread(input); resumeThread(input); injectHistory?(input);
  startTurn(input: ProviderAdapterV2TurnInput); compactThread?; steerTurn(input);
  interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart? });
  stopTask?; awaitBackgroundTasks?; stopSubagent?; unloadThread?;
  respondToRuntimeRequest({ requestId, decision?, feedback?, answers? });
  readThreadSnapshot(...); rollbackThread({ providerThread, target, providerThreadTurns });
  forkThread({ sourceProviderThread, providerTurnId?, targetThreadId, ... });
  uploadFeedback?; mcpApps?: { listTools, callTool, readResource };
}
```

Normalized adapter events (`ProviderAdapterV2Event`):
`app_thread.created, provider_session.updated, provider_thread.updated (pendingBackgroundWork),
provider_turn.updated, node.updated, subagent.updated, message.updated, turn_item.updated,
background_work.updated, command_output.delta (unpersisted), runtime_request.updated,
plan.updated, turn.terminal {status: completed|interrupted|cancelled|failed, failure, retry,
threadDisposition: reusable|broken, childTurnsContinue}`.

`runtimePolicy` passed to every call: `{ runtimeMode, interactionMode, cwd, approvalPolicy?,
sandboxPolicy?, maxRuntimeMode? }`.

`ProviderEventIngestor.ts` / `ProviderCommitBatch.ts` turn adapter events into orchestration
commands/events; `ProviderSessionManager.ts` owns process lifetime, idle release, MCP credential
minting; `ProviderRuntimeRecoveryService.ts` handles crashed processes.

### 4.2 Capability matrix (`OrchestrationV2ProviderCapabilities`, orchestrationV2.ts L260-396)

Groups: `sessions` (multiple threads per session, model/mode switch in session, pending requests
survive restart), `threads` (create empty, read snapshot, rollback, fork, fork from turn/subagent,
native id), `turns` (native turn id, emits started/completed, interrupt, **active steering**,
steering interrupts tools, steering accepts attachments, steer-by-restart, queued messages,
`terminalStatusQuality: strong|weak|none`), `streaming`, `tools`, `approvals` (command/file-read/
file-change/apply-patch, native request ids, live-only callbacks, from subagents), `planning`,
`subagents`, `context` (system/developer/synthetic-user context, summaries, delta/full handoff,
max chars), `checkpointing` (app can checkpoint fs, nested scopes, provider can roll back
conversation, rollback returns snapshot), `identity` (native id strength per entity),
`runtimePolicy.enforcement: native|client-boundary`.

Examples: Codex, Claude, Pi declare rollback+fork+active steering+strong terminal; the generic ACP
adapter declares rollback true, `canForkThread: false`, `supportsActiveSteering: false`
(`packages/provider-acp/src/server/adapter.ts` ~L668). Antigravity: checkpoint yes, conversation
rollback no -> revert rejected before touching files.

### 4.3 Per-provider integration (protocol names from replay transcripts)

| Provider | Protocol | How |
|---|---|---|
| Codex | `codex.app-server` | Spawns `codex app-server [launchArgs]` (`provider/codexLaunchArgs.ts`); JSON-RPC over stdio via `packages/effect-codex-app-server`. Uses `thread/start|resume|fork|read|compact/start|unarchive|unsubscribe`, rollback via `thread/turns/list` + `thread/revert {beforeTurnId}` (`provider/CodexThreadRevert.ts`; legacy `thread/rollback` is never sent), `thread/goal/*`, `turn/start|steer|interrupt`; consumes `turn/started|completed`, `item/started|completed`, `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/plan/delta`, `item/commandExecution/outputDelta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `model/rerouted`; answers server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`. Opts out of `turn/diff/updated`. MCP injected per thread in `thread/start` config with bearer header. Managed ChatGPT auth/home (`provider/CodexManaged*.ts`). |
| Claude Code | `claude-agent-sdk.query` | `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode inside a worker (`runClaudeWorker`), `includePartialMessages: true`, `resume`/`sessionId`, `forkSession`, `setPermissionMode`, `interrupt()`, `setMcpServers`, `canUseTool` callback for approvals, hooks (`SubagentStart`). Runtime mode -> `permissionMode` mapping in `ClaudeAdapterV2.ts` ~L2800 (`plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions`+`allowDangerouslySkipPermissions`, `dontAsk` for read-only). 12.4k-line adapter. |
| Cursor | `cursor-agent-sdk.local` | `@cursor/sdk` (`agent.open`, `run.start`, `interaction.update`). |
| OpenCode | `opencode-sdk.sse` | 1.x: one T3-managed `opencode` server per thread; 2.x: one server per instance with per-thread `t3-code-<thread>` MCP entries and session permission rules. |
| Pi | `pi.rpc-jsonl` | User's own `pi` in RPC mode; session files back resume/rollback/fork. |
| Grok, Kiro, fx, Antigravity | `acp.ndjson-jsonrpc` | Thin flavors over the shared ACP adapter (`packages/provider-acp/src/server/adapter.ts`). |
| ACP Registry | `acp.ndjson-jsonrpc` | Any ACP agent from the registry, **no per-agent code** ("Never add agent-id checks to the generic registry adapter"). Supports ACP client terminals, elicitation forms, MCP-over-ACP bridge (`mcpOverAcpBridge.ts`). |
| Muse | `muse.msp-jsonl` | `@muse-code/sdk`. |

Process/account isolation rules (`docs/internals/providers.md`): route by provider **instance**
(two accounts on one driver never share state), strip ambient credentials the instance didn't
configure, never open a session from a background health check (it can start MCP servers, run
hooks, or launch a login browser), run provider updates only through the installer that provably
owns the binary.

"Traps several providers hit" (`docs/internals/adding-a-provider.md`) is a gold checklist:
settings applied before advertised; "default" model is a sentinel; Stop sent before turn started;
work the provider starts on its own (background tasks/goals) after turn settled; subagents
outliving their run; failed/stopped turns must settle all open tools/approvals; usage-limit errors
classified as `usage_limit` with reset time; symlinked workspaces (`/tmp` on macOS).

---

## 5. Git integration

- **VCS driver abstraction**: `apps/server/src/vcs/VcsDriver.ts`, `GitVcsDriver.ts`,
  `GitVcsDriverCore.ts` (4.5k lines), `VcsDriverRegistry.ts`, `VcsStatusBroadcaster.ts` (pushes
  status over `subscribeVcsStatus`).
- **Checkpoint capture** (`GitVcsDriver.ts` ~L905-1300): temp index at
  `<gitCommonDir>/t3-checkpoint-index-<uuid>` via `GIT_INDEX_FILE`, seeded from the user index
  (preserving mtime to keep git's racy-check), config overrides (`core.fsmonitor=false`,
  `core.splitIndex=false`, `splitIndex.sharedIndexExpire=never`, sparse handling), add all,
  `write-tree`, `commit-tree` with **HEAD as parent** (so `listAuthoredPaths` can tell what HEAD
  movement brought in), author "T3 Code", then `update-ref <checkpointRef> <oid>`. Refs live under
  `refs/t3/orchestration-v2/checkpoints` (`orchestration-v2/CheckpointService.ts` L26). Nested
  repos captured as gitlinks.
- **Restore**: `ls-files --with-tree`, `git restore`/`reset -- .`, then `git clean -fd -- .`
  repeated until a dry-run `clean -dn` is empty (removing a new `.gitignore` exposes files it hid);
  Windows long paths handled.
- **Diffs**: `diffCheckpoints` (patch or numstat, whitespace option, byte caps, path filter);
  diff blobs cached (migration 003).
- **Worktrees**: `vcsCreateWorktree/RemoveWorktree`, `ThreadLaunchService.ts`,
  `WorktreeBranchSync.ts`, `vcs/worktreeRemoval.ts`, `project/ProjectSetupScriptRunner.ts`;
  worktree setup progress stream (`subscribeWorktreeSetup`).
- **Commit/push/PR**: `gitRunStackedAction` with `GitStackedAction = commit | push | create_pr |
  commit_push | commit_push_pr` and progress events (`action_started, phase_started{branch|commit|
  push|pr}, hook_started, hook_output, hook_finished, action_finished, action_failed`). Commit
  message generation uses a temporary index to compute the staged patch without disturbing the
  user's index (`prepareCommitContext`). PR text generation is evaluated (`evals/pr-content`) against
  prompt injection from project instructions.
- **PR lifecycle**: multi-link `pullRequests[]` per thread, stacked PRs, PR sync worker,
  `PullRequestSyncReactor.ts` re-reads links after a run that ran a merge/close command (agent ran
  `gh pr merge`), auto-settle on merge, full PR review UI (comments, reviews, reactions, checks,
  files-viewed, AI review guide).

---

## 6. Performance, packaging, distribution

Performance practices (`docs/internals/performance-regressions.md`, `AGENTS.md`):
- Bounded snapshots: ~1 MiB encoded rows, 10 user turns or 500 rows per window, 75 inside a
  long turn; older history via HTTP pages; resume replay capped at 128 events / 1 MiB before
  falling back to snapshot.
- Raw command output, dynamic tool bodies, inline file-change bodies omitted on the wire;
  fetched on demand. Deduped bodies (`textOmitted`) and compact ID tables (`withRecordIdTable`)
  for opted-in clients.
- Shell (sidebar) carries only active rows; archived via separate query.
- 50 ms live-event coalescing; per-thread dispatch lock; sequence cursors always seek indexes.
- Dedicated perf test command `vp run test:perf:v2-wire`; `transferBudgetV2.integration.test.ts`
  caps decoded bytes for a 900-row turn.
- UI: no continuously repainting animations; virtualized lists; React effects linted.
- Native modules never load in Electron main process on startup; risky native work in forked
  children with deadlines.

Packaging and distribution:
- `npx t3@latest`, `curl -fsSL https://t3.codes/install.sh | sh`, `irm .../install.ps1 | iex`;
  `t3 service install` (background service), `t3 update`, channels stable/nightly/preview
  (`docs/operations/release.md`, nightly every 30 min, stable = promoted nightly).
- Server can be built as a **Node single-executable (SEA)** (`apps/server/scripts/cli.ts
  build-exe`), still needing a `node_modules` tree for native deps.
- Desktop: Electron 44, electron-builder (dmg, AppImage, deb, nsis), electron-updater, signed and
  notarized; Homebrew cask, winget, scoop, AUR. Desktop spawns the bundled server and can expose it
  for remote clients (`DesktopServerExposure.ts`).
- Remote: LAN, Tailscale (`vp run dev --share` prints a pairing URL), SSH, and **T3 Connect**
  relay/tunnel with DPoP-bound tokens; pairing links with scoped grants; guest links.
- Mobile on App Store / Google Play.

---

## 7. Evals

`evals/README.md`: evals cover **model-facing text T3 owns**, not agent capability:
`mcp-tool-use` (do agents use T3's MCP tools correctly, device routing/recovery, in fake threads
with a shell simulator), `thread-titles`, `pr-content` (PR text describes the diff even when
project instructions try to redirect it), `voice-cleanup`, `test-signal` (cheap model flags
low-signal tests). Rules: cases reproduce a real bad experience with a named source, are added
before the fix and must fail on old text, include controls, run multiple samples (fail if half
fail), compare to a baseline on the same model, import prompts/tool schemas from source (never
copy), flags `--out --model --baseline --case`. CI only typechecks and runs grader unit tests;
paid runs are manual.

The **real correctness suite is replay fixtures**, not evals:
`apps/server/src/orchestration-v2/testkit/` (`ProviderReplayHarness.ts`,
`OrchestratorScenario.ts`, `DeterministicRuntime.ts`) with 103 scenario dirs under `fixtures/`
(`simple`, `multi_turn`, `queued_turn`, `turn_interrupt`, `message_steering`,
`provider_thread_resume`, `tool_call_*`, many Claude background/subagent/compact cases, Grok,
fx...). Each scenario has `input.ts` (steps), one `<provider>_transcript.ndjson` per provider and
`<provider>_output.ts` assertions. Transcript lines:
`{"type":"transcript_start","provider":"codex","protocol":"codex.app-server",...}`,
`{"type":"expect_outbound","label":"initialize","frame":{...}}`,
`{"type":"emit_inbound","label":"response:initialize","frame":{...}}`. Recorded live by
`apps/server/scripts/record-*-replay-fixture.ts`. "The only normal substitute in orchestration
tests is the provider runtime transport."

---

## 8. Strengths worth copying (ranked) and weaknesses/gaps (ranked)

### 8.1 Strengths (ranked by value to rcode)

1. **App-owned IDs + provider refs + explicit execution graph** (thread -> run -> attempt -> node,
   plus provider session/thread/turn). Solves steer-by-restart, subagents outliving runs,
   rollback-by-run-count, provider switching. Copy the ID families from
   `docs/orchestration-v2/entity-ids-and-correlation.md` directly into rcode's own session model.
2. **Command/event/receipt/outbox in one transaction**, idempotent `commandId`, acks mean "intent
   committed". Makes reconnecting clients and retries trivially safe. rcode's server mode should
   accept client-generated command IDs and return a sequence.
3. **Upsert-style events with full entity payloads + snapshot/cursor resume + `synchronized`
   marker + `unknown-event` forward compatibility.** Any client can join late, drop frames, and
   tolerate newer servers.
4. **Capability matrix instead of provider-name branches**, including "honest" capabilities
   (`terminalStatusQuality`, `responseCapability`, `enforcement: native|client-boundary`). rcode
   should publish its own capability object over the wire so GUIs light up features.
5. **Hidden-ref git checkpoints with a temp index**, HEAD-as-parent for authored-path
   attribution, and the rule that revert coordinates files + conversation and is refused up front
   when the agent can't roll back.
6. **Replay-transcript testing** (`expect_outbound` / `emit_inbound` NDJSON) recorded from real
   providers. rcode should both (a) record its own model API exchanges this way and (b) ship
   transcripts of its server protocol for GUI authors.
7. **Out-of-band live output channel** (`subscribeCommandOutput`, bounded tail, per-subscriber
   throttling) separate from durable events.
8. **Queue vs steer vs restart dispatch modes** as first-class protocol, with per-provider
   fallbacks (steer-by-interrupt-restart).
9. **Permission modes mapped to native enforcement, never emulated**; approval decisions with
   native option IDs passed through; text reply to a pending approval = decline with feedback.
10. **MCP back-channel**: the harness injects its own MCP server (`t3-code`) into every agent so
    agents can create threads, delegate tasks, wait, schedule, link PRs. Credentials scoped to
    environment+thread+instance+session, revoked on session release.
11. **Bounded wire budgets enforced by tests** (`test:perf:v2-wire`, transfer budget test).
12. **Docs discipline**: `docs/internals` records only constraints and traps, not catalogs.

### 8.2 Weaknesses / gaps (ranked)

1. **Enormous complexity concentrated in a few files**: `Orchestrator.ts` 14.6k lines,
   `ClaudeAdapterV2.ts` 12.4k, `CodexAdapterV2.ts` 8k, `ACP adapter` ~9k+, `ws.ts` 3.6k, contracts
   `orchestrationV2.ts` 4.3k. The "pure orchestrator" is effectively a monolith; hard to fork or
   reason about despite the stated "smallest model" philosophy.
2. **It owns no agent loop.** Everything hinges on third-party protocols that change weekly
   (Claude SDK `^0.3.x`, Codex generated schemas, Cursor SDK pinned), hence 80 migrations, legacy
   wire fields kept for old clients, and huge per-provider trap handling. A terminal-first agent
   that *is* the loop avoids an entire class of correlation bugs.
3. **Hard dependency on Effect** (v4 alpha-ish APIs, `effect-tsgo`) across server, contracts and
   clients. Contracts are Effect `Schema`, not JSON Schema/OpenAPI, so non-TS clients must
   reverse-engineer them; wire framing is Effect RPC's own envelope. Third-party GUIs cannot
   easily speak it.
4. **Event log pruned after ~1 day**; projections are the truth and cannot be rebuilt — weak audit
   trail and replay for long-lived threads, and a "time-travel" UI is impossible from the log.
5. **Node-only server** with native deps (node-pty, keyring, ffi-rs, transcribe-cpp); SEA binary
   still needs `node_modules`. Startup and memory are non-trivial; not a single static binary.
6. **Checkpoints are git-only** (VCS abstraction exists but only Git driver); non-git folders get
   no diff/revert.
7. **Capability flags are many and boolean-heavy** (~60 fields), and correctness depends on every
   adapter author setting them honestly; the docs repeatedly warn about this.
8. **Wire schema surface is huge** (~200 RPC methods, opt-in flags like
   `acceptCompactIds`/`acceptDedupedBodies`), with compatibility shims that will only grow.
9. **Diffs/attribution rely on snapshot comparison**, so concurrent edits by the user or another
   thread in the same checkout get attributed to the turn unless a worktree is used.
10. **Evals are thin** (5 suites focused on T3's own text); no end-to-end task-success benchmark of
    the agents under T3 orchestration.

---

## 9. The 20 most important source files

1. `packages/provider-core/src/server/ProviderAdapter.ts` — the adapter contract: session runtime methods, normalized adapter events, error taxonomy.
2. `packages/contracts/src/orchestrationV2.ts` — every orchestration wire type: thread/run/node/turn item/runtime request/checkpoint, commands, domain events, stream items, capabilities, WS method names.
3. `packages/contracts/src/rpc.ts` — the full `WsRpcGroup` (≈200 methods) with payload/success/error/stream schemas.
4. `apps/server/src/orchestration-v2/Orchestrator.ts` — serialized command processor deciding events without I/O; dispatch, queries, stream APIs.
5. `apps/server/src/orchestration-v2/EventSink.ts` — single-transaction commit of events, projections, receipts, and outbox effects.
6. `apps/server/src/orchestration-v2/EffectWorker.ts` — runs committed outbox effects and feeds results back as commands.
7. `apps/server/src/orchestration-v2/EffectOutbox.ts` — durable effect request schema and claiming.
8. `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` — translates adapter event streams into orchestration state.
9. `apps/server/src/orchestration-v2/ProviderSessionManager.ts` — provider process lifecycle, session reuse/release, MCP credential minting.
10. `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` — reference adapter for the richest protocol (`codex app-server`).
11. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` — Claude Agent SDK adapter incl. permission-mode mapping, fork, rollback, background tasks.
12. `packages/provider-acp/src/server/adapter.ts` — generic ACP adapter used by Grok/Kiro/fx/Antigravity/Registry agents.
13. `packages/effect-codex-app-server/src/client.ts` — typed JSON-RPC stdio client over generated Codex schemas.
14. `apps/server/src/ws.ts` — `/ws` upgrade, protocol-version gate, scope authorization, all RPC handlers.
15. `apps/server/src/orchestration-v2/ThreadStream.ts` (+ `ThreadLiveEventCoalescer.ts`, `WireProjection.ts`) — snapshot/cursor thread subscription, coalescing and bounded wire projection.
16. `apps/server/src/orchestration-v2/CheckpointService.ts` — checkpoint scopes, refs prefix, capture/restore orchestration.
17. `apps/server/src/vcs/GitVcsDriver.ts` — hidden-ref checkpoint capture/restore/diff plumbing on a temp index.
18. `apps/server/src/persistence/Migrations/055_OrchestrationV2.ts` (+ `persistence/Sqlite.ts`) — event, receipt, projection tables and SQLite pragmas.
19. `packages/client-runtime/src/state/orchestrationV2Projection.ts` — client reducer applying upsert events to the thread projection.
20. `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` (+ `fixtures/`) — replay transport that drives real adapters from recorded NDJSON transcripts.

Honorable mentions: `apps/server/src/orchestration-v2/CommandOutputHub.ts` (live output tail),
`apps/server/src/mcp/OrchestratorMcpService.ts` (agent-facing MCP tools),
`apps/server/src/orchestration-v2/RuntimePolicy.ts` (mode ceilings),
`apps/server/src/terminal/Manager.ts` (PTY history), `packages/client-runtime/src/connection/supervisor.ts`
(reconnect policy), `docs/internals/adding-a-provider.md` (trap checklist).

---

## 10. What rcode must expose so a GUI like t3code can drive it

T3 integrates an agent through exactly one seam: a driver + `ProviderAdapterV2`. A terminal-first
agent has three ways in, from cheapest to richest:

### 10.1 Option A (do first): speak ACP over stdio — zero T3 changes

T3 ships a generic **ACP Registry** driver: any agent that follows the ACP spec runs with no
per-agent code (`docs/user/providers-acp.md`, `packages/provider-acp-registry`,
`packages/effect-acp`). `rcode acp` (NDJSON JSON-RPC on stdin/stdout) gets rcode into T3, Zed, and
other ACP clients immediately. To score well against T3's generic ACP capabilities, implement:
`initialize` (advertise capabilities honestly), `session/new`, `session/load` (resume),
`session/prompt` with streamed `session/update` notifications (agent message chunks, thought
chunks, tool calls with stable IDs and status transitions, plans), `session/cancel` with a final
`stopReason` of `cancelled`, `session/request_permission` with stable option IDs including a
decline/reject option, session modes and config options (advertise before accepting writes),
client terminals (`terminal/*`) and fs callbacks if you want T3 to own execution, MCP server
injection from the client (T3 injects `t3-code`), and usage-limit errors that carry a reset time.
Gaps under generic ACP in T3 today: no fork (`canForkThread: false`) and no active steering —
which Option B fixes.

### 10.2 Option B (recommended for a first-class adapter): a Codex-app-server-shaped server

T3's V2 model was "designed around the real provider behavior observed in the Codex app-server
probes"; Codex is treated as the richest protocol. If `rcode app-server` (JSON-RPC 2.0 over stdio,
optionally also WebSocket) mirrors those semantics, a native T3 adapter is small and every
capability can be `true`. Minimum surface, with the exact semantic requirements T3 relies on:

Client -> rcode requests:
```
initialize {clientInfo, capabilities:{optOutNotifications?:[...]} } -> {serverInfo, capabilities}
thread/start   {cwd, model, effort?, approvalPolicy, sandbox, mcpServers?, developerInstructions?}
                 -> {thread:{id, createdAt, updatedAt, ...}}
thread/resume  {threadId, ...same config}          -> {thread}
thread/read    {threadId, includeTurns?}           -> {thread, turns[], items[]}   // snapshot
thread/fork    {threadId, atTurnId?}               -> {thread}                      // native fork
thread/revert  {threadId, beforeTurnId}            -> {thread, turns[]}             // returns snapshot
thread/turns/list {threadId, cursor, limit, sortDirection} -> {data[], nextCursor}  // paging
thread/compact/start {threadId}
thread/archive|unarchive|unsubscribe {threadId}
turn/start     {threadId, input:[text|image|file...], model?, effort?, approvalPolicy?, mode?:"plan"|"default"}
                 -> {turn:{id, status:"inProgress"}}     // ack only
turn/steer     {threadId, turnId, input[]}               // inject into active turn
turn/interrupt {threadId, turnId}                        // ack; terminal arrives as turn/completed
model/list, account/read, config/read                    // catalog + auth status without side effects
```

rcode -> client notifications (stable IDs on everything):
```
thread/started, thread/status/changed, thread/tokenUsage/updated {usage, contextWindow}
turn/started {threadId, turn}
turn/completed {threadId, turn:{id, status: completed|interrupted|failed, error?:{kind, message,
                usageLimit?:{resetAt}}}}           // THE authoritative terminal, exactly once
item/started | item/completed {threadId, turnId, item:{id, type, ...}}
   item types: userMessage, agentMessage, reasoning, plan/todoList, commandExecution{command,cwd,
   exitCode,aggregatedOutput}, fileChange{changes[{path,kind,diff}]}, mcpToolCall, webSearch,
   subagent{childThreadId}, contextCompaction
item/agentMessage/delta, item/reasoning/textDelta, item/plan/delta
item/commandExecution/outputDelta {itemId, chunk}   // high-frequency, separately throttled
account/rateLimits/updated, model/rerouted
```

rcode -> client requests (client replies; must be cancellable when the turn ends):
```
item/commandExecution/requestApproval {threadId, turnId, itemId, command, cwd, reason,
                                       options:[{id, kind: accept|acceptForSession|decline|cancel}]}
item/fileChange/requestApproval       {..., changes}
item/permissions/requestApproval      {...}
item/tool/requestUserInput            {questions:[{id, prompt, options?, multiSelect?}]}
mcpServer/elicitation/request         {...}
```

Semantics T3's adapter contract needs (from `ProviderAdapter.ts`, `docs/internals/providers.md`,
`adding-a-provider.md`):
1. **Stable native IDs** for thread, turn, item, request (`identity` capabilities = `strong`).
2. **Exactly-once terminal per turn**, even on cancel, error, process kill, and Stop-before-start.
   Settle every open tool item and pending request when a turn ends (emit `item/completed` with a
   failed/cancelled status; resolve pending approvals as cancelled).
3. **Interrupt is two-phase**: request acks; `turn/completed{status:"interrupted"}` follows.
   Provide a bounded stop deadline (T3 has `ProviderAdapterInterruptTimeoutError`).
4. **Steering**: accept input into an active turn; declare whether steering cancels pending tools
   and whether it accepts attachments.
5. **Rollback returns an authoritative snapshot** (T3 reconciles app run count against it), and
   **fork from a turn**. These enable T3's revert and fork with native fidelity.
6. **Resume across process restarts** from rcode's own persisted sessions (T3 assumes threads
   outlive provider processes; `pendingRequestsSurviveRestart` is a capability).
7. **Background work**: if rcode can start work after a turn (background shells, subagents,
   goals), expose `hasPendingBackgroundWork` and emit continuation turns rather than silently
   finishing later.
8. **Subagents** as child threads with their own turns/terminals that never close the parent.
9. **Native permission enforcement** for each mode T3 offers (`approval-required`,
   `auto-accept-edits`, `auto`, `full-access`, plus `plan` interaction mode); a read-only sandbox.
   T3 will not emulate modes you don't enforce.
10. **Usage/limit errors classified** (`usage_limit` with `resetAt`), token usage + context window
    per thread.
11. **No side effects from status/catalog probes** (listing models must not start MCP servers,
    hooks, or a login browser). Separate `auth/status` from `auth/login`.
12. **MCP client injection per thread** with auth headers, and survive an unreachable MCP server.
13. **No per-turn diff events needed** — T3 computes diffs from its own git checkpoints. But do
    report file changes per item so T3 can attribute them.
14. **Symlinked cwd tolerance** and no inherited credentials beyond the configured instance.
15. Ship **recorded transcripts** of your protocol (NDJSON `expect_outbound`/`emit_inbound`) so a
    replay-based adapter test suite can be written without paying for model calls.

### 10.3 Option C: rcode as its own "environment" server (T3-shaped)

If rcode wants its own GUI (or to be driven like a T3 environment), copy the T3 *server* shape on
top of rcode's in-process agent loop, minus the provider-correlation machinery:
- `GET /ws?protocol=N` with a version gate (HTTP 426 on mismatch) and scoped auth at upgrade.
- `dispatchCommand({commandId, type, ...})` -> `{sequence}`; durable receipts for idempotency.
- `subscribeShell()` and `subscribeThread({threadId, afterSequence})` emitting
  `snapshot | event{sequence, event} | synchronized | unknown-event`, with entity-upsert events
  (`run.updated`, `turn-item.updated`, `message.updated{streaming}`, `runtime-request.updated`,
  `checkpoint.captured`) coalesced at ~50 ms.
- A separate `subscribeCommandOutput({threadId, itemId})` live tail.
- `getTurnDiff / getFullThreadDiff` from hidden-ref checkpoints; `checkpoint.rollback` command.
- `message.dispatch` with `dispatchMode` queue/steer/restart/start and `launchThread` with
  workspace strategy `root | existing_worktree | worktree{baseRef, branch}`.
- Terminal RPCs (`open/attach/write/resize/close`) with bounded server-side history.
- Publish schemas as **JSON Schema** (not only TS types) and a capability object, so non-TS GUIs
  can bind. Use plain JSON-RPC 2.0 framing rather than Effect RPC's envelope for interoperability.
- Persist to SQLite WAL with events + projections + receipts in one transaction; unlike T3, keep
  the event log (or at least per-thread compaction) so threads can be replayed and audited.

Recommended sequencing for rcode: build the agent loop with app-owned IDs and an internal event
stream shaped like Option B's notifications from day one; expose it as ACP (A) first for instant
reach, then as `rcode app-server` (B) for full-fidelity GUI control; treat (C) as optional.
