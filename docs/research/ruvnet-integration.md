# RuvNet Ecosystem Integration for rcode

Status: research / design proposal
Date: 2026-11-07
Scope: ruflo (`@claude-flow/cli` v3.72.2), ruvector (`ruvector` v0.3.14 + `@ruvector/*`), ruvnet-brain (v4.7.28)
Reference checkouts (read-only):

- `reference/ruflo` (ruvnet/ruflo, MIT)
- `reference/ruvector` (ruvnet/ruvector, MIT)
- `reference/ruvnet-brain` (stuinfla/ruvnet-brain, MIT)

All paths below are relative to `/Users/rudycelekli/Downloads/rcode/reference/` unless stated.
Statements tagged **[verified]** were checked directly in source or by running a binary on this
machine. Statements tagged **[doc]** come from READMEs/ADRs and may be stale. Where docs and code
disagree, this file says so.

---

## 0. TL;DR

| Component | What rcode should use | How | Cost |
|---|---|---|---|
| ruvector | `ruvector` library (`VectorDB`, `OnnxEmbedder`) in-process | npm dependency (optional) | Native NAPI binary ~6-9 MB per platform; bundled 10 MB ONNX WASM; 90 MB model downloaded on first embed |
| ruvector fallback | `rvlite` (WASM, ~850 KB) or a pure-TS flat/HNSW index | npm dependency (pure) | Works under Bun with no native code |
| ruflo | `@claude-flow/cli` MCP server over stdio, lazily installed into `~/.rcode/runtime/` | `node <bin>/cli.js mcp start` (stdio JSON-RPC) | Heavy: 300+ tools, optional native `better-sqlite3`, large dep tree (the installed v2.7.47 on this machine is 712 MB) |
| ruflo (in-proc, optional) | `@claude-flow/cli/dist/src/mcp-client.js` -> `callMCPTool()` | dynamic `import()` under Node only | Same install; avoids JSON-RPC hop but loads the entire registry |
| ruvnet-brain | Its MCP server `plugin/mcp/server.mjs` over stdio, plus re-implemented hook semantics in rcode | lazily installed via `npx ruvnet-brain --no-claude`-style flow or direct release download; KB at `~/.cache/ruvnet-brain/kb` | KB is ~1.6 GB + ~257 MB models on this machine **[verified]** |

Recommendation in one line: **bundle ruvector + a pure-TS fallback as the default memory layer;
treat ruflo and ruvnet-brain as opt-in "power packs" that rcode installs into a private runtime
dir and speaks to over MCP stdio, with health checks and degrade-to-noop behaviour.**

---

## 1. ruflo

### 1.1 Packages and binaries [verified]

The repo is a monorepo. Three npm names matter:

| npm name | Source | `bin` | Notes |
|---|---|---|---|
| `ruflo` | `ruflo/ruflo/package.json` | `ruflo -> bin/ruflo.js` | Branded umbrella. `mcpName: io.github.ruvnet/ruflo`. Also ships an HTTP "mcp-bridge" (`src/mcp-bridge/index.js`) and docker-compose files. |
| `claude-flow` | `ruflo/package.json` | `claude-flow -> bin/cli.js` | Umbrella that just `import()`s `v3/@claude-flow/cli/bin/cli.js` (`ruflo/bin/cli.js`). |
| `@claude-flow/cli` | `ruflo/v3/@claude-flow/cli/package.json` | `cli`, `claude-flow -> bin/cli.js`; `claude-flow-mcp -> bin/mcp-server.js` | **The real implementation.** `"type": "module"`, `main: dist/src/index.js`. Version 3.72.2. |

All three are at version 3.72.2 in the checkout. The README's canonical registration is
`claude mcp add claude-flow -- npx ruflo@latest mcp start` (`ruflo/README.md:343`).

Key `@claude-flow/cli` facts (`v3/@claude-flow/cli/package.json`):

- `scripts.postinstall: node ./scripts/postinstall.cjs` — patches the installed `agentdb` tree
  (copies `dist/src/<x>` to `dist/<x>` and augments its `exports` map). Best-effort, try/catch
  wrapped (`scripts/postinstall.cjs` header comment). `bin/preinstall.cjs` is a no-op.
- Hard dependencies include `sql.js` (WASM SQLite), `express`, `ws`, `inquirer`, `typescript`
  (yes, as a runtime dep), `@claude-flow/memory`, `@claude-flow/neural`, `@claude-flow/mcp`,
  `@ruvector/rabitq-wasm`, `zod`, `ajv`.
- `optionalDependencies` (where native code and size live): `better-sqlite3 ^12.9.0`,
  `agentdb ^3.3.0`, `agentic-flow ^3.0.0`, `ruvector ^0.3.13`, `@napi-rs/keyring`,
  `@agntcy/slim-bindings`, `@metaharness/*`, `agent-booster`, `@ruvector/learning-wasm`,
  `nostr-tools`, `@claude-flow/aidefence`.
- `peerDependencies` (optional): `metaharness`, `@metaharness/router`, `@ruvector/typesafe`.
- `exports` (library surface):
  - `"."` -> `dist/src/index.js` (the `CLI` class, parser, output, commands, context delegation)
  - `"./mcp-tools"` -> `dist/src/mcp-tools/index.js` (tool *definitions* arrays: `memoryTools`,
    `hooksTools`, `swarmTools`, `agentTools`, ...)
  - `"./memory"` -> `dist/src/memory/memory-initializer.js`
  - `"./intelligence"` -> `dist/src/memory/intelligence.js`
  - `"./ruvector"`, `"./ruvector/*"`
  - `"./dist/*"` (wildcard — this is how `dist/src/mcp-client.js` is reachable)

### 1.2 Starting the MCP server [verified]

Two equivalent stdio entry points:

```bash
# (a) through the CLI router — auto-detects MCP mode
node <pkg>/v3/@claude-flow/cli/bin/cli.js mcp start
npx -y @claude-flow/cli@latest mcp start
npx -y ruflo@latest mcp start

# (b) dedicated, formatting-free entry point
node <pkg>/v3/@claude-flow/cli/bin/mcp-server.js      # bin name: claude-flow-mcp
```

`bin/cli.js:152` decides MCP mode with
`isExplicitMCP = cliArgs[0] === 'mcp' && (cliArgs.length === 1 || cliArgs[1] === 'start')`.
`bin/mcp-server.js` writes all logs to **stderr** (stdout is reserved for JSON-RPC), caps the stdin
buffer at 10 MB, and imports `listMCPTools/callMCPTool/hasTool` from `dist/src/mcp-client.js` plus
the policy enforcer (`dist/src/mcp-tools/policy-enforcer.js`). Protocol is newline-delimited
JSON-RPC 2.0; it supports both the 2026-07-28 revision and legacy `initialize`
(`dist/src/mcp-protocol.js`, ADR-524).

Useful env/flags:

| Variable / flag | Effect | Source |
|---|---|---|
| `--tools <sel>` / `CLAUDE_FLOW_MCP_TOOLS=<sel>` | Comma list of categories, prefixes (`memory` matches `memory_*`) or exact names. Filters *advertised* tools. Critical for rcode because 300+ schemas blow the context window. | `bin/cli.js:38-60`, `src/commands/mcp.ts:169,602` |
| `CLAUDE_FLOW_MCP_TRANSPORT=stdio` | Transport selection (plugin sets this) | `plugins/ruflo-core/.mcp.json` |
| `CLAUDE_FLOW_MEMORY_PATH` | Root dir for `memory.db` (default `cwd/.swarm`) | `src/memory/memory-initializer.ts:177-218` |
| `RUFLO_MCP_CLI_OVERRIDE`, `RUFLO_MCP_SKIP_NPX=1`, `RUFLO_MCP_SPAWN=1` | Launcher resolution controls | `plugins/ruflo-core/scripts/mcp-launch.cjs` header |
| `RUFLO_STATE_DIR` | Funnel/consent state dir | `src/funnel/*` |

Ruflo's own Claude Code plugin does not call `npx` directly; it runs
`node ${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launch.cjs`, which resolves a local `@claude-flow/cli`
install (requires both `bin/cli.js` *and* `dist/src/index.js` to exist), runs it in-process, and
only falls back to `npx -y @claude-flow/cli@latest mcp start`. **rcode should copy this pattern:
resolve a pinned local install first, never float on `@latest` at runtime.**

Measured on this machine with the globally installed (older) `claude-flow@2.7.47`:
`--version` 0.04 s; `mcp start` answering `tools/list` 0.29 s wall **[verified]**. v3 loads far
more modules (AgentDB bridge, ONNX, HNSW), so budget 1-3 s cold start and do it in the background.

