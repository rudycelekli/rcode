import { rmSync, writeFileSync } from "node:fs";
/**
 * AgentSession — the one object every frontend (TUI, print, RPC, ACP, SDK) drives.
 * Wires: config · model/auth · tools (core + task + memory + MCP) · permissions · shell hooks ·
 * session persistence · compaction · memory injection · steering/follow-up queues · slash commands.
 */
import { Agent } from "../agent/loop.ts";
import type { AgentEvent, AgentHooks, BeforeToolCall, PermissionDecision, Tool } from "../agent/types.ts";
import { apiKeyFor, defaultModelRef, resolveModel, resolveTier } from "../ai/models.ts";
import type { Message, Model, ThinkingLevel, UserContent } from "../ai/types.ts";
import { loadAuth, loadConfig, type RcodeConfig } from "../config.ts";
import "../config-surface.ts";
import { buildSystemPrompt, environmentBlock } from "../context/system-prompt.ts";
import { expandCommand, setClaudeHomeImport, loadAgents, loadCommands, loadSkills, type AgentDef, type Command, type Skill } from "../ext/resources.ts";
import { ShellHooks } from "../hooks/shell-hooks.ts";
import { McpManager } from "../mcp/manager.ts";
import { createLazyMcpTools } from "../mcp/lazy.ts";
import { createMemoryTools, getMemory, memoryContext, type MemoryProvider } from "../memory/index.ts";
import { captureLessons, sessionMemoryBlock } from "../memory/capture.ts";
import { PermissionPolicy, type Asker, type PermissionMode } from "../permissions/policy.ts";
import { contextTokens, DEFAULT_COMPACTION, findCutPoint, shouldCompact, summarize, type CompactionSettings } from "../session/compaction.ts";
import { Session, RCODE_HOME } from "../session/store.ts";
import { coreTools, filterTools } from "../tools/index.ts";
import { createTaskTool } from "../tools/task.ts";
import { killAllJobs } from "../tools/bash.ts";
import { maskStale } from "../context/prune.ts";
import { VerifyGate } from "./verify-gate.ts";
import { Checkpoints } from "./checkpoints.ts";
import { sandboxBackend } from "../tools/sandbox.ts";
import { Guards } from "./guards.ts";
import { RuvnetIntegration } from "../integrations/ruvnet.ts";
import { ThreatGuard } from "../guard/rules.ts";
import { buildReceipt, formatReceipt, sealReceipt, type TurnReceipt } from "./receipt.ts";
import { syntaxNote } from "../tools/diagnostics.ts";
import { Telemetry } from "../telemetry/beacon.ts";
import { join } from "node:path";

export interface SessionOptions {
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  mode?: PermissionMode;
  /** "continue" = latest session for cwd; a path = specific file; undefined = new. */
  resume?: "continue" | string;
  ephemeral?: boolean;
  asker?: Asker;
  /** Disable MCP/memory/ruvnet for fast headless runs. */
  minimal?: boolean;
  tools?: string[];
  systemPromptAppend?: string;
  maxTurns?: number;
}

export class AgentSession {
  config!: RcodeConfig;
  model!: Model;
  agent!: Agent;
  session!: Session;
  policy!: PermissionPolicy;
  mcp?: McpManager;
  memory?: MemoryProvider;
  ruvnet?: RuvnetIntegration;
  skills: Skill[] = [];
  commands: Command[] = [];
  agentDefs: AgentDef[] = [];
  thinking: ThinkingLevel = "medium";
  private hooks!: ShellHooks;
  private steerQ: UserContent[][] = [];
  private followQ: UserContent[][] = [];
  private msgIds: string[] = [];
  private listeners = new Set<(e: AgentEvent) => void>();
  private compacting = false;
  private compaction: CompactionSettings = DEFAULT_COMPACTION;
  private auth: Record<string, string> = {};
  goal?: string;
  private envBlock = "";
  private memoryBlock?: string;
  private toolsDirty = false;
  private turn = 0;
  readonly verifyGate = new VerifyGate();
  checkpoints?: Checkpoints;
  guards = new Guards();
  threat = new ThreatGuard();
  lastReceipt?: TurnReceipt;
  private telemetry?: Telemetry;
  private promptId = "";

