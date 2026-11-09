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
| **Starts with zero setup** | No config needed: rcode uses your keys if you have them, otherwise the best coding model already installed in Ollama or LM Studio. With nothing at all, it explains your two options in plain words. Paste any API key straight into the chat: rcode recognizes the provider, saves the key on your computer, and never sends it to a model. A new session suggests three first prompts that fit the folder; type 1, 2 or 3. |
| **Grows by talking** | `/hire a reviewer who checks accessibility` designs a persistent teammate the agent can delegate to. `/teach release` turns what you just did into a reusable `/release` workflow. Both are plain markdown you can edit. |
| **Plain mode** | `rcode --plain` or `/plain` in chat: everyday words, a one-sentence meaning for any technical term, a yes before anything is overwritten, and a three-bullet "what changed" after every edit. |
| **Command center** | `rcode center` is the local host. `rcode center --lan` opens it on your network. `rcode center --share`, or Share on the page, opens a cloudflared link for a device that is not on your network. Cloudflare carries that link. `rcode app` installs a double-clickable app that starts the center and opens it. The link keeps the same key between launches, so a bookmark and a phone home screen keep working. `--token` sets a key for one run. Look for phones lists Xcode simulators, starts one you pick, and shows a live picture you can tap. Android taps go through adb. iOS taps go through idb when it is installed. The simctl and adb commands follow T3 Code (MIT). Their account and their desktop shell were not copied. Threads, a crash-safe mission queue, live tools, approvals, and a receipt after every rcode turn. The same page installs to a phone home screen, dictates in the browser (the audio never reaches rcode), attaches and quotes, draws an HTML answer in a sandbox that cannot reach the network, shows the turn's diff next to its verdict, undoes it, makes a second checkout, and opens a GitHub pull request. It lists a simulator or phone that is already on and takes a screenshot only when you ask. Plan totals come from rcode's receipts plus Claude Code's local stats and a count of Codex threads. Login files are never read. The engine menu runs **Claude plan**, **Codex plan**, or **any agent** that speaks the Agent Client Protocol (`grok acp`, and the rest). A guest uses its own tools. Claude and Codex are outside rcode's checks. Any other agent still asks you before it acts. Phone chat stays `rcode gateway`. **Skin** reskins the page the way Winamp did. It has eight presets: Ember, Llama (the classic player look, with bevels and a green readout), Paper, Synthwave, Amber CRT, Phosphor, Fjord, and Contrast. You can also set accent, text size, roundness, spacing, font, and an effect (bevel, scanlines, glow), or press Surprise me for a fresh palette. Copy a skin and send it to a friend. A pasted skin can only set colors and numbers, so it cannot carry code. `?skin=llama` in the link picks one. |
| **Stays current** | `rcode ahead` checks the latest public release of Claude Code, Codex, the Agent Client Protocol, and T3 Code against the version rcode has already reviewed. Claude plan and Codex plan run those CLIs, so a new model or tool they ship is used on the next turn, with no rcode release. A protocol message rcode has not met yet is shown in the thread instead of dropped. A weekly check opens a GitHub issue when one of them ships past the reviewed version. |
| **Walk away** | `rcode queue add "update the docs"` queues work for a folder. `rcode queue run` finishes it unattended. Jobs survive crashes and Ctrl+C: a job that was interrupted resumes on the next run, and one that keeps crashing is stopped after three tries. |
| **Your Claude plan, no API key** | `rcode -m claude-cli/sonnet` (or `opus`, `haiku`) thinks through the official `claude` CLI, signed in with your own Claude account. rcode runs the tools, so permissions, guards and receipts still apply. rcode never reads your Claude credentials; sign in with `claude` then `/login`. Each turn resends the conversation, so long sessions use more of your plan's limits. |
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
