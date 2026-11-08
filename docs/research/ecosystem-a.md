# Ecosystem A: agency-agents, claude-mem, OpenRig, agent-beacon

Status: research / design proposal
Date: 2026-11-07
Scope: what rcode should adopt from four agent-ecosystem projects, and how.

Reference checkouts (read-only, not installed or run):

| Repo | Upstream | License | Local path |
|---|---|---|---|
| agency-agents | msitarzewski/agency-agents | MIT ("Copyright (c) 2025 AgentLand Contributors") | `reference/agency-agents` |
| claude-mem | thedotmack/claude-mem v15.12.0 | Apache-2.0, NOTICE present ("Copyright 2026 Alex Newman") | `reference/claude-mem` |
| OpenRig | mvschwarz/openrig v0.7.x | Apache-2.0, no NOTICE file at repo root | `reference/openrig` |
| agent-beacon | Asymptote-Labs/agent-beacon | MIT | `reference/agent-beacon` |

All paths below are relative to `/Users/rudycelekli/Downloads/rcode/reference/` unless they start
with `rcode/` (meaning `/Users/rudycelekli/Downloads/rcode/`). Everything was read from source; where a
statement comes only from a README or doc page it is marked **[doc]**.

---

## 0. TL;DR

| Repo | What it really is | What rcode takes | How |
|---|---|---|---|
| agency-agents | ~283 persona prompts (markdown + frontmatter) across 20 "divisions", plus converters to 17 harness formats | ~16 engineering-relevant personas as built-in subagent types; the rest as an opt-in "agency pack" | **Bundle content** (adapted, kebab-cased, with rcode `tools`/`model` frontmatter) under `rcode/builtin/agents/`, MIT attribution in each file + `THIRD_PARTY_NOTICES.md` |
| claude-mem | Hook-driven background "observer" LLM that compresses tool events into typed XML observations, stores them in SQLite+FTS5 (+Chroma vectors), injects a budgeted timeline at SessionStart, and exposes 3-step progressive-disclosure search | The **mechanism**: observe → compress → store → index → inject → search; the observation schema; budget-fitting; privacy tag stripping; dedup; ACT-R reinforcement | **Reimplement natively** in `rcode/src/memory/` (in-process, no worker daemon), with ruvector as the vector index and a pure-TS fallback. Keep Apache NOTICE text for any ported code/prompt text |
| OpenRig | A daemon that runs *teams* of unmodified Claude Code/Codex sessions in tmux, with a YAML topology ("rig spec"), a durable SQLite work queue with mandatory closure reasons, restore-after-restart, MCP + ACP front doors | Ideas, not code: declarative team spec, durable handoff queue with closure reasons, `delegates_to`/`escalates_to` edges, role guidance "startup files", rosters | **Reimplement a small subset** as rcode "teams" (P1/P2). Do not depend on OpenRig; optionally ship a `rcode` runtime adapter recipe so OpenRig can host rcode seats |
| agent-beacon | Local-first telemetry for 20+ agent harnesses (OTel collector -> normalized JSONL), offline CEL threat-rule engine with 87 self-testing rules, review-gated "memory candidates" promoted to Agent Skills, cross-runtime session handoff | Normalized event log for rcode itself; threat-rule format as a permission/guard layer; review-gated learning loop (memory -> skill promotion); handoff brief export | **Emit Beacon-compatible events natively** (P1); **reimplement** a small CEL-free rule evaluator over the same YAML format for a curated rule subset (P1); adopt "candidate -> approve -> promote to SKILL.md" (P1) |

One-line recommendation: **ship a curated agency-agents roster as built-in subagents now, build
claude-mem-style memory natively on rcode's own hook bus with ruvector/pure-TS indexing, and borrow
beacon's review-gated promotion and event schema; treat OpenRig as an interop target, not a
dependency.**

---

## 1. agency-agents (msitarzewski/agency-agents, MIT)

### 1.1 What it is

A content library: "The Agency", a collection of specialist persona prompts. No runtime code beyond
bash converters/installers. 384 files; 283 are agent definitions.

### 1.2 Layout and key files

| Path | Purpose |
|---|---|
| `agency-agents/<division>/*.md` | Agent personas. Divisions: academic, design, engineering (66 files), finance, game-development, gis, healthcare, marketing (37), paid-media, product, project-management, research, sales, security (12), spatial-computing, specialized (~40), support, testing (9), plus subfolders under game-development |
| `agency-agents/divisions.json` | Source of truth for divisions: label, Lucide icon, brand color. CI (`scripts/check-divisions.sh`) fails if it drifts from disk |
| `agency-agents/tools.json` | Source of truth for the 17 target harnesses (claude-code, opencode, cursor, codex, gemini-cli, aider, windsurf, qwen, kimi, ...) with install contract: dest templates, render `format`, `installKind` (`per-agent` / `roster` / `plugin`) |
| `agency-agents/scripts/convert.sh` | Converts each persona into each harness format (e.g. `convert_opencode()` at line 311 emits `mode: subagent` + hex color). Aider/Windsurf get a single combined roster file |
| `agency-agents/scripts/install.sh` | Detects installed harnesses and copies converted files |
| `agency-agents/scripts/lint-agents.sh` | Frontmatter + fence linting |
| `agency-agents/scripts/check-agent-originality.sh` | Duplicate detector: entity-neutralised 8-word shingle overlap vs. the whole roster (WARN 20%, FAIL 40%; library median 0%, worst pair ~1.5%) |
| `agency-agents/strategy/` | "NEXUS" playbooks (phase-0 discovery .. phase-6 operate), runbooks (`scenario-startup-mvp.md`, `scenario-incident-response.md`), `coordination/handoff-templates.md`, `agent-activation-prompts.md`. No frontmatter; human/agent-readable process docs |
| `agency-agents/integrations/mcp-memory/README.md` | A prompt pattern: append a "Memory Integration" section telling the agent to `remember`/`recall`/`search`/`rollback` via any MCP memory server |
| `agency-agents/examples/workflow-*.md` | Multi-agent walkthroughs (landing page, startup MVP, with-memory) |

### 1.3 Agent file format (verified across all 283 files)

```yaml
---
name: Code Reviewer            # human title, spaces allowed (283/283)
description: Expert code reviewer who ...   # 283/283
color: purple                  # 283/283, named or hex
emoji: 👁️                      # 282/283
vibe: Reviews code like a mentor, not a gatekeeper.   # 281/283
tools: WebFetch, WebSearch, Read, Write, Edit         # only 17 files (marketing/paid-media)
author: ...                    # 10 files
---
```

Body structure is highly regular: "Your Identity & Memory" (role, personality, memory, experience),
"Core Mission", "Critical Rules You Must Follow", "Technical Deliverables" (with code examples),
"Workflow Process", "Communication Style", "Success Metrics". Sizes range ~76 lines
(`engineering/engineering-code-reviewer.md`) to ~535 (`security/security-appsec-engineer.md`).

Observations relevant to rcode:

- **No `tools` or `model` on 266/283 files.** Personas assume full tool access. rcode must add
  least-privilege tool lists itself (a reviewer should not get `write`/`edit`).
- **`name` is a display title**, not a slug. rcode's loader (`rcode/src/ext/resources.ts`
  `loadAgents()`) keys agents by `meta.name`, so "Code Reviewer" would become an awkward task
  `agent_type`. Convert to kebab-case slugs and move the title to `title:`.
- **Emoji-heavy headings** ("## 🧠 Your Identity & Memory"). Harmless, but they cost tokens on every
  subagent spawn; strip in conversion.
- **Many personas are framework-specific** (e.g. `engineering-senior-developer.md` is
  "Laravel/Livewire/FluxUI, Three.js"; `testing-test-automation-engineer.md` is Playwright/Cypress)
  or web-centric (`testing-reality-checker.md` demands screenshot evidence). Adapt wording when
  shipping as generic built-ins.