  constructor(readonly opts: SessionOptions) {}

  get cwd() { return this.opts.cwd; }
  get mode() { return this.policy.mode; }

  async init(): Promise<this> {
    const o = this.opts;
    this.config = loadConfig(o.cwd);
    this.auth = loadAuth();
    this.thinking = o.thinking ?? this.config.thinking ?? "medium";
    this.compaction = { ...DEFAULT_COMPACTION, ...this.config.compaction };
    const ref = o.model ?? this.config.model ?? defaultModelRef(this.auth);
    const model = resolveModel(ref);
    if (!model) throw new Error(`Unknown model "${ref}". Try provider/model, e.g. anthropic/claude-opus-5-5, openai/gpt-5, ollama/qwen3-coder.`);
    this.model = model;

    this.envBlock = environmentBlock(o.cwd);
    this.guards = new Guards(this.config.guards ?? []);
    this.threat = new ThreatGuard(this.config.rules !== "off");
    this.policy = new PermissionPolicy(o.mode ?? this.config.permissionMode ?? "ask", { allow: this.config.permissions?.allow ?? [], deny: this.config.permissions?.deny ?? [] }, o.asker);
    this.hooks = new ShellHooks(this.config.hooks ?? [], o.cwd);
    setClaudeHomeImport(!!this.config.compat?.claudeHome);
    this.skills = loadSkills(o.cwd, this.config.paths?.skills);
    this.commands = loadCommands(o.cwd, this.config.paths?.commands);
    this.agentDefs = loadAgents(o.cwd, this.config.paths?.agents);

    // Session persistence
    if (o.resume === "continue") { const f = Session.latest(o.cwd); this.session = f ? Session.open(f) : Session.create(o.cwd, { ephemeral: o.ephemeral }); }
    else if (o.resume) this.session = Session.open(o.resume);
    else this.session = Session.create(o.cwd, { ephemeral: o.ephemeral });
    if (this.session.meta.model && !o.model) { const m = resolveModel(this.session.meta.model); if (m) this.model = m; }

    if (!o.minimal) {
      if (this.config.memory?.enabled !== false && this.config.memory?.provider !== "off") {
        getMemory((this.config.memory?.provider as any) ?? "auto", this.config.memory?.embeddings ?? "hash").then(async (m) => {
          this.memory = m;
          // Session-start memory is computed once so the system prompt stays cache-stable for the session.
          this.memoryBlock = await sessionMemoryBlock(m, this.cwd).catch(() => undefined);
          if (this.memoryBlock) this.refreshTools();
        }).catch(() => {});
      }
      const servers = { ...(this.config.mcpServers ?? {}) };
      this.ruvnet = new RuvnetIntegration(this.config, o.cwd);
      Object.assign(servers, this.ruvnet.mcpServers());
      if (Object.keys(servers).length) {
        this.mcp = new McpManager(servers, o.cwd);
        this.mcp.onChange(() => this.refreshTools());
        this.ruvnet.attach(this.mcp);
        void this.mcp.connectAll();
      }
    }

    this.checkpoints = new Checkpoints(o.cwd, this.session.id, this.config.checkpoints !== false && !o.ephemeral);
    if (this.config.telemetry !== "off" && !o.minimal && !o.ephemeral) {
      this.telemetry = new Telemetry(join(RCODE_HOME, "telemetry", "runtime.jsonl"));
    }
    this.agent = new Agent({
      model: this.model,
      apiKey: apiKeyFor(this.model, this.auth),
      systemPrompt: "",
      tools: [],
      thinking: this.thinking,
      cwd: o.cwd,
      sessionId: this.session.id,
      maxTurns: o.maxTurns ?? this.config.maxTurns,
      hooks: this.agentHooks(),
    });
    this.applySandbox();
    this.refreshTools();
    const ctx = this.session.buildContext();
    this.agent.messages = ctx.messages;
    this.msgIds = ctx.ids;
    this.agent.subscribe((e) => {
      for (const l of this.listeners) l(e);
      if (this.promptId) this.telemetry?.onAgent(this.session.id, this.promptId, e);
    });
    if (this.hooks.has("SessionStart")) {
      const r = await this.hooks.run("SessionStart", { session_id: this.session.id, source: o.resume ? "resume" : "startup" });
      if (r.context) this.opts.systemPromptAppend = [this.opts.systemPromptAppend, r.context].filter(Boolean).join("\n");
      this.refreshTools();
    }
    return this;
  }