### 1.3 Tool families [verified]

Registered in `v3/@claude-flow/cli/src/mcp-client.ts` (`registerTools([...])`). Counts are
`name:` entries per file in `src/mcp-tools/`:

| Family (file) | # | Relevance to a coding agent |
|---|---|---|
| `hooks_*` (`hooks-tools.ts`) | 42 | **High** — pre/post edit/command/task, route, model-route, SONA trajectories, patterns, workers |
| `agentdb_*` (`agentdb-tools.ts`, `agentdb-episode-tools.ts`) | 21+4 | **High** — ReasoningBank patterns, hierarchical memory, episodes, causal graph |
| `memory_*` (`memory-tools.ts`) | 15 | **High** — KV + vector memory (`.swarm/memory.db`) |
| `embeddings_*` (`embeddings-tools.ts`) | 10 | Medium — ONNX MiniLM, hyperbolic, RaBitQ |
| `swarm_*` + coordination (`swarm-tools.ts`, `coordination-tools.ts`) | 10+7 | Medium — state tracking only (see 1.5) |
| `agent_*` (`agent-tools.ts`) | 9 | Medium — registry; `agent_execute` calls Anthropic Messages API itself |
| `task_*` (`task-tools.ts`) | 8 | Medium — cross-session task store |
| `session_*` (`session-tools.ts`) | 8 | Medium |
| `hive-mind_*`, `workflow_*`, `claims_*`, `autopilot_*`, `daa_*`, `neural_*`, `performance_*` | 10/12/12/10/8/6/6 | Low-medium |
| `wasm_agent_*`, `browser_*` (only if `agent-browser` on PATH), `managed_agent_*`, `ruvllm_*`, `metaharness_*`, `agenticow_*`, `agentbbs_*`, `x_federation_*`, `team_*`, `mission_*`, `github_*`, `terminal_*`, `system_*`, `security_*`, `transfer_*`, `rure_*`, `policy_*`, `config_*`, `progress_*`, `analyze_*`, `testgen`, `http_fetch`, `fast_apply` | many | Low for rcode v1; several are federation/cloud features that should be filtered out |

Tool shape (`src/mcp-tools/types.ts`): `{ name, description, inputSchema, category, tags, version,
cacheable, cacheTTL, handler(input, context) }`. `listMCPTools(category?)` returns everything but
`handler` (`mcp-client.ts`, around line 395).

### 1.4 The ~30 most useful tools and their input schemas [verified]

Extracted from the `inputSchema` blocks. `*` = required.

**Memory (`memory-tools.ts`)** — backed by `.swarm/memory.db` (sql.js, optional better-sqlite3), 384-d embeddings:

| Tool | Input |
|---|---|
| `memory_store` | `key*: string, value*: string\|object, namespace?: string, tags?: string[], ttl?: number, upsert?: boolean, provenance_type?: 'user_claim'\|'agent_output'\|'system_observation'\|'tool_result'\|'unknown', dbPath?: string` |
| `memory_retrieve` | `key*: string, namespace?: string, dbPath?: string` |
| `memory_search` | `query*: string, namespace?: string, limit?: number, threshold?: number, smart?: boolean, provenance_filter?: string[], dbPath?: string` |
| `memory_list` | `namespace?, tags?: string[], limit?, offset?, dbPath?` |
| `memory_delete` | `key*: string, namespace?, dbPath?` |
| `memory_search_unified` | `query*: string, limit?, namespace?, namespaces?: string[]` (merges Claude Code memories + AgentDB) |

**Hooks / routing / learning (`hooks-tools.ts`)**:

| Tool | Input |
|---|---|
| `hooks_route` | `task*: string, context?: string, useSemanticRouter?: boolean` -> `{ task, routing:{method,backend,latencyMs}, primaryAgent:{type,confidence,reason}, alternativeAgents[], semanticMatches[] ... }` (3-tier: codemod / Haiku / Sonnet-Opus) |
| `hooks_model-route` | `task*: string, preferSpeed?: boolean, preferCost?: boolean` -> haiku/sonnet/opus |
| `hooks_model-outcome` | `task*, model*: 'haiku'\|'sonnet'\|'opus', outcome*: 'success'\|'failure'\|'escalated'` |
| `hooks_pre-task` | `taskId*: string, description*: string, filePath?: string` |
| `hooks_post-task` | `taskId*: string, success?: boolean, agent?, quality?: number, task?, duration?, latencyBudgetMs?, consensusAlignment?, agentRole?, storeDecisions?: boolean, parentAgentId?, depth?` |
| `hooks_pre-edit` | `filePath*: string, operation?: string, context?: string` |
| `hooks_post-edit` | `filePath*: string, success?: boolean, agent?: string` |
| `hooks_pre-command` | `command*: string` (risk assessment) |
| `hooks_post-command` | `command*: string, exitCode?: number, success?: boolean, ttl?: integer` |
| `hooks_session-start` | `sessionId?, restoreLatest?: boolean, startDaemon?: boolean` |
| `hooks_session-end` | `saveState?, exportMetrics?, stopDaemon?: boolean` |
| `hooks_intelligence_trajectory-start` | `task*: string, agent?, sessionId?` |
| `hooks_intelligence_trajectory-step` | `trajectoryId*: string, action*: string, result?: string, quality?: number` |
| `hooks_intelligence_trajectory-end` | `trajectoryId*: string, success?: boolean, feedback?: string` |
| `hooks_intelligence_pattern-store` | `pattern*: string, type?, confidence?: number, metadata?: object` |
| `hooks_intelligence_pattern-search` | `query*: string, topK?, minConfidence?, namespace?, strategy?: 'semantic'\|'state-tree', sessionId?, depth?` |

**AgentDB (`agentdb-tools.ts`)** — requires optional `agentdb` package; degrades otherwise:

| Tool | Input |
|---|---|
| `agentdb_health` | `{}` |
| `agentdb_pattern-store` | `pattern*: string, type?, confidence?` |
| `agentdb_pattern-search` | `query*: string, topK?, minConfidence?` (BM25 + semantic hybrid) |
| `agentdb_feedback` | `taskId*: string, success?, quality?, agent?` |
| `agentdb_hierarchical-store` | `key*, value*: string, tier?: 'working'\|'episodic'\|'semantic', validFrom?, validUntil?, supersedes?` |
| `agentdb_hierarchical-recall` | `query*: string, tier?, topK?, includeExpired?` |
| `agentdb_episode-recall` | `query*: string, k?, hybrid?, rerank?, onlySuccesses?, onlyFailures?, minReward?, timeWindowDays?` |
| `agentdb_context-synthesize` | `query*: string, maxEntries?` |
| `agentdb_route` | `task*: string, context?` |

**Orchestration (`swarm-tools.ts`, `agent-tools.ts`, `task-tools.ts`)**:

| Tool | Input |
|---|---|
| `swarm_init` | `topology?, maxAgents?: number, strategy?, config?: object` |
| `swarm_status` / `swarm_shutdown` | `swarmId?` / `swarmId?, graceful?` |
| `agent_spawn` | `agentType*: string, agentId?, name?, swarmId?, config?, domain?, model?: 'haiku'\|'sonnet'\|'opus'\|'opus-4.7'\|'inherit', task?, memoryBase?, memoryDimension?` |
| `agent_execute` | `agentId*, prompt*, systemPrompt?, maxTokens?, temperature?` (calls Anthropic API directly — needs a key) |
| `agent_status` / `agent_list` / `agent_terminate` | `agentId*` / `status?, domain?, agentType?, includeTerminated?` / `agentId*, force?, promoteMemory?` |
| `task_create` / `task_status` / `task_complete` | `type*, description*, priority?, assignTo?, tags?` / `taskId*` / `taskId*, result?` |

**Embeddings**: `embeddings_init` (`model?: 'Xenova/all-MiniLM-L6-v2'\|'Xenova/all-mpnet-base-v2', hyperbolic?, curvature?, cacheSize?, force?`), `embeddings_generate` (`text*, hyperbolic?, normalize?`), `embeddings_search` (`query*, topK?, threshold?, namespace?`).

