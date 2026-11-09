# rcode

**The open, fast, extensible coding agent.** Terminal-first, any model, MCP-native, with built-in long-term memory, parallel subagents, a real permission system, and a library of world-class workflows (`/plan`, `/tdd`, `/review`, `/ddd`, `/adr`, `/security`, …) — all working the moment you install it.

> Status: **early alpha** — moving fast, in the open. Issues and PRs welcome.

```bash
curl -fsSL https://raw.githubusercontent.com/rudycelekli/rcode/main/install.sh | sh   # prebuilt binary (macOS/Linux)
# or from source: bun install -g github:rudycelekli/rcode
rcode setup                               # 60-second wizard: model, approval mode, RuvNet stack
rcode                                     # start working
```

## Why rcode

rcode was built after studying the best open agents in depth — [pi](https://github.com/earendil-works/pi), [oh-my-pi](https://github.com/can1357/oh-my-pi), [jcode](https://github.com/1jehuang/jcode), [goose](https://github.com/aaif-goose/goose), [t3code](https://github.com/pingdotgg/t3code) and more (see [`docs/research/`](docs/research)) — taking what each does best and filling the gaps none of them cover.

| | rcode |
|---|---|
| **Any model** | Anthropic (Claude Opus/Sonnet/Haiku 5.5, Fable), OpenAI (GPT-5, Responses API), Google Gemini, OpenRouter, Groq, xAI, DeepSeek, Mistral, Cerebras, Together, Fireworks, **Ollama (native, full context)**, LM Studio. `rcode models --refresh` pulls live pricing from models.dev. |
| **Agent loop** | Errors-are-data streaming (never crashes mid-turn) · parallel read-only tools, serialized writes · steering (type while it works) & follow-up queues · loop guard · automatic context compaction with structured summaries · overflow recovery. |
| **Editing that works** | Multi-edit atomic replacements with exact → normalized → indentation-tolerant matching, BOM/CRLF preserved, **stale-file protection** (refuses to edit files changed since last read), unified diffs. |
| **Real permissions** | `ask` · `auto-edit` · `full` · `plan` (read-only). Deterministic bash risk classifier refuses catastrophic commands even in full mode. Allow/deny rules like `bash(npm test*)`. Per-session "always allow". |
| **Subagents** | `task` tool runs batches of subagents in parallel, each in a fresh context, with a curated roster (explorer, planner, reviewer, security-auditor, debugger, …) — and reads `.claude/agents/*.md` too. |
| **Memory** | Long-term memory that just works: hybrid BM25 + vector recall, auto-injected per prompt. Pure-TS by default; native HNSW via [ruvector](https://github.com/ruvnet/ruvector) when installed. |
| **MCP-native** | stdio + streamable HTTP servers, tool annotations mapped to permissions. `rcode mcp add <name> <cmd>`. |
| **Workflows & skills** | ~30 built-in slash workflows, Agent Skills (`SKILL.md`), markdown commands with `$ARGUMENTS`, Claude-Code-compatible hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, …). |
| **Human + AI native** | Beautiful TUI · `rcode -p` headless · `--json` JSONL events · `--rpc` JSONL RPC with approvals · `rcode acp` (Agent Client Protocol for Zed, t3code, goose desktop…). |
| **Browser & desktop** | `browser` tool drives a real Chrome via [agent-browser](https://github.com/vercel-labs/agent-browser) (accessibility-tree snapshots with `@refs`, screenshots, forms); `desktop` tool operates native apps via [agent-desktop](https://github.com/vercel-labs/agent-desktop). Per-action permissions (external domains ask once per domain; every desktop action asks unless full mode), secret-field refusal. `rcode setup` installs both. |
| **Remote** | `rcode gateway` — talk to your agent from your phone: **Telegram, Slack (Socket Mode), Discord** and a token-protected mobile web UI. One-tap pairing (`rcode gateway link` prints a link + QR), owner vs. chat-only roles, ✅/♾/❌ approval buttons bound to their conversation, streaming replies, `/stop` `/new` `/mode` `/undo`, scheduled jobs from chat (`/every 30m …`, `/daily 09:00 …`), single instance, `rcode gateway install` as a launchd/systemd service. |
| **Safety nets** | Git checkpoints before every prompt — `/undo` restores everything (even bash-made changes) without touching your index. A verified-done gate stops "it works!" without evidence. Threat rules block pipe-to-shell and secret-then-egress even in full mode. Every turn seals a hash-chained receipt (`/receipt`). |
| **Sessions** | Append-only JSONL trees: resume, fork, rewind — branch position persisted. |
| **RuvNet stack, pre-wired** | If [ruflo](https://github.com/ruvnet/ruflo) or [ruvnet-brain](https://github.com/stuinfla/ruvnet-brain) are installed, rcode auto-connects them. Every prompt gets a short route and the patterns that worked before (1.2s cap, dropped if the server is slow). Questions about the stack also get source excerpts. On-device MiniLM embeddings turn on by themselves once the model is cached. The status line shows `stack`. |

## Usage

```bash
rcode                          # interactive
rcode "fix the failing tests"  # interactive with a first prompt
rcode -p "explain src/auth"    # headless, prints the answer
git diff | rcode -p "review this"   # stdin is attached
rcode -p --json "…"            # JSONL event stream for scripts and other agents
rcode -c                       # continue the last session
rcode --plan                   # read-only planning mode
rcode -y                       # full auto (catastrophic commands still refused)
rcode -m ollama/qwen3-coder    # fully local
rcode acp                      # serve the Agent Client Protocol over stdio
rcode doctor                   # verify providers, tools, MCP, memory
rcode eval evals/smoke.json    # deterministic suite, Wilson 95% confidence interval
rcode handoff                  # markdown brief of the last session (files, commands, verdicts)
rcode gateway                  # remote control: web UI + Telegram (rcode login telegram <bot-token>)
rcode gateway link             # one-tap pairing link + QR for your phone
rcode gateway pair ABC123      # approve a pairing code someone received
rcode gateway install          # run the gateway as a background service
```

**In the TUI:** `enter` send · `alt+enter` newline · `esc` interrupt · `shift+tab` cycle approval mode · `ctrl+t` cycle thinking · `tab` complete `/commands` and `@files` · while the agent works, `enter` steers it and `alt+enter` queues a follow-up. `/help` lists everything.

## Configuration

- `~/.rcode/config.json` (global) and `<project>/.rcode/config.json` (project, honored when trusted)
- `~/.rcode/auth.json` — API keys (`rcode login <provider>`), or use env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, …)
- Context files: `AGENTS.md` / `CLAUDE.md` / `RCODE.md` in the project and its parents, plus `~/.rcode/AGENTS.md`
- Extensions: `~/.rcode/{commands,skills,agents}` and `.rcode/…` / `.claude/…` in the project

```json
{
  "model": "anthropic/claude-opus-5-5",
  "thinking": "medium",
  "permissionMode": "auto-edit",
  "permissions": { "allow": ["bash(npm test*)", "bash(bun test*)"], "deny": ["bash(git push*)"] },
  "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } },
  "hooks": [{ "event": "PostToolUse", "matcher": "edit|write", "command": "bunx prettier --write $(jq -r .tool_input.path)" }]
}
```

## Architecture

```
src/ai/          provider-neutral streaming (anthropic SDK, openai chat+responses, gemini, ollama native), model registry
src/agent/       the agent loop: tool batching, gating, steering, compaction hooks
src/tools/       read · edit · write · bash (+background jobs) · grep · glob · ls · todo · web_fetch · task · diagnostics
src/session/     JSONL session trees + compaction
src/core/        AgentSession — the single object every frontend drives; turn receipts and handoff briefs
src/permissions/ policy + bash risk classifier
src/guard/       threat rules + secret-then-egress correlation
src/eval/        scripted suites, graders, Wilson intervals
src/telemetry/   local Beacon-shaped JSONL (redacted)
src/memory/      memory providers (flat, ruvector) + tools
src/mcp/         MCP client manager
src/integrations ruvnet (ruflo / ruvector / brain)
src/modes/       print · rpc · acp · eval and handoff
src/tui/         interactive terminal UI
builtin/         shipped workflows, agents, skills
```

## License

MIT. rcode adapts ideas and some content from permissively licensed projects — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