- **Quality of the engineering core is high and opinionated in the right direction for a coding
  agent**: `engineering-minimal-change-engineer.md` (smallest diff, no scope creep),
  `testing-reality-checker.md` (default "NEEDS WORK"), `engineering-codebase-onboarding-engineer.md`
  ("state only facts grounded in the code"), `security-ai-generated-code-auditor.md` (CWE-mapped,
  scan/fix/rescan).

### 1.4 What rcode should adopt

1. **Bundle a curated roster as built-in subagent types** (Section 5). Content is MIT, so copying
   and modifying is allowed provided the copyright and permission notice travel with "all copies or
   substantial portions". Put an attribution comment in each adapted file and the full MIT text in
   `rcode/THIRD_PARTY_NOTICES.md`.
2. **Offer the full library as an opt-in pack**, not built-in: `rcode agents add agency` (or
   `/agents install agency:<division>`) that fetches a pinned tag and converts on the fly. This keeps
   the binary small and avoids marketing/finance personas cluttering the `task` tool description,
   which is rebuilt from every agent's description (`rcode/src/tools/task.ts` line 30).
3. **Add rcode as a target in their converter ecosystem** (upstream contribution): a `tools.json`
   entry with `format: rcode`, `installKind: per-agent`, dest `~/.rcode/agents/{slug}.md`. Since
   rcode also reads `.claude/agents` (compat), the existing `claude-code` output already works today.
4. **Reuse the originality checker idea** for rcode's own roster/skill CI: shingle-overlap to stop
   near-duplicate built-ins.
5. **NEXUS runbooks as slash commands** (P2): `strategy/runbooks/scenario-incident-response.md` -> `/runbook incident`.
6. **Skip the "Memory Integration" prompt pattern**; rcode memory is native (Section 6).

---

## 2. claude-mem (thedotmack/claude-mem, Apache-2.0)

### 2.1 What it is

"Persistent memory for AI coding agents: the next session starts where the last one left off."
A Claude Code plugin (plus adapters for Codex, Cursor, OpenCode, Pi, Windsurf, Kimi, Gemini, ...)
that runs a **second, tool-less "observer" LLM** watching the primary session's tool events,
writing compressed, typed observations into SQLite, and injecting a compact timeline into future
sessions. ~172k lines of TS in `claude-mem/src` (the bulk is installers, sync, provider plumbing and
UI; the memory core is perhaps 10-15k lines).

Open-core: `docs/ip-boundary.md` says the engine, CLI, SDKs, adapters, MCP tools, schemas are
Apache-2.0; hosted cloud/team sync/enterprise features are reserved and not in the repo.

### 2.2 Architecture

```
Claude Code hooks (plugin/hooks/hooks.json)
  SessionStart ──> `claude-mem hook claude-code context`  ── GET context ──┐
  UserPromptSubmit ─> session-init (start/continue observer generation;     │
                       optional semantic injection)                          │
  PreToolUse(Read|Grep|Glob|Bash) ─> file-context (inject file's            │
                       observation timeline; may DENY big full-file Reads)   │
  PostToolUse / PostToolUseFailure (async) ─> observation ── POST ──┐       │
  Stop (async) ─> summarize        SubagentStop ─> subagent-stop     │       │
  SessionEnd (async) ─> session-end                                  v       │
                                                      Worker (Bun HTTP, localhost)
                                                        SessionManager: RAM buffer per session
                                                        Observer provider (Claude Agent SDK /
                                                          OpenRouter / OpenAI-compat / Gemini)
                                                        ResponseProcessor: parse XML -> rows
                                                        SessionStore (SQLite) + FTS5 triggers
                                                        ChromaSync (vector docs per field)
                                                        SearchManager (chroma | fts | hybrid)
                                                        MCP server (search/timeline/get_observations)
```

Key files:

| Concern | File |
|---|---|
| Hook registration | `claude-mem/plugin/hooks/hooks.json` |
| Hook handlers | `claude-mem/src/cli/handlers/{context,session-init,observation,file-context,summarize,subagent-stop,session-end}.ts` |
| Observer prompts | `claude-mem/src/sdk/prompts.ts` (536 lines) |
| Observer XML parsing | `claude-mem/src/sdk/parser.ts`, `src/sdk/output-classifier.ts` |
| "Modes" (prompt + schema packs) | `claude-mem/plugin/modes/code.json` (+30 locale variants, `law-study.json`, `email-investigation.json`) |
| Storage + migrations | `claude-mem/src/services/sqlite/SessionStore.ts` (5,285 lines) |
| FTS5 index + search | `claude-mem/src/services/sqlite/SessionSearch.ts` |
| Vector sync | `claude-mem/src/services/sync/ChromaSync.ts`; in-process embedder `src/services/vector/LocalEmbedder.ts`, models `src/services/vector/models.ts` |
| Search orchestration | `claude-mem/src/services/worker/SearchManager.ts` |
| Context injection | `claude-mem/src/services/context/{ContextBuilder,ContextBudget,ObservationCompiler,TokenCalculator}.ts`, renderers in `sections/` and `formatters/AgentFormatter.ts` |
| Progressive search contract | `claude-mem/src/shared/progressive-search.ts` |
| MCP tools | `claude-mem/src/servers/mcp-server.ts` |
| Privacy | `claude-mem/src/utils/tag-stripping.ts`, `src/utils/redaction.ts` |
| Dedup | `claude-mem/src/services/dedup/{nearDuplicate,tfidfCosine,idfVeto,normalize,idf}.ts` |
| Reinforcement ranking | `claude-mem/src/services/reinforcement/{strength,rank,persist}.ts` |
| Defaults | `claude-mem/src/shared/SettingsDefaultsManager.ts` (lines ~500-700) |
| Lifecycle contract | `claude-mem/docs/architecture/observer-lifecycle.md` |
| Search skill | `claude-mem/plugin/skills/mem-search/SKILL.md` |

### 2.3 Capture (hooks -> observer)

- `PostToolUse` and `PostToolUseFailure` fire `observation` **async** with matcher `*`
  (`hooks.json`). The handler (`src/cli/handlers/observation.ts`) filters: skipped tools
  (`CLAUDE_MEM_SKIP_TOOLS` default `ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`),
  untracked projects, subagent events (`should-skip-agent-observation.ts`), and **recursive memory
  tools** (`src/shared/memory-retrieval-tools.ts`: a memory search must never generate an
  observation about itself; an explicit `save_memory` is "already durable").
- The event is bounded (`boundObservationDispatch`, image payloads stripped) and handed to the
  worker with a **250 ms transport deadline, no disk outbox, no retry**.
- `docs/architecture/observer-lifecycle.md` is the most valuable design document in the repo. After
  a year of incidents (paid backlog replays after quota recovery, 1,200 surprise API calls), the
  contract is now: **live-only capture**. RAM buffer max 128 messages/session and 1,024/worker;
  unsent inputs expire after 5 minutes; on quota/auth failure the buffer is *discarded*, never
  replayed. "An outage can leave a gap in generated memory... Do not hide that gap by quietly
  replaying fragments." rcode should adopt this contract verbatim in spirit.

### 2.4 Compression (the observer prompt)

`src/sdk/prompts.ts` builds three prompt kinds from a mode file (`plugin/modes/code.json`):