Suggested advertised subset for rcode:
`CLAUDE_FLOW_MCP_TOOLS=memory_store,memory_retrieve,memory_search,memory_list,memory_delete,hooks_route,hooks_model-route,hooks_model-outcome,hooks_pre-task,hooks_post-task,hooks_pre-edit,hooks_post-edit,hooks_pre-command,hooks_post-command,hooks_session-start,hooks_session-end,hooks_intelligence_trajectory-start,hooks_intelligence_trajectory-step,hooks_intelligence_trajectory-end,hooks_intelligence_pattern-search,agentdb_health,agentdb_pattern-search,agentdb_episode-recall,agentdb_context-synthesize,swarm_init,swarm_status,agent_spawn,agent_list,task_create,task_complete`.
Note that rcode calls most hooks tools *itself* (not the model), so only memory/route/swarm need to
be model-visible; the rest can be called by rcode without being advertised to the LLM (filtering
affects `tools/list` only — `bin/cli.js:38` "Filters *advertised* tools").

### 1.5 Library use instead of CLI/MCP [verified]

Yes, with caveats.

```ts
// Node only (ESM). All business logic lives in tool handlers (ADR-005 "MCP-first").
const { callMCPTool, listMCPTools, hasTool } =
  await import('@claude-flow/cli/dist/src/mcp-client.js');
const r = await callMCPTool('memory_search', { query: 'auth flow', limit: 5 });

// Lower level memory API
const mem = await import('@claude-flow/cli/memory'); // memory-initializer.js
await mem.initializeMemoryDatabase({ /* ... */ });
await mem.storeEntry({ key, value, namespace, generateEmbeddingFlag: true, tags, provenanceType: 'tool_result' });
const hits = await mem.searchEntries({ query, namespace, limit: 5, threshold: 0.3 });
// also: generateEmbedding, loadEmbeddingModel, searchHNSWIndex, resolveDbPath, getMemoryRoot
```

Caveats:

1. Importing `mcp-client.js` statically imports **every** tool module (agent, swarm, browser,
   federation, managed-agents, ...). Cold import is the same cost as starting the server, and any
   failing optional import surfaces in rcode's process.
2. Several modules patch `console.log/warn` globally (`bin/cli.js:34-36`, `bin/mcp-server.js`).
   Running in-process means those patches leak into rcode's TUI output.
3. Bun compatibility is unverified for `better-sqlite3` (Bun has its own `bun:sqlite`; the npm
   `better-sqlite3` addon generally does not load under Bun) and for `agentdb`'s native bits.
   `sql.js` (WASM) path should work.
4. "Swarm" in ruflo is *coordination state* (registry, topology, pheromones, persistence). It does
   not execute LLM work except `agent_execute` (Anthropic API with its own key). rcode remains the
   executor; ruflo is a ledger + router + memory.

Conclusion: **use MCP stdio as the primary integration** (process isolation, crash containment,
console hygiene, works whether rcode runs under Bun or Node) and keep the in-process path as an
experimental optimization behind a flag, Node-only.

### 1.6 Native deps, startup, failure modes

| Failure | Cause | Detection | Mitigation |
|---|---|---|---|
| `ruflo: command not found` / `claude-flow` missing | Not installed; relying on `npx` without network | `which`, or resolve `<runtime>/node_modules/@claude-flow/cli/bin/cli.js` + `dist/src/index.js` | rcode installs into `~/.rcode/runtime/ruflo` with a pinned version; never depend on PATH |
| `better-sqlite3` build failure (node-gyp, no Xcode CLT / python, Node ABI mismatch) | optional native dep | install log; or `require('better-sqlite3')` in a probe | It is optional: ruflo falls back to `sql.js`. Install with `--omit=optional` first, then try optional deps in a second, non-fatal step. Code even guards mixed-mode WAL corruption (`memory-initializer.ts:70-150`, "refusing an unsafe sql.js ... restore the native better-sqlite3 bridge") |
| `ERR_MODULE_NOT_FOUND dist/src/index.js` | git checkout without build | check `dist/` exists (the launcher does exactly this) | only install from npm tarball |
| `[AgentDB Patch] Controller index not found` noise | agentdb layout drift | stderr | cosmetic; postinstall patches; filtered in bin |
| ONNX model download fails / slow | `Xenova/all-MiniLM-L6-v2` fetched from HuggingFace on first embed (`memory-initializer.ts` ~2400, ADR-454 cache dir) | first `memory_store` slow / `embedding` missing; `#3325` flag on result | Pre-warm during `rcode setup`; ruflo falls back to "ruvector ONNX / agentic-flow / hash fallback" |
| Huge tool list | 300+ schemas | `tools/list` size | `CLAUDE_FLOW_MCP_TOOLS` filter |
| Memory written into project | default `cwd/.swarm/memory.db` | `.swarm/` appears | set `CLAUDE_FLOW_MEMORY_PATH` to `~/.rcode/projects/<hash>/ruflo` or accept + gitignore |
| Network calls | funnel/telemetry endpoints `https://funnel.ruv.io/v1/events` (`src/funnel/event-transport.ts:43`) | — | consent-gated: `hasConsent('telemetry')` requires an explicit receipt (`src/funnel/consent.ts`); default not granted. Also point `RUFLO_FUNNEL_*_ENDPOINT` at an unroutable value as belt-and-braces |

Install size data point: the globally installed `claude-flow@2.7.47` here is **712 MB, 339 top-level
modules** (`~/.nvm/.../lib/node_modules/claude-flow`) **[verified]**. v3 with optional deps
(agentdb, agentic-flow, onnxruntime via transformers) should be assumed similar or larger. This is
the single strongest reason not to put ruflo in rcode's own `dependencies`.

---

## 2. ruvector

### 2.1 npm packages [verified]

From `ruvector/npm/packages/*/package.json`:

| Package | Version | Role | Native? |
|---|---|---|---|
| `ruvector` | 0.3.14 | Main SDK + CLI (`bin: ruvector -> bin/cli.js`) + MCP server. Deps: `@ruvector/core`, `@ruvector/attention`, `@ruvector/gnn`, `@ruvector/sona`, `@modelcontextprotocol/sdk`, `commander`, `chalk@4`, `ora@5`. Optional: `@ruvector/rvf`, `@ruvector/rabitq-wasm`, `@ruvector/mincut-wasm`, `@ruvector/tiny-dancer`, `@metaharness/*` | via deps |
| `@ruvector/core` | 0.1.36 | NAPI-RS HNSW vector DB (Rust; redb storage). Optional platform packages `ruvector-core-{darwin-arm64,darwin-x64,linux-x64-gnu,linux-arm64-gnu,win32-x64-msvc}@0.1.34`. Loader `core/index.js` maps `process.platform/arch` and throws `Native module not found for ...` if missing | **yes** (prebuilt, no compile) |
| `@ruvector/node` | 0.1.26 | Older Node wrapper over core + gnn | yes |
| `@ruvector/rvf`, `rvf-node`, `rvf-wasm`, `rvf-mcp-server` | — | RVF "cognitive container" file format | mixed |
| `rvlite` | 0.2.8 | **WASM** vector DB with SQL/SPARQL/Cypher, ~850 KB, `createRvLite({dimensions})`, `insert/search/get`, `exportJson()`, Node RVF persistence via `RvLite.createWithRvf()/saveToRvf()` (README) | **no** |
| `@ruvector/wasm` | 0.1.31 | Meta package over learning/economy/exotic/nervous-system/attention WASM; directory only contains `package.json` | no |
| `@ruvector/cli` | 0.1.30 | Separate CLI (pg optional) — also claims `bin: ruvector` (conflicts with main package) | — |
| `@ruvector/sona`, `gnn`, `attention`, `router`, `tiny-dancer`, `ruvllm` | — | learning / routing / local LLM | native + wasm variants |

No `postinstall` scripts in `ruvector`, `@ruvector/core`, `@ruvector/node`, `@ruvector/cli`, `rvlite`
**[verified]** — native code ships as prebuilt optional platform packages.

### 2.2 Programmatic Node API [verified]

Backend selection in `npm/packages/ruvector/src/index.ts`:

1. If `RUVECTOR_BACKEND=rvf` or `--backend rvf` -> `@ruvector/rvf` (must export `VectorDb`).
2. Else `require('@ruvector/core')` -> `implementationType = 'native'`.
3. Else try `@ruvector/rvf`.
4. Else a **stub** `VectorDb` whose `insert/insertBatch/delete` throw and `search` returns `[]`,
   with `implementationType = 'wasm'` (misleading name — it is *not* a working WASM backend).

Public API (`VectorDBWrapper`, exported as `VectorDB` and `VectorDb`):

