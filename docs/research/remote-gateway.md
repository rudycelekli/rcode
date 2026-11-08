# Remote gateway research: OpenClaw + Hermes Agent → `rcode gateway`

Status: research + design. Sources were read only (nothing installed, built or run):

- `reference/openclaw` (openclaw/openclaw, MIT): "Your assistant, on your devices, in your chats"
- `reference/hermes-agent` (NousResearch/hermes-agent, MIT)
- rcode as it is today: `src/core/session.ts` (AgentSession), `src/permissions/policy.ts` (modes + `Asker`), `src/modes/rpc.ts`, and the first-pass gateway already in `src/gateway/{types,server,telegram,web}.ts`.

The goal: give rcode what these two projects offer for remote connection out of the box. You talk to your agent from your phone or chat apps, approve risky actions with a tap, keep it running as a service and schedule work, without making it easy to take over the machine from a chat message.

---

## 0. TL;DR

Both projects use the same basic shape:

1. **One long-lived gateway daemon per host.** It owns every channel connection, the per-chat session store, the scheduler and the approval queue. Agents never talk to Telegram directly.
2. **Channel adapters** normalize inbound events into an envelope (channel, account, chat, thread, sender, text, media). They render outbound text, streaming previews, buttons and typing indicators back into each platform's own format.
3. **Deterministic session keys** built from the message origin, e.g. `agent:main:telegram:dm:<chat_id>` or `…:group:<chat_id>:topic:<thread_id>`. The model never chooses where a reply goes.
4. **Default deny + DM pairing.** Unknown senders get an 8-char one-time code (1 h TTL, max 3 pending, no ambiguous characters). The owner approves it on the host with `<tool> pairing approve <channel> <CODE>`.
5. **Approvals as inline buttons.** The options are Allow once / Allow for session / Always / Deny. The callback data is short, versioned and auth-checked, and approvals expire into a safe "no".
6. **Streaming by editing one preview message.** Edits are throttled to about 1 per second per chat, and both projects watch for Telegram 429 `retry_after`.
7. **Long polling by default**, so no public URL is needed. Webhooks are optional and require a secret token.
8. **Service install** via launchd (macOS) or a systemd user unit (Linux), with KeepAlive or Restart=always, throttled restarts and umask 077.
9. **A cron scheduler inside the gateway.** Results are delivered to the origin chat. Headless runs **deny** dangerous actions by default.

