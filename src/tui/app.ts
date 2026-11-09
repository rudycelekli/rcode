import { VERSION } from "../version.ts";
/**
 * rcode interactive TUI.
 * Main-screen renderer: finalized output is committed to native scrollback exactly once; a small live
 * region (streaming text, running tools, prompts, editor, status) is redrawn in synchronized-output frames.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentEvent } from "../agent/types.ts";
import { allModels } from "../ai/models.ts";
import type { ThinkingLevel } from "../ai/types.ts";
import { AgentSession, type SessionOptions } from "../core/session.ts";
import type { PermissionMode } from "../permissions/policy.ts";
import { contextTokens } from "../session/compaction.ts";
import { listSessions } from "../session/store.ts";
import { a, strip, truncate, width, wrap } from "./ansi.ts";
import { Editor, type Completion } from "./editor.ts";
import { renderMarkdown } from "./markdown.ts";
import { keyProvider, starterIdeas, WELCOME } from "../core/welcome.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MODES: PermissionMode[] = ["ask", "auto-edit", "full", "plan"];
const NOARG = new Set(["help", "undo", "plan", "new", "fork", "rewind", "cost", "context", "mcp", "tools", "skills", "agents", "commands", "export", "copy", "clear", "quit", "resume", "model", "thinking", "mode", "memory", "receipt"]);
const THINK: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

interface RunningTool { id: string; name: string; summary: string; started: number; tail?: string }
interface PendingPerm { title: string; reason: string; resolve: (d: "allow" | "allow-session" | "deny") => void }

const BUILTINS: Array<[string, string]> = [
  ["help", "Show commands and keys"], ["model", "Switch model: /model <ref> (no arg lists)"], ["thinking", "Set reasoning: off|low|medium|high|xhigh|max"],
  ["mode", "Approval mode: ask|auto-edit|full|plan"], ["plan", "Toggle plan mode (read-only)"], ["guard", "Toggle guards: freeze-tests | no-skip | strict-tdd"], ["goal", "Set a goal the agent must reach before stopping"],
  ["compact", "Summarize older context: /compact [focus]"], ["new", "Start a fresh session"], ["resume", "Resume a recent session"], ["fork", "Fork this session into a new branch file"],
  ["rewind", "Undo the last exchange (keeps it in the session tree)"], ["undo", "Revert file edits from the last turn that changed files"], ["cost", "Token usage and cost"], ["receipt", "Hash-chained proof of the last turn"], ["context", "Where the context window goes (by section, tool, message type)"], ["mcp", "MCP server status"],
  ["hire", "Add a teammate from one sentence: /hire a reviewer who checks accessibility"], ["teach", "Turn what we just did into a reusable workflow: /teach <name>"],
  ["memory", "Search memory: /memory <query>"], ["remember", "Save a memory: /remember <text>"], ["forget", "Delete a memory: /forget <id>"], ["promote", "Promote memories to AGENTS.md: /promote <id…>"], ["tools", "List available tools"], ["skills", "List skills"],
  ["agents", "List subagent types"], ["commands", "List slash commands"], ["export", "Export transcript to markdown"], ["copy", "Copy last answer to clipboard"], ["clear", "Clear screen"], ["quit", "Exit"],
];

export async function runInteractive(opts: SessionOptions, initialPrompt?: string): Promise<number> {
  const out = process.stdout;
  if (!process.stdin.isTTY) { console.error("Interactive mode needs a TTY. Use -p for headless runs."); return 2; }

  const ed = new Editor();
  let perm: PendingPerm | undefined;
  let streaming = "";
  let committedStreamLines = 0;
  let thinking = "";
  let thinkStart = 0;
  const tools = new Map<string, RunningTool>();
  let spin = 0;
  let prevCursorRow = 0;
  let renderQueued = false;
  let lastCtrlC = 0;
  let notice = "";
  let busySince = 0;

  const session = await new AgentSession({
    ...opts,
    asker: (req) => new Promise((resolve) => { perm = { title: `${req.tool.label ?? req.tool.name}: ${req.summary}`, reason: req.reason, resolve }; render(); }),
  }).init();
  const ideas = starterIdeas(session.cwd);

  const cols = () => Math.max(20, out.columns || 80);
  const rows = () => Math.max(10, out.rows || 24);

  // ── rendering ───────────────────────────────────────────────
  function statusLine(): string {
    const m = session.model;
    const ctx = contextTokens(session.messages);
    const pct = Math.min(100, Math.round((ctx / m.contextWindow) * 100));
    const u = session.agent.usage;
    const modeColor = session.mode === "plan" ? a.cyan : session.mode === "full" ? a.red : session.mode === "auto-edit" ? a.yellow : a.green;
    const left = `${a.accent("rcode")} ${a.gray("·")} ${m.id} ${a.gray(session.thinking)} ${a.gray("·")} ${modeColor(session.mode)}${session.goal ? a.gray(" · ") + a.magenta("goal") : ""}${session.guards.list().length ? a.gray(" · ") + a.cyan("guard:" + session.guards.list().join("+")) : ""}${session.sandboxStatus !== "off" ? a.gray(" · sandboxed") : ""}${session.stackMark ? a.gray(" · ") + a.magenta(session.stackMark) : ""}`;
    const right = a.gray(`ctx ${pct}% · $${u.cost.total.toFixed(3)} · ${basename(session.cwd)}`);
    const gap = Math.max(1, cols() - width(left) - width(right));
    return left + " ".repeat(gap) + right;
  }

  function liveLines(): { lines: string[]; cursorRow: number; cursorCol: number } {
    const W = cols();
    const lines: string[] = [];
    if (thinking && !streaming) {
      const last = thinking.trim().split("\n").pop() ?? "";
      lines.push(a.gray(`✻ thinking ${Math.round((Date.now() - thinkStart) / 1000)}s  ${truncate(last, W - 20)}`));
    }
    if (streaming) {
      const md = renderMarkdown(streaming).flatMap((l) => wrap(l, W));
      const maxLive = Math.max(4, rows() - 10);
      // Commit stable lines to scrollback when the stream outgrows the live area.
      if (md.length - committedStreamLines > maxLive) {
        const upto = md.length - Math.floor(maxLive / 2);
        commit(md.slice(committedStreamLines, upto));
        committedStreamLines = upto;
      }
      lines.push(...md.slice(committedStreamLines));
    }
    for (const t of tools.values()) {
      const s = Math.round((Date.now() - t.started) / 100) / 10;
      lines.push(`${a.accent(SPIN[spin % SPIN.length]!)} ${a.bold(t.name)} ${a.gray(truncate(t.summary, W - t.name.length - 14))} ${a.gray(s + "s")}`);
      if (t.tail) for (const l of t.tail.split("\n").slice(-4)) lines.push(a.gray("  │ " + truncate(l, W - 6)));
    }
    if (session.isRunning && !tools.size && !streaming && !thinking) lines.push(a.gray(`${SPIN[spin % SPIN.length]} working… ${Math.round((Date.now() - busySince) / 1000)}s  (esc to interrupt)`));
    if (perm) {
      lines.push("");
      lines.push(a.yellow("╭ Permission required ") + a.gray(`(${perm.reason})`));
      for (const l of wrap(perm.title, W - 4)) lines.push(a.yellow("│ ") + l);
      lines.push(a.yellow("╰ ") + `${a.bold("y")} allow  ${a.bold("a")} always (this session)  ${a.bold("n")} deny`);
    }
    if (notice) { lines.push(notice); }
    lines.push(a.gray("─".repeat(W)));
    // editor
    const prompt = session.isRunning ? a.gray("» ") : a.accent("❯ ");
    let cursorRow = lines.length, cursorCol = 2;
    ed.lines.forEach((l, i) => {
      const pre = i === 0 ? prompt : "  ";
      const wrapped = wrap(l, W - 2);
      if (i === ed.row) {
        const before = l.slice(0, ed.col);
        const bw = width(before);
        cursorRow = lines.length + Math.floor(bw / (W - 2));
        cursorCol = 2 + (bw % (W - 2));
      }
      wrapped.forEach((wl, j) => lines.push((j === 0 ? pre : "  ") + wl));
      if (!wrapped.length) lines.push(pre);
    });
    if (ed.isEmpty() && !session.isRunning) lines[lines.length - 1] += a.gray("ask anything · / for commands · @ to attach files");
    if (ed.completions.length) {
      ed.completions.slice(0, 8).forEach((c, i) => lines.push(`  ${i === ed.compIdx ? a.inverse(" " + c.label + " ") : " " + c.label + " "} ${a.gray(truncate(c.hint ?? "", W - c.label.length - 8))}`));
    }
    lines.push(statusLine());
    return { lines: lines.map((l) => truncate(l, W)), cursorRow, cursorCol };
  }

  function render() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      const { lines, cursorRow, cursorCol } = liveLines();
      let buf = "\x1b[?2026h\r";
      if (prevCursorRow > 0) buf += `\x1b[${prevCursorRow}A`;
      buf += "\x1b[J" + lines.join("\r\n");
      const up = lines.length - 1 - cursorRow;
      if (up > 0) buf += `\x1b[${up}A`;
      buf += `\r\x1b[${cursorCol}C`.replace("\x1b[0C", "");
      buf += "\x1b[?2026l";
      out.write(buf);
      prevCursorRow = cursorRow;
    }, 16);
  }

  /** Print lines permanently above the live region. */
  function commit(lines: string[]) {
    if (!lines.length) return;
    let buf = "\x1b[?2026h\r";
    if (prevCursorRow > 0) buf += `\x1b[${prevCursorRow}A`;
    buf += "\x1b[J" + lines.join("\r\n") + "\r\n";
    out.write(buf + "\x1b[?2026l");
    prevCursorRow = 0;
    render();
  }
  const say = (s: string) => commit(s.split("\n").flatMap((l) => wrap(l, cols())));

  // ── agent events ────────────────────────────────────────────
  session.subscribe((e: AgentEvent) => {
    switch (e.type) {
      case "agent_start": busySince = Date.now(); break;
      case "message_update":
        if (e.delta?.kind === "thinking") { if (!thinking) thinkStart = Date.now(); thinking += e.delta.text; }
        else if (e.delta?.kind === "text") streaming += e.delta.text;
        render(); break;
      case "message_end": {
        if (thinking) { commit([a.gray(`✻ thought for ${Math.max(1, Math.round((Date.now() - thinkStart) / 1000))}s`)]); thinking = ""; }
        if (streaming) {
          const md = renderMarkdown(streaming.trimEnd()).flatMap((l) => wrap(l, cols()));
          commit([...md.slice(committedStreamLines), ""]);
        }
        streaming = ""; committedStreamLines = 0;
        if (e.message.stopReason === "error") say(a.red(`✗ ${e.message.errorMessage}`));
        break;
      }
      case "tool_start": tools.set(e.toolCallId, { id: e.toolCallId, name: e.name, summary: e.summary ?? JSON.stringify(e.args).slice(0, 100), started: Date.now() }); render(); break;
      case "tool_update": { const t = tools.get(e.toolCallId); if (t && e.text) { t.tail = e.text; render(); } break; }
      case "tool_end": {
        const t = tools.get(e.toolCallId);
        tools.delete(e.toolCallId);
        commit(toolSummary(e, t?.summary ?? ""));
        break;
      }
      case "user_message": if (e.steering) say(a.gray("↳ ") + e.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("")); break;
      case "compaction": say(a.gray(`⟳ compacted context ${e.before.toLocaleString()} → ${e.after.toLocaleString()} tokens`)); break;
      case "notice": say(e.level === "info" ? a.gray(e.text) : (e.level === "error" ? a.red : a.yellow)(e.text)); break;
      case "agent_end": {
        const secs = Math.round((Date.now() - busySince) / 1000);
        if (secs > 5) say(a.gray(`  ${secs}s · $${session.agent.usage.cost.total.toFixed(4)} total`));
        if (process.env.RCODE_BELL !== "0" && secs > 15) out.write("\x07");
        render(); break;
      }
    }
  });

  function toolSummary(e: Extract<AgentEvent, { type: "tool_end" }>, summary: string): string[] {
    const W = cols();
    const d: any = e.result.details;
    const icon = e.result.isError ? a.red("✗") : a.green("✓");
    const dur = e.durationMs > 1000 ? a.gray(` ${(e.durationMs / 1000).toFixed(1)}s`) : "";
    const head = `${icon} ${a.bold(e.name)} ${a.gray(truncate(summary, W - e.name.length - 12))}${dur}`;
    const txt = e.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const lines = [head];
    if (e.result.isError) { for (const l of txt.split("\n").slice(0, 4)) lines.push(a.red("  " + truncate(l, W - 4))); return lines; }
    if (d?.diff) {
      const dl = String(d.diff).split("\n").slice(2);
      for (const l of dl.slice(0, 14)) lines.push("  " + truncate(l.startsWith("+") ? a.green(l) : l.startsWith("-") ? a.red(l) : l.startsWith("@@") ? a.cyan(l) : a.gray(l), W - 2));
      if (dl.length > 14) lines.push(a.gray(`  … ${dl.length - 14} more diff lines`));
    } else if (e.name === "bash") {
      const tl = txt.trimEnd().split("\n");
      for (const l of tl.slice(-5)) lines.push(a.gray("  │ " + truncate(l, W - 6)));
      if (tl.length > 5) lines[1] = a.gray(`  │ … ${tl.length - 5} lines above`) + "\n" + lines[1];
    } else if (e.name === "todo" && d?.todos) {
      for (const t of d.todos) lines.push(`  ${t.status === "completed" ? a.green("☑") : t.status === "in_progress" ? a.yellow("◐") : "☐"} ${t.status === "completed" ? a.gray(t.content) : t.content}`);
    } else if (e.name === "task") {
      lines.push(a.gray(`  ${d?.tasks ?? ""} subagent(s) finished${d?.cost ? ` · $${d.cost.toFixed(4)}` : ""}`));
    }
    return lines.flatMap((l) => l.split("\n"));
  }

  // ── completion ──────────────────────────────────────────────
  function computeCompletions(): Completion[] {
    const { token } = ed.currentToken();
    if (ed.row === 0 && token.startsWith("/") && ed.lines[0]!.trim() === token) {
      const q = token.slice(1).toLowerCase();
      const all: Completion[] = [...BUILTINS.map(([n, h]) => ({ label: "/" + n, insert: "/" + n + " ", hint: h })), ...session.commands.map((c) => ({ label: "/" + c.name, insert: "/" + c.name + " ", hint: c.description }))];
      return all.filter((c) => c.label.slice(1).toLowerCase().startsWith(q)).concat(all.filter((c) => !c.label.slice(1).toLowerCase().startsWith(q) && c.label.toLowerCase().includes(q)));
    }
    if (token.startsWith("@")) {
      const p = token.slice(1);
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
      const base = p.slice(dir.length).toLowerCase();
      try {
        return readdirSync(join(session.cwd, dir)).filter((f) => !f.startsWith(".") && f !== "node_modules" && f.toLowerCase().startsWith(base)).slice(0, 30).map((f) => {
          const isDir = (() => { try { return statSync(join(session.cwd, dir, f)).isDirectory(); } catch { return false; } })();
          return { label: dir + f + (isDir ? "/" : ""), insert: "@" + dir + f + (isDir ? "/" : " ") };
        });
      } catch { return []; }
    }
    return [];
  }

  // ── slash commands ──────────────────────────────────────────
  async function builtin(cmd: string, arg: string): Promise<boolean> {
    switch (cmd) {
      case "help":
        say([a.bold("Commands"), ...BUILTINS.map(([n, h]) => `  ${a.accent("/" + n.padEnd(10))} ${a.gray(h)}`), session.commands.length ? a.bold(`\nWorkflows (${session.commands.length})`) + a.gray("  — /commands to list") : "",
          a.bold("\nKeys"), a.gray("  enter send · alt+enter / \\ newline · esc interrupt · ctrl+c clear/exit · shift+tab cycle mode · ctrl+t cycle thinking · tab complete · ↑↓ history"),
          a.gray("  while working: enter = steer (injected after current step) · alt+enter = queue follow-up")].join("\n"));
        return true;
      case "model":
        if (!arg) { say(allModels().map((m) => `  ${m.provider}/${m.id === session.model.id ? a.accent(m.id) : m.id} ${a.gray(m.name)}`).join("\n")); return true; }
        try { const m = session.setModel(arg); say(a.gray(`model → ${m.provider}/${m.id}`)); } catch (e) { say(a.red((e as Error).message)); }
        return true;
      case "thinking": if (THINK.includes(arg as any) || arg === "minimal") { session.setThinking(arg as ThinkingLevel); say(a.gray(`thinking → ${arg}`)); } else say(a.gray(`thinking: ${session.thinking} (off|low|medium|high|xhigh|max)`)); return true;
      case "mode": if (MODES.includes(arg as any)) { session.setMode(arg as PermissionMode); say(a.gray(`mode → ${arg}`)); } else say(a.gray(`mode: ${session.mode} (ask|auto-edit|full|plan)`)); return true;
      case "guard": {
        const { GUARDS } = await import("../core/guards.ts");
        if (GUARDS.includes(arg as any)) session.guards.toggle(arg as any);
        else if (arg) { say(a.red(`unknown guard ${arg} (${GUARDS.join(" | ")})`)); return true; }
        say(a.gray(`guards: ${session.guards.list().join(", ") || "none"}`));
        return true;
      }
      case "plan": session.setMode(session.mode === "plan" ? "auto-edit" : "plan"); say(a.gray(`mode → ${session.mode}`)); return true;
      case "goal": session.setGoal(arg || undefined); say(a.gray(arg ? `goal set: ${arg}` : "goal cleared")); if (arg) void send(`Work toward this goal until it is met: ${arg}`); return true;
      case "compact": say(a.gray("compacting…")); try { await session.compact(arg || undefined); } catch (e) { say(a.red((e as Error).message)); } return true;
      case "new": session.newSession(); out.write("\x1b[2J\x1b[H"); prevCursorRow = 0; say(a.gray("new session")); return true;
      case "resume": {
        const list = listSessions(session.cwd, 15);
        if (!arg) { say(list.map((s, i) => `  ${a.accent(String(i + 1).padStart(2))} ${new Date(s.mtime).toLocaleString()} ${a.gray(`${s.messages} msgs`)} ${s.title}`).join("\n") + a.gray("\n  /resume <n>")); return true; }
        const s = list[Number(arg) - 1];
        if (!s) { say(a.red("no such session")); return true; }
        session.resume(s.file);
        say(a.gray(`resumed: ${s.title}`));
        for (const m of session.messages.slice(-6)) {
          if (m.role === "user") say(a.accent("❯ ") + m.content.map((c) => (c.type === "text" ? c.text : "")).join("").slice(0, 400));
          else if (m.role === "assistant") { const t = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join(""); if (t) commit(renderMarkdown(t).flatMap((l) => wrap(l, cols()))); }
        }
        return true;
      }
      case "undo": {
        const r = session.undo();
        say(r ? a.gray(`reverted ${r.files.length} file(s): ${r.files.slice(0, 20).map((f) => f.replace(session.cwd + "/", "")).join(", ")}${r.via === "history" ? "\n  (not a git repo: only edit/write changes are tracked, not bash)" : ""}`) : a.gray("nothing to undo"));
        return true;
      }
      case "fork": say(a.gray(`forked → ${session.fork()}`)); return true;
      case "rewind": { const t = session.rewind(1); if (t !== undefined) { ed.text = t.replace(/^<relevant_memories>[\s\S]*?<\/relevant_memories>\n\n/, ""); say(a.gray("rewound one exchange (still in session tree)")); } else say(a.gray("nothing to rewind")); return true; }
      case "context": {
        const { contextBreakdown, renderBreakdown } = await import("../context/breakdown.ts");
        say(renderBreakdown(contextBreakdown(session.agent.config.systemPrompt, session.agent.config.tools, session.messages, session.model.contextWindow), Math.min(50, cols() - 40)));
        return true;
      }
      case "receipt": {
        const { formatReceipt } = await import("../core/receipt.ts");
        say(session.lastReceipt ? formatReceipt(session.lastReceipt) : a.gray("no receipt yet"));
        return true;
      }
      case "cost": {
        const u = session.agent.usage;
        const ctx = contextTokens(session.messages);
        say(`  input ${u.input.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · output ${u.output.toLocaleString()}\n  cost $${u.cost.total.toFixed(4)} · context ${ctx.toLocaleString()} / ${session.model.contextWindow.toLocaleString()} (${Math.round((ctx / session.model.contextWindow) * 100)}%)`);
        return true;
      }
      case "mcp": {
        const s = session.mcp ? [...session.mcp.servers.values()] : [];
        say(s.length ? s.map((x) => `  ${x.status === "ready" ? a.green("●") : x.status === "connecting" ? a.yellow("◌") : a.red("●")} ${x.name} ${a.gray(x.status === "ready" ? `${x.tools} tools` : x.error ?? x.status)}`).join("\n") : a.gray("  no MCP servers (rcode mcp add <name> <cmd>)"));
        return true;
      }
      case "memory": {
        const m = session.memory;
        if (!m) { say(a.gray("memory not ready")); return true; }
        const items = arg ? (await m.search(arg, { k: 10, project: session.cwd })).map((h) => h.item) : await m.list({ project: session.cwd, limit: 15 });
        say(items.length ? items.map((i) => `  ${a.gray(i.id)} ${i.text}`).join("\n") : a.gray("  no memories")); return true;
      }
      case "promote": {
        if (!session.memory || !arg) { say(a.gray("usage: /promote <memory-id> [more ids…]  (ids from /memory)")); return true; }
        const all = await session.memory.list({ limit: 100000 });
        const picked = arg.split(/\s+/).map((id) => all.find((m) => m.id === id)).filter(Boolean) as any[];
        if (!picked.length) { say(a.red("no matching memory ids")); return true; }
        const { promoteToAgentsMd } = await import("../memory/promote.ts");
        const r = promoteToAgentsMd(session.cwd, picked.map((p) => p.text));
        say(a.gray(r.added ? `added ${r.added} convention(s) to ${r.file.replace(session.cwd + "/", "")} — commit it to share with your team` : "already present"));
        return true;
      }
      case "hire": {
        if (!arg) { say(a.gray("usage: /hire <describe the job in one sentence>")); return true; }
        say(a.gray("designing your teammate…"));
        try {
          const r = await session.hire(arg);
          say(`${a.green("✓")} hired ${a.accent(r.name)} ${a.gray("— " + r.spec.description)}\n${a.gray(`  ask for them by name ("have ${r.name} look at…") · edit ${r.file}`)}`);
        } catch (e) { say(a.red((e as Error).message)); }
        return true;
      }
      case "teach": {
        if (!arg) { say(a.gray("usage: /teach <name>  — after doing a task once, saves it as /<name>")); return true; }
        say(a.gray("distilling what worked…"));
        try {
          const r = await session.teach(arg);
          say(`${a.green("✓")} learned ${a.accent("/" + r.name)} ${a.gray("— " + r.spec.description)}\n${a.gray(`  run it any time · edit ${r.file}`)}`);
        } catch (e) { say(a.red((e as Error).message)); }
        return true;
      }
      case "forget": if (arg && session.memory) say(a.gray((await session.memory.remove(arg)) ? `forgot ${arg}` : `no memory ${arg}`)); return true;
      case "remember": if (arg && session.memory) { await session.memory.add({ text: arg, scope: "project", project: session.cwd, kind: "fact", source: "user" }); say(a.gray("remembered")); } return true;
      case "tools": say(session.agent.config.tools.map((t) => `  ${a.accent(t.name)} ${a.gray(t.description.split("\n")[0]!.slice(0, 90))}`).join("\n")); return true;
      case "skills": say(session.skills.length ? session.skills.map((s) => `  ${a.accent(s.name)} ${a.gray(s.description.slice(0, 90))}`).join("\n") : a.gray("  no skills")); return true;
      case "agents": say(session.agentDefs.map((s) => `  ${a.accent(s.name)} ${a.gray(s.description.slice(0, 90))}`).join("\n") || a.gray("  no agent types")); return true;
      case "commands": say(session.commands.map((c) => `  ${a.accent("/" + c.name)} ${a.gray(c.description)}`).join("\n") || a.gray("  none")); return true;
      case "export": {
        const f = join(session.cwd, `rcode-${session.session.id}.md`);
        writeFileSync(f, session.messages.map((m) => m.role === "user" ? `## User\n\n${m.content.map((c: any) => c.text ?? "").join("")}` : m.role === "assistant" ? `## rcode\n\n${m.content.map((c: any) => c.type === "text" ? c.text : c.type === "toolCall" ? `\`${c.name}\` ${JSON.stringify(c.arguments).slice(0, 200)}` : "").filter(Boolean).join("\n\n")}` : `> ${m.toolName}: ${m.content.map((c: any) => c.text ?? "").join("").slice(0, 300)}`).join("\n\n"));
        say(a.gray(`exported → ${f}`)); return true;
      }
      case "copy": {
        const last = [...session.messages].reverse().find((m) => m.role === "assistant");
        const t = last?.role === "assistant" ? last.content.filter((c) => c.type === "text").map((c: any) => c.text).join("") : "";
        const cmd = process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
        try { const p = Bun.spawn(cmd, { stdin: "pipe" }); p.stdin.write(t); p.stdin.end(); say(a.gray("copied")); } catch { say(a.red("clipboard unavailable")); }
        return true;
      }
      case "clear": out.write("\x1b[2J\x1b[3J\x1b[H"); prevCursorRow = 0; render(); return true;
      case "quit": case "exit": await shutdown(); return true;
    }
    return false;
  }

  async function send(textIn: string) {
    let trimmed = textIn.trim();
    if (!trimmed) return;
    if (!session.messages.length && /^[1-3]$/.test(trimmed) && ideas[Number(trimmed) - 1]) trimmed = ideas[Number(trimmed) - 1]!;
    if (session.needsModel && !trimmed.startsWith("/")) { say(a.yellow(WELCOME.join("\n"))); return; }
    const m = trimmed.match(/^\/(\w[\w:-]*)\s*([\s\S]*)$/);
    if (m && (await builtin(m[1]!, m[2]!.trim()))) return;
    if (m && !session.commands.some((c) => c.name === m[1])) { say(a.red(`unknown command /${m[1]} — /help`)); return; }
    // @file mentions → inline attachments hint
    const files = [...trimmed.matchAll(/@([\w./-]+)/g)].map((x) => x[1]!).filter((f) => { try { return statSync(join(session.cwd, f)).isFile(); } catch { return false; } });
    const extra = files.length ? `\n\n(Attached files — read them: ${files.join(", ")})` : "";
    commit([a.accent("❯ ") + a.bold(trimmed.split("\n")[0]!) + (trimmed.includes("\n") ? a.gray(` (+${trimmed.split("\n").length - 1} lines)`) : ""), ""]);
    busySince = Date.now();
    const ticker = setInterval(() => { spin++; if (session.isRunning) render(); }, 100);
    try { await session.prompt(trimmed + extra); } finally { clearInterval(ticker); render(); }
  }

  // ── input ───────────────────────────────────────────────────
  async function shutdown() {
    out.write("\x1b[?2004l\x1b[<u\r\n");
    process.stdin.setRawMode(false);
    await session.dispose();
    process.exit(0);
  }

  function submit(asFollowUp = false) {
    const t = ed.expanded();
    if (!t.trim()) return;
    const pasted = keyProvider(t);
    if (pasted) {
      ed.clear();
      const m = session.useKey(pasted.provider, pasted.key);
      say(`${a.green("✓")} saved your ${pasted.provider} key (${pasted.key.slice(0, 7)}…${pasted.key.slice(-4)}) on this computer only.\n${a.gray(`  using ${m.provider}/${m.id} · ask anything`)}`);
      return;
    }
    ed.pushHistory(ed.text);
    ed.clear();
    if (session.isRunning) {
      if (t.startsWith("/")) { void builtin(t.slice(1).split(/\s+/)[0]!, t.slice(1).split(/\s+/).slice(1).join(" ")); render(); return; }
      if (asFollowUp) { session.followUp(t); say(a.gray(`⏎ queued follow-up: ${t.slice(0, 80)}`)); }
      else { session.steer(t); say(a.gray(`↳ steering: ${t.slice(0, 80)}`)); }
      return;
    }
    void send(t);
  }

  function onKey(k: string) {
    notice = "";
    if (perm) {
      const p = perm;
      const ans = k === "y" || k === "\r" ? "allow" : k === "a" ? "allow-session" : k === "n" || k === "\x1b" || k === "\x03" ? "deny" : undefined;
      if (ans) { perm = undefined; commit([a.gray(`  ${ans === "deny" ? a.red("denied") : a.green(ans === "allow" ? "allowed" : "always allowed")}: ${strip(p.title).slice(0, 100)}`)]); p.resolve(ans); }
      render(); return;
    }
    if (ed.completions.length) {
      if (k === "\t" || k === "\r") {
        const c = ed.completions[ed.compIdx]!;
        const exact = ed.currentToken().token === c.label;
        ed.applyCompletion(c);
        // Enter runs the command when it was fully typed (or is a no-arg builtin); otherwise it just completes.
        if (k === "\r" && c.label.startsWith("/") && (exact || NOARG.has(c.label.slice(1)))) submit();
        render(); return;
      }
      if (k === "\x1b[A") { ed.compIdx = (ed.compIdx - 1 + Math.min(8, ed.completions.length)) % Math.min(8, ed.completions.length); render(); return; }
      if (k === "\x1b[B") { ed.compIdx = (ed.compIdx + 1) % Math.min(8, ed.completions.length); render(); return; }
      if (k === "\x1b") { ed.completions = []; render(); return; }
    }
    switch (k) {
      case "\r": { const l = ed.lines[ed.row]!; if (l.endsWith("\\") && ed.col === l.length) { ed.backspace(); ed.newline(); } else submit(); break; }
      case "\x1b\r": case "\x1b[13;2u": case "\x0a": if (session.isRunning && k === "\x1b\r") submit(true); else ed.newline(); break;
      case "\x7f": case "\b": ed.backspace(); break;
      case "\x1b[3~": ed.del(); break;
      case "\x1b[D": ed.left(); break;
      case "\x1b[C": ed.right(); break;
      case "\x1b[A": ed.up(); break;
      case "\x1b[B": ed.down(); break;
      case "\x1b[H": case "\x01": ed.home(); break;
      case "\x1b[F": case "\x05": ed.end(); break;
      case "\x1bb": case "\x1b[1;3D": case "\x1b[1;5D": ed.wordLeft(); break;
      case "\x1bf": case "\x1b[1;3C": case "\x1b[1;5C": ed.wordRight(); break;
      case "\x17": case "\x1b\x7f": ed.killWordBack(); break;
      case "\x0b": ed.killToEnd(); break;
      case "\x15": ed.killToStart(); break;
      case "\x19": ed.yank(); break;
      case "\x0c": out.write("\x1b[2J\x1b[H"); prevCursorRow = 0; break;
      case "\x1b[Z": { const i = MODES.indexOf(session.mode); session.setMode(MODES[(i + 1) % MODES.length]!); notice = a.gray(`mode → ${session.mode}`); break; }
      case "\x14": { const i = THINK.indexOf(session.thinking); session.setThinking(THINK[(i + 1) % THINK.length]!); notice = a.gray(`thinking → ${session.thinking}`); break; }
      case "\t": { const c = computeCompletions(); if (c.length === 1) ed.applyCompletion(c[0]!); else { ed.completions = c; ed.compIdx = 0; } break; }
      case "\x1b": if (session.isRunning) { session.abort(); notice = a.yellow("interrupted"); } break;
      case "\x03": {
        if (session.isRunning) { session.abort(); notice = a.yellow("interrupted"); break; }
        if (!ed.isEmpty()) { ed.clear(); break; }
        if (Date.now() - lastCtrlC < 1500) { void shutdown(); return; }
        lastCtrlC = Date.now(); notice = a.gray("press ctrl+c again to exit"); break;
      }
      case "\x04": if (ed.isEmpty()) { void shutdown(); return; } ed.del(); break;
      default:
        if (k.startsWith("\x1b")) break;
        ed.insert(k.replace(/[\x00-\x08\x0e-\x1f]/g, ""));
        { const { token } = ed.currentToken(); ed.completions = token.startsWith("/") && ed.row === 0 && ed.lines[0] === token ? computeCompletions() : []; ed.compIdx = 0; }
    }
    render();
  }

  // Tokenize raw input into keys; handle bracketed paste.
  let pasteBuf: string | null = null;
  function onData(data: string) {
    let s = data;
    while (s.length) {
      if (pasteBuf !== null) {
        const end = s.indexOf("\x1b[201~");
        if (end < 0) { pasteBuf += s; return; }
        pasteBuf += s.slice(0, end);
        ed.paste(pasteBuf); pasteBuf = null; s = s.slice(end + 6); render(); continue;
      }
      if (s.startsWith("\x1b[200~")) { pasteBuf = ""; s = s.slice(6); continue; }
      const m = s.match(/^(\x1b\[[0-9;]*[A-Za-z~]|\x1b\[[0-9;]*u|\x1b[\r\x7fbfO]|\x1bO[A-Z]|\x1b|[\s\S])/u);
      const key = m ? m[0] : s[0]!;
      s = s.slice(key.length);
      // Fast path for typed text runs (non-control chars) to avoid per-char renders on paste without brackets.
      if (key.length === 1 && key >= " " && !perm && !ed.completions.length) {
        let run = key;
        while (s.length && s[0]! >= " " && s[0] !== "\x7f") { run += s[0]; s = s.slice(1); }
        onKey(run);
      } else onKey(key);
    }
  }

  // ── start ───────────────────────────────────────────────────
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  out.write("\x1b[?2004h"); // bracketed paste
  out.on("resize", () => render());
  process.on("SIGTERM", () => void shutdown());

  const ctxFiles = (await import("../context/system-prompt.ts")).loadContextFiles(session.cwd);
  const fresh = !session.messages.length;
  const banner = [
    `${a.accent(a.bold("rcode"))} ${a.gray("v" + VERSION)}  ${a.gray("·")} ${session.needsModel ? a.yellow("no model yet") : `${session.model.provider}/${session.model.id}`} ${a.gray("·")} ${session.mode}`,
    a.gray(`${session.cwd}${ctxFiles.length ? ` · ${ctxFiles.map((f) => basename(f.path)).join(", ")}` : ""} · ${session.commands.length} workflows · ${session.agentDefs.length} agents · ${session.skills.length} skills`),
    fresh ? a.gray("/help for commands · shift+tab cycles approval mode · esc interrupts") : a.gray(`resumed session with ${session.messages.length} messages`),
    "",
    ...(session.needsModel ? [a.yellow(WELCOME.join("\n")), ""]
      : fresh && !initialPrompt ? [a.gray("Try one (type its number):"), ...ideas.map((s, i) => `  ${a.accent(String(i + 1))} ${s}`), ""] : []),
  ];
  commit(banner);
  if (initialPrompt) void send(initialPrompt);
  else render();
  return new Promise<number>(() => {});
}