```ts
import { VectorDB, OnnxEmbedder, getImplementationType, isNative } from 'ruvector';

const db = new VectorDB({
  dimensions: 384,                 // alias: dimension
  distanceMetric: 'cosine',        // 'cosine' | 'euclidean' | 'dot' (normalized)
  storagePath: './agent-memory.db' // alias: path; persistent via redb
  // hnswConfig?: { m, efConstruction, efSearch, ... }
});
await db.insert({ id: 'decision-1', vector, metadata: { text, kind } });   // -> id
await db.insertBatch([{ id, vector, metadata }]);                           // -> ids
await db.search({ vector: q, k: 5, filter: { tenant: 'acme' }, efSearch }); // -> [{id, score, metadata}]
await db.get(id); await db.update(id, ...); await db.delete(id);
await db.deleteMany(ids); await db.len(); await db.isEmpty();
```

Metadata is JSON-encoded automatically by the wrapper. Lower score = closer for distance metrics
(`examples/nodejs/README.md`: "Lower search distances are closer").

Embeddings (`src/core/onnx-embedder.ts`, exported from `src/core/index.ts:44`):

```ts
const embedder = new OnnxEmbedder();      // default model 'all-MiniLM-L6-v2', 384-d
await embedder.init();
const v  = await embedder.embedPassage(text);
const qv = await embedder.embedQuery(query);
// functional API: initOnnxEmbedder({ modelId, cacheDir, maxLength, normalize }), embed, embedBatch,
// embedQueryBatch, similarity, cosineSimilarity, getDimension, isReady, getActiveModelId
```

- Runtime: **pure WASM**, bundled in the package at
  `src/core/onnx/pkg/ruvector_onnx_embeddings_wasm_bg.wasm` (10.2 MB) **[verified]**, loaded via
  `WebAssembly.instantiate` on raw bytes (deliberately avoids `--experimental-wasm-modules`,
  `onnx-embedder.ts:277-291`). No `onnxruntime-node` native addon. This should run under Bun.
- Model catalogue (`src/core/onnx/loader.js` `MODELS`): `all-MiniLM-L6-v2` (default),
  `all-MiniLM-L12-v2`, `bge-small-en-v1.5`, `bge-base-en-v1.5`, `e5-small-v2`, `gte-small`.
- Download behaviour: first `init()` fetches `model.onnx` + `tokenizer.json` from
  `https://huggingface.co/sentence-transformers/<model>/resolve/main/...` and caches under
  `config.cacheDir || $HOME/.ruvector/models` (`onnx-embedder.ts:298-303`). MiniLM-L6 is ~90 MB.
  Logs to stderr (`Loading ONNX model: ...`, `Downloading: <url>`).
- Embedding-space identity is recorded (`deriveOnnxEmbeddingSpaceIdentity`, provider
  `ruvector-onnx-wasm`), useful to refuse mixing vectors from different models.

### 2.3 WASM fallback under Bun

- **Embeddings**: yes — the ONNX path is WASM already. Bun supports `WebAssembly.instantiate`.
  (Not executed here; rcode CI must verify on Bun 1.2+.)
- **Vector store**: the root `ruvector` package has **no working WASM vector store fallback** in
  current code. Docs say otherwise: `docs/architecture/NPM_PACKAGE_ARCHITECTURE.md` "ADR-002: WASM
  as Universal Fallback" lists `@ruvector/wasm` as a required dep and a compat matrix
  "Bun | Native ✅ | WASM ✅" **[doc]** (retrieved via `search_ruvnet`), but
  `npm/PUBLISHING_STATUS.md` says the WASM build was "blocked by architecture (redb, mmap-rs)" and
  the current `src/index.ts` stub refuses writes. The example README states it plainly: "The root
  package's limited fallback does not provide a working persistent vector store."
- **Native under Bun**: `@ruvector/core` is a NAPI-RS addon; Bun implements Node-API and generally
  loads napi-rs prebuilt `.node` files. Treat as "likely works, must be probed at runtime".
- **Real fallback options**: `rvlite` (WASM, persists via `exportJson()` or RVF file) or rcode's
  own pure-TS index (section 4.2). Both are safe under Bun with no native code.

### 2.4 ruvector MCP server [verified]

```bash
npx -y ruvector mcp start                       # stdio
RUVECTOR_MCP_PROFILE=readonly npx -y ruvector mcp start
npx ruvector mcp tools                          # list
# Claude Code reference registration (README):
claude mcp add --scope project --env RUVECTOR_MCP_PROFILE=readonly --transport stdio ruvector -- npx -y ruvector mcp start
```

Server: `npm/packages/ruvector/bin/mcp-server.js` (~145 tool declarations); policy in
`bin/mcp-policy.js`: precedence `RUVECTOR_MCP_DENY` > `RUVECTOR_MCP_ALLOW`/`RUVECTOR_MCP_PROFILE`
> allow-all. The only built-in profile is `readonly` (`ruvector`, `metaharness_status|route|replay_verify|flywheel_gate|workspace_probe|reward_hack_scan`, `hooks_stats`, `hooks_recall`, `hooks_memory_get`, `hooks_memory_list`, `hooks_route`, `hooks_route_enhanced`, `hooks_suggest_context`, `hooks_capabilities`, `hooks_export`, `hooks_doctor`, `hooks_attention_info`, `hooks_gnn_info`).

Tool families by prefix count: `hooks_*` 53, `brain_*` 11, `rvf_*` 12, `workers_*` 12,
`vectordb_*` 7, `decompile_*` 6, `metaharness_*` 6, `edge_*` 4, `rvlite_*` 3, `diskann_*` 2,
`identity_*` 2, plus singletons. Key schemas:

| Tool | Input |
|---|---|
| `vectordb_create` | `path*: string (inside project), dimension*: number, metric?: 'cosine'\|'euclidean'\|'dot'` |
| `vectordb_insert` | `path*, entries*: [{id, vector, metadata?}]` |
| `vectordb_search` | `path*, vector*: number[], k?: number (<=1000), filter?: object` |
| `vectordb_get/update/delete/stats` | `path*, id...` |
| `hooks_remember` | `content*: string, type?: 'project'\|'code'\|'decision'\|'context'` |
| `hooks_recall` | `query*: string, top_k?: number` |
| `hooks_route`, `hooks_route_enhanced`, `hooks_suggest_context`, `hooks_rag_context` | task routing / context |
| `hooks_memory_get/list/update`, `hooks_forget` | CRUD on remembered items |

Storage: semantic hook memory in `<project>/.ruvector/intelligence.json` (falls back to
`~/.ruvector/intelligence.json`; `bin/intel-store.js:11-19`).

For rcode, ruvector's MCP server is **not** needed: rcode uses the library directly. Expose it only
if the user wants the model to see `vectordb_*` tools.

---

## 3. ruvnet-brain

### 3.1 What it is [verified]

A "source-grounded brain" over ~77-121 RuvNet repositories, delivered as:

1. **A knowledge base** — per-repo RVF vector stores + passage files
   (`<repo>.big.rvf`, `.embed.json`, `.idmap.json`, `.meta.json`, `.passages.jsonl`) plus primers
   and capability cards, at `~/.cache/ruvnet-brain/kb` (1,193 entries, **1.6 GB**) and local
   embedder/reranker models at `~/.cache/ruvnet-brain/models` (**257 MB**, Xenova) on this machine
   **[verified]**. The KB is itself a tiny npm project (`kb/package.json`: deps
   `@ruvector/rvf ^0.3.4`, `@xenova/transformers 2.17.2`, `@babel/parser`) with
   `forge-ask.mjs` (CLI) and `forge-mcp-all.mjs` (MCP worker).
2. **An MCP server** — `plugin/mcp/server.mjs` ("Stable Spine protocol shell", 437 lines).
3. **Lifecycle hooks** — `plugin/hooks/hooks.json` dispatched through `plugin/scripts/hook-shim.mjs`.
4. **An installer** — `bin/install.mjs` (7,441 lines), npm bin `ruvnet-brain`.
5. Host adapters for Claude Code, Codex, Grok (`plugin/host-adapters/{claude,codex,grok}.json`).

### 3.2 Installation [verified]

```bash
npx ruvnet-brain            # recommended
npx github:stuinfla/ruvnet-brain
npx ruvnet-brain --doctor   # health check (--json for machine-readable)
npx ruvnet-brain --uninstall
```

`bin/install.mjs` is dependency-free (Node built-ins; shells out to `unzip`, `npm`, `claude`). It:

1. Resolves the latest GitHub release (`https://api.github.com/repos/stuinfla/ruvnet-brain/releases/latest`,
   fallback `.../releases/download/<tag>/<asset>`; `--pin vX.Y.Z` supported) and downloads the KB
   archive (`kb/download-retry.mjs`, `kb/zip-extract.mjs`); verifies against
   `keys/ruvnet-brain-signing.pub.pem`.