rcode already has about 60% of a minimal version (see §3.0 for a gap review of the existing `src/gateway/*`). The design in §3 hardens it and grows it into a full daemon, with zero new dependencies (plain `fetch` + Bun's built-in `WebSocket`/`Bun.serve`).

---

## 1. OpenClaw deep dive

### 1.1 Architecture

- **Gateway = control plane.** One process per host owns all messaging surfaces: WhatsApp (Baileys), Telegram (grammY), Slack (Bolt), Discord, Signal, iMessage and WebChat. It exposes a typed WebSocket API on `127.0.0.1:18789` (`docs/concepts/architecture.md`). The source is huge: `src/gateway/` alone has about 2,900 files.
- **Wire protocol** (`docs/concepts/architecture.md`, `docs/gateway/protocol.md`). Text frames carry JSON. The first frame must be `connect`. After that: `{type:"req",id,method,params}` → `{type:"res",id,ok,payload|error}`, and server-push `{type:"event",event,payload,seq?}`. Side-effecting methods (`send`, `agent`) require idempotency keys. Schemas are written in TypeBox, from which JSON Schema and Swift models are generated.
- **Clients**: the CLI, the TUI, the Control UI (a Vite + Solid SPA served by the gateway on the same port, `docs/web/control-ui.md`) and the macOS/iOS/Android apps. **Nodes** are devices that connect with `role: "node"` and expose commands like `camera.*`, `screen.record` and `location.get`. The gateway calls them via `node.invoke` (`docs/gateway/remote.md`, `docs/platforms/ios.md`). Example: a Telegram message comes in, the agent runs on the gateway, calls a phone node to take a photo, and replies in Telegram.
- **Device pairing for WS clients.** Each client has a device identity and signs a `connect.challenge` nonce (signature v3 binds platform and device family). New devices need approval, after which the gateway issues a device token. Loopback connects can be auto-approved, but LAN/tailnet connects always need approval.
- **Channel plugins** live under `extensions/<channel>/`, with a large capability contract `ChannelPlugin` in `src/channels/plugins/types.plugin.ts`. The adapters are `config`, `pairing`, `security`, `groups`, `mentions`, `outbound`, `status`, `gateway`, `auth`, `approvalCapability`, `commands`, `lifecycle`, `secrets`, `allowlist`, `doctor`, `bindings`, `streaming`, `threading`, `message`, `actions`, `heartbeat` and `agentTools`. Pairing hooks are in `src/channels/plugins/pairing.types.ts` (`idLabel`, `normalizeAllowEntry`, `notifyApproval`).
- **Config**: JSON5 at `~/.openclaw/openclaw.json` (`docs/gateway/configuration.md`), with `openclaw doctor --fix` for migrations and hot reload for many keys.

### 1.2 Channels and how each is implemented

| Channel | Implementation (`extensions/*/package.json`, `docs/channels/*.md`) |
|---|---|
| Telegram | grammY + `@grammyjs/transformer-throttler`. Long polling by default, webhook optional (`webhookUrl` + `webhookSecret`, route on the gateway port) |
| Discord | Own gateway WebSocket (`ws`, `discord-api-types`), components v2 for buttons/approvals, `@discordjs/voice` |
| Slack | `@slack/bolt` + `@slack/web-api`. Socket Mode by default, HTTP Request URLs or "relay mode" also supported |
| WhatsApp | `baileys` (WhatsApp Web emulation, QR login) |
| Signal | `signal-cli` over HTTP (native daemon JSON-RPC + SSE, or bbernhard REST container) |
| iMessage | `imsg` CLI, JSON-RPC over stdio on a signed-in Mac (BlueBubbles support removed) |
| Matrix, Teams, Google Chat, IRC, LINE, Mattermost, Nostr, Twitch, Zalo, Feishu, WeChat, SMS… | each its own extension |
| Email | `extensions/imap` (`imapflow`, `mailparser`) for automations |
| Web | Control UI + WebChat served by the gateway; Telegram **Mini App** opens the Control UI inside Telegram via `/controlui` |

### 1.3 Access control and pairing

- `dmPolicy` (`docs/gateway/security/access-control.md`) is one of: `pairing` (the default), `allowlist`, `open` (requires `"*"` in the allowlist as an explicit opt-in) or `disabled`. Groups have a separate `groupPolicy`, `groupAllowFrom`, mention gating (`requireMention`) and `contextVisibility`.
- Pairing codes (`docs/channels/pairing.md`) are 8 chars, uppercase, with no `0O1I`. They expire after 1 h, at most 3 are pending per channel account, and the bot only replies when a *new* request is created (about once per hour per sender). You approve with `openclaw pairing approve telegram <CODE> [--notify]` or in Control UI → Settings → Channels → DM access requests.
- **Chat access is separate from command ownership.** `commands.ownerAllowFrom` lists who may run privileged commands and approve exec. The first approved pairing bootstraps the owner, and later approvals only grant chat access. Reusable `accessGroups` share sender sets across channels.
- Telegram exec approvals (`docs/channels/telegram/rich-messages.md`): `execApprovals.enabled: "auto"`; approvers must be numeric Telegram user IDs; `target: dm | channel | both` (by default the approval goes to the **approver's DM**, not the group); approvals expire after 30 min.
- Callback data (`extensions/telegram/src/approval-callback-data.ts`) is a **versioned** prefix `tga1:<kind>:<decision>:<approvalId>`, where kind is e/p/s and decision is o (allow-once), a (allow-always) or d (deny). It respects the 64-byte `callback_data` cap and falls back to a digest reference. The gateway still authorizes against the canonical approval record, so the callback data is only a locator.

### 1.4 Streaming, rate limits, ingress durability

- Telegram `streaming.mode` is `off | partial | block | progress` (default `progress`): one editable "status draft" (status + tool lines) during the turn, then the final answer as a **new** message, so the user gets a notification (`docs/channels/telegram/messaging.md`). `partial` streams answer text into the preview with `editMessageText`.
- `extensions/telegram/src/draft-stream.ts`: `DEFAULT_THROTTLE_MS = 1000`, minimum 250 ms, `MIN_PREVIEW_DWELL_MS = 4000` (a preview is never flashed and deleted), and preview edits are abandoned after 3 consecutive failures.
- `account-throttler.ts`: a per-account **flood gate** that respects `retry_after`. While the gate is closed, outbound calls (except `getUpdates`) are skipped fast. The flood budget is 5 min.
- Long polling saves its restart offset only **after** an update is committed to a durable ingress queue (`docs/channels/telegram/transports.md`). `allowed-updates.ts` subscribes to the default update types plus `message_reaction` and `channel_post`.
- Text chunk limit is 4000, and `chunkMode: "newline"` prefers paragraph boundaries.

### 1.5 Sessions and routing

`docs/channels/channel-routing.md`: replies always route back to the origin, and the model never picks the channel. By default DMs from every channel collapse into `agent:<agentId>:main`. Setting `session.dmScope: per-peer | per-channel-peer | per-account-channel-peer` splits them. Groups use `agent:<id>:<channel>:group:<id>`, Slack/Discord threads append `:thread:<id>`, and Telegram forum topics use `:topic:<id>`. Even when DMs share the main transcript, tool/sandbox policy uses a derived per-channel runtime key, so a chat DM is never treated like a local terminal run. The steering queue defaults to `steer` (injecting into the active run at tool boundaries), with `followup`, `collect` and `interrupt` as alternatives (`docs/concepts/queue-steering.md`).

### 1.6 Permissions, sandboxing, security model

- Session permission modes (`docs/gateway/permission-modes.md`): `read-only`, `guarded` ("Ask me", a human reviews exec after the allowlist), `workspace` ("Auto-review", an LLM reviewer allows/denies/ escalates, and 3 consecutive denials escalate to a human) and `full`.
- Sandboxing is opt-in, with Docker and other backends (`docs/gateway/sandboxing.md`). The gateway stays on the host and only tool execution moves into the sandbox.
- Trust model (`docs/gateway/security/trust-model.md`): **one trust boundary per gateway**. Mutually untrusted users need separate gateways. `sessionKey` is a routing selector, *not* an auth token.
- Prompt injection (`docs/gateway/security/prompt-injection.md`): treat every inbound message, attachment and fetched page as untrusted, keep DMs locked down, and use mention gating in groups. Suggested layers are a read-only "reader agent" to summarize untrusted content, strict inline-eval checks for allowlisted interpreters, and heredocs always needing review.

### 1.7 Remote access, service, automation

- Remote access (`docs/gateway/remote.md`, `docs/gateway/tailscale.md`): bind to loopback, then use **Tailscale Serve** (tailnet-only HTTPS with identity headers) or **Funnel** (public, requires a password), or an SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 host`. There is also an "OpenClaw ID" remote tunnel. A plain SSH port-forward counts as local authority.
- Service (`src/daemon/`): launchd label `ai.openclaw.gateway` with `RunAtLoad`, `KeepAlive`, `ThrottleInterval: 10`, `Umask: 0o077` and `ProcessType: Interactive` (`launchd-plist.ts`). The systemd user unit (`systemd-unit.ts`) has `After/Wants=network-online.target`, `Restart=always`, `RestartSec=5`, `StartLimitBurst=10/300s`, `KillMode=mixed` and `WantedBy=default.target`. Windows uses Scheduled Tasks (`schtasks-*.ts`). `openclaw onboard --install-daemon` handles install.
- Automations (`docs/automation/cron-jobs.md`, `src/cron/`): persisted jobs with one-shot, cron and interval schedules, run history, delivery to a channel, a webhook or nowhere, plus webhook and Gmail PubSub triggers. The old heartbeat (`HEARTBEAT.md`) was folded into ordinary automation jobs (`docs/gateway/heartbeat.md`). A single `GatewayScheduler` coalesces missed ticks after sleep.

### 1.8 Other standout features (brief)

Multi-agent "bindings" route accounts to agents. Active memory, "dreaming" and memory-wiki handle long-term memory. Skills come from the ClawHub registry (`skills/`, `custodian-skills/`). The Canvas widget host runs at `/__openclaw__/canvas/`. Voice: talk mode, wake word, TTS providers. Mini App inside Telegram. Prometheus/OTel diagnostics.

---

## 2. Hermes Agent deep dive

### 2.1 Architecture

- Python. One background **gateway** process connects every configured platform, holds a per-chat session store, dispatches to `AIAgent` (`run_agent.py`), runs the cron scheduler (60 s tick) and handles voice (`website/docs/user-guide/messaging/index.md`). The core lives in `gateway/` (`run.py`, `session.py`, `pairing.py`, `delivery_ledger.py`, `stream_consumer*.py`, `slash_commands*.py`). Platform adapters are plugins in `plugins/platforms/<name>/` with the base class in `gateway/platforms/base.py`. There is a guide in `gateway/platforms/ADDING_A_PLATFORM.md`.
- Commands: `hermes gateway` (foreground), `setup` (wizard), `install` (systemd user/launchd), `start|stop|status`, `sudo hermes gateway install --system`. `kill -USR2` dumps stacks.
- **Liveness**: an event-loop watchdog exits with code 75 after 3 missed probes so the supervisor restarts it, and `gateway_state.json` is re-stamped every 60 s as a heartbeat, so `status` can report "heartbeat stale". Optional systemd `Type=notify` with `WatchdogSec`.
- **Delivery ledger** (`gateway/delivery_ledger.py`, `state.db`): final replies are recorded around each send and redelivered after a crash, with a "♻️ Recovered reply — may be a duplicate" label when ambiguous. It retries flood-control rejections after the penalty. Bounds are 3 attempts / 24 h.
- **Hermes Relay** (`gateway/relay/`, `docs/.../messaging/relay.md`): an optional external *connector* owns platform tokens/sockets and talks to the gateway over WS. Capabilities (buttons, threads, streaming) are negotiated at handshake.
- Config: `~/.hermes/config.yaml` + secrets in `~/.hermes/.env` (env-style `TELEGRAM_ALLOWED_USERS=…`), plus profiles for multiple isolated homes.

### 2.2 Channels

Telegram, Discord, Slack, WhatsApp (Baileys bridge) and WhatsApp Cloud API, Signal (signal-cli daemon: **SSE for inbound, JSON-RPC for send**, httpx only), SMS (Twilio), Email (stdlib `imaplib`/`smtplib`, in-thread replies), Matrix, Mattermost, Teams, Google Chat, iMessage via BlueBubbles/Photon, LINE, ntfy, IRC, SimpleX, DingTalk/Feishu/WeCom/Weixin/QQ, Home Assistant, a generic **webhook** adapter (HMAC-validated routes, e.g. GitHub, that trigger agent runs) and an **OpenAI-compatible API server** so any chat frontend (Open WebUI) can talk to it. The capability matrix (voice / images / files / threads / reactions / typing / streaming) is in `messaging/index.md`.

- Telegram (`plugins/platforms/telegram/adapter.py`, about 8.7k lines incl. helpers) uses `python-telegram-bot`. Long polling by default. Webhook mode via `TELEGRAM_WEBHOOK_URL` *requires* `TELEGRAM_WEBHOOK_SECRET`: the gateway refuses to start without it, after security advisory GHSA-3vpc-7q5r-276h. It supports Bot API 9.5 `sendMessageDraft` native streaming in DMs (`gateway.streaming.transport: auto|draft|edit|off`, default edit), Bot API 10.1 `sendRichMessage` for tables, private-chat **topics** as multi-session DMs (`/topic`), forum-topic skill binding and a local Bot API server for files over 20 MB.
- Slack uses Socket Mode (slack-bolt). Discord uses discord.py over the gateway WS with liveness checks.

### 2.3 Auth: allowlists, pairing, admin tiers

- Authorization order (`website/docs/user-guide/security.md`, "Authorization Check Order"): per-platform allow-all → paired list → platform allowlist → global allowlist → global allow-all → **deny**. With no allowlist configured, everyone is denied and a startup warning is logged.
- `gateway/pairing.py` (OWASP / NIST 800-63-4 comment at the top): `ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"`, `CODE_LENGTH = 8`, generated with `secrets.choice`; TTL 3600 s; 1 request per user per 600 s; `MAX_PENDING_PER_PLATFORM = 3`; lockout for 1 h after 5 failed approvals; codes stored as **salted hashes** and compared with `compare_digest`; never logged; files chmod 0600. Approval also writes the user into the configured allowlist so the list stays the visible source of truth.
- **Admin vs user tiers** per scope (DM vs group): `allow_admin_from`, `user_allowed_commands`, with `/whoami` to inspect. A bot sender is admitted only via `*_ALLOW_BOTS`, and `gateway.bot_loop_guard` caps it at 4 hops.
- Session keys (`website/docs/user-guide/sessions.md`, `gateway/session.py:build_session_key`): `agent:main:telegram:dm:<chat_id>`, `agent:main:<platform>:group:<chat_id>:<user_id>` (per-user in groups by default, `group_sessions_per_user: true`), `…:group:<chat_id>:<thread_id>` for threads. `/stop` reaches any run in the caller's room/thread but never another room.

### 2.4 Approvals relayed to chat

- Modes (`security.md`): `approvals.mode: smart | manual | off`. In `smart`, an auxiliary LLM auto-approves low risk, auto-denies clear danger and escalates the rest. `timeout: 300`. **`cron_mode: deny`, `single_query_mode: deny`, `unattended_mode: deny`** by default. There is a hardline blocklist floor and user deny rules.
- Telegram buttons (`adapter.py` `_send_exec_approval_prompt`): `callback_data=f"ea:{choice}:{approval_id}"` with choices `once | session | always | deny`. Short monotonic ids map back to the session key in `_approval_state`. Callbacks go through `_callback_authorized(...)` before claiming the pending entry, and the toast is shown via `answerCallbackQuery` (200 char cap). Every prompt ends with a deadline line, *"doing nothing is a safe no"* (`gateway/platforms/base_exec_approval.py`). There is a text fallback (`yes/no`, `/approve`, `/deny`).
- The `clarify` tool renders as numbered inline buttons (`cl:<id>:<idx>`) plus "Other", with a 90 s timeout. If the button card fails it falls back to a numbered list, and if delivery fails entirely it releases the agent immediately.
- Destructive slash commands (`/new`, `/undo`) get a 3-button confirm (`sc:once|always|cancel:<id>`).

### 2.5 Streaming, notifications, busy input

- Progressive `editMessageText`. Recurring status bubbles are edited in place via a `{(chat_id,status_key)→message_id}` cache.
- **Notification hygiene**: `display.platforms.telegram.notifications: important`. Only final replies, approval prompts and confirmations ring. Progress and stream chunks are sent with `disable_notification=true`.
- **Busy input mode**: `interrupt` (the default; redirects the active turn at the next tool boundary), `queue` (next turn) or `steer` (inject after the next tool call). `/stop` is a hard stop.
- **Silence tokens** (`[SILENT]`, `NO_REPLY`) let a final reply be suppressed in groups/automations, but never for a direct human message without a notice.
- `channel_overrides` per chat/thread set model, provider, system_prompt and allow_silence.

### 2.6 Chat commands

`/new` `/reset` `/model [provider:model] [--global|--once]` `/retry` `/undo` `/status` `/whoami` `/stop` `/approve` `/deny` `/sethome` `/compress` `/title` `/resume` `/sessions [search q]` `/usage` `/reasoning` `/voice` `/rollback` `/bg <prompt>` `/btw <q>` `/reload-mcp` `/update` `/help` `/<skill-name>` `/cron add "every 2h" "…"` `/heartbeat every 10m …` `/topic`.

### 2.7 Scheduling

- Cron (`cron/`, `website/docs/user-guide/features/cron.md`): one tool `cronjob_manage`. Schedules can be natural language ("in 30m", "every 2h", "every morning at 9am") or cron expressions. Each run gets a fresh agent session, and results are delivered to the origin chat, a file or a platform target. There is a **no-agent mode** (a script whose stdout is delivered, with no LLM), event triggers via webhook routes, pre-dispatch validation (no tokens spent on a misconfigured job, a single alert) and model pin resolution per job → `cron.model` → main model. **Cron runs cannot create cron jobs** (this prevents runaway loops).
- **Session heartbeat** (`features/heartbeat.md`): `/heartbeat every 10m <prompt>` re-enters *this* conversation when idle (min 60 s, injected only between turns), with pause/resume/clear.

### 2.8 Service, remote, security extras

- Service (`hermes_cli/gateway.py`): launchd label `ai.hermes.gateway*` and a systemd user unit. It pre-flights the user D-Bus session and runs `loginctl enable-linger <user>` automatically, so the gateway survives logout. `--system` installs a boot-time unit.
- Security extras (`security.md`): context-file injection scanner (AGENTS.md/.cursorrules are scanned for "ignore previous instructions", hidden HTML comments, secret reads, curl exfiltration, invisible Unicode; blocked files are replaced by a `[BLOCKED: …]` marker), SSRF protection, credential redaction, Docker terminal backend, `HERMES_WRITE_SAFE_ROOT`, and a production checklist (explicit allowlists, container backend, non-root, `.env` 0600).

### 2.9 Other standout features (brief)

Closed learning loop: the agent writes **skills** after complex tasks, compatible with agentskills.io, with a Skills Hub. A **Curator** ages agent-made skills active→stale→archived and proposes consolidations (`features/curator.md`). Bounded memory files `MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars) are injected as a frozen snapshot, alongside FTS5 session search. There are also Honcho user modeling, subagent delegation, six terminal backends (local, Docker, SSH, Modal, Daytona, Vercel Sandbox), Kanban, trajectory export for training, and a desktop app plus web dashboard.

### 2.10 What to steal (ranked)

| Idea | From | Why |
|---|---|---|
| Default deny + 8-char hashed pairing codes, rate limits, cap 3 | both | Safe first contact with no config editing |
| Chat access is separate from owner/approver | OpenClaw | Approving risky tools is a stronger right than chatting |
| Approval buttons expire into deny, "doing nothing is a safe no" | Hermes | The agent never hangs and a missed tap does nothing |
| `cron_mode/unattended_mode: deny` | Hermes | Headless runs must not silently escalate |
| Progress draft + final as new message; `disable_notification` on progress | OpenClaw / Hermes | Good phone UX: one notification per turn |
| Flood gate on 429 + 1 s edit throttle | OpenClaw | Avoids bans and lost edits |
| Commit polling offset after durable enqueue; delivery ledger | OpenClaw / Hermes | Crash safety |
| Deterministic session keys; model never chooses the target | both | Prevents cross-chat leakage via injection |
| Webhook mode must require a secret | Hermes (advisory) | Forged updates otherwise |
| Loopback bind + Tailscale Serve / SSH tunnel | OpenClaw | Remote web UI without exposing a port |

---

## 3. Design: `rcode gateway`

### 3.0 Review of the existing first pass (`src/gateway/*`)

Good: zero-dep Telegram long polling, a `ChannelAdapter` interface, one AgentSession per conversation persisted in `~/.rcode/gateway.json`, inline-button approvals wired into `Asker` (15 min auto-deny), throttled edits (1.2 s), `/new /stop /status /mode /model /undo`, `full` mode refused from chat unless configured, steering while running, a web UI with a timing-safe token, and simple schedules.

Gaps to fix (P0 unless noted):

1. **Pairing codes are weak and spammable.** `Math.random().toString(36)`, 6 chars, 10 min TTL. Every message from an unknown user creates a new code, writes state and sends a reply. There is no cap, no rate limit and no hashing. Fix: §3.5.
2. **Approval callbacks are not bound to the requester.** `onApproval` ignores `userId` and the conversation, and ids are predictable (`Date.now().toString(36)+seq`). Any allowlisted user in *any* chat can resolve any approval. Fix: random 64-bit ids, and check that `callback.message.chat.id` matches the approval's chat and that the sender is an approver.
3. **Groups.** Unknown members in a group get pairing replies in the group, and any allowlisted user in any group can drive a session. Default to private chats only; groups must be opt-in per chat id.
4. **No `deleteWebhook` at start.** Polling gets 409 Conflict if a webhook was ever set. `stop()` doesn't abort the in-flight 50 s `getUpdates`. The offset is not persisted.
5. **Race in `sessionFor`.** Two quick messages can create two sessions. Fix: a `Map<key, Promise<AgentSession>>`.
6. **The web token is in the query string** (it leaks into history/logs). The WS has no Origin check. `--host 0.0.0.0` serves plain HTTP. Fix: §3.7.
7. **The approval card shows only a 200-char summary.** Show the exact command/path (code block, escaped), the cwd and the reason. Edit the card when it times out ("⌛ expired — denied").
8. **The scheduler** uses `setInterval` with no persistence, no missed-run handling and no headless approval policy (prompts land in chat, which is OK, but cron must default to deny when nobody is watching). P1: §3.10.
9. **No single-instance lock or control socket.** `rcode gateway pair` only works in the TTY console (`pairCode` writes the state file, which the daemon re-reads every 2 s; that works but is racy). Fix: §3.3.

### 3.1 Process model

```
                ┌──────────────────────── rcode gateway (daemon, 1 per host/profile) ────────────────────────┐
 Telegram ◀───▶ │ TelegramAdapter ─┐                                                                          │
 Web UI   ◀───▶ │ WebAdapter ──────┼─▶ Router ──▶ SessionPool (AgentSession per key, lazy, LRU-evicted)       │
 Slack    ◀───▶ │ SlackAdapter ────┤     │  ▲          │ asker → ApprovalBroker ─▶ adapter.askApproval       │
 Discord  ◀───▶ │ DiscordAdapter ──┘     │  └ commands │ events → StreamRenderer ─▶ adapter.edit/send       │
                │                        ▼                                                                    │
                │  AuthZ (allowlist, pairing, owner)   Scheduler (cron/heartbeat)   ControlSocket (unix)      │
                │  State: ~/.rcode/gateway/{state.json, offsets.json, ledger.jsonl, audit.jsonl}              │
                └─────────────────────────────────────────────────────────────────────────────────────────────┘
        rcode gateway pair|status|stop|sessions|send  ──▶ ~/.rcode/gateway/gateway.sock (0600)
```

- `rcode gateway [run]` runs in the foreground (also what the service runs). `rcode gateway install|uninstall|start|stop|status|logs` manage the service. `rcode gateway pair <CODE>`, `rcode gateway link`, `rcode gateway allow <channel> <id>`, `rcode gateway revoke …`, `rcode gateway sessions` and `rcode gateway send <target> <text>` talk to the control socket.
- **Single instance**: `~/.rcode/gateway/gateway.lock` holds a pid. Refuse to start if that pid is alive. Telegram also enforces this (409 Conflict if two pollers use the same token).
- **Control socket**: `Bun.listen({ unix: "~/.rcode/gateway/gateway.sock" })`, chmod 0600, JSON lines `{id, method, params}` with the same envelope as `src/modes/rpc.ts`. Filesystem permissions on the socket are the auth; it never listens on TCP.
- **SessionPool**: `Map<SessionKey, Promise<AgentSession>>`. Sessions are created with `new AgentSession({ cwd, model, mode, resume, asker }).init()`, so a pending create is shared. Idle sessions are disposed after N minutes (default 30) and resumed from `state.sessions[key]` (the session file path) on the next message. At most one running turn per key.
- Each session's `cwd` is the chat's **bound project**, chosen from `gateway.projects` (see §3.9). The default is the first project, or the cwd the gateway was started in.

### 3.2 Channel adapter interface (TypeScript)

This is a superset of the current `src/gateway/types.ts`, designed so the current Telegram/Web adapters change only a little.

```ts
// src/gateway/types.ts
export type ChatKind = "dm" | "group" | "channel";
export type Decision = "allow" | "allow-session" | "deny";

export interface Address {          // where a message came from / where replies go — never model-chosen
  channel: string;                  // "telegram" | "web" | "slack" | "discord"
  account: string;                  // bot/workspace id ("default" for single-account)
  chatId: string;
  threadId?: string;                // telegram message_thread_id, slack thread_ts, discord thread channel id
  kind: ChatKind;
}

export interface Sender { id: string; name?: string; isBot: boolean }

export interface Attachment {
  kind: "image" | "file" | "audio";
  mimeType: string;
  name?: string;
  bytes?: number;
  load(): Promise<Uint8Array>;      // lazy; adapters enforce size caps (default 20 MB)
}

export interface Inbound {
  address: Address;
  sender: Sender;
  text: string;
  attachments: Attachment[];
  messageId: string;
  replyToText?: string;             // quoted/replied-to content (untrusted, see §4)
  forwarded?: boolean;              // forwarded content is untrusted third-party text
  mentionedBot?: boolean;           // group mention gating
}

export interface ApprovalCard {
  id: string;                       // 16 hex chars, crypto-random, unguessable
  tool: string;
  detail: string;                   // exact command / path / URL
  reason: string;                   // from PermissionPolicy ("runs a command", "force push"…)
  cwd: string;
  expiresAt: number;
}

export interface ApprovalAnswer { id: string; decision: Decision; sender: Sender; address: Address }

export interface StreamHandle {
  /** Replace the preview text (adapter throttles + coalesces; never throws). */
  update(text: string): void;
  /** Finalize: edit preview into first chunk or delete it and send fresh; split long text. */
  finish(text: string, opts?: { notify?: boolean }): Promise<void>;
  /** Abort preview (e.g. on error) — leaves a short marker. */
  fail(text: string): Promise<void>;
}

export interface Capabilities {
  edits: boolean; buttons: boolean; threads: boolean; typing: boolean;
  maxText: number;                  // 4096 tg, 2000 discord, ~40000 slack (use 3900)
  editIntervalMs: number;           // tg 1000 (DM) / 3000 (group), slack 1500, discord 1200
}

export interface AdapterContext {
  onInbound(m: Inbound): void;
  onApproval(a: ApprovalAnswer): void;
  log(level: "info" | "warn" | "error", msg: string): void;
  state: KV;                        // namespaced persistent KV (offsets, bot info)
  signal: AbortSignal;              // aborted on shutdown
}

export interface ChannelAdapter {
  readonly name: string;
  readonly caps: Capabilities;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  send(to: Address, text: string, opts?: { notify?: boolean; replyTo?: string }): Promise<string /*messageId*/>;
  stream(to: Address, opts?: { replyTo?: string }): Promise<StreamHandle>;
  askApproval(to: Address, card: ApprovalCard): Promise<void>;
  resolveApproval(to: Address, card: ApprovalCard, outcome: Decision | "expired", by?: Sender): Promise<void>;
  typing?(to: Address): Promise<void>;
  setCommands?(cmds: Array<{ command: string; description: string }>): Promise<void>;
  sendFile?(to: Address, name: string, data: Uint8Array, caption?: string): Promise<void>;
}

export interface KV { get<T>(k: string): T | undefined; set(k: string, v: unknown): void }
```

The core (not adapters) owns authorization, session keys, commands, approvals and rendering policy. Adapters only translate.

### 3.3 Session keys and thread → session mapping

```
sessionKey = `${channel}:${account}:${kind}:${chatId}` + (threadId ? `:t:${threadId}` : "")
             + (kind !== "dm" && cfg.groupSessionsPerUser ? `:u:${senderId}` : "")
```

- `state.json.sessions[sessionKey] = { file, project, mode, model, updatedAt }`. `/new` rotates `file`, and `/sessions` lists recent files for this key (keep the last 10). `/resume <n>` re-points the key.
- **Telegram**: DMs give one session per chat. The multi-session DM option (P1) uses Bot API private chat topics or forum supergroups. Each topic is a `message_thread_id`, which becomes its own session, so "one topic per task" works naturally (as Hermes `/topic` and OpenClaw `:topic:` do).
- **Slack**: replies always go in a thread. The session key uses `thread_ts` (a new top-level DM message starts a new thread, i.e. a new session).
- **Discord**: threads are channels, so the key uses the thread's channel id. `/new` in a channel can open a new thread (P2).
- **Web**: `web:default:dm:<conversation-id>` (the UI has a session picker, so `c=` in the URL becomes a header/WS message, not auth).
- `/stop` aborts the run for the current key, or for a group thread any run in that thread. It never reaches another chat.

### 3.4 Message flow per inbound

1. The adapter emits `Inbound`. The core **drops it** if `sender.isBot`, or if the chat kind is not enabled (groups are off by default), or if a group message lacks a mention while `requireMention` is on.
2. **AuthZ** (§3.5): allowed, pairing, or silent drop.
3. Rate limit per sender (token bucket, default 20 msgs/min) and per chat.
4. If the text starts with `/`, it goes to the command table (§3.8). Unknown `/x` falls through to rcode slash commands (`session.commands`) if permitted, otherwise to the model as plain text.
5. If the session is running: by default (`busyMode: steer`) call `session.steer(text)` and react with "↳ queued for the running task". The `queue` mode uses `session.followUp`, and `interrupt` calls `abort()` and then prompts. Images during a run are queued as a follow-up.
6. Otherwise: `typing()` every 4.5 s, `stream()` a preview, subscribe to `AgentEvent`s, run `await session.prompt(text, images)`, then `finish(final)`. Errors go to `fail()`.
7. Append to the delivery ledger before and after the final send (P1). Write an audit line for every approval decision.

### 3.5 Authorization and pairing

State in `~/.rcode/gateway/state.json` (0600):

```jsonc
{
  "owners":   ["telegram:123456789"],            // may approve tools, pair users, change mode/project
  "allowed":  ["telegram:123456789", "telegram:555"],
  "pending":  { "<requestId>": { "channel": "telegram", "senderId": "555", "name": "bob",
                                 "codeHash": "<sha256(salt+code)>", "salt": "<hex>", "created": 1730000000000 } },
  "limits":   { "telegram:555": 1730000000000 }, // last pairing request time
  "failures": { "telegram": { "count": 0, "lockedUntil": 0 } },
  "sessions": { "telegram:default:dm:123456789": { "file": "...", "project": "rcode", "mode": "ask" } }
}
```

Effective allow = `config.gateway.<channel>.allow` ∪ `state.allowed`. The check order is (1) owner, (2) allowed, (3) `policy: pairing` → pairing flow, (4) otherwise **deny silently**.

**Pairing flow A: code (works everywhere):**

1. An unknown sender DMs the bot. If `limits[sender]` is under 10 min old, or 3 requests are already pending for this channel, or the channel is locked, **drop silently**.
2. Generate a code: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` using `crypto.getRandomValues` with rejection sampling. Store only `sha256(salt‖code)`, with a TTL of 1 h. Never log the code.
3. The bot replies once: "🔒 This rcode is private. Pairing code: `XKGH5N7P`. Ask the owner to run `rcode gateway pair XKGH5N7P` (expires in 1 h)."
4. The owner runs `rcode gateway pair XKGH5N7P` (via the control socket) or taps Approve in the web UI (owner session). The daemon compares the hash with `timingSafeEqual`. On success it adds the sender to `allowed`, removes the pending entry and optionally notifies the user. If there are no owners yet, the **first paired user becomes owner** (printed explicitly in the CLI output, as OpenClaw does). Five wrong codes lock that channel's pairing for 1 h.

**Pairing flow B: one-time deep link (best UX for the owner, P0):**

1. On the host, `rcode gateway link` creates a 128-bit token (base64url, TTL 10 min, single use, stored hashed). It prints `https://t.me/<bot_username>?start=<token>` and a terminal QR code.
2. The owner taps it on their phone. Telegram sends `/start <token>` from that user, and the daemon matches the hash and adds `telegram:<from.id>` as **owner**.
3. This proves possession of the host terminal and the Telegram account at once, so there is no user-id lookup and no config editing. Slack/Discord equivalent: `rcode gateway link slack` prints a phrase to DM the bot.

Static allowlists also work (`gateway.telegram.allow: ["123456789"]`) for headless/Ansible setups. `rcode gateway revoke telegram 555` removes access and aborts that sender's sessions.

### 3.6 Approval relay (Asker ↔ buttons)

```ts
// src/gateway/approvals.ts
class ApprovalBroker {
  private pending = new Map<string, { card: ApprovalCard; key: string; to: Address; resolve(d: Decision): void; timer: Timer }>();

  askerFor(key: string, to: Address, adapter: ChannelAdapter, cwd: string): Asker {
    return (req) => new Promise((resolve) => {
      const id = crypto.getRandomValues(new Uint8Array(8)).toHex();           // 16 hex
      const card: ApprovalCard = { id, tool: req.tool.name, detail: detailOf(req), reason: req.reason, cwd,
                                   expiresAt: Date.now() + cfg.approvalTimeoutMs /* default 10 min */ };
      const timer = setTimeout(() => this.settle(id, "expired"), cfg.approvalTimeoutMs);
      this.pending.set(id, { card, key, to, resolve, timer });
      adapter.askApproval(cfg.approvalTarget === "owner-dm" ? ownerDm(to) : to, card)
        .catch(() => this.settle(id, "deny"));                             // undeliverable ⇒ deny now
    });
  }

  answer(a: ApprovalAnswer) {
    const p = this.pending.get(a.id);
    if (!p) return "expired";
    if (!isOwner(a.sender) && !(cfg.allowedUsersMayApprove && sameChat(a.address, p.to))) return "forbidden";
    if (!sameChat(a.address, p.to) && !isOwnerDm(a.address)) return "forbidden";
    this.settle(a.id, a.decision, a.sender);
    return "ok";
  }

  private settle(id: string, outcome: Decision | "expired", by?: Sender) {
    const p = this.pending.get(id); if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer);
    p.resolve(outcome === "expired" ? "deny" : outcome);                    // silence is a safe "no"
    audit({ id, key: p.key, tool: p.card.tool, detail: p.card.detail, outcome, by: by?.id });
    void adapterOf(p.to).resolveApproval(p.to, p.card, outcome, by);       // edit card: buttons removed
  }
}
```

- `detailOf(req)` gives the exact `args.command` for bash, `path` (+ a diff stat if available) for edits, `url` for fetches. Truncate to 3000 chars and mark it as truncated. The model's own description of the action is never shown as the detail.
- Buttons are **✅ Allow once** (`allow`), **♾ Allow for session** (`allow-session`, which maps to `PermissionPolicy.sessionAllows`) and **❌ Deny**. There is no "always" (persisting allow rules) from chat in P0. That has to be done in config, on the host.
- Callback data: `ap1:<a|s|d>:<id16>` (22 bytes, under the 64-byte limit). The `ap1` prefix versions it.
- The text fallback `/approve <id>`, `/deny <id>` is for channels without buttons.
- **Abort semantics**: `/stop` settles all of the key's pending approvals as `deny`, then calls `session.abort()`.
- Cron/heartbeat runs (no human watching) use `cronApprovals: "deny"` by default. The alternative is `"ask-owner"`, which relays to the owner DM with a shorter timeout.

### 3.7 Built-in web UI (P0)

- `Bun.serve` on `127.0.0.1:7788`. A single-file SPA, extending the existing `PAGE` in `web.ts`.
- **Auth**: `rcode gateway` prints `http://127.0.0.1:7788/#t=<token>`. The token is in the URL *fragment* (never sent to the server or logs). The page does `POST /auth` with `Authorization: Bearer <token>` and receives an `HttpOnly; SameSite=Strict` session cookie (`Secure` when served over https). The WS upgrade requires that cookie **and** `Origin` equal to the page origin (blocks cross-site WS hijacking). The token is 144-bit random, persisted in `~/.rcode/auth.json`, rotated with `rcode gateway token --rotate`, and compared with `timingSafeEqual`.
- **WS protocol**, reusing the RPC envelope so tooling stays uniform:
  - client → `{type:"prompt", c, text, images?}`, `{type:"approval", id, decision}`, `{type:"cmd", c, name, args}`, `{type:"subscribe", c}`
  - server → `{type:"event", c, event: AgentEvent(slim)}` (the full rpc event stream, so the web UI can show tool calls and diffs), `{type:"approval", c, card}`, `{type:"approval_resolved", id, outcome}`, `{type:"sessions", list}`, `{type:"pairing_requests", list}` (owner only)
- The web user is the **owner** (they hold the host token). The web UI is also the approval console for pairing requests.
- **Remote access**: keep the loopback bind. Document `tailscale serve --bg 7788` (tailnet-only HTTPS) and `ssh -N -L 7788:127.0.0.1:7788 host`. If `--host` is not loopback, require `--tls-cert/--tls-key` or `--insecure-http` (printed warning). Never use Funnel/public exposure without a separate password. P2: a `rcode gateway tailscale` helper.

### 3.8 Chat commands

| Command | Who | Effect |
|---|---|---|
| `/start [token]` | anyone | the deep-link pairing token, or help |
| `/help` | allowed | list commands |
| `/new` | allowed | `session.newSession()`; rotate the key's file |
| `/stop` | allowed | deny pending approvals, `session.abort()` |
| `/status` | allowed | model, mode, project/cwd, running/idle, messages, cost, pending approvals |
| `/model [ref]` | allowed (list) / owner (set, if `ownerOnly.model`) | `session.setModel` |
| `/mode [plan\|ask\|auto-edit]` | owner | `session.setMode`; `full` only if `gateway.allowFullAuto` **and** the chat is listed in `fullAutoChats` |
| `/project [name]` | owner | rebind the chat's cwd to a configured project root (disposes the session, new one in that cwd) |
| `/sessions`, `/resume <n>` | allowed | list/resume this key's recent sessions |
| `/undo` | allowed | `session.undo()` (revert the last turn's file edits) |
| `/compact [focus]` | allowed | `session.compact` |
| `/approve <id>`, `/deny <id>` | approver | text fallback |
| `/cron add "<sched>" <prompt>` / `/cron list` / `/cron rm <id>` | owner (P1) | scheduled prompts delivered here |
| `/heartbeat every 10m <prompt>` / `pause` / `clear` | owner (P1) | idle-only recurring prompt in this session |
| `/whoami` | anyone allowed | sender id, role, chat key |

Register them with `setMyCommands` (Telegram) or as Slack slash commands. In Telegram groups, handle `/cmd@botname`.

### 3.9 Configuration (`~/.rcode/config.json` → `gateway`)

```jsonc
{
  "gateway": {
    "projects": { "rcode": "~/Downloads/rcode", "site": "~/code/site" },  // the only cwds chats may use
    "defaultProject": "rcode",
    "mode": "ask",                       // default for every chat session (plan|ask|auto-edit)
    "allowFullAuto": false,              // must be true AND chat listed in fullAutoChats for /mode full
    "fullAutoChats": [],
    "approvalTimeoutSec": 600,
    "approvalTarget": "origin",          // origin | owner-dm
    "cronApprovals": "deny",             // deny | ask-owner
    "busyMode": "steer",                 // steer | queue | interrupt
    "idleDisposeMin": 30,
    "groups": { "enabled": false, "requireMention": true, "perUser": true, "chats": [] },
    "redactSecrets": true,
    "telegram": { "enabled": true, "tokenRef": "auth:telegram", "policy": "pairing", "allow": [],
                  "streaming": "progress", "notifications": "important" },
    "web": { "enabled": true, "host": "127.0.0.1", "port": 7788 },
    "slack": { "enabled": false, "botTokenRef": "auth:slack_bot", "appTokenRef": "auth:slack_app", "policy": "pairing" },
    "discord": { "enabled": false, "tokenRef": "auth:discord", "policy": "pairing" },
    "schedules": [
      { "id": "standup", "cron": "0 9 * * 1-5", "prompt": "Summarize yesterday's commits and open PRs", "deliver": "telegram:default:dm:123456789", "project": "rcode", "fresh": true }
    ]
  }
}
```

Secrets are **never** stored in config. `*Ref: "auth:<name>"` resolves from `~/.rcode/auth.json` (0600, already used by `loadAuth()`), and env overrides are `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `DISCORD_BOT_TOKEN`. `rcode login telegram <token>` validates with `getMe` and writes it. Log lines must mask tokens (`bot123:AA…xyz`), because a Telegram token is embedded in every API URL.

### 3.10 Scheduling

- **Parser** (zero deps, about 80 lines): a 5-field cron (`m h dom mon dow`, with `*`, `a-b`, `*/n` and lists), `every <n><s|m|h|d>`, `at <ISO>` (one-shot) and `daily HH:MM` (kept for back-compat). The timezone is the host's local time, with an optional `tz` per job via `Intl`.
- **Store**: `~/.rcode/gateway/cron.json` holds `{id, schedule, prompt, deliver, project, fresh, model?, enabled, lastRun, nextRun, lastStatus}`. Jobs can be created from config, `/cron add` or `rcode gateway cron add`.
- **Tick**: one timer to the earliest `nextRun`. On wake (including after sleep), each due job runs **once** and missed runs are coalesced. A job doesn't start again while its previous run is active.
- **Run**: `fresh: true` (the default) means a new ephemeral AgentSession in the project. Otherwise the job uses the delivery target's session (like `/heartbeat`). The asker follows `cronApprovals`. Output goes to `deliver` as the final message with `notify: true`. Errors and "blocked by approval" are reported in one message. **Cron runs cannot create cron jobs** (the `/cron` tool/command is disabled in cron context).
- **Heartbeat** (P1): `/heartbeat every 10m <prompt>`, min 60 s. It fires only when the session is idle and injects a normal user turn into the existing session. Its state lives in `state.sessions[key].heartbeat`.

### 3.11 Running as a service

`rcode gateway install` detects the platform. It resolves absolute paths for `bun` and the rcode entry (or the compiled `dist/rcode`) and writes:

**macOS:** `~/Library/LaunchAgents/dev.rcode.gateway.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.rcode.gateway</string>
  <key>ProgramArguments</key><array>
    <string>/Users/me/.bun/bin/bun</string><string>/Users/me/.rcode/bin/rcode.ts</string>
    <string>gateway</string><string>run</string></array>
  <key>WorkingDirectory</key><string>/Users/me</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/me/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardInPath</key><string>/dev/null</string>
  <key>StandardOutPath</key><string>/Users/me/.rcode/logs/gateway.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.rcode/logs/gateway.log</string>
</dict></plist>
```

Commands: `launchctl bootstrap gui/$(id -u) <plist>`, `launchctl kickstart -k gui/$(id -u)/dev.rcode.gateway` (restart), `launchctl bootout gui/$(id -u)/dev.rcode.gateway` (uninstall), `launchctl print gui/$(id -u)/dev.rcode.gateway` (status).

**Linux:** `~/.config/systemd/user/rcode-gateway.service`

```ini
[Unit]
Description=rcode gateway
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/home/me/.bun/bin/bun /home/me/.rcode/bin/rcode.ts gateway run
WorkingDirectory=/home/me
Environment=PATH=/home/me/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
RestartPreventExitStatus=78
UMask=0077
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Commands: `systemctl --user daemon-reload && systemctl --user enable --now rcode-gateway`, then `loginctl enable-linger $USER` so it runs without a login session (prompt the user before running it), and `journalctl --user -u rcode-gateway -f` for logs. Exit code 78 (EX_CONFIG) means "bad config, don't restart-loop". Windows (P2): `schtasks /Create /SC ONLOGON /TN rcode-gateway /TR …`.

The gateway handles `SIGTERM` by stopping polling (aborting the in-flight `getUpdates`), denying pending approvals, finishing/flushing the ledger and disposing sessions, all within a 20 s budget.

### 3.12 Telegram adapter: exact Bot API usage (plain `fetch`)

Base: `https://api.telegram.org/bot<TOKEN>/<method>`, `POST` with JSON body (`content-type: application/json`). Response: `{ok:true,result}` or `{ok:false,error_code,description,parameters?:{retry_after,migrate_to_chat_id}}`.

**Startup**

```http
POST /getMe                         {}                                → {id, is_bot, username}
POST /deleteWebhook                 {"drop_pending_updates": false}  → true   (else getUpdates = 409 Conflict)
POST /setMyCommands                 {"commands":[{"command":"new","description":"Start a fresh session"}, …],
                                     "scope":{"type":"all_private_chats"}}
```

**Receive loop (long polling)**

```http
POST /getUpdates  {"offset": <lastUpdateId+1>, "timeout": 50, "limit": 100,
                   "allowed_updates": ["message", "callback_query"]}
```

- Use an `AbortController` per request: abort on shutdown, and give the client a 65 s timeout (more than 50).
- Updates are confirmed by the *next* call's `offset`. Persist `offset` to `offsets.json` **after** handing each update to the router (a cheap in-memory enqueue). A crash then replays at most one batch, and dedupe via an LRU of `update_id`s.
- `Update`: `{update_id, message?: Message, callback_query?: CallbackQuery}`
- `Message`: `{message_id, from:{id,is_bot,first_name,username?}, chat:{id, type:"private"|"group"|"supergroup"|"channel"}, date, text?, caption?, entities?, photo?: PhotoSize[], document?: {file_id,file_name,mime_type,file_size}, voice?: {file_id,duration,mime_type}, message_thread_id?, is_topic_message?, reply_to_message?, forward_origin?}`
- `CallbackQuery`: `{id, from:{id,…}, message?: {message_id, chat:{id}, text}, data?: string, chat_instance}`
- Error handling: 409 means another poller or a webhook (log, back off 30 s, run `deleteWebhook` once). 401 means a bad token (exit 78). 429 means sleep `retry_after`. Network errors use exponential backoff from 1 s to 30 s.

**Send / stream**

```http
POST /sendMessage {"chat_id": 123, "message_thread_id": 7?, "text": "…",            // 1..4096 chars
                   "parse_mode": "HTML"?, "link_preview_options": {"is_disabled": true},
                   "reply_parameters": {"message_id": 42}?, "disable_notification": true?,
                   "reply_markup": {...}?}                                          → Message
POST /editMessageText {"chat_id": 123, "message_id": 99, "text": "…", "parse_mode": "HTML"?,
                       "link_preview_options": {"is_disabled": true}, "reply_markup": {...}?} → Message | true
POST /deleteMessage   {"chat_id": 123, "message_id": 99}
POST /sendChatAction  {"chat_id": 123, "message_thread_id": 7?, "action": "typing"}   // lasts ≈5 s
```

- **Formatting**: send plain text by default (safe). P1 is an HTML renderer for markdown (only `<b> <i> <code> <pre> <a>`, escaping `& < >`). On a `400 can't parse entities` error, resend as plain text. Avoid MarkdownV2 (its escaping is brittle).
- Ignore `400 Bad Request: message is not modified`. On `message to edit not found`, fall back to `sendMessage`.

**Streaming algorithm** (`streaming: "progress"` by default, `"partial"` optional):

- `progress`: send one status message with `disable_notification: true`: "⏳ working… · ⚙️ bash `npm test`" (the last 3 tool lines plus elapsed time). Edit it at most once per `editIntervalMs` (1000 ms in DMs, 3000 ms in groups, because of Telegram's group limit of about 20 msgs/min). At the end, **delete** it (or edit it to "✓ done in 42s · 5 tools") and send the final answer as a new message with notification, split at 4000 chars on paragraph or newline boundaries. The result is exactly one notification per turn.
- `partial`: the preview carries the answer text (the last 4000 chars, prefixed "…"). On finish, edit the preview into chunk 1 and send the rest. Keep a 4 s minimum dwell before deleting any preview.
- Coalescing: keep `pending` text and a single timer. Never have two edits in flight for one message. Skip the edit if the text is unchanged.
- **Flood gate per bot**: on a 429, set `pausedUntil = now + retry_after*1000`. While paused, `update()` only stores text and `send()` waits; `getUpdates` is exempt. There is a global cap of about 25 sends per second.

**Approval card**

```http
POST /sendMessage {
  "chat_id": 123, "text": "⚠️ Approve? (runs a command)\n\n$ git push origin main\n\ncwd ~/code/rcode · expires in 10 min — no answer = deny",
  "reply_markup": {"inline_keyboard": [[
      {"text": "✅ Allow once",        "callback_data": "ap1:a:9f3c2b1a7d4e5f60"},
      {"text": "♾ Allow for session", "callback_data": "ap1:s:9f3c2b1a7d4e5f60"}],
     [{"text": "❌ Deny",              "callback_data": "ap1:d:9f3c2b1a7d4e5f60"}]]}}
```

**On `callback_query`**

```http
POST /answerCallbackQuery {"callback_query_id": "<cq.id>", "text": "Allowed"|"Not authorized"|"Expired"}  // ≤200 chars; answer promptly
POST /editMessageText     {"chat_id": cq.message.chat.id, "message_id": cq.message.message_id,
                           "text": "<card text>\n\n✅ Allowed by @alice", "reply_markup": {"inline_keyboard": []}}
```

Authorization uses `cq.from.id`, which must be an owner, or an allowed user if configured. The chat must match the approval's address. The card text in an edit is re-rendered from the stored card, not from `cq.message.text`.

**Attachments**

```http
POST /getFile {"file_id": "<id>"}            → {"file_path": "photos/file_1.jpg", "file_size": 12345}
GET  https://api.telegram.org/file/bot<TOKEN>/<file_path>          // bot downloads capped at 20 MB
POST /sendDocument  (multipart/form-data: chat_id, document=<Blob name>, caption)   // via FormData + fetch
POST /sendPhoto     (multipart/form-data: chat_id, photo=<Blob>, caption)
```

- Photos are passed to the model as image content (the largest `PhotoSize`, mime from extension). Documents up to 20 MB are saved to `~/.rcode/gateway/inbox/<sessionKey>/<name>` and their path is mentioned in the prompt ("User attached file at …"). They are never executed, and paths are sanitized (no `..`).
- Voice (P2): download the `.oga` and transcribe via a configured STT provider; otherwise reply "voice not supported".
- Outbound files: a `send_file` tool exposed **only to gateway sessions** lets the agent send a file from inside the project root to the *current* chat. The target is fixed by the session key.

**Webhook mode (P2, optional)**: `POST /setWebhook {"url": "https://host/tg/<random-path>", "secret_token": "<32+ random chars>", "allowed_updates": [...]}`. Telegram sends the header `X-Telegram-Bot-Api-Secret-Token`, and the gateway refuses to start webhook mode without a secret and compares it with `timingSafeEqual`. Long polling stays the default.

**Rate limits to respect**: about 1 msg/s per chat, about 20 msgs/min per group, about 30 msgs/s per bot. Edits count. Keep `callback_data` ≤ 64 bytes and `text` ≤ 4096 chars (UTF-16 units, so measure `str.length` in JS, which already counts UTF-16).

### 3.13 Slack adapter (P1, plain fetch + Bun WebSocket, Socket Mode)

- App setup: enable Socket Mode, an app-level token `xapp-…` (`connections:write`) and a bot token `xoxb-…` with scopes `chat:write`, `im:history`, `im:read`, `app_mentions:read`, `files:read`, `commands` (opt). Events: `message.im`, `app_mention`. Interactivity on.
- Connect: `POST https://slack.com/api/apps.connections.open` with `Authorization: Bearer xapp-…` returns `{ok, url:"wss://…"}`. Then `new WebSocket(url)`.
- Envelopes: `{type:"hello"}`; `{envelope_id, type:"events_api", payload:{event:{type:"message", channel, user, text, ts, thread_ts?, bot_id?, channel_type:"im"}}}`; `{envelope_id, type:"interactive", payload:{type:"block_actions", user:{id}, channel:{id}, message:{ts}, actions:[{action_id, value}]}}`; `{envelope_id, type:"slash_commands", payload:{command, text, user_id, channel_id}}`; `{type:"disconnect"}` (reconnect). **Ack every envelope within 3 s**: `ws.send(JSON.stringify({envelope_id}))`.
- Send: `POST https://slack.com/api/chat.postMessage` (Bearer xoxb) `{channel, text, thread_ts, blocks?}` returns `{ts}`. Edit: `chat.update {channel, ts, text, blocks}`. Delete: `chat.delete`.
- Approval blocks: `[{type:"section",text:{type:"mrkdwn",text:"*Approve?* runs a command\n```git push```"}}, {type:"actions",elements:[{type:"button",text:{type:"plain_text",text:"Allow once"},style:"primary",action_id:"ap1:a",value:"<id>"}, {type:"button",text:{type:"plain_text",text:"Allow for session"},action_id:"ap1:s",value:"<id>"}, {type:"button",text:{type:"plain_text",text:"Deny"},style:"danger",action_id:"ap1:d",value:"<id>"}]}]`
- Limits: postMessage about 1/s per channel, `chat.update` Tier 3 (about 50/min), so `editIntervalMs` is 1500. Always reply in a thread (`thread_ts` = root ts), giving thread = session. Ignore events with `bot_id` or `subtype`.

### 3.14 Discord adapter (P1/P2, plain fetch + Bun WebSocket)

- `GET https://discord.com/api/v10/gateway/bot` (header `Authorization: Bot <token>`) returns `{url}`. Connect with `${url}/?v=10&encoding=json`.
- op 10 Hello `{heartbeat_interval}` means sending op 1 `{op:1,d:lastSeq}` every interval (with initial jitter). Then op 2 Identify `{token, intents, properties:{os, browser:"rcode", device:"rcode"}}`. Intents: `GUILDS(1<<0) | GUILD_MESSAGES(1<<9) | DIRECT_MESSAGES(1<<12) | MESSAGE_CONTENT(1<<15)` (MESSAGE_CONTENT is privileged, so enable it in the dev portal). Dispatches are op 0 with `t` = `READY` (store `session_id`, `resume_gateway_url`), `MESSAGE_CREATE`, `INTERACTION_CREATE`. op 7 or a dropped socket means resume (op 6 `{token, session_id, seq}`). op 9 means re-identify.
- Send: `POST /channels/{channel_id}/messages {content (≤2000), components?, message_reference?}`. Edit: `PATCH /channels/{channel_id}/messages/{message_id}`. Typing: `POST /channels/{id}/typing` (10 s). On 429, read `retry_after` (seconds, float) and the `X-RateLimit-*` headers.
- Buttons: `components:[{type:1,components:[{type:2,style:3,label:"Allow once",custom_id:"ap1:a:<id>"}, {type:2,style:2,label:"Allow for session",custom_id:"ap1:s:<id>"},{type:2,style:4,label:"Deny",custom_id:"ap1:d:<id>"}]}]`.
- Interaction (`INTERACTION_CREATE`, `type:3`): reply within **3 s** with `POST /interactions/{id}/{token}/callback` `{type:7, data:{content:"…✅ Allowed", components:[]}}` (UPDATE_MESSAGE). The user is `member.user.id` (guild) or `user.id` (DM).
- Threads are channels, so the session key uses the thread channel id. Text commands use the `/` or `!` prefix in P1, and registered application commands come in P2.

### 3.15 Files to add/change

| File | Change |
|---|---|
| `src/gateway/types.ts` | interface from §3.2 |
| `src/gateway/server.ts` | split into `daemon.ts` (lifecycle, lock, control socket), `router.ts` (authz, keys, commands, busy mode), `pool.ts` |
| `src/gateway/auth.ts` | pairing codes (hashed), deep-link tokens, owners/allowed, rate limits, lockout |
| `src/gateway/approvals.ts` | ApprovalBroker (§3.6) |
| `src/gateway/render.ts` | StreamRenderer: AgentEvent → progress/partial text; markdown→Telegram HTML; chunking |
| `src/gateway/telegram.ts` | §3.12 (persisted offset, deleteWebhook, abortable poll, flood gate, cards, files) |
| `src/gateway/web.ts` | fragment token → cookie, Origin check, full event stream, sessions + pairing panel |
| `src/gateway/cron.ts` | parser + store + tick (§3.10) |
| `src/gateway/service.ts` | launchd/systemd install/uninstall/status (§3.11) |
| `src/gateway/slack.ts`, `discord.ts` | P1/P2 |
| `src/cli.ts` | `rcode gateway [run|install|uninstall|start|stop|status|logs|pair|link|allow|revoke|sessions|cron|token]` |
| `tests/gateway/*.test.ts` | fake Bot API server via `Bun.serve` (set `apiRoot`), authz matrix, callback forgery, throttle |

---

## 4. Security requirements

Threat model: the bot token is a capability anyone can message. Chat platforms are third-party servers that store everything you send. Chat messages are a **remote shell trigger**: whoever can get text into a session can, via the model, run tools on your machine. So:

**Who may talk (default deny)**

- S1. No sender is admitted unless they are an owner, on the allowlist, or approved by pairing. Unknown senders get at most one pairing reply per 10 min, and nothing at all when pairing is disabled, the pending cap is reached or the channel is locked out.
- S2. Pairing codes: 8 chars × 32-symbol alphabet (40 bits), CSPRNG, 1 h TTL, single use, stored as salted SHA-256, compared in constant time, never logged, max 3 pending per channel, lockout for 1 h after 5 failures. Deep-link tokens: 128-bit, 10 min, single use.
- S3. Groups are disabled by default. When enabled: only listed chat ids, `requireMention`, the sender must still be allowed (being a member is not enough), and per-user sessions by default. Messages from bots (`is_bot`, `bot_id`) are dropped (loop guard).
- S4. Roles: **owner** (approve tools, pair, `/mode`, `/project`, `/cron`) vs **allowed** (chat only, plus approve in their own chat only if `allowedUsersMayApprove`). The first pairing on a fresh install becomes owner and this is printed explicitly.

**What a chat may do**

- S5. Every chat session defaults to `mode: "ask"` (gateway config `mode`, allowed values `plan|ask|auto-edit`). `full` is impossible from chat unless `allowFullAuto: true` **and** the chat id is in `fullAutoChats`. Even then, `classifyCommand` "catastrophic" stays hard-denied (already in `policy.ts`).
- S6. Allow rules are never persisted from chat (no "always" button). Session-scoped allows die with the session, `/new` or idle disposal.
- S7. Approvals: unguessable ids, bound to chat + approver, single settle, a timeout means **deny**, undeliverable means **deny**, `/stop` means deny-all. The card shows the exact command/path/URL and cwd (escaped and truncated with a marker), never a model-written paraphrase.
- S8. Headless (cron/heartbeat/webhook) runs: `cronApprovals: "deny"` by default. Cron cannot create cron jobs. Scheduled prompts come only from host config/owner commands.
- S9. Working directories are limited to `gateway.projects`. `/project` cannot take a raw path from chat. Attachments are stored under `~/.rcode/gateway/inbox/…` with sanitized names, never executed, and capped in size.
- S10. The reply target is fixed by the session key. Tools exposed to gateway sessions (`send_file`) cannot address other chats. Session keys are routing data, not credentials.

**Prompt injection from chat**

- S11. Only the allowed sender's own text is treated as the user's instruction. Forwarded messages, quoted replies (`reply_to_message`), other group members' text, file contents and OCR'd images are wrapped as untrusted context, e.g. `<untrusted source="telegram-forward">…</untrusted>`, with a system note that instructions inside must not be followed without confirmation.
- S12. Because injection can also arrive via web pages, files or repo content the agent reads, the approval layer, not the model, is the security boundary. Keep `ask` defaults for writes, network and non-safe bash. Document that `auto-edit` over chat means anything that edits files can be steered by a malicious README.
- S13. Bot commands are parsed by the gateway before the model sees anything. The model cannot invoke `/mode`, `/project`, `/cron` or pairing.

**Secrets and data**

- S14. Tokens only in `~/.rcode/auth.json` (0600) or env vars, never in `config.json`, the unit file, the plist or logs. Mask `bot<token>` in every logged URL and error. State and log files are written with mode 0600 and dirs 0700; services use `Umask 077`.
- S15. Outbound redaction (`redactSecrets: true`): before sending any text to a third-party chat, replace matches of common secret patterns (`sk-ant-…`, `sk-…`, `ghp_…`, `xox[bap]-…`, AWS `AKIA…`, PEM private-key blocks, `.env`-style `KEY=…` for keys named *TOKEN|SECRET|PASSWORD|KEY*) with `[redacted]`. Warn in docs that tool output streamed to Telegram/Slack lives on their servers.
- S16. Web UI: loopback bind by default. The token goes in the URL fragment and is then swapped for an HttpOnly SameSite=Strict cookie. Requests need an Origin check (WS + POST) and a CSP. Non-loopback binds require TLS or an explicit `--insecure-http`. Recommend Tailscale Serve or SSH tunnel; never a public Funnel without an extra password.
- S17. Webhook mode (P2) refuses to start without `secret_token`, checks it in constant time and uses an unguessable path.
- S18. Audit log `~/.rcode/gateway/audit.jsonl`: pairing requests/approvals/revokes, every approval card + outcome + approver, mode/project changes, cron runs. `rcode gateway status` shows the last entries.
- S19. Run as a normal user (never root). Refuse to start as uid 0 unless `--allow-root`.

---

## 5. Priorities

### P0: "talk to rcode from my phone, safely" (ship first)

- Harden the existing Telegram adapter: `deleteWebhook`, abortable 50 s long poll, persisted offset plus `update_id` dedupe, flood gate on 429, `editIntervalMs` 1000/3000, ignore "not modified".
- Auth module: hashed 8-char pairing codes with rate limit/cap/lockout, **deep-link owner pairing** (`rcode gateway link` with a QR code), owners vs allowed, private chats only, bot senders dropped.
- ApprovalBroker: random ids, chat + approver binding, `ap1:` callback data, timeout and undeliverable both mean deny, card shows exact detail, card edited on resolve/expiry, `/stop` denies pending.
- Router: session keys (§3.3), a promise-cached SessionPool with idle disposal, busy mode `steer`, per-sender rate limit.
- Commands: `/help /new /stop /status /model /mode /undo /whoami /start <token>`, with `full` blocked by default.
- Streaming renderer in `progress` mode (one quiet status message, final answer as a new notifying message, chunking).
- Web UI: fragment token → cookie, Origin check, full event stream, approval + pairing console, session picker.
- Single-instance lock + unix control socket; CLI `rcode gateway run|pair|link|allow|revoke|status`.
- Secrets in auth.json, token masking in logs, outbound secret redaction, audit log.
- `rcode gateway install|uninstall|start|stop|logs` for launchd + systemd user (plus a linger prompt).
- Tests: a fake Bot API (`Bun.serve`) covering the authz matrix, forged/foreign callback rejection, expiry → deny, throttle coalescing, offset persistence.

### P1: "it's my daily driver"

- Cron store + 5-field parser + `/cron` + headless deny policy; `/heartbeat`.
- `/project` with `gateway.projects`; `/sessions` + `/resume`; `/compact`.
- Photos → images, documents → inbox; a `send_file` tool scoped to the current chat.
- Markdown → Telegram HTML renderer with plain-text fallback; `partial` streaming mode.
- Slack adapter (Socket Mode, Block Kit buttons, thread = session).
- Delivery ledger for final replies (redeliver after a crash, labeled as recovered).
- Notification policy (`important`: only final, approval and errors ring).
- Optional groups with mention gating and per-user sessions; approvals to the owner DM (`approvalTarget: owner-dm`).
- `rcode doctor` checks: token valid, webhook not set, service installed, linger, perms 0600.

### P2: "everywhere"

- Discord adapter (gateway WS, components, interactions).
- Telegram extras: forum/private-chat topics as multi-session, `sendMessageDraft` native streaming in DMs, voice transcription, webhook mode with secret, Mini App opening the web UI.
- Signal (signal-cli JSON-RPC + SSE) and email (IMAP/SMTP) adapters. WhatsApp via an external bridge only (no Baileys in core).
- Generic HMAC webhook triggers (GitHub/CI) → cron-like runs; an OpenAI-compatible HTTP endpoint.
- `rcode gateway tailscale` helper (Serve setup), Windows Scheduled Task service.
- LLM "auto-review" approval mode (like OpenClaw `workspace` / Hermes `smart`) as an opt-in between ask and auto-edit.
- Multi-profile gateways (separate homes and tokens per trust boundary), as both projects recommend for mutually untrusted users.

---

## 6. Appendix: quick reference of reference-project paths

OpenClaw: `docs/concepts/architecture.md`, `docs/gateway/{remote,tailscale,permission-modes,sandboxing,heartbeat,configuration}.md`, `docs/gateway/security/{access-control,trust-model,prompt-injection}.md`, `docs/channels/{pairing,channel-routing}.md`, `docs/channels/telegram/{messaging,rich-messages,transports}.md`, `docs/automation/cron-jobs.md`, `docs/web/control-ui.md`, `src/channels/plugins/{types.plugin,pairing.types}.ts`, `src/daemon/{launchd-plist,systemd-unit,constants}.ts`, `extensions/telegram/src/{approval-callback-data,draft-stream,account-throttler,allowed-updates}.ts`.

Hermes Agent: `website/docs/user-guide/messaging/{index,telegram,slack,signal,email,whatsapp,webhooks,relay}.md`, `website/docs/user-guide/{security,sessions}.md`, `website/docs/user-guide/features/{cron,heartbeat,curator,memory,skills}.md`, `gateway/{pairing,session,delivery_ledger,run}.py`, `gateway/platforms/{base,base_exec_approval}.py`, `plugins/platforms/telegram/adapter.py` (approval buttons, around line 4252; callback router, around line 4730), `hermes_cli/gateway.py` (launchd/systemd/linger).
