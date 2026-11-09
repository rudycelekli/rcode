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
- Context efficiency: content-addressed artifact store (`artifact://`), type-aware output shaping (errors + head/tail, JSON condensing, progress-bar cleanup), stale-output masking, cache-stable prompt layout, two rolling cache breakpoints.
- Browser & desktop: `browser` (agent-browser) and `desktop` (agent-desktop) tools with per-action permissions and secret guards; skills; setup installs them.
- Remote: `rcode gateway` — Telegram (pairing, approval buttons, streaming edits) + token-protected web UI, per-conversation sessions, chat commands, schedules, launchd/systemd service.
- Safety nets: verified-done gate (agent must verify or admit it didn't), git checkpoints before every prompt (`/undo` restores bash-made changes too, index untouched).
- Memory v2: background lesson capture from corrections / recovered errors / busy turns, session-start memory block, `/forget`.
- `/context` breakdown (system sections, per-tool schema cost, conversation by type); lazy MCP loading (`mcp_search`/`mcp_call`) above 30 MCP tools.
- Repo map: zero-dependency symbol extraction (~15 languages) + personalized PageRank over the reference graph with query relevance; `read` outline mode and "definitions further down" hints.
- Memory v3: `/promote` memories into AGENTS.md conventions (shareable via git); opt-in on-device MiniLM embeddings through ruvector with cached vectors.
- Gateway round 2: Slack (Socket Mode) and Discord (Gateway + buttons) channels, owner vs. user roles, one-time pairing links + terminal QR, chat-managed jobs (/every, /daily, /jobs, /unjob) that can't spawn jobs, single-instance lock, `gateway users|revoke`.
- Sandbox: bash runs under macOS Seatbelt / Linux bubblewrap (project-only writes, no network) outside full mode; `unsandboxed:true` escape needs approval; sandboxed commands skip approval in ask mode.
- Guard modes enforced in code: freeze-tests, no-skip, strict-tdd (`/guard`, config `guards`).
- Cost router: `fast`/`smart` tiers for subagents and background work. A failed fast attempt is retried once on the main model, with the failed report attached.
- Turn receipts: hash-chained proof of files, commands, verdict (`verified` / `unverified` / `failed` / `read-only`) per prompt. `/receipt`, printed in headless mode, stored on the session.
- Threat guard: self-tested single-event rules plus a session correlation (credential read, then network egress is refused in every mode).
- Local telemetry: Beacon-shaped JSONL at `~/.rcode/telemetry/runtime.jsonl` (rotated, secrets redacted, never uploaded).
- Eval harness: `rcode eval <suite.json>` runs scripted cases and reports a Wilson 95% interval. `evals/smoke.json` is the offline smoke suite.
- Handoff brief: `rcode handoff` renders a resume note from receipts.
- Diagnostics: TS/JS syntax is appended to edit results; the `diagnostics` tool runs the project's checker.
- Distribution: single-file binaries with the builtin library embedded, tagged release workflow, `install.sh` (checksum-verified), `rcode update`.
- Frontends: TUI (scrollback-native, differential live region, completions, paste collapsing), print/JSON, JSONL RPC with approvals, ACP server.

## P0 — next

- **Gateway round 3**: voice notes (local whisper / provider transcription), file attachments both ways, webhook mode with secret tokens, WhatsApp/Signal bridges.
- **OAuth / subscription login** where providers officially support it.
- **Gateway, round 2** (remote-gateway.md): owner vs. user roles, `rcode gateway link` one-tap pairing (t.me deep link + QR), Slack (Socket Mode) and Discord channels, voice notes, control socket + single-instance lock, cron jobs that cannot schedule more cron jobs.
- **OAuth / subscription login** for providers that officially support it; `rcode login` with browser flow.

## P1

- tree-sitter WASM backend for the repo map (exact parsing where installed).
- Session hibernation + daemon mode for many concurrent agents (jcode's architecture), file-touch bus across agents.
- Beacon-compatible JSONL telemetry and the rule guard shipped. Still open: loading external `*.rule.yaml` packs.
- Optional headroom proxy integration (base-URL), lazy MCP tool loading (`discover_tools`).
- Eval harness live-model lane and a terminal-bench runner (scripted graders and Wilson CIs shipped).
- Cost router on the main agent (subagent fast → smart escalation shipped).

## P2

- Declarative teams (openrig-style) and a durable task queue aligned with ruflo.
- Eval-gated harness evolution (only policy files, reviewable diffs).
- LSP diagnostics after edits (syntax notes and a `diagnostics` tool shipped; a language-server backend is still open); semantic code search.
- Optional REA plugin preset for static analysis of user-owned binaries/bundles.
- Desktop/web front-end via the app-server protocol.