2. Extracts into `~/.cache/ruvnet-brain/` (versioned trees under `versions/<v>/`, pointer
   `active.json`), runs `npm i` inside the KB, warms models (checks `huggingface.co` reachability).
3. Wires the Claude Code plugin at user scope:
   `claude plugin marketplace add <source>` + `claude plugin install ruvnet-brain@ruvnet-brain --scope user`
   (`bin/install.mjs:1491-1492`). Optionally Codex.
4. Optionally installs a **nightly refresh scheduler** (`plugin/scripts/nightly-scheduler.mjs`,
   launchd/cron) and an auto-update plane.

Runtime deps of the published package (`package.json`): `@claude-flow/aidefence`,
`@metaharness/flywheel`, `@metaharness/router`, `@pacphi/agentic-kit@next` (a floating `next` tag),
`ws`.

### 3.3 MCP server and tool contract [verified]

Launch: `node <plugin>/mcp/server.mjs` (stdio; `plugin/.mcp.json`). Protocol `2024-11-05`, server
info `{ name: 'ruvnet-brain', version: '2.0.0' }`.

Behaviour (`server.mjs` header): the parent answers `initialize`/`ping`/`tools/list` itself, lazily
spawns a warm child `KB/forge-mcp-all.mjs` with env `KB_DIR`, remaps JSON-RPC ids, hot-swaps the child
between calls when `active.json` generation or KB `SOURCE.json` mtime changes, and returns a soft
error with install guidance if the brain is absent. Location resolution: `$RUVNET_BRAIN_KB` >
`$RUVNET_BRAIN_HOME/kb` > `~/.cache/ruvnet-brain/kb`. Model cache `$KB_MODEL_CACHE` else
`<home>/models`. Timeouts: `RUVNET_BRAIN_INIT_TIMEOUT_MS` (60 s), `RUVNET_BRAIN_CALL_TIMEOUT_MS`
(240 s), `RUVNET_BRAIN_CHILD_IDLE_MS` (30 min).

Tools:

```jsonc
// search_ruvnet  (readOnlyHint: true, idempotentHint: true)
{ "query": "string (required)", "k": "integer, default 6" }
// ruvnet_registry_latest (read-only): { "executable": <enum of managed CLIs> }
// ruvnet_cli_help (read-only): { "executable": ..., "argv": ["<=2 lowercase subcommand tokens"] }  // appends --help
// ruvnet_cli_run (destructive): { "executable": ..., "argv": [literal tokens] }  // no shell; refuses unless matching help read in last 24 h
```

`search_ruvnet` response (observed in this session) is a JSON object:
`{ answer: string /* ranked "#n repo=... path: ... full document" text */, grounding: { receiptId, sources:[{path, packages, installs, sha, enforceable}] }, implementation: { required, verdict: 'proven'|..., implementationSources[] }, routing: { candidateRepos[], confidence, reason }, retrieval: { schemaVersion:1, kind:'ruvnet-brain.retrieval-result', query, k, results:[{rank, repo, path, text, contentSha256}] } }`.
Note the corpus snapshot age is reported ("newest store 0.9d old") and the answer is large
(the 4-result query used here returned ~25 KB) — rcode must truncate/summarize before injecting.

### 3.4 Hook lifecycle [verified]

`plugin/hooks/hooks.json` — every command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" <hook-id> [...]`:

| Event | Matcher | Hook id | Timeout | Mode |
|---|---|---|---|---|
| SessionStart | `startup\|resume\|clear\|compact\|fork` | `session-start` (restore project checkpoint, update plane) | 8 s | advisory |
| UserPromptSubmit | `*` | `unprompted-speech UserPromptSubmit` | 9 s | |
| UserPromptSubmit | `*` | `ground-ruvnet` (retrieve-and-inject grounding) | 10 s | advisory |
| UserPromptSubmit | `*` | `capacity-aware-parallel-work` | 6 s | advisory |
| UserPromptSubmit | `*` | `grounding-turn-mark` | 5 s | advisory |
| PreToolUse | `^(Write\|Edit\|MultiEdit\|NotebookEdit\|apply_patch)$` | `decision-gate write` — **blocking**: refuses rUv-product code until `search_ruvnet` was consulted (ADR-0012/ADR-067) | 5 s | blocking |
| PostToolUse | `*` | `session-snapshot PostToolUse` | 10 s | advisory |
| PostToolUse | `^(?:.*__)?search_ruvnet$` | `grounding-stamp` (opens the write gate) | 5 s | advisory |
| Stop | `*` | `continuation-gate`, `session-snapshot Stop`, `grounding-turn-gate` (forces continuation if the turn answered without searching) | 10 s | |
| PreCompact | `*` | `session-snapshot PreCompact` | 10 s | advisory |
| SessionEnd | `*` | `session-snapshot SessionEnd` | 10 s | advisory |

`hook-shim.mjs` resolves the active code tree from `~/.cache/ruvnet-brain/active.json` once per
invocation, only honours code roots under `~/.cache/ruvnet-brain/versions/` (or a declared dev
checkout in `dev.json`), propagates exit codes for `blocking` hooks and forces exit 0 for
`advisory` ones, and has a per-hook "Brain OFF" contract (ADR-054). `hook-contracts.json` documents
which registrations are permitted.

### 3.5 Hosting the brain from a non-Claude-Code agent

The pieces are host-agnostic Node scripts reading Claude-Code-shaped JSON on stdin. Two options:

**Option A — MCP only (recommended for rcode v1).** Spawn `node <brain>/plugin/mcp/server.mjs`
(or run `KB_DIR=~/.cache/ruvnet-brain/kb node ~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs`
directly), call `search_ruvnet`, and implement grounding natively in rcode's
`onUserPrompt` hook: if the prompt mentions RuvNet products (ruflo, ruvector, agentdb, rvf, ...),
call `search_ruvnet({query: prompt, k: 4})`, trim to ~3-4 KB, inject as a system note with source
paths. No dependency on `${CLAUDE_PLUGIN_ROOT}`, `claude` CLI or hook-shim internals.

**Option B — run the brain's hooks verbatim.** rcode emulates the Claude Code hook protocol:
set `CLAUDE_PLUGIN_ROOT=<brain>/plugin`, pipe the Claude-format JSON event
(`{hook_event_name, session_id, cwd, prompt | tool_name, tool_input, ...}`) to
`node hook-shim.mjs <id>`, honour exit code 2 / `{"decision":"block"}` for blocking hooks, and merge
`hookSpecificOutput.additionalContext` from stdout. The Codex adapter
(`plugin/hooks/codex-hooks.json`, `plugin/scripts/codex-hook-wrapper.mjs`) proves the scripts already
tolerate a second host. Downsides: 13 node process spawns per turn worst case (~50-150 ms each),
blocking write gate that rcode users did not ask for, and tight coupling to the brain's internal
host detection.

Ship A; offer B as `rcode brain hooks --enable` for users who want the full behaviour.

---

## 4. Integration design for rcode

### 4.1 Packaging decision

| Piece | Decision | Rationale |
|---|---|---|
| `ruvector` (+ `@ruvector/core` platform binaries) | **optionalDependency of rcode** | Prebuilt NAPI, no postinstall, ~10-20 MB. Gives real HNSW + bundled WASM ONNX embedder in-process with no IPC. Optional so a failed platform resolution never breaks `bun install`. |
| `rvlite` | **dependency** (small, WASM) — or skip in favour of the pure-TS index | Guaranteed-to-load vector fallback, ~850 KB. |
| Pure-TS fallback (`FlatIndex` / tiny HNSW + hashing embedder) | **in rcode source** | Zero-dependency floor so memory always works (degraded quality). |
| Embedding model (MiniLM-L6, ~90 MB) | **lazy download on first run / `rcode setup`**, into `~/.rcode/models` (pass `cacheDir`) | Not shippable in an npm tarball; user consent for network. |
| `@claude-flow/cli` (ruflo) | **lazy install** to `~/.rcode/runtime/ruflo` with a pinned version, spoken to over **MCP stdio** | 700 MB-class tree, optional native deps, postinstall that mutates agentdb, global console patches. Isolation is worth the IPC. |
| ruvnet-brain | **lazy install** (KB download ~1.6 GB + 257 MB models) only after explicit opt-in; reuse an existing `~/.cache/ruvnet-brain` if present; talk via MCP stdio | Size; KB already exists on many RuvNet users' machines. |
| ruvector MCP server | not used by default | Library covers it. |

