/**
 * AgentSession — the one object every frontend (TUI, print, RPC, ACP, SDK) drives.
 * Wires: config · model/auth · tools (core + task + memory + MCP) · permissions · shell hooks ·
 * session persistence · compaction · memory injection · steering/follow-up queues · slash commands.
 */
import { Agent } from "../agent/loop.ts";
import type { AgentEvent, AgentHooks, Tool } from "../agent/types.ts";
import { apiKeyFor, defaultModelRef, resolveModel } from "../ai/models.ts";
import type { Message, Model, ThinkingLevel, UserContent } from "../ai/types.ts";
import { loadAuth, loadConfig, type RcodeConfig } from "../config.ts";
import { buildSystemPrompt } from "../context/system-prompt.ts";
import { expandCommand, loadAgents, loadCommands, loadSkills, type AgentDef, type Command, type Skill } from "../ext/resources.ts";
import { ShellHooks } from "../hooks/shell-hooks.ts";
import { McpManager } from "../mcp/manager.ts";
import { createMemoryTools, getMemory, memoryContext, type MemoryProvider } from "../memory/index.ts";
import { PermissionPolicy, type Asker, type PermissionMode } from "../permissions/policy.ts";
import { contextTokens, DEFAULT_COMPACTION, findCutPoint, shouldCompact, summarize, type CompactionSettings } from "../session/compaction.ts";
import { Session } from "../session/store.ts";
import { coreTools, filterTools } from "../tools/index.ts";
import { createTaskTool } from "../tools/task.ts";
import { killAllJobs } from "../tools/bash.ts";
import { RuvnetIntegration } from "../integrations/ruvnet.ts";

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

    this.policy = new PermissionPolicy(o.mode ?? this.config.permissionMode ?? "ask", { allow: this.config.permissions?.allow ?? [], deny: this.config.permissions?.deny ?? [] }, o.asker);
    this.hooks = new ShellHooks(this.config.hooks ?? [], o.cwd);
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
        getMemory((this.config.memory?.provider as any) ?? "auto").then((m) => (this.memory = m)).catch(() => {});
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
    this.refreshTools();
    const ctx = this.session.buildContext();
    this.agent.messages = ctx.messages;
    this.msgIds = ctx.ids;
    this.agent.subscribe((e) => { for (const l of this.listeners) l(e); });
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
    const memTools = this.opts.minimal || this.config.memory?.enabled === false ? [] : createMemoryTools(() => getMemory((this.config.memory?.provider as any) ?? "auto"), this.cwd);
    const task = createTaskTool({
      agents: () => this.agentDefs,
      maxDepth: 2,
      maxParallel: 6,
      build: (def, depth) => {
        const model = (def?.model && def.model !== "inherit" && resolveModel(def.model)) || this.model;
        let tools = filterTools([...coreTools(), ...memTools, ...(this.mcp?.getTools() ?? [])], def?.tools);
        if (depth < 2) tools = [...tools, task];
        const base = buildSystemPrompt({ cwd: this.cwd, tools, subagent: true, mode: this.policy.mode === "plan" ? "plan" : "default" });
        return { model, apiKey: apiKeyFor(model, this.auth), tools, systemPrompt: def ? `${base}\n\n# Your role: ${def.name}\n${def.body}` : base, hooks: { beforeToolCall: (c) => this.policy.decide(c) } };
      },
    });
    const all = [...coreTools(), task, ...memTools, ...(this.mcp?.getTools() ?? [])];
    return filterTools(all, this.opts.tools);
  }

  refreshTools() {
    if (!this.agent) return;
    const tools = this.buildTools();
    this.agent.config.tools = tools;
    this.agent.config.systemPrompt = buildSystemPrompt({
      cwd: this.cwd, tools, skills: this.skills, mode: this.policy.mode === "plan" ? "plan" : "default",
      extra: [this.opts.systemPromptAppend, this.goal ? `# Active goal\n${this.goal}\nDo not stop until this goal is met or you are blocked.` : ""].filter(Boolean).join("\n\n") || undefined,
    });
  }

  private agentHooks(): AgentHooks {
    return {
      onMessage: (m) => { this.msgIds.push(this.session.appendMessage(m)); },
      beforeToolCall: async (c) => {
        if (this.hooks.has("PreToolUse")) {
          const r = await this.hooks.run("PreToolUse", { session_id: this.session.id, tool_name: c.tool.name, tool_input: c.args }, c.tool.name);
          if (r.block) return { action: "deny", reason: `Hook: ${r.block}` };
        }
        return this.policy.decide(c);
      },
      afterToolCall: async (c) => {
        if (this.hooks.has("PostToolUse")) await this.hooks.run("PostToolUse", { session_id: this.session.id, tool_name: c.tool.name, tool_input: c.args, tool_response: c.result.content.map((x) => (x.type === "text" ? x.text : "[image]")).join("").slice(0, 20000) }, c.tool.name);
        this.ruvnet?.afterTool(c.tool.name, c.args, !c.result.isError);
      },
      maybeCompact: async (messages, lastUsage) => {
        if (this.compacting) return;
        if (shouldCompact(this.model, contextTokens(messages, lastUsage), this.compaction)) await this.compact();
      },
      onContextOverflow: async () => { try { await this.compact(); return true; } catch { return false; } },
      getSteering: () => this.steerQ.splice(0),
      getFollowUp: () => this.followQ.splice(0),
      onStop: async () => {
        if (this.hooks.has("Stop")) {
          const r = await this.hooks.run("Stop", { session_id: this.session.id });
          if (r.block) return r.block;
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
    const mem = this.memory && this.config.memory?.autoCapture !== false ? await memoryContext(this.memory, input, this.cwd, this.config.memory?.maxInject ?? 5).catch(() => undefined) : undefined;
    const ruv = await this.ruvnet?.beforePrompt(input).catch(() => undefined);
    const ctxBlocks = [mem && `<relevant_memories>\n${mem}\n</relevant_memories>`, ruv].filter(Boolean);
    parts.push({ type: "text", text: ctxBlocks.length ? `${ctxBlocks.join("\n")}\n\n${textIn}` : textIn });
    parts.push(...images);
    if (!this.session.title) this.session.setMeta({ title: input.slice(0, 80), model: `${this.model.provider}/${this.model.id}` });
    await this.agent.prompt(parts);
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
  setMode(mode: PermissionMode) { this.policy.mode = mode; this.refreshTools(); }
  setGoal(goal?: string) { this.goal = goal; this.refreshTools(); }

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