1. **Init/continuation prompt**: `system_identity` ("You are a Claude-Mem, a specialized observer
   tool for creating searchable memory FOR FUTURE SESSIONS... You do not have access to tools"),
   `observer_role` (watch a different session live; silent by design), `recording_focus` (durable
   technical signal: what the system now does, what shipped, debugging findings), `skip_guidance`
   (skip re-confirmations, empty status checks, clean installs, empty searches), then the XML
   skeleton. Mode-only text comes **first** so providers can prompt-cache a byte-identical prefix
   (`observerInstructions()` comment). The user's request is appended as
   `<observed_from_primary_session><user_request>`.
2. **Per-tool-event prompt** (`buildObservationPromptParts`): `<what_happened>tool</what_happened>`,
   `<occurred_at>`, `<working_directory>`, `<parameters>` and `<outcome>`, each field capped at
   `OBS_PROMPT_FIELD_MAX_CHARS = 16_000` with a **60% head / 30% tail** slice and an explicit
   `<elided chars=... />` marker plus an instruction not to infer the elided range. Base64 images are
   stripped by content-block shape, not tool name. The model must return `<observation>` blocks or
   `<skip_summary reason="noise" />`; anything else is re-asked once, then discarded.
3. **Summary prompt** on `Stop`: root `<summary>` with `request, investigated, learned, completed,
   next_steps, notes`, or `<skip_summary reason="nothing durable" />`.

Observation schema (from `observationSkeleton()` and `code.json`):

```xml
<observation>
  <type>bugfix|feature|refactor|change|discovery|decision|security_alert|security_note|sensitive</type>
  <title/> <subtitle/>            <!-- subtitle max 24 words -->
  <facts><fact/>...</facts>        <!-- self-contained, no pronouns, include filenames/values -->
  <narrative/>                     <!-- what, how, why it matters -->
  <concepts><concept/>...</concepts>  <!-- 2-5 of: how-it-works, why-it-exists, what-changed,
                                           problem-solution, gotcha, pattern, trade-off -->
  <files_read><file/></files_read> <files_modified><file/></files_modified>
</observation>
```

Types and concepts are orthogonal dimensions (explicitly enforced in `concept_guidance`). The
observer runs on a cheap model by default (`CLAUDE_MEM_MODEL: 'haiku'`, with `$TIER:fast`/`$TIER:smart`
routing). HTTP providers split the prompt so instructions become the system message
(`splitFramingPrompt`, issue #3868: small models drift off-schema otherwise).

### 2.5 Storage and indexing

- SQLite tables (`SessionStore.ts` ~1279-1330 + later migrations): `sdk_sessions`
  (content_session_id, memory_session_id, project, platform_source, status), `observations`
  (type, title, subtitle, narrative, text, facts JSON, concepts JSON, files_read, files_modified,
  discovery_tokens, created_at_epoch, reinforcement_dates, title_norm_key), `session_summaries`,
  `user_prompts`, `observation_files`, `tool_uses` (raw I/O, fetched only on demand), dedup tables.
- **FTS5 external-content tables** `observations_fts(title, subtitle, narrative, text, facts, concepts)`
  and `session_summaries_fts(...)` kept in sync by AFTER INSERT/DELETE/UPDATE triggers
  (`SessionSearch.ts` lines 57-90, 250-300). FTS5 availability is probed at startup.
- **Vectors**: ChromaSync writes *one vector document per field*, not per row:
  `obs_<id>_narrative`, `obs_<id>_text`, `obs_<id>_fact_<i>`, title; summaries per section
  (`ChromaSync.ts` ~690-775). Results are mapped back to row ids and hydrated from SQLite. Newer code
  embeds in-process with transformers.js `Xenova/all-MiniLM-L6-v2` (384-d, mean pooling, chunk size 4,
  32 KB char cap per text) so vectors match Chroma's default (`LocalEmbedder.ts`, `models.ts`; e5
  multilingual candidates listed because MiniLM collapses CJK).
- **Search strategy** (`SearchManager.ts`): `chroma | fts | hybrid | filter_only` with explicit
  fallback reasons; date-less semantic search has an implicit **90-day recency window**
  (`CLAUDE_MEM_SEARCH_RECENCY_DAYS`).
- **Dedup** (`services/dedup/nearDuplicate.ts`): Tier-0 exact normalized-title match = silent merge;
  Tier-1 IDF-weighted cosine >= threshold *and* no rare-token veto = candidate stored for review
  (`observation_dedup_candidates`), never silently merged. Validated on 7,651 real rows; simhash was
  rejected as false-positive dominated.
- **ACT-R reinforcement** (`services/reinforcement/strength.ts`): each observation keeps up to 10
  re-confirmation dates; strength = sum of age^-0.5 (power-law decay). Off by default
  (`CLAUDE_MEM_REINFORCE_ALPHA: '0'`); when on, re-confirmed older notes can climb into the
  SessionStart window. Embedding-free.

### 2.6 Re-injection and token budgets

SessionStart (`startup|clear|compact`) prints a context block on stdout that Claude Code injects.
Rendered by `ContextBuilder` with `AgentFormatter.ts`:

```
# [project] recent context, <time>
Mode: Code (code)
Legend: 🎯session ●bugfix ◆feature ...
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill
Stats: 50 obs (2,310t read) | 41,200t work | 94% savings
### 2026-11-06
#11131 3:48p ◆ Added JWT authentication
...
<last session summary: request / completed / next_steps>
```

Budget mechanics (`ContextBudget.ts`):

- Hard limit `CONTEXT_OUTPUT_LIMIT = 10_000` **characters** (Claude Code silently replaces larger hook
  output with a preview stub), minus a 512-char banner reserve.
- **Fit by measuring, not by counting**: render, and while over budget drop the most expensive thing
  in a fixed order: full narratives -> last-session summary -> last assistant message -> halve
  session count -> halve observation count. Whole items only; header/footer and at least one
  observation always survive.
- Defaults: 50 observations, 0 full narratives, 10 sessions, last summary on, main agent only.
- Token economics (`TokenCalculator.ts`): `readTokens = chars/4` of title+subtitle+narrative+facts;
  `discovery_tokens` = what the primary session spent producing that knowledge; the header advertises
  "savings %" to make the value of reading memory instead of re-exploring visible to the model.

Two more injection points:

- **PreToolUse file-context** (`src/cli/handlers/file-context.ts`): before Read/Grep/Glob/Bash on a
  file >= 1,500 bytes, inject that file's observation timeline (max 15 rows, 10 paths, 3 s budget,
  fail-open). The "File Read Gate" *denies* full-file Reads >= 32 KB of code (not markdown/yaml/toml)
  steering the model to outline-first reading; their eval measured -32..-35% cost on a 49 KB file but
  +20% on Opus for a 19 KB file, hence the threshold.
- **UserPromptSubmit semantic injection** (`src/shared/semantic-context.ts`): prompts >= 20 chars get
  top-N (default 5, max 20) semantically similar observations as "## Relevant Past Work". Off by
  default ("experimental").

### 2.7 Progressive disclosure (retrieval)

The core idea: **never fetch bodies before filtering on an index**. Three MCP tools
(`mcp-server.ts` ~626-720) plus a skill (`plugin/skills/mem-search/SKILL.md`):

1. `search(query, limit<=100, project, type, obs_type, dateStart, dateEnd, orderBy)` -> table of
   `ID | Time | Type | Title | ~read tokens` (~50-100 tokens/row).
2. `timeline(anchor | query, depth_before, depth_after)` -> chronological neighbours (observations,
   summaries, prompts interleaved) around one hit.
3. `get_observations(ids[])` -> full bodies, batched, only for selected ids.
4. Escape hatch `get_tool_uses(ids)` for raw tool I/O, explicitly "rarely needed".

`progressive-search.ts` also defines a one-shot `dumb_search` with hard caps (limit 20, maxDetails
<= 5, depth <= 3, 64 KB response) and id/kind validation before disclosure. `save_memory` lets the
agent store a deliberate note.

### 2.8 Privacy

`tag-stripping.ts` removes balanced `<private>`, `<claude-mem-context>`, `<system-reminder>`,
`<system-instruction>`, `<persisted-output>` blocks before anything reaches the observer (prevents
re-ingesting injected memory = feedback loops, and lets users fence secrets). Unclosed tags in prose
are left alone. `redaction.ts` runs vendor-key regexes (AWS AKIA/ASIA, `sk-ant-`, `sk-`, ...) with an
opt-in generic set, and tells the observer what a redaction marker means.

### 2.9 What rcode should adopt (and what not)

Adopt (reimplement natively; see Section 6 for the design):

- Observation schema (type x concepts, facts/narrative/files) and the observer/summary prompt
  structure, including cacheable-prefix ordering, head/tail elision with markers, `skip` sentinel,
  one re-ask then discard.