Runtime layout:

```
~/.rcode/
  config.json                 # feature flags, consent receipts, pinned versions
  models/                     # ONNX models (ruvector cacheDir)
  runtime/
    ruflo/                    # npm prefix: node_modules/@claude-flow/cli@3.72.2
    brain/                    # optional npm prefix for ruvnet-brain plugin files
  projects/<sha1(realpath)>/
    memory.rvdb               # ruvector VectorDB storagePath
    memory.jsonl              # canonical text log (source of truth, rebuildable index)
    ruflo/                    # CLAUDE_FLOW_MEMORY_PATH
  health.json                 # last setup/doctor result
~/.cache/ruvnet-brain/        # brain's own home (respected, not moved)
```

### 4.2 Adapter interfaces

```ts
// src/integrations/types.ts
export type Health =
  | { status: 'ok'; backend: string; detail?: string }
  | { status: 'degraded'; backend: string; reason: string }
  | { status: 'unavailable'; reason: string; fix?: string };

export interface Embedder {
  readonly id: string;           // e.g. 'ruvector-onnx-wasm:all-MiniLM-L6-v2' | 'hash-256'
  readonly dimensions: number;
  embed(texts: string[], kind?: 'query' | 'passage'): Promise<Float32Array[]>;
}

export interface MemoryRecord {
  id: string;
  text: string;
  namespace: string;             // 'project' | 'decision' | 'episode' | 'pattern' | ...
  tags?: string[];
  provenance?: 'user_claim' | 'agent_output' | 'system_observation' | 'tool_result';
  createdAt: number;
  meta?: Record<string, unknown>;
}
export interface MemoryHit extends MemoryRecord { score: number }

export interface MemoryProvider {
  readonly name: string;
  init(): Promise<Health>;
  health(): Promise<Health>;
  put(rec: Omit<MemoryRecord, 'createdAt'> & { createdAt?: number }): Promise<string>;
  get(id: string): Promise<MemoryRecord | null>;
  search(q: string, opts?: { k?: number; namespace?: string; minScore?: number }): Promise<MemoryHit[]>;
  delete(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface KnowledgeHit { repo: string; path: string; text: string; rank: number; sha?: string }
export interface KnowledgeProvider {
  readonly name: string;
  init(): Promise<Health>;
  search(query: string, k?: number): Promise<{ hits: KnowledgeHit[]; receiptId?: string; corpusAgeDays?: number }>;
  /** cheap heuristic: should this prompt be grounded? */
  isRelevant(prompt: string): boolean;
  close(): Promise<void>;
}

export interface RouteAdvice {
  tier: 1 | 2 | 3;               // 1 = deterministic codemod, 2 = small model, 3 = large model
  model?: 'haiku' | 'sonnet' | 'opus';
  agentType?: string;
  confidence: number;
  reason: string;
}
export interface OrchestratorProvider {
  readonly name: string;
  init(): Promise<Health>;
  route(task: string, context?: string): Promise<RouteAdvice | null>;
  onTaskStart(e: { taskId: string; description: string; filePath?: string }): Promise<void>;
  onTaskEnd(e: { taskId: string; success: boolean; quality?: number; durationMs?: number; model?: string }): Promise<void>;
  onEditStart(e: { filePath: string; operation?: string }): Promise<string | null>; // returns context hint
  onEditEnd(e: { filePath: string; success: boolean }): Promise<void>;
  onCommand(e: { command: string; phase: 'pre' | 'post'; exitCode?: number }): Promise<{ risk?: 'low' | 'medium' | 'high'; note?: string } | void>;
  trajectory?: {
    start(task: string): Promise<string>;
    step(id: string, action: string, result?: string, quality?: number): Promise<void>;
    end(id: string, success: boolean, feedback?: string): Promise<void>;
  };
  /** optional: tools to expose to the model (already filtered) */
  modelTools?(): Promise<McpToolDef[]>;
  close(): Promise<void>;
}
```

MCP plumbing shared by ruflo and brain:

```ts
// src/integrations/mcp-stdio.ts
export class StdioMcpClient {
  constructor(private spec: { command: string; args: string[]; env?: Record<string,string>; cwd?: string;
                             initTimeoutMs?: number; callTimeoutMs?: number }) {}
  async start(): Promise<void>;                  // spawn, initialize (protocolVersion '2024-11-05'), notifications/initialized
  async listTools(): Promise<McpToolDef[]>;
  async call<T = unknown>(name: string, args: object, timeoutMs?: number): Promise<T>; // unwraps content[0].text JSON
  onExit(cb: (code: number | null) => void): void;
  async stop(): Promise<void>;                   // SIGTERM, then SIGKILL after 3 s
}
// Use Bun.spawn or node:child_process; stderr -> ~/.rcode/logs/<name>.log (never the TUI).
// Lazily (re)spawn on first call; circuit-breaker: 3 failures in 60 s -> mark degraded for the session.
```

Implementations:

```ts
// src/integrations/memory/ruvector.ts
export class RuvectorMemory implements MemoryProvider {
  name = 'ruvector';
  private db!: any; private emb!: Embedder; private log!: JsonlLog;
  constructor(private dir: string, private embedderFactory: () => Promise<Embedder>) {}
  async init(): Promise<Health> {
    let rv: typeof import('ruvector');
    try { rv = await import('ruvector'); } catch (e) { return { status: 'unavailable', reason: String(e) }; }
    if (rv.getImplementationType() !== 'native') {
      return { status: 'unavailable', reason: `ruvector backend=${rv.getImplementationType()} (stub refuses writes)` };
    }
    this.emb = await this.embedderFactory();
    this.db = new rv.VectorDB({ dimensions: this.emb.dimensions, distanceMetric: 'cosine',
                                storagePath: join(this.dir, `memory.${this.emb.id.replace(/\W/g,'_')}.rvdb`) });
    this.log = await JsonlLog.open(join(this.dir, 'memory.jsonl'));
    return { status: 'ok', backend: `ruvector-native+${this.emb.id}` };
  }
  async put(r) { const id = r.id ?? crypto.randomUUID(); const [v] = await this.emb.embed([r.text], 'passage');
                 await this.log.append({ ...r, id, createdAt: r.createdAt ?? Date.now() });
                 await this.db.insert({ id, vector: v, metadata: { ...r, id } }); return id; }
  async search(q, o = {}) { const [v] = await this.emb.embed([q], 'query');
                 const hits = await this.db.search({ vector: v, k: o.k ?? 8, filter: o.namespace ? { namespace: o.namespace } : undefined });
                 return hits.map(h => ({ ...h.metadata, score: 1 - h.score })); }
  // get/delete/close ...
}

// src/integrations/embed/ruvector-onnx.ts  -> wraps OnnxEmbedder({ cacheDir: ~/.rcode/models })
// src/integrations/embed/hash.ts           -> deterministic feature-hashing embedder (256-d, token+bigram, L2 norm)

// src/integrations/memory/fallback.ts — pure TS, always available
export class FlatMemory implements MemoryProvider {
  // memory.jsonl is canonical; vectors kept in a Float32Array arena; brute-force cosine is fine to ~50k
  // records (50k x 384 floats = 77 MB; switch to rvlite or a small HNSW if larger).
}

// src/integrations/memory/ruflo.ts — optional mirror so ruflo's own agents/hooks see rcode memory
export class RufloMemory implements MemoryProvider {
  constructor(private mcp: StdioMcpClient) {}
  put = (r) => this.mcp.call('memory_store', { key: r.id, value: r.text, namespace: r.namespace, tags: r.tags,
                                               provenance_type: r.provenance ?? 'agent_output', upsert: true });
  search = async (q, o) => (await this.mcp.call<any>('memory_search', { query: q, limit: o?.k ?? 8, namespace: o?.namespace }))
                              .results.map(toHit);
}

// src/integrations/knowledge/brain.ts
export class BrainKnowledge implements KnowledgeProvider {
  name = 'ruvnet-brain';
  private static RX = /\b(ruflo|claude-flow|ruvector|agentdb|rvf|sona|agentic-flow|ruvllm|ruvnet|hnsw|reasoningbank)\b/i;
  isRelevant(p: string) { return BrainKnowledge.RX.test(p); }
  async search(query: string, k = 4) {
    const r = await this.mcp.call<any>('search_ruvnet', { query, k }, 60_000);
    return { hits: r.retrieval.results.map((x: any) => ({ repo: x.repo, path: x.path, text: x.text.slice(0, 1200), rank: x.rank, sha: x.contentSha256 })),
             receiptId: r.grounding?.receiptId };
  }
}

// src/integrations/orchestrator/ruflo.ts
export class RufloOrchestrator implements OrchestratorProvider {
  name = 'ruflo';
  async route(task, context) {
    const r = await this.mcp.call<any>('hooks_route', { task, context }, 5_000).catch(() => null);
    if (!r?.primaryAgent) return null;
    const m = await this.mcp.call<any>('hooks_model-route', { task }, 3_000).catch(() => null);
    return { tier: r.tier ?? (m?.model === 'haiku' ? 2 : 3), model: m?.model, agentType: r.primaryAgent.type,
             confidence: r.primaryAgent.confidence, reason: r.primaryAgent.reason };
  }
  onTaskStart = (e) => this.fire('hooks_pre-task', e);
  onTaskEnd   = (e) => Promise.all([
                  this.fire('hooks_post-task', { taskId: e.taskId, success: e.success, quality: e.quality, duration: e.durationMs }),
                  e.model ? this.fire('hooks_model-outcome', { task: e.taskId, model: e.model, outcome: e.success ? 'success' : 'failure' }) : null ]).then(() => {});
  onEditStart = async (e) => (await this.call('hooks_pre-edit', { filePath: e.filePath, operation: e.operation }))?.context ?? null;
  onEditEnd   = (e) => this.fire('hooks_post-edit', { filePath: e.filePath, success: e.success });
  onCommand   = (e) => e.phase === 'pre' ? this.call('hooks_pre-command', { command: e.command })
                                         : this.fire('hooks_post-command', { command: e.command, exitCode: e.exitCode, success: e.exitCode === 0 });
  private fire(n: string, a: object) { void this.mcp.call(n, a, 2_000).catch(() => {}); return Promise.resolve(); } // never block a turn
}

// src/integrations/orchestrator/local.ts — fallback: heuristic router (length/keywords/file count -> tier),
// outcomes appended to ~/.rcode/projects/<id>/routing.jsonl so a later ruflo install can import them.
```