  subscribe(l: (e: AgentEvent) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(e: AgentEvent) { for (const l of this.listeners) l(e); }

  /** All tools available to the main agent. */
  private buildTools(): Tool[] {
    const memTools = this.opts.minimal || this.config.memory?.enabled === false ? [] : createMemoryTools(() => getMemory((this.config.memory?.provider as any) ?? "auto", this.config.memory?.embeddings ?? "hash"), this.cwd);
    const task = createTaskTool({
      agents: () => this.agentDefs,
      maxDepth: 2,
      maxParallel: 6,
      escalate: this.config.router?.escalate !== false,
      build: (def, depth, tier) => {
        const model = resolveTier(tier ?? def?.model, this.model, this.config.smallModel);
        let tools = filterTools([...coreTools(this.config.tools), ...memTools, ...this.mcpTools()], def?.tools);
        if (depth < 2) tools = [...tools, task];
        const base = buildSystemPrompt({ cwd: this.cwd, tools, env: this.envBlock, subagent: true, mode: this.policy.mode === "plan" ? "plan" : "default" });
        return { model, apiKey: apiKeyFor(model, this.auth), tools, systemPrompt: def ? `${base}\n\n# Your role: ${def.name}\n${def.body}` : base, hooks: { beforeToolCall: (c) => this.gateTool(c, false) } };
      },
    });
    const all = [...coreTools(this.config.tools), task, ...memTools, ...this.mcpTools()];
    return filterTools(all, this.opts.tools);
  }

  /** MCP tools: inline when few, behind mcp_search/mcp_call when many (saves context, improves selection). */
  private mcpTools(): Tool[] {
    const tools = this.mcp?.getTools() ?? [];
    const threshold = this.config.mcpLazyThreshold ?? 30;
    if (tools.length <= threshold) return tools;
    return createLazyMcpTools(() => this.mcp?.getTools() ?? []);
  }

  refreshTools() {
    if (!this.agent) return;
    // Never change tools/system prompt mid-turn: it breaks the prompt cache and confuses the model.
    if (this.agent.isRunning) { this.toolsDirty = true; return; }
    this.toolsDirty = false;
    const tools = this.buildTools();
    this.agent.config.tools = tools;
    this.agent.config.systemPrompt = buildSystemPrompt({
      cwd: this.cwd, tools, skills: this.skills, mode: this.policy.mode === "plan" ? "plan" : "default",
      extra: this.opts.systemPromptAppend || undefined,
      env: this.envBlock,
      memory: this.memoryBlock,
    });
  }

  /** Shell hooks (main agent only), threat rules, guard modes, then the permission policy. */
  private async gateTool(c: BeforeToolCall, shell: boolean): Promise<PermissionDecision> {
    if (shell && this.hooks.has("PreToolUse")) {
      const r = await this.hooks.run("PreToolUse", { session_id: this.session.id, tool_name: c.tool.name, tool_input: c.args }, c.tool.name);
      if (r.block) return { action: "deny", reason: `Hook: ${r.block}` };
    }
    const hit = this.threat.check(c.tool.name, c.args);
    if (hit?.action === "deny") {
      this.telemetry?.denied(this.session.id, this.promptId || this.session.id, c.tool.name, hit.reason ?? "");
      return hit;
    }
    if (hit?.action === "ask" && this.policy.mode !== "full") {
      if (!this.policy.asker) return { action: "deny", reason: `${hit.reason} Needs approval and there is no interactive user. Re-run with --yes or choose another path.` };
      let summary = c.tool.name;
      try { summary = c.tool.summarize?.(c.args as never) ?? summary; } catch { /* keep the tool name */ }
      const ans = await this.policy.asker({ tool: c.tool, args: c.args, summary, reason: hit.reason ?? "threat rule" });
      if (ans === "deny") return { action: "deny", reason: "The user declined this action." };
    }
    const guard = this.guards.check(c.tool.name, c.args);
    if (guard) return guard;
    return this.policy.decide(c);
  }

  private agentHooks(): AgentHooks {
    return {
      transformContext: (messages) => maskStale(messages),
      onMessage: (m) => { this.msgIds.push(this.session.appendMessage(m)); },
      beforeToolCall: (c) => this.gateTool(c, true),
      afterToolCall: async (c) => {
        if (!c.result.isError) this.threat.observe(c.tool.name, c.args);
        if (this.hooks.has("PostToolUse")) await this.hooks.run("PostToolUse", { session_id: this.session.id, tool_name: c.tool.name, tool_input: c.args, tool_response: c.result.content.map((x) => (x.type === "text" ? x.text : "[image]")).join("").slice(0, 20000) }, c.tool.name);
        this.ruvnet?.afterTool(c.tool.name, c.args, !c.result.isError);
        this.verifyGate.onTool(c.tool.name, c.args, !!c.result.isError);
        if (this.config.diagnostics !== "off" && !c.result.isError && (c.tool.name === "edit" || c.tool.name === "write")) {
          const note = syntaxNote(this.cwd, String(c.args.path ?? ""));
          if (note) {
            const content = c.result.content.map((x) => x.type === "text" ? { ...x, text: `${x.text}\n\n[syntax] ${note}\nThe edit was saved. Fix the syntax error before continuing.` } : x);
            return { ...c.result, content: content.length ? content : [{ type: "text" as const, text: `[syntax] ${note}` }] };
          }
        }
      },
      maybeCompact: async (messages, lastUsage) => {
        if (this.compacting) return;
        if (shouldCompact(this.model, contextTokens(messages, lastUsage), this.compaction)) await this.compact();
      },
      onContextOverflow: async () => { try { await this.compact(); return true; } catch { return false; } },
      getSteering: () => this.steerQ.splice(0),
      getFollowUp: () => this.followQ.splice(0),
      onStop: async (messages) => {
        if (this.hooks.has("Stop")) {
          const r = await this.hooks.run("Stop", { session_id: this.session.id });
          if (r.block) return r.block;
        }
        if (this.policy.mode !== "plan" && this.config.verifyGate !== false) {
          const last = [...messages].reverse().find((m) => m.role === "assistant");
          const text = last?.role === "assistant" ? last.content.filter((c) => c.type === "text").map((c: any) => c.text).join("") : "";
          return this.verifyGate.check(text);
        }
        return undefined;
      },
    };
  }

  /** Send a prompt (handles markdown slash commands, memory injection, UserPromptSubmit hooks). */
  async prompt(input: string, images: UserContent[] = []): Promise<void> {
    let textIn = input;
    const m = input.match(/^\/([\w:-]+)\s*([\s\S]*)$/);
    if (m) {
      const cmd = this.commands.find((c) => c.name === m[1]);
      if (cmd) textIn = expandCommand(cmd, m[2] ?? "");
    }
    if (this.hooks.has("UserPromptSubmit")) {
      const r = await this.hooks.run("UserPromptSubmit", { session_id: this.session.id, prompt: textIn });
      if (r.block) { this.emit({ type: "notice", level: "warn", text: `Prompt blocked by hook: ${r.block}` }); return; }
      if (r.context) textIn += `\n\n<hook_context>\n${r.context}\n</hook_context>`;
    }
    const parts: UserContent[] = [];
    let mem = this.memory ? await memoryContext(this.memory, input, this.cwd, this.config.memory?.maxInject ?? 5).catch(() => undefined) : undefined;
    // Don't repeat memories already present in the session-start block.
    if (mem && this.memoryBlock) mem = mem.split("\n").filter((l) => !this.memoryBlock!.includes(l.replace(/^- /, ""))).join("\n") || undefined;
    const ruv = await this.ruvnet?.beforePrompt(input).catch(() => undefined);
    const goalBlock = this.goal ? `<active_goal>\n${this.goal}\nKeep working until this goal is met or you are genuinely blocked.\n</active_goal>` : undefined;
    const ctxBlocks = [mem && `<relevant_memories>\n${mem}\n</relevant_memories>`, ruv, goalBlock].filter(Boolean);
    parts.push({ type: "text", text: ctxBlocks.length ? `${ctxBlocks.join("\n")}\n\n${textIn}` : textIn });
    parts.push(...images);
    if (!this.session.title) this.session.setMeta({ title: input.slice(0, 80), model: `${this.model.provider}/${this.model.id}` });
    if (this.toolsDirty) this.refreshTools();
    this.agent.state.set("turn", ++this.turn);
    this.promptId = `${this.session.id}:${this.turn}`;
    this.telemetry?.prompt(this.session.id, this.promptId, textIn);
    this.checkpoints?.snapshot(this.turn);
    this.verifyGate.reset();
    this.guards.resetTurn();
    const startIdx = this.agent.messages.length;
    const costBefore = this.agent.usage.cost.total;
    await this.agent.prompt(parts);
    const slice = this.agent.messages.slice(startIdx);
    const receipt = sealReceipt(buildReceipt(slice, this.turn, this.agent.usage.cost.total - costBefore), this.lastReceipt?.hash ?? null);
    this.lastReceipt = receipt;
    this.session.appendCustom("receipt", receipt);
    this.telemetry?.completed(this.session.id, this.promptId, receipt.verdict, receipt.hash, receipt.stopReason);
    this.emit({ type: "notice", level: "info", text: formatReceipt(receipt).split("\n")[0]! });
    if (this.toolsDirty) this.refreshTools();
    if (this.memory && this.config.memory?.autoCapture !== false && !this.opts.minimal) {
      const turn = this.agent.messages.slice(startIdx);
      const small = resolveTier("fast", this.model, this.config.smallModel);
      void captureLessons({ model: small, apiKey: apiKeyFor(small, this.auth), memory: this.memory, project: this.cwd, turn })
        .then((n) => { if (n) this.emit({ type: "notice", level: "info", text: `🧠 learned ${n} thing${n > 1 ? "s" : ""} for next time (/memory to review)` }); })
        .catch(() => {});
    }
    this.ruvnet?.afterPrompt(input, this.agent.messages);
  }

  steer(text: string) { this.steerQ.push([{ type: "text", text }]); }
  followUp(text: string) { this.followQ.push([{ type: "text", text }]); }
  abort() { this.agent.abort(); this.steerQ.length = 0; }
  get isRunning() { return this.agent.isRunning; }
  get messages(): Message[] { return this.agent.messages; }

  setModel(ref: string): Model {
    const m = resolveModel(ref);
    if (!m) throw new Error(`Unknown model "${ref}"`);
    this.model = m;
    this.agent.config.model = m;
    this.agent.config.apiKey = apiKeyFor(m, this.auth);
    this.session.setMeta({ model: `${m.provider}/${m.id}` });
    return m;
  }
  setThinking(t: ThinkingLevel) { this.thinking = t; this.agent.config.thinking = t; this.session.setMeta({ thinking: t }); }
  setMode(mode: PermissionMode) { this.policy.mode = mode; this.applySandbox(); this.refreshTools(); }

  /** Sandbox bash in ask/auto-edit (and plan) by default; full mode runs unsandboxed unless sandbox:"always". */
  private applySandbox() {
    const cfg = this.config.sandbox ?? "auto";
    const backend = sandboxBackend();
    const on = !!backend && cfg !== "off" && (cfg === "always" || this.policy.mode !== "full");
    this.agent.state.set("sandbox", { enabled: on, network: this.config.sandboxNetwork ?? false });
    this.policy.sandboxed = on;
  }
  get sandboxStatus() { const p = this.agent.state.get("sandbox") as any; return p?.enabled ? `${sandboxBackend()}${p.network ? "" : ", no network"}` : "off"; }
  setGoal(goal?: string) { this.goal = goal; }

  /** Revert file changes made by edit/write during the most recent turn that changed files. */
  undo(): { turn: number; files: string[]; via: "git" | "history" } | undefined {
    // Prefer git checkpoints (cover bash-made changes too); fall back to edit/write pre-images.
    const viaGit = this.checkpoints?.undo();
    if (viaGit) {
      const h0 = this.agent.state.get("fileHistory") as Array<{ turn: number }> | undefined;
      if (h0) this.agent.state.set("fileHistory", h0.filter((x) => x.turn < viaGit.turn));
      (this.agent.state.get("reads") as Map<string, unknown> | undefined)?.clear();
      return { ...viaGit, via: "git" };
    }
    const h = this.agent.state.get("fileHistory") as Array<{ turn: number; path: string; content: string | null }> | undefined;
    if (!h?.length) return undefined;
    const turn = h[h.length - 1]!.turn;
    const snaps = h.filter((x) => x.turn === turn);
    for (const s of snaps) {
      try { if (s.content === null) rmSync(s.path, { force: true }); else writeFileSync(s.path, s.content); } catch {}
    }
    this.agent.state.set("fileHistory", h.filter((x) => x.turn !== turn));
    (this.agent.state.get("reads") as Map<string, unknown> | undefined)?.clear();
    return { turn, files: snaps.map((s) => s.path), via: "history" };
  }

  async compact(focus?: string): Promise<void> {
    if (this.compacting) return;
    this.compacting = true;
    try {
      const msgs = this.agent.messages;
      const cut = findCutPoint(msgs, this.compaction.keepRecentTokens);
      if (cut <= 1) return;
      const before = contextTokens(msgs);
      if (this.hooks.has("PreCompact")) await this.hooks.run("PreCompact", { session_id: this.session.id });
      const prev = msgs[0]?.role === "user" && msgs[0].timestamp === 0 ? (msgs[0].content[0] as any)?.text : undefined;
      const summary = await summarize(this.model, apiKeyFor(this.model, this.auth), msgs.slice(prev ? 1 : 0, cut), prev, focus);
      const firstKeptId = this.msgIds[cut] && this.msgIds[cut] !== "compaction" ? this.msgIds[cut]! : null;
      this.session.appendCompaction(summary, firstKeptId, before);
      const ctx = this.session.buildContext();
      this.agent.messages = ctx.messages;
      this.msgIds = ctx.ids;
      this.emit({ type: "compaction", before, after: contextTokens(ctx.messages), summary });
    } finally { this.compacting = false; }
  }

  newSession() {
    this.session = Session.create(this.cwd, { ephemeral: this.opts.ephemeral });
    this.agent.messages = []; this.msgIds = [];
    this.agent.config.sessionId = this.session.id;
    this.agent.usage = { ...this.agent.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  }

  resume(file: string) {
    this.session = Session.open(file);
    const ctx = this.session.buildContext();
    this.agent.messages = ctx.messages; this.msgIds = ctx.ids;
    this.agent.config.sessionId = this.session.id;
  }

  fork(): string {
    const s = this.session.fork();
    this.session = s;
    this.agent.config.sessionId = s.id;
    const ctx = s.buildContext();
    this.msgIds = ctx.ids;
    s.flush();
    return s.file;
  }

  /** Branch: rewind to before the Nth-from-last user message (keeps the old branch in the tree). */
  rewind(userTurnsBack = 1): string | undefined {
    const path = this.session.path().filter((e) => e.type === "message");
    const users = path.filter((e: any) => e.message.role === "user");
    const target = users[users.length - userTurnsBack] as any;
    if (!target) return undefined;
    this.session.setLeaf(target.parentId);
    const ctx = this.session.buildContext();
    this.agent.messages = ctx.messages; this.msgIds = ctx.ids;
    return target.message.content.map((c: any) => c.text ?? "").join("");
  }

  async dispose() {
    try { if (this.hooks.has("SessionEnd")) await this.hooks.run("SessionEnd", { session_id: this.session.id }); } catch {}
    this.session.flush();
    killAllJobs();
    await this.mcp?.close();
    await this.ruvnet?.close();
  }
}