- Live-only capture contract with bounded RAM buffer, expiry, discard-on-quota.
- Budget-fit-by-measuring with the fixed reduction order.
- Three-step progressive search tools + a `memory` skill describing the workflow.
- Privacy tag stripping, vendor-key redaction, recursion guard for memory tools.
- Tiered dedup (exact merge, IDF-cosine candidate, rare-token veto).
- ACT-R reinforcement as a ranking signal (cheap, embedding-free).
- Per-file timeline injection on `read` (inject only; gating optional and off by default).

Do not adopt:

- The separate worker daemon, port management, process supervisor, launcher, 17 installers, Chroma
  MCP subprocess, Postgres server runtime, cloud sync. rcode owns its agent loop, so the observer can
  be an in-process background task with direct DB access. This removes most of claude-mem's
  operational complexity (`port-reclaim.ts`, `process-registry.ts`, `worker-spawn-gate.ts` alone are
  >3k lines).
- Shell-hook transport. rcode calls the memory subsystem from its internal hook bus; external shell
  hooks (`rcode/src/hooks/shell-hooks.ts`) remain available so users can still run claude-mem itself.

Compatibility: since rcode already runs Claude-Code-style shell hooks, users can keep using
claude-mem unchanged. To make that work, rcode needs the missing events `PostToolUseFailure`,
`SubagentStop` and the `SessionStart` `source` matcher values (`startup|resume|clear|compact`), and
must honour the 10k-char stdout injection contract.