Provider registry with graceful degradation:

```ts
// src/integrations/index.ts
export async function loadIntegrations(cfg: RcodeConfig, project: Project) {
  const memory = await firstHealthy<MemoryProvider>([
    cfg.memory !== 'flat' && (() => new RuvectorMemory(project.dataDir, embedderChain(cfg))),
    () => new FlatMemory(project.dataDir, embedderChain(cfg)),          // always succeeds
  ]);
  const orchestrator = cfg.ruflo.enabled
    ? await firstHealthy([() => RufloOrchestrator.spawn(cfg, project), () => new LocalOrchestrator(project)])
    : new LocalOrchestrator(project);
  const knowledge = cfg.brain.enabled
    ? await firstHealthy([() => BrainKnowledge.spawn(cfg), () => new NullKnowledge()])
    : new NullKnowledge();
  return { memory, orchestrator, knowledge };
}
// embedderChain: RuvectorOnnx (if model cached or consented) -> HashEmbedder.
// Index files are keyed by embedder.id so switching embedders never mixes vector spaces;
// memory.jsonl allows a full re-embed (`rcode memory reindex`).
```

Initialization must be **non-blocking**: the TUI starts immediately with `FlatMemory` +
`LocalOrchestrator`; heavier providers swap in when their `init()` resolves (the brain's own
server does the same "readiness promise" trick).

### 4.3 Lifecycle hook mapping

rcode lifecycle events (proposed) and what each provider does:

| rcode event | ruflo (MCP tool, fire-and-forget unless noted) | ruvnet-brain | rcode native memory |
|---|---|---|---|
| `session.start` | `hooks_session-start {sessionId, restoreLatest:true, startDaemon:false}` | (Option B: `session-start`) | open stores; recall last session summary |
| `prompt.submit` | `hooks_route {task: prompt}` + `hooks_model-route` (awaited, 3-5 s budget) -> model/agent advice; `hooks_intelligence_trajectory-start` | `search_ruvnet` if `isRelevant(prompt)` -> inject top-k as context (awaited, 10 s budget, cached per prompt hash) | `memory.search(prompt, k=5)` -> inject |
| `task.start` (plan step / sub-agent spawn) | `hooks_pre-task {taskId, description}`; optional `agent_spawn` for ledger | — | — |
| `tool.pre` Edit/Write | `hooks_pre-edit {filePath, operation}` (awaited 1 s; use returned context as hint) | Option B only: `decision-gate write` (blocking) — **off by default** | — |
| `tool.post` Edit/Write | `hooks_post-edit {filePath, success}`; `trajectory-step` | Option B: `session-snapshot` | — |
| `tool.pre` Bash | `hooks_pre-command {command}` -> risk shown in approval prompt (advisory only; rcode's own permission system decides) | — | — |
| `tool.post` Bash | `hooks_post-command {command, exitCode, success}` | — | store failing command + fix as `episode` when the next run succeeds |
| `task.end` | `hooks_post-task {taskId, success, quality, duration}`, `hooks_model-outcome`, `agentdb_feedback` | — | store distilled decision |
| `turn.end` (Stop) | `trajectory-end {success}` | Option B: `grounding-turn-gate` (can force continuation — off by default) | — |
| `compact.pre` | `memory_store` of the compaction summary (`namespace:'session'`) | Option B: `session-snapshot PreCompact` | write summary to memory |
| `session.end` | `hooks_session-end {saveState:true, exportMetrics:false, stopDaemon:true}` | Option B: `session-snapshot SessionEnd` | flush, close |

Rules: no provider hook may block or slow the turn beyond its budget; all ruflo calls get a
timeout and swallow errors (ruflo's own hook shim follows the same "always exit 0" rule,
`plugins/ruflo-core/hooks/hooks.json` description). Advice from `hooks_route` is *advisory* —
rcode's configured model wins unless the user enables `routing: auto`.

### 4.4 `rcode setup` first-run flow

```
$ rcode setup            # also auto-runs (non-interactive defaults) on first launch
```

1. **Detect environment**: runtime (Bun version / Node version via `process.versions`),
   platform/arch, free disk, network reachability (HEAD `registry.npmjs.org`, `huggingface.co`,
   3 s timeouts), existing installs: `~/.cache/ruvnet-brain/active.json`, global `claude-flow`/`ruflo`,
   `~/.ruvector/models`.
2. **Core memory (always, no prompt)**:
   - Try `import('ruvector')`; record `getImplementationType()`.
   - If native: create `~/.rcode/projects/<id>/memory.*.rvdb`, insert/search/delete a probe
     vector, record latency.
   - Else: select `FlatMemory` (or rvlite) and print one line: `memory: pure-TS fallback (ruvector
     native backend unavailable for <platform>)`.
3. **Embedding model (prompted once, default yes when online)**: "Download local embedding model
   all-MiniLM-L6-v2 (~90 MB) from huggingface.co into ~/.rcode/models?" -> `OnnxEmbedder.init({cacheDir})`,
   run a 2-sentence similarity sanity check (related > unrelated). Decline/offline -> hash embedder,
   retry offered by `rcode doctor`.
4. **ruflo power pack (prompted, default yes on desktop, no in CI)**:
   - `npm install --prefix ~/.rcode/runtime/ruflo --omit=optional --ignore-scripts @claude-flow/cli@3.72.2`
     (pinned; `--ignore-scripts` first so nothing runs before we check).
   - Second, best-effort step: `npm install --prefix ... --no-save better-sqlite3 agentdb`
     (allow scripts only for this step, only if the user accepted "native speedups"); on failure
     keep sql.js mode. Run the agentdb postinstall patch explicitly
     (`node .../@claude-flow/cli/scripts/postinstall.cjs`) only if agentdb installed.
   - Health: spawn `node .../bin/cli.js mcp start` with `CLAUDE_FLOW_MCP_TOOLS=<subset>`,
     `CLAUDE_FLOW_MEMORY_PATH=~/.rcode/projects/<id>/ruflo`; expect `initialize` < 15 s,
     `tools/list` contains `memory_store` and `hooks_route`; round-trip
     `memory_store`/`memory_search`/`memory_delete` on `namespace:'rcode-healthcheck'`;
     `hooks_route {task:'rename variable x to y'}` returns a `primaryAgent`.
   - Ruflo must run under **Node**, not Bun (native addons + console patching). Resolve `node`
     on PATH (>=20); if absent, skip ruflo with `fix: install Node 20+`.
5. **ruvnet-brain (prompted, default no unless an install already exists)**:
   - Existing `~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs` -> reuse; no download.
   - Else explain size (~1.9 GB incl. models) and offer: `npx ruvnet-brain@<pinned>` with flags that
     skip Claude Code plugin wiring and the nightly scheduler (verify actual flag names in
     `bin/install.mjs` before shipping; if no "no-host" flag exists, download the release asset
     ourselves and run only the KB `npm i`).
   - Health: spawn MCP server, `search_ruvnet {query:'ruvector VectorDB insert search', k:2}`
     must return >=1 result within 60 s (first call warms models).
6. **Write** `~/.rcode/config.json` (enabled providers, pinned versions, consent receipts with
   timestamp) and `~/.rcode/health.json`; print a table:

```
rcode setup
  memory        ok        ruvector-native + onnx:all-MiniLM-L6-v2 (384d)   12 ms search
  orchestrator  ok        ruflo 3.72.2 (sql.js, 30/300 tools advertised)   1.8 s cold start
  knowledge     skipped   ruvnet-brain (enable: rcode setup --brain)
```

`rcode doctor` re-runs the health checks without installing; `rcode setup --repair` reinstalls
pinned versions; `rcode setup --offline` only does steps 1-2 with the hash embedder.

Graceful degradation matrix:

| Condition | Result |
|---|---|
| No network at all | Flat memory + hash embedder + local router; everything works, lower recall |
| ruvector native missing (e.g. linux-musl, win-arm64) | FlatMemory/rvlite + ONNX embedder (WASM) |
| No Node on PATH (Bun-only machine) | ruflo + brain disabled; core unaffected |
| ruflo crashes mid-session | circuit breaker -> LocalOrchestrator; one-line notice; auto-retry next session |
| Brain KB corrupt / stale | `search_ruvnet` soft error -> NullKnowledge; `rcode doctor` suggests `npx ruvnet-brain --doctor` |

### 4.5 Risks and mitigations

| Risk | Detail | Mitigation |
|---|---|---|
| Install size | ruflo-class trees ~700 MB; brain ~1.9 GB; model 90 MB | Never in rcode's `dependencies`; opt-in, private prefix, `rcode setup --uninstall <pack>` removes dirs; show sizes before download |
| Postinstall scripts | `@claude-flow/cli` postinstall mutates sibling `agentdb` files; transitive native builds (`better-sqlite3` node-gyp) | `--ignore-scripts` on first install; run only the known postinstall explicitly; isolated prefix so it cannot touch rcode's own `node_modules` |
| Floating versions / supply chain | ruflo plugin falls back to `npx @claude-flow/cli@latest`; brain depends on `@pacphi/agentic-kit@next`; ruvector has many optional `^` ranges | Pin exact versions in rcode, install with a lockfile we ship (`~/.rcode/runtime/ruflo/package-lock.json`), verify `npm audit signatures` where available, upgrade via `rcode setup --upgrade` only |
| Network / model downloads | HuggingFace downloads at first embed (ruvector, ruflo's transformers chain, brain models); GitHub release download for brain | Pre-warm in setup with consent; set explicit cache dirs; offline mode; timeouts |
| Telemetry | ruflo funnel endpoints (`funnel.ruv.io`), brain `kb/telemetry-ping.mjs` | ruflo telemetry is consent-gated (default off). Set `RUFLO_STATE_DIR` to an rcode-owned dir with no consent receipts; for brain, honour its off-switch (`$RUVNET_BRAIN_STATE_DIR`) and document it; rcode itself sends nothing |
| Auto-running hooks | Brain Option B runs 13 hook processes, one *blocking* write gate, a Stop hook that can force continuation; ruflo hooks write learning state | rcode calls providers through typed adapters only; no third-party shell hooks run unless `hooks.thirdParty: true`; blocking/continuation hooks disabled by default; every hook has a timeout and runs with `cwd` = project but no extra env secrets |
| Tool surface / prompt injection | 300+ ruflo tools incl. `agent_execute` (spends Anthropic credits), `terminal_*`, `http_fetch`, federation, `ruvnet_cli_run` (destructive) | Allowlist via `CLAUDE_FLOW_MCP_TOOLS`; never advertise `agent_execute`, `terminal_*`, `*federation*`, `ruvnet_cli_run`; MCP results treated as untrusted data and wrapped in a delimiter before reaching the model |
| Data written into the repo | ruflo default `.swarm/`, ruvector `.ruvector/intelligence.json`, brain claims cache-only | Redirect via `CLAUDE_FLOW_MEMORY_PATH` and rcode-owned paths; `rcode doctor` warns if `.swarm/` appears untracked |
| Bun incompatibility | `better-sqlite3` addon, ruflo console patching, agentdb native | Run ruflo/brain under Node subprocesses; in-proc only ruvector (NAPI probe + WASM ONNX) with fallback |
| Vector-space drift | switching embedder/model silently corrupts similarity | index filename keyed by embedder id; jsonl canonical log + `reindex` |
| Startup latency | ruflo cold start 1-3 s, brain first search up to 60 s | lazy spawn after first paint; keep warm for session; budgets per hook |
| Licensing | All three MIT | keep NOTICE entries; we do not vendor source |

---

## 5. Open questions to verify before implementation

1. Does `@ruvector/core`'s NAPI binary load under Bun 1.2.x on darwin-arm64 and linux-x64? (probe
   script in CI: `bun -e "const r=require('ruvector');console.log(r.getImplementationType())"`).
2. Exact `bin/install.mjs` flags for "KB only, no Claude Code plugin, no scheduler" — grep showed
   `--doctor`, `--uninstall`, `--pin`, `--json`, `--host-sync-only`, `--local`; a no-host flag was
   not confirmed.
3. Real v3 install size of `@claude-flow/cli@3.72.2` with and without optional deps (measure in a
   clean container; the 712 MB figure is v2.7.47).
4. Whether `hooks_route` output includes an explicit `tier` field in all code paths (the AgentDB and
   SONA branches shown in `hooks-tools.ts` return `routing/primaryAgent` but the tier is encoded in
   other branches); the adapter above derives it defensively.
5. Whether ruflo's sql.js-only mode supports HNSW search or falls back to brute force for
   `memory_search` (code mentions both `searchHNSWIndex` and brute-force paths).

## 6. Key source files

- `ruflo/v3/@claude-flow/cli/package.json` — bins, exports, deps, postinstall
- `ruflo/v3/@claude-flow/cli/bin/cli.js` — MCP auto-detect (l.152), `--tools` filter (l.38-60)
- `ruflo/v3/@claude-flow/cli/bin/mcp-server.js` — stdio server entry
- `ruflo/v3/@claude-flow/cli/src/mcp-client.ts` — tool registry, `callMCPTool`, `listMCPTools`
- `ruflo/v3/@claude-flow/cli/src/mcp-tools/{memory,hooks,agentdb,swarm,agent,task,embeddings}-tools.ts` — schemas
- `ruflo/v3/@claude-flow/cli/src/memory/memory-initializer.ts` — `.swarm/memory.db`, sql.js/better-sqlite3, MiniLM loader
- `ruflo/v3/@claude-flow/cli/scripts/postinstall.cjs` — agentdb patching
- `ruflo/v3/@claude-flow/cli/src/funnel/{consent,event-transport}.ts` — telemetry consent
- `ruflo/plugins/ruflo-core/{.mcp.json,scripts/mcp-launch.cjs,hooks/hooks.json,scripts/ruflo-hook.cjs}` — reference host wiring
- `ruvector/npm/packages/ruvector/src/index.ts` — backend selection, `VectorDB` wrapper
- `ruvector/npm/packages/ruvector/src/core/onnx-embedder.ts`, `src/core/onnx/loader.js` — WASM ONNX + model URLs
- `ruvector/npm/packages/ruvector/bin/{mcp-server,mcp-policy,intel-store}.js` — MCP server, profiles, storage
- `ruvector/npm/packages/core/index.js` — native platform loader
- `ruvector/npm/packages/rvlite/README.md` — WASM fallback DB
- `ruvector/examples/nodejs/README.md` — canonical write/reopen tutorial
- `ruvnet-brain/plugin/mcp/server.mjs`, `plugin/mcp/managed-cli-interface.mjs` — MCP contract
- `ruvnet-brain/plugin/hooks/{hooks.json,hook-contracts.json}`, `plugin/scripts/hook-shim.mjs` — hooks
- `ruvnet-brain/bin/install.mjs` — installer, release download, plugin wiring
- `~/.cache/ruvnet-brain/kb/package.json` — KB runtime deps
