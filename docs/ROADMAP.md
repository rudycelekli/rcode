# rcode roadmap

Distilled from the research in [`docs/research/`](research) (pi, oh-my-pi, jcode, goose, t3code, rea, RuvNet stack, agency-agents, claude-mem, openrig, agent-beacon, agentic-qe, open-ontologies, colibri, headroom).

## ✅ Shipped (alpha)

- Provider layer: Anthropic (official SDK, adaptive thinking/effort), OpenAI Chat + Responses, Gemini, native Ollama (full `num_ctx`), 10+ OpenAI-compatible providers, faux provider for tests; errors-are-data streams; retry/backoff; cost accounting incl. cache tokens.
- Agent loop: parallel shared tools / serialized exclusive tools, steering + follow-up queues, loop guard, argument shim for weaker models, length-stop safety, overflow → compact → retry.
- Tools: read (selectors, continuation hints, images), edit (multi-edit, fuzzy + re-indent, stale-file guard, CRLF/BOM), write, bash (process groups, background jobs), grep (ripgrep + fallback), glob, ls, todo, web_fetch, task (parallel subagents, depth 2), remember/recall/forget.
- Sessions: JSONL trees with persisted leaf, compaction entries, fork, rewind, resume; `/undo` of file edits per turn.
- Permissions: ask / auto-edit / full / plan, deterministic bash risk classifier, allow/deny rules, per-session approvals; trusted-project gating for project hooks/MCP.
- Extensibility: Claude-Code-compatible shell hooks, markdown slash commands, Agent Skills, agent definitions (`.claude/agents` compatible), MCP client (stdio + HTTP).
- Built-in library: 31 workflows (`/plan /goal /tdd /debug /review /court /verify /security /ddd /adr /sparc /research /premortem /refactor /perf /migrate /qe /flaky /testgen /impact /explain /onboard /docs /commit /pr /release /retro /skillify /ontology /repair /init`), 14 agents, 6 skills.
- Memory: hybrid BM25 + hashed-vector flat store, optional ruvector HNSW, per-prompt injection.
- RuvNet: auto-detected ruflo (allowlisted MCP + learning hooks) and ruvnet-brain (grounded context).
- Frontends: TUI (scrollback-native, differential live region, completions, paste collapsing), print/JSON, JSONL RPC with approvals, ACP server.

## P0 — next

- **Context efficiency** (context-efficiency.md): artifact store (`artifact://` instead of temp spill), type-aware output shaping (logs/grep/diff/JSON), stale-read masking via `transformContext`, `/context` breakdown with calibrated token counts, second cache breakpoint.
- **Memory v2** (ecosystem-a.md, after claude-mem): background observer capturing typed observations from tool events, budgeted session-start injection, progressive-disclosure tools (search → timeline → get), review-gated lesson promotion to skills.
- **Verified-done gate**: the agent can't claim completion after edits without a verification run (tests/typecheck) or an explicit "unverified" statement.
- **Git checkpoints** (t3code-style hidden refs) so `/undo` also covers bash-made changes.
- **OAuth / subscription login** for providers that officially support it; `rcode login` with browser flow.

## P1

- `repo_map` tool (tree-sitter WASM + PageRank) and outline mode for large reads.
- Session hibernation + daemon mode for many concurrent agents (jcode's architecture), file-touch bus across agents.
- Beacon-compatible JSONL telemetry (local only) and a rule-based PreToolUse guard.
- Guard modes (freeze-tests, no-skip, strict-tdd) as native policy, not just prompt text.
- Optional headroom proxy integration (base-URL), lazy MCP tool loading (`discover_tools`).
- Eval harness: replayable sessions, terminal-bench runner, deterministic graders, Wilson CIs.
- Cost router: cheap-model first for subagents / summaries with escalation.
- Sandboxing (macOS seatbelt / Linux bubblewrap) for bash in `auto-edit` mode.

## P2

- Declarative teams (openrig-style) and a durable task queue aligned with ruflo.
- Eval-gated harness evolution (only policy files, reviewable diffs).
- LSP diagnostics after edits; semantic code search over ruvector.
- Optional REA plugin preset for static analysis of user-owned binaries/bundles.
- Desktop/web front-end via the app-server protocol.