License: Apache-2.0 section 4. If rcode copies prompt text (e.g. adapted `code.json` wording) or code
(e.g. `ContextBudget.ts`, `strength.ts`), it must (a) include the Apache-2.0 license, (b) mark
modified files with a prominent change notice, (c) retain copyright/attribution notices, and (d)
reproduce the claude-mem NOTICE content ("Claude-Mem / Copyright 2026 Alex Newman / This product
includes software developed for the Claude-Mem project.") in rcode's own NOTICE. Reimplementing the
*mechanism* from this description does not trigger those obligations, but crediting it is good
practice. Recommendation: write rcode's prompts fresh, port the small algorithmic files with headers.

---

## 3. OpenRig (mvschwarz/openrig, Apache-2.0)

### 3.1 What it is

"A harness wraps a model. A rig wraps your harnesses." A local daemon that runs a **team of
unmodified coding agents** (Claude Code, Codex, Pi, Oh My Pi, plain terminal, scripted stub) as tmux
sessions, defined by a YAML topology, coordinated through a durable work queue, observable through a
TUI, CLI (`rig`, 87 commands), MCP server (18+ tools) and an ACP agent. Node 22/24, SQLite
(better-sqlite3, WAL), Hono HTTP on port 7433.

### 3.2 Architecture (from `openrig/ARCHITECTURE.md`, verified against tree)

| Package | Role |
|---|---|
| `openrig/packages/daemon` | Hono routes (`src/routes/`, 67 files), domain services (`src/domain/`, ~400 files), SQLite migrations (`src/db/migrations/`, 94), runtime adapters (`src/adapters/*-adapter.ts`), built-in specs (`specs/`), skills, context packs |
| `openrig/packages/cli` | `rig` CLI (`src/index.ts` `createProgram()`), MCP server (`src/mcp-server.ts`), daemon lifecycle |
| `openrig/packages/tui` | Terminal UI reading daemon projections + SSE `/api/activity/events`; control socket for agents |
| `openrig/packages/acp` | `openrig-acp`: exposes the whole team as one ACP agent (e.g. in Zed); a prompt becomes a queue row |
| `openrig/packages/ui` | React web UI (maintenance mode) |
| `openrig/packages/test-system` | Stub-agent scenario library: real CLI + daemon + tmux + SQLite with scripted agents, zero model cost; each scenario is a healthy/seeded-regression pair |

Core concepts and files:

- **Rig spec** (`packages/daemon/specs/rigs/launch/starter/rig.yaml`): `pods[] -> members[]` with
  `agent_ref`, `runtime` (claude-code/codex/...), `model`, `profile`, `cwd`, `startup.files` (role
  guidance delivered as first input); `edges[]` with kinds `delegates_to`, `spawned_by`,
  `can_observe`, `collaborates_with`, `escalates_to` (`docs/reference/edge-types.md`). Only
  `delegates_to`/`spawned_by` affect launch order (topological sort, cycles rejected);
  `delegates_to`/`escalates_to` drive queue escalation.
- **Agent spec** (`specs/agents/<area>/<role>/agent.yaml`): imports shared resources, `profiles`
  selecting skills/guidance/subagents/plugins/runtime_resources, `startup.files` with
  `orientation: role`. Shared skill set in `specs/agents/shared/agent.yaml` (TDD, systematic
  debugging, verification-before-completion, office-hours, requirements-writer, plan-review, ...).
- **Durable queue** (`db/migrations/024_queue_items.ts`, `025_queue_transitions.ts`,
  `domain/queue-*.ts`): `queue_items(qitem_id, source_session, destination_session, state, priority,
  tier, tags, blocked_on, handed_off_to/from, expires_at, chain_of_record, body, closure_reason,
  closure_target, claimed_at, last_nudge_*, last_heartbeat, resolution)` + an append-only transitions
  log. MCP tools `rig_queue_create/claim/unclaim/update/handoff/decide/list/show`.
- **Hot-potato contract** (`domain/hot-potato-enforcer.ts`): any transition to `done` *must* carry a
  closure reason from `handed_off_to | denied | canceled | no-follow-on | escalation | superseded`
  (`blocked_on` only for parked items). Enforced at the domain layer so every surface inherits it.
  This kills the classic multi-agent failure "work silently dropped".
- **Workflow specs** (`src/builtins/workflow-specs/*.yaml`: basic-loop, linear-build,
  gated-release, branched-remediation, conveyor): roles with `skill_refs` and `preferred_targets`,
  steps with `actor_role`, `objective`, `allowed_exits [handoff, waiting, failed]`, `next_hop`.
- **Runtime adapter interface** (`domain/runtime-adapter.ts`): `listInstalled`, `project` (write
  skills/files into the runtime's dirs), `deliverStartup`, `launchHarness`, `checkReady`. Terminal
  adapter is the smallest example.
- **Restore** (`domain/restore-orchestrator.ts`, `snapshot-*`, `resume-token-*`): after a crash or
  reboot, relaunch each seat and resume its native session by captured resume token.
- **Context monitor** (`domain/context-monitor.ts`, 30 s poll) + `claude-compaction-enforcer.ts`:
  tracks per-seat context usage and triggers compaction/handover.
- **Rosters** (`docs/reference/rosters.md`): JSON "who to involve for what and why" with
  `capabilities`, `engagement`, `use_when`, `why`, `caveat`; recommendation, not authority.
- **Context packs**: every skill and doc becomes a pack served by `rig context get`.
- Skills mirrored in three "edges" with digest checks (`scripts/mirror-skills.mjs`); public copy at
  `openrig/skills/_canonical/{core,pm,pods,process}/`.

### 3.3 What rcode should adopt

OpenRig solves "many long-lived *external* agent processes". rcode's subagents are in-process and
short-lived, so most of OpenRig (tmux, restore, permission drift, 94 migrations) is out of scope.
Worth taking:

1. **Mandatory closure reasons for delegated work** (P1). Make rcode's `task` tool result carry a
   structured `status: done | handed_off | blocked | denied | failed` plus `reason`, and reject
   subagent final reports without one (re-ask once). Cheap, high value for reliability.
2. **Declarative teams** (P2): `.rcode/teams/<name>.yaml` reusing OpenRig's vocabulary (`members`
   with `agent` = rcode agent type, `model`, `edges` with `delegates_to`/`escalates_to`). rcode's
   orchestrator agent reads it to decide who to delegate to. Keep it a subset so a later
   `rig`-compatible export is possible.
3. **Durable work queue for long-running/background agents** (P2): SQLite `work_items` + transitions,
   exposed as tools `queue_create/claim/handoff/close`. Only needed once rcode has background or
   multi-process agents (ruflo swarms); align with ruflo's task model rather than inventing a third.
4. **Scenario tests with stub runtimes** (P1, internal): copy the *practice* of healthy/seeded pairs
   with a scripted fake provider so multi-agent flows are tested without model spend.
5. **Interop** (P2): an rcode `RuntimeAdapter` contributed upstream (launch `rcode --headless`,
   project skills into `.rcode/skills`, readiness via RPC), so rcode can be a seat in an OpenRig team;
   and rcode's ACP server lets OpenRig-style "team as one ACP agent" be built on rcode too.

Skills under `openrig/skills/_canonical/process/` (TDD, systematic-debugging,
verification-before-completion) overlap obra/superpowers content; if rcode ships similar skills,
source them from their original upstream rather than from OpenRig copies. No code copying is
proposed, so no Apache obligations arise unless that changes (OpenRig has no NOTICE file; the LICENSE
and change notices would suffice).

---

## 4. agent-beacon (Asymptote-Labs/agent-beacon, MIT)

### 4.1 What it is

"Self-improving memory for coding agents", but architecturally it is **local-first endpoint
telemetry for AI agents**: capture every harness's activity (hooks, plugins, OTLP, or polling the
harness's session store), normalize it into one event model, write `runtime.jsonl`, run offline
detection rules, and on top of that offer a review-gated memory loop and cross-runtime session
handoff. Mostly Go (1,065 .go files under `cli/`, `pkg/`, `collector-builder/`), plus TS plugins for
TS harnesses.

### 4.2 Architecture and key files

| Concern | Path |
|---|---|
| CLI (`beacon`) | `agent-beacon/cli/beacon/` (Go module) |
| Hook adapter binary | `agent-beacon/cli/beacon-hooks/` |
| Event model + rule engine | `agent-beacon/pkg/asymptoteobserve/` (`Event`, `threatrules/`, `lens.go`) |
| Collector distribution | `agent-beacon/collector-builder/` (OTel collector + `beaconjson` exporter) |
| Harness plugins (TS) | `agent-beacon/plugins/{pi,opencode,cline,omp,omo,openclaw,prime}-beacon/` |
| Agent Skills | `agent-beacon/agent-skills/skills/beacon-{memory-recall,memory-distill,memory-promote,lens-create,session-handoff,trace-share}/SKILL.md` |
| Threat rules | `agent-beacon/rules/<category>/*.rule.yaml` (87 rules, 10 categories) |
| Rule spec | `agent-beacon/spec/threat-rules/{SPEC.md,FIELDS.md,VERSION}` |
| Lens spec | `agent-beacon/spec/lenses/SPEC.md` |
| Docs | `agent-beacon/docs/architecture/architecture.mdx`, `docs/concepts/{cross-harness-memory,session-handoff,beacon-skills}.mdx`, `docs/telemetry-schema/event-schema.mdx` |

Pipeline (`docs/architecture/architecture.mdx`): **collect** (loopback OTLP 4317/4318 + hook payloads)
-> **normalize** (stable `event.action` such as `prompt.submitted`, `tool.invoked`,
`command.executed`, `file.read`, `file.modified`, `mcp.tool_invoked`, `approval.requested/allowed`;
provenance `harness.collection_method` = hook|otlp|plugin|poll and `event.fidelity` =
observed|inferred) -> **store** (`~/.beacon/endpoint/logs/runtime.jsonl`, rotate at 10 MiB, keep 5)
-> **correlate** (`session.id`, `prompt.id` = one user turn and everything after it,
`gen_ai.tool.call.id`, content-derived `event.id` so hook and OTLP copies dedupe) -> **detect**
(`beacon scan`).

### 4.3 Concrete mechanisms

- **Harness plugin pattern** (`plugins/pi-beacon/src/beacon.ts`, 275 lines): subscribe to a minimal
  event set (`session_start, session_shutdown, input, tool_call, tool_result, user_bash,
  message_end`), structurally typed (no imports, loads anywhere), spawn the hook binary via argv
  (no shell), 2 s send timeout because the harness awaits handlers. Explicitly refuses to synthesize
  approval events the harness did not emit.
- **Threat rules** (`spec/threat-rules/SPEC.md`, v1.2): YAML with `id, version, title, severity,
  status, posture, taxonomy (owasp_llm, mitre_atlas), match` (one CEL expression over the event) **or**
  `correlation {scope: session, window: 120s, order: any|ordered, steps[]}`, `emit.reason`, and
  **inline `tests` with match/no_match fixtures** so every rule is self-verifying. Categories:
  agent-control, approval-abuse, context-exfiltration (e.g. `secret-read-then-egress`), credential-access,
  external-access, prompt-injection, resource-consumption, risky-command, sensitive-edit,
  source-control. Some regexes are very large (the v5 `secret-read-then-egress` encodes `.env.example`
  exclusions as a hand-unrolled negative lookahead because RE2 lacks lookaround).
- **Review-gated memory** (`docs/concepts/cross-harness-memory.mdx`): traces -> candidates (either an
  external evaluator scores `task_success`, `reusable_lesson`, `evidence_supported`; candidate only if
  success >= 0.50 and mean >= 0.60; or the agent drafts a lesson citing event IDs) -> human review ->
  approved memory in `memory.db` (kinds: `workflow, correction, debugging_pattern, gotcha,
  convention`), scoped per project (worktrees map to main checkout) -> reuse via MCP
  (`search_memory`, `get_memory`, `get_memory_context`) or **promotion to an Agent Skill**
  (`.agents/skills/<slug>/SKILL.md` with provenance frontmatter). "Nothing in this workflow runs from
  hooks." `beacon-memory-promote/SKILL.md` gives sound guidance: promote only repo-wide workflows and
  conventions; leave one-off gotchas in memory; suggest editing AGENTS.md instead of duplicating it.
- **Session handoff** (`docs/concepts/session-handoff.mdx`): read each runtime's *own* session store
  (read-only), export a Markdown brief (what was asked, changed, where it stopped), resume natively
  (`claude --resume`, `codex resume`) or in a different runtime; detached launch via a one-shot
  private launch spec when called from inside a non-TTY agent.
- **Lenses** (`spec/lenses/SPEC.md`): sandboxed single-file HTML trace views (rcode: skip).

### 4.4 What rcode should adopt

1. **Emit Beacon-compatible normalized events** from rcode's own loop (P1): a JSONL sink at
   `~/.rcode/telemetry/runtime.jsonl` with Beacon field names (`event.action`, `session.id`,
   `prompt.id`, `gen_ai.tool.call.id`, `command.command`, `file.path`, `harness.name=rcode`,
   `harness.collection_method=plugin`, `event.fidelity=observed`). Zero cost, and makes rcode
   first-class in Beacon, SIEMs and our own memory pipeline (the memory observer can consume the same
   event stream). Upstream: add an rcode runtime reader/plugin to Beacon.
2. **Rule-based guard layer** (P1): load `*.rule.yaml` in Beacon's format and evaluate single-event
   rules at `PreToolUse` time (posture `detect` -> warn; rcode-only `posture: block` -> deny via the
   permission system in `rcode/src/permissions/policy.ts`). CEL is heavy; either use a small CEL
   subset interpreter in TS (`==`, `&&`, `||`, `!`, `.matches()`, field access cover the corpus) or
   depend on a JS CEL implementation behind a lazy import. Ship a curated 15-20 rule subset
   (credential-access, risky-command, context-exfiltration) as built-in, with MIT attribution; run the
   rules' own `tests` in rcode CI to prove conformance. Correlation rules (session window) are P2.
3. **Review-gated learning loop** (P1, part of memory): rcode memory has an auto tier (observations)
   and a curated tier (lessons). `/memory review` shows candidates; approval writes a lesson;
   `/memory promote <id>` renders `.rcode/skills/<slug>/SKILL.md` (and optionally `.agents/skills`)
   with provenance frontmatter. Promotion guidance copied in spirit from `beacon-memory-promote`.
4. **Handoff brief** (P1): `rcode handoff export [session]` writes a Markdown brief from rcode's JSONL
   session tree and memory summary; `rcode handoff import <brief>` seeds a new session (reading
   Claude Code/Codex stores read-only is P2).

License: MIT. Copying rules or skill text requires the MIT notice; list in `THIRD_PARTY_NOTICES.md`
and keep `id`/`version` fields so rules can be re-synced.

---

## 5. Built-in agent roster proposal for rcode

### 5.1 Format

rcode loads agents from `builtin/agents/` -> `~/.rcode/agents` -> `~/.claude/agents` ->
`.claude/agents` -> `.rcode/agents` (later wins; `rcode/src/ext/resources.ts`). Proposed frontmatter
(superset of Claude Code's, so files stay portable):

```markdown
---
name: code-reviewer                 # kebab slug = task agent_type (required)
title: Code Reviewer                # display name (optional)
description: Reviews diffs for correctness, security, maintainability and tests; returns
  prioritized findings (blocker/suggestion/nit). Read-only. Use after non-trivial changes.
tools: [read, grep, glob, bash]     # least privilege; omitted = all tools
model: smart                        # inherit | fast | smart | <provider/model-id>
max_turns: 40                       # optional budget
memory: read                        # none | read | write  (access to memory tools)
source: agency-agents@<commit>:engineering/engineering-code-reviewer.md
license: MIT (c) 2025 AgentLand Contributors; adapted for rcode
---
<body: identity, mission, rules, workflow, output contract>
```

Conventions:

- `model` tiers resolve via config (`models.fast`, `models.smart`) so the roster is provider-agnostic.
- Every body ends with an **Output contract** section (what the final report must contain, plus the
  closure `status` from Section 3.3) because subagent output is the only thing the parent sees.
- Strip emoji headings and framework-specific examples; keep the critical rules verbatim where they
  are strong (minimal-change, reality-checker).
- The loader needs three small changes: accept `title`, `max_turns`, `memory`; map `tools` names
  case-insensitively (`Read` -> `read`) so imported Claude-Code agents work; treat
  `description` as the routing text (it is truncated to 400 chars already).

### 5.2 Core roster (built-in, P0)

| Agent type | Source (agency-agents) | Tools | Model | Notes |
|---|---|---|---|---|
| `general` | rcode original | all | inherit | Already implicit in `task.ts` |
| `explore` | rcode original, prompt borrows from `engineering/engineering-codebase-onboarding-engineer.md` ("facts grounded in code") | read, grep, glob, bash(read-only) | fast | Fan-out search; returns locations, not dumps |
| `planner` | `engineering/engineering-software-architect.md` (112 lines) | read, grep, glob, web_fetch | smart | Plan with files, trade-offs, steps; no edits |
| `minimal-change` | `engineering/engineering-minimal-change-engineer.md` (207) | read, grep, glob, edit, write, bash | inherit | The default implementer persona for bug fixes |
| `code-reviewer` | `engineering/engineering-code-reviewer.md` (76) | read, grep, glob, bash | smart | Blocker/suggestion/nit; one complete pass |
| `reality-checker` | `testing/testing-reality-checker.md` (249), de-webbed; evidence rules from `testing/testing-evidence-collector.md` | read, grep, glob, bash | smart | Verification gate: default NEEDS WORK, demands run output as evidence |
| `test-engineer` | `testing/testing-test-automation-engineer.md` (196), generalized beyond Playwright | read, grep, glob, edit, write, bash | inherit | Writes/fixes tests, de-flakes |
| `security-auditor` | `security/security-ai-generated-code-auditor.md` (207) + checklist from `security/security-appsec-engineer.md` | read, grep, glob, bash, web_fetch | smart | CWE-mapped findings; scan/fix/rescan loop only on request |
| `debugger` | rcode original (systematic debugging), with incident discipline from `engineering/engineering-incident-response-commander.md` | read, grep, glob, bash, edit | smart | Hypothesis -> evidence -> fix |
| `tech-writer` | `engineering/engineering-technical-writer.md` (393, trimmed) | read, grep, glob, edit, write | fast | Docs, READMEs, changelogs |
| `onboarding` | `engineering/engineering-codebase-onboarding-engineer.md` (173) | read, grep, glob, bash | fast | "Explain this codebase/module" |
| `researcher` | `research/research-synthesist.md` (136) | read, grep, glob, web_fetch | smart | Source evaluation, evidence-weighted synthesis |

12 agents keeps the `task` tool description short (~1.2k tokens).

### 5.3 Extended roster (built-in but hidden from the `task` description until enabled, P1)

Exposed via `/agents` and `agents.enabled` config; the `task` tool lists only enabled ones.

| Agent type | Source | Tools | Model |
|---|---|---|---|
| `orchestrator` | `specialized/agents-orchestrator.md` (366; PM -> Arch -> Dev<->QA loop) | read, grep, glob, task, todo | smart |
| `frontend-dev` | `engineering/engineering-frontend-developer.md` | all | inherit |
| `backend-architect` | `engineering/engineering-backend-architect.md` | read, grep, glob, web_fetch | smart |
| `devops` | `engineering/engineering-devops-automator.md` | all | inherit |
| `sre` | `engineering/engineering-sre.md` + incident-response-commander | read, grep, glob, bash | smart |
| `db-optimizer` | `engineering/engineering-database-optimizer.md` | read, grep, glob, bash | smart |
| `git-workflow` | `engineering/engineering-git-workflow-master.md` | read, bash | fast |
| `perf-benchmarker` | `testing/testing-performance-benchmarker.md` | read, grep, glob, bash, edit | inherit |
| `api-tester` | `testing/testing-api-tester.md` | read, grep, glob, bash, write | inherit |
| `a11y-auditor` | `testing/testing-accessibility-auditor.md` | read, grep, glob, bash | smart |
| `secrets-engineer` | `security/security-secrets-credential-engineer.md` | read, grep, glob, bash | smart |
| `prompt-engineer` | `engineering/engineering-prompt-engineer.md` | read, edit, write, web_fetch | smart |
| `dx-tooling` | `engineering/engineering-developer-tooling-engineer.md` | all | inherit |
| `ux-architect` | `design/design-ux-architect.md` | read, write, web_fetch | smart |
| `product-manager` | `product/product-manager.md` | read, write, web_fetch | smart |

### 5.4 Agency pack (opt-in, P1)

`rcode agents add agency [--division engineering,testing]` downloads a pinned release tarball of
agency-agents, converts on the fly (slugify name, map `tools` if present, drop color/emoji/vibe into
`title`/`meta`), writes to `~/.rcode/agents/agency/`, and records the source commit for updates.
Non-engineering divisions (marketing, sales, finance, healthcare, gis, game-development) stay in the
pack only.

Plumbing: a `/agents` command (list, enable/disable, show source/license, new from template) and CI
that lints frontmatter and requires `source`/`license` on every adapted built-in.

---

## 6. Memory design recommendation ("rmem")

Goal: claude-mem's capture/compress/inject/progressive-search mechanism, natively in rcode, with
ruvector for vectors when available and a pure-TS fallback that always works under `bun build --compile`.

### 6.1 Components (`rcode/src/memory/`)

```
agent loop / hook bus (in-process events)
   │ tool_result, prompt, stop, subagent_stop, compact, session_end
   v
capture.ts      filter (skip tools, recursion guard, <private> strip, redaction, size bounds)
   v
observer.ts     bounded RAM queue per session (max 128, 5 min TTL), batches events,
                calls models.fast with cacheable observer prefix; discard on quota/auth error
   v
parse.ts        XML -> Observation | Summary | skip; one re-ask on schema drift, then drop
   v
store.ts        bun:sqlite: sessions, observations, summaries, prompts, tool_uses(raw, capped),
                lessons, files; FTS5 external-content + triggers
   v
index/          VectorIndex interface
                 ├─ ruvector.ts   (VectorDB + OnnxEmbedder, lazy import, optional dep)
                 ├─ flat.ts       (pure TS: Float32Array matrix, cosine, int8 quantized, persisted)
                 └─ hashed.ts     (no-model fallback: feature-hashed TF-IDF vectors, 512-d)
   v
retrieve.ts     hybrid search: FTS5 BM25 + vector kNN, Reciprocal Rank Fusion, recency window,
                ACT-R strength, type/concept/project filters
inject.ts       SessionStart/compact block, per-prompt semantic block, per-file timeline;
                budget-fit-by-measuring
tools.ts        memory_search, memory_timeline, memory_get, memory_save, memory_review
promote.ts      lesson -> SKILL.md (beacon-style provenance)
```

The memory subsystem subscribes to rcode's internal events, not shell hooks, so there is no daemon,
no port, no process supervision. Shell hooks remain for third-party memory tools.

### 6.2 Data model

```sql
CREATE TABLE mem_sessions(id TEXT PRIMARY KEY, project TEXT, cwd TEXT, started_at INT,
  ended_at INT, parent_id TEXT, harness TEXT DEFAULT 'rcode');
CREATE TABLE observations(id INTEGER PRIMARY KEY, session_id TEXT, project TEXT,
  type TEXT, title TEXT, subtitle TEXT, narrative TEXT, facts TEXT /*json*/,
  concepts TEXT /*json*/, files_read TEXT, files_modified TEXT, prompt_id TEXT,
  discovery_tokens INT, created_at INT, reinforcement_dates TEXT, title_norm TEXT,
  superseded_by INT, agent TEXT /*main|subagent type*/);
CREATE TABLE summaries(id INTEGER PRIMARY KEY, session_id TEXT, prompt_id TEXT, request TEXT,
  investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at INT);
CREATE TABLE lessons(id INTEGER PRIMARY KEY, project TEXT, kind TEXT /*workflow|correction|
  debugging_pattern|gotcha|convention*/, title TEXT, body TEXT, evidence TEXT /*obs ids*/,
  state TEXT /*candidate|approved|rejected|superseded*/, promoted_path TEXT, created_at INT);
CREATE TABLE vec_meta(doc_id TEXT PRIMARY KEY, row_kind TEXT, row_id INT, field TEXT,
  model_id TEXT, dims INT);
CREATE VIRTUAL TABLE observations_fts USING fts5(title, subtitle, narrative, facts, concepts,
  content='observations', content_rowid='id');
```

- Location: `~/.rcode/memory/memory.db` (global, project column) plus optional per-project export.
  Project identity = git root of main worktree (claude-mem `utils/worktree.ts` and Beacon both map
  worktrees to the main checkout).
- `prompt_id` ties observations to the user turn (Beacon correlation model) and to rcode's JSONL
  session tree node, so `memory_timeline` can jump into the transcript.
- `model_id` is stored per vector (claude-mem's `LocalEmbedder.modelId` includes repo/dtype/pooling/
  maxTokens) so a model change triggers re-embed rather than silent mixed spaces.

### 6.3 Vector strategy: ruvector with pure-TS fallback

Per `docs/research/ruvnet-integration.md`, ruvector offers `VectorDB` (native NAPI HNSW, prebuilt per
platform) and `OnnxEmbedder` (bundled ONNX WASM, MiniLM 384-d, model downloaded on first use).

`VectorIndex` interface:

```ts
interface Embedder { id: string; dims: number; embed(texts: string[], kind: "query"|"passage"): Promise<Float32Array[]> }
interface VectorIndex {
  upsert(docs: { id: string; vector: Float32Array; meta: Record<string, string|number> }[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(q: Float32Array, k: number, filter?: { project?: string; kind?: string }): Promise<{ id: string; score: number }[]>;
  stats(): { count: number; backend: string; embedder: string };
}
```

Selection at startup (`memory.backend: auto | ruvector | flat | hashed | off`):

1. `auto` tries `await import("ruvector")`; if `isNative()` and the platform binary loads, use
   ruvector `VectorDB` for the index. Embedder: ruvector `OnnxEmbedder` if the model is cached,
   otherwise schedule a background download and use `hashed` until ready (no first-run stall).
2. Else `flat`: pure-TS brute-force cosine over an in-memory `Float32Array` (int8-quantized on disk
   in a sidecar file or a BLOB column). Brute force is fine up to ~100k vectors (384-d x 100k x 1 byte
   = 38 MB, a scan is ~10-20 ms in Bun). Embedder: transformers.js (`@huggingface/transformers`,
   pure WASM) when installed, else `hashed`.
3. `hashed`: feature-hashing of word unigrams+bigrams with stored IDF into 512 dims; no model, no
   download, deterministic. Quality well below MiniLM but strictly better than FTS-only for rewording,
   and it is the guaranteed floor for compiled binaries and air-gapped machines.
4. Granularity follows claude-mem: one vector doc per `title`, `narrative`, each `fact`, and each
   summary section; results are grouped by row and the best field score is used.
5. `rvlite` (WASM, ~850 KB) can slot in later behind the same interface.

Hybrid ranking: `score = RRF(bm25_rank, vector_rank, k=60) * (1 + alpha * actr_strength) * recency`,
with claude-mem's 90-day implicit recency window for date-less queries and `alpha` default 0.2
(claude-mem ships it off; rcode can afford it on because strength is computed from dates only).

With the ruflo power pack active, rmem mirrors approved lessons (never raw observations) into ruflo
`memory_store` namespace `rcode-lessons` so swarm agents share curated knowledge.

### 6.4 Capture rules

- Events: `tool_result` (success and failure), `user_prompt`, `assistant_stop`, `subagent_stop`,
  `pre_compact`, `session_end`. Subagent tool events are captured with `agent=<type>` but excluded
  from SessionStart injection by default (claude-mem `MAIN_AGENT_ONLY=true`).
- Skip: `todo`, memory tools themselves (recursion guard), `task` envelopes (the subagent's own
  events are already captured), read-only calls whose output is empty or "not found".
- Bound each field at 16k chars with 60/30 head/tail and `<elided chars=N/>`; strip base64 images.
- Strip `<private>...</private>` and rcode's own injected memory blocks (`<rcode-memory>`) and
  `<system-reminder>` before the observer sees text; run vendor-key redaction.
- Live-only: queue max 128/session, TTL 5 min, discard on provider quota/auth errors, never replay.
  Concurrency 1 observer call per session; batch up to N events per call (cheaper than claude-mem's
  one-event-per-turn streaming conversation, and it keeps rcode stateless between calls).
- Observer model: `memory.model` default `fast` tier; disabled entirely with `memory.observer: off`
  (then only summaries at Stop, or nothing). `rcode memory cost` reports spend.
- Offline mode without any LLM: a deterministic "mechanical observation" from tool metadata
  (`files_modified` from edit/write, commands run, test pass/fail) so memory is never empty.

### 6.5 Injection and budgets

Token budgets in tokens (rcode controls injection directly, so no 10k-char hook limit), with
character fallback estimate 4 chars/token:

| Injection point | Default budget | Content |
|---|---|---|
| Session start / after `/clear` / after compaction | 1,500 tokens | Header + legend, last summary (request/completed/next_steps), up to 50 observation index rows (`#id time type title`), approved lessons for this project (titles only), fetch hint |
| Per user prompt (semantic) | 600 tokens, top 5, prompts >= 20 chars, score threshold | "Relevant past work" index rows; narratives only if `memory.inject.format=narrative` |
| Before `read` of a file with history | 300 tokens, max 10 rows, files >= 1.5 KB | That file's observation timeline |
| Subagent preamble | 400 tokens | Lessons + top 3 relevant observations for the delegated prompt |

All rendered through one `fitToBudget(items, config, render, limit)` port of claude-mem's
`ContextBudget.ts` reduction order: drop narratives -> drop last summary -> halve sessions -> halve
observations; whole items only. Injected text is wrapped in `<rcode-memory>` so it is stripped from
capture (no feedback loop) and identifiable by compaction. The header shows "N obs, ~X tokens read,
~Y tokens of original work" to signal value.

Compaction tie-in: rcode's compaction (`rcode/src/session/compaction.ts`) should consume the latest
summaries instead of re-summarizing raw turns, and re-inject the session-start block afterwards
(claude-mem hooks `SessionStart:compact` for this).

### 6.6 Retrieval tools (progressive disclosure)

| Tool | Returns | Caps |
|---|---|---|
| `memory_search(query, type?, concept?, since?, until?, project?, limit=20)` | Index rows `#id date type title (~tokens)` | limit <= 50; no bodies |
| `memory_timeline(anchor? \| query?, before=3, after=3)` | Chronological neighbours: observations, summaries, prompts | depth <= 10 |
| `memory_get(ids[])` | Full bodies (facts, narrative, files) | <= 20 ids, 16 KB response |
| `memory_save(title, body, kind?)` | Creates an approved lesson (explicit, user/agent intent) | |
| `memory_review(action, id?, text?)` | List/approve/reject/supersede candidates | |

Plus a built-in skill `builtin/skills/memory/SKILL.md` describing "search -> timeline -> get, never
fetch before filtering" and when to save. Also expose the same tools via rcode's MCP server so other
harnesses can query rcode memory.

### 6.7 Curation, dedup, promotion

- Dedup at insert: exact normalized title within project -> reinforce existing row (append today to
  `reinforcement_dates`) instead of inserting; IDF-cosine >= 0.8 with no rare-token veto -> keep both,
  mark as candidate pair for `/memory review`. Port `services/dedup/*` (small, Apache, add headers).
- Lessons: candidates come from (a) the Stop summary's `learned` section when it contains a
  correction or repeated failure, (b) `memory_save`, (c) `/memory distill <session>`, where the smart
  model drafts lessons citing observation ids (Beacon's agent-drafted path). Nothing auto-approves.
- `/memory promote <lesson>` writes `.rcode/skills/<slug>/SKILL.md` with frontmatter
  `name, description, metadata: { source: rcode-memory, lesson_id, evidence, created }`, following the
  Beacon rule of thumb: promote only repo-wide workflows/conventions; suggest AGENTS.md edits for
  things that duplicate it.
- `/memory forget <id|query>`, retention (`memory.retention_days`, default unlimited), and a
  `memory export --jsonl` for portability.

### 6.8 Privacy and safety defaults

Local only; no network except the configured observer model provider. `<private>` fencing documented
in `/help memory`. `.rcode/memory.ignore` globs (e.g. `**/.env*`) whose tool events are never captured.
Observation type `sensitive` is never injected automatically. Memory is per-project by default;
cross-project search is opt-in (`project: "*"`).

---

## 7. Licensing and attribution plan

| Source | Use in rcode | Obligation | Action |
|---|---|---|---|
| agency-agents (MIT) | Adapted persona text in `builtin/agents/*.md`; optional pack download | Include copyright + permission notice with substantial portions | Header line in each adapted file (`source`, `license` frontmatter); full MIT text under "agency-agents" in `rcode/THIRD_PARTY_NOTICES.md`; README credit |
| claude-mem (Apache-2.0) | Mechanism reimplemented; optionally port `ContextBudget.ts`, `reinforcement/strength.ts`, `dedup/*` | Sec. 4: license copy, change notices on modified files, retain notices, include NOTICE contents | `rcode/NOTICE` with claude-mem NOTICE text; `// Portions adapted from claude-mem (Apache-2.0), modified by rcode contributors` headers; Apache text in `THIRD_PARTY_NOTICES.md`. rcode itself stays MIT (Apache-2.0 code can be included in an MIT project; the ported files remain Apache-2.0 licensed) |
| OpenRig (Apache-2.0) | Concepts only (team spec vocabulary, closure reasons) | None for ideas | Credit in docs; if any code/spec text is copied, same treatment as claude-mem (no NOTICE file to reproduce) |
| agent-beacon (MIT) | Curated `*.rule.yaml` subset, event field names, skill wording ideas | MIT notice for copied rules | Keep rule `id`/`version`; MIT text in `THIRD_PARTY_NOTICES.md`; `builtin/rules/README.md` with upstream commit |
| Trademarks | "Claude-Mem", "Beacon", "OpenRig", "The Agency" | Apache/MIT grant no trademark rights | Do not name rcode features after them; say "inspired by" |

---

## 8. Prioritized feature list

### P0 (first release)

1. **Built-in core roster** (12 agents, Section 5.2) in `builtin/agents/`, adapted from agency-agents
   with least-privilege `tools` and `model` tiers; loader accepts `title`, case-insensitive tool names.
2. **rmem capture + store**: in-process observer on the fast model, live-only bounded queue,
   observation/summary XML schema, privacy stripping + redaction, SQLite + FTS5
   (`rcode/src/memory/{capture,observer,parse,store}.ts`).
3. **Session-start injection with budget fitting** (1,500 tokens, reduction order) and re-injection
   after compaction/clear.
4. **Progressive-disclosure tools** `memory_search` / `memory_timeline` / `memory_get` / `memory_save`
   plus `builtin/skills/memory/SKILL.md`.
5. **Pure-TS vector fallback** (`hashed` + `flat`) so semantic search works in the compiled binary
   with zero downloads; hybrid RRF ranking.
6. **Hook-compat gaps**: add `PostToolUseFailure`, `SubagentStop`, `SessionStart` source matchers
   (`startup|resume|clear|compact`) to `rcode/src/hooks/shell-hooks.ts` so claude-mem and Beacon hook
   integrations work unmodified.
7. **NOTICE + THIRD_PARTY_NOTICES** files and per-file attribution.

### P1

1. **ruvector backend** (`VectorDB` + `OnnxEmbedder`) behind `VectorIndex`, background model download,
   re-embed on model change.
2. **Per-prompt semantic injection** and **per-file timeline injection** on `read` (inject only).
3. **Dedup tiers + ACT-R reinforcement** ranking; `/memory review`, `/memory forget`, `/memory stats`.
4. **Lessons tier + promotion to SKILL.md** (Beacon-style, review-gated); `/memory distill`.
5. **Structured subagent closure** (`status` + `reason`, re-ask once) in `rcode/src/tools/task.ts`.
6. **Extended roster** (15 agents, hidden until enabled) + `/agents` command + **agency pack**
   installer with pinned source.
7. **Beacon-compatible JSONL telemetry sink** (`~/.rcode/telemetry/runtime.jsonl`), `prompt.id`
   correlation; upstream an rcode reader to agent-beacon.
8. **Rule guard**: Beacon threat-rule YAML loader, single-event evaluation at `PreToolUse`
   (warn/deny), curated 15-20 built-in rules with their fixtures run in CI.
9. **Handoff export/import** (Markdown brief from session tree + summaries).
10. **Stub-provider scenario tests** for multi-agent flows (OpenRig practice).
11. **Mechanical observations** fallback when the observer model is disabled or unavailable.

### P2

1. **Declarative teams** (`.rcode/teams/*.yaml`, OpenRig vocabulary: members, `delegates_to`,
   `escalates_to`) driving the `orchestrator` agent.
2. **Durable work queue** with mandatory closure reasons for background/multi-process agents, aligned
   with ruflo's task model.
3. **OpenRig interop**: rcode `RuntimeAdapter` upstream; "team as one ACP agent" on rcode's ACP server.
4. **Correlation (session-window) threat rules** and a CEL engine.
5. **Cross-harness import**: read Claude Code / Codex session stores (read-only) into rmem and handoff.
6. **ruflo mirroring** of approved lessons into a shared namespace; ruvnet-brain as a read-only
   knowledge source in `memory_search` results (tagged by source).
7. **Memory modes** (claude-mem "modes": alternative type/concept vocabularies and observer prompts
   for non-code work, plus locale variants).
8. **Runbooks as slash commands** from agency-agents `strategy/runbooks/` (incident, MVP).
9. **Originality/shingle CI** for built-in agents and skills.

---

## 9. Risks and open questions

- **Observer cost/privacy**: every tool call feeds a fast-model call. Batch, skip noise, show cost,
  allow `observer: off` or a local model; make the default explicit at first run.
- **Schema drift on small models**: prefer provider JSON/structured output; XML as portable fallback.
- **Injection noise**: claude-mem injects titles only by default; start there and measure with evals.
- **Persona bloat**: trim adapted agency bodies to <=150 lines (they cost tokens on every spawn).
- **CEL subset mismatch**: run every shipped rule's inline `tests` in rcode CI.
- **Global vs. project DB**: offer `rcode memory export --project` for team sharing.
