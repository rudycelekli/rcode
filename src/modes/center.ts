/**
 * `rcode center` — a local command center.
 *
 * One screen for the work rcode already does: several threads, a crash-safe mission queue,
 * live tool calls, approvals, and a receipt after every turn. Studied the host-and-threads
 * shape of t3code (MIT, T3 Tools Inc.); this UI is rcode's own.
 *
 * Binds 127.0.0.1. The page and the socket both require the token printed at startup.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentEvent } from "../agent/types.ts";
import type { ServerWebSocket } from "bun";
import { AgentSession } from "../core/session.ts";
import { add, clearFinished, drain, load, type Job } from "../core/queue.ts";
import { listSessions } from "../session/store.ts";
import { runSessionJob } from "./queue.ts";
import { GUEST_NOTE, runGuest, type GuestEngine } from "../center/guests.ts";

type Sock = ServerWebSocket<{ id: string }>;

export interface CenterOptions {
  cwd: string;
  port?: number;
  host?: string;
  token?: string;
  model?: string;
  /** Override the queue file. Tests use this so they never touch ~/.rcode. */
  queueFile?: string;
}

const MODELS = ["claude-cli/sonnet", "claude-cli/opus", "claude-cli/haiku"];

function authed(token: string, got: string | null) {
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function textOf(content: any[]): string {
  return content.map((c) => (c?.type === "text" ? c.text : "")).join("");
}

function transcript(s: AgentSession) {
  const out: { role: string; text: string }[] = [];
  for (const m of s.messages.slice(-40)) {
    if (m.role === "user") {
      const t = textOf(m.content).replace(/<(relevant_memories|stack|active_goal|hook_context)[\s\S]*?<\/\1>\s*/g, "").trim();
      if (t) out.push({ role: "user", text: t.slice(0, 4000) });
    } else if (m.role === "assistant") {
      const say = textOf(m.content).trim();
      const tools = m.content.filter((c) => c.type === "toolCall").map((c: any) => c.name);
      const line = [say, tools.length ? `tools: ${tools.join(", ")}` : ""].filter(Boolean).join("\n");
      if (line) out.push({ role: "agent", text: line.slice(0, 4000) });
    }
  }
  return out;
}

function titleOf(s: AgentSession) {
  const first = s.messages.find((m) => m.role === "user");
  const t = first ? textOf(first.content).replace(/<[\s\S]*?>/g, "").trim() : "";
  return (t || "New thread").slice(0, 80);
}

function jobView(j: Job) {
  return { id: j.id, status: j.status, prompt: j.prompt, verdict: j.verdict, result: j.result?.slice(0, 240), error: j.error?.slice(0, 240) };
}

export async function startCenter(opts: CenterOptions) {
  const token = opts.token ?? randomBytes(18).toString("base64url");
  const host = opts.host ?? "127.0.0.1";
  const file = opts.queueFile;
  const threads = new Map<string, AgentSession>();
  const guests = new Map<string, { id: string; engine: GuestEngine; title: string; running: boolean; warned: boolean; stop?: () => void }>();
  const approvals = new Map<string, (d: "allow" | "allow-session" | "deny") => void>();
  const sockets = new Set<Sock>();
  let queueRunning = false;

  const send = (ws: Sock, msg: unknown) => { try { ws.send(JSON.stringify(msg)); } catch {} };
  const broadcast = (msg: unknown) => { for (const ws of sockets) send(ws, msg); };
  const jobs = () => (file ? load(file) : load()).map(jobView);
  const pushQueue = () => broadcast({ type: "queue", jobs: jobs(), running: queueRunning });

  function pack(e: AgentEvent): Record<string, unknown> | null {
    switch (e.type) {
      case "agent_start": return { type: "status", running: true };
      case "message_update":
        if (e.delta?.kind === "text" || e.delta?.kind === "thinking") return { type: "delta", kind: e.delta.kind, text: e.delta.text };
        return null;
      case "tool_start": return { type: "tool", id: e.toolCallId, name: e.name, summary: (e.summary ?? "").slice(0, 180), status: "run" };
      case "tool_end": {
        const text = e.result.content.map((c) => (c.type === "text" ? c.text : "")).join("").slice(0, 1500);
        return { type: "tool", id: e.toolCallId, name: e.name, status: e.result.isError ? "fail" : "ok", text };
      }
      case "notice": return { type: "note", text: e.text, level: e.level };
      case "compaction": return { type: "note", text: `Compacted context ${e.before.toLocaleString()} → ${e.after.toLocaleString()} tokens`, level: "info" };
      case "agent_end": return { type: "turn" };
      default: return null;
    }
  }

  function stateOf(s: AgentSession) {
    const r = s.lastReceipt;
    return {
      id: s.session.id, title: titleOf(s), model: `${s.model.provider}/${s.model.id}`, mode: s.mode, plain: s.plain,
      needsModel: s.needsModel, running: s.isRunning, cost: s.agent.usage.cost.total,
      receipt: r ? { hash: r.hash, verdict: r.verdict } : null, guest: false,
    };
  }

  function guestState(g: { id: string; engine: GuestEngine; title: string; running: boolean }) {
    return { id: g.id, title: g.title, model: g.engine === "claude" ? "Claude plan" : "Codex plan", mode: "guest", plain: false, needsModel: false, running: g.running, cost: 0, receipt: null, guest: true, engine: g.engine };
  }

  const engineOf = (v: unknown): "rcode" | GuestEngine => (v === "claude" || v === "codex" ? v : "rcode");

  async function guestTurn(engine: GuestEngine, text: string, existing?: string) {
    let g = existing ? guests.get(existing) : undefined;
    if (g?.running) { broadcast({ type: "evt", thread: g.id, evt: { type: "note", level: "warn", text: "Still working. Stop it before sending more." } }); return; }
    if (!g || g.engine !== engine) {
      g = { id: randomBytes(4).toString("hex"), engine, title: text.slice(0, 80), running: false, warned: false };
      guests.set(g.id, g);
      broadcast({ type: "focus", id: g.id, messages: [] });
    }
    if (g.title === "New thread") g.title = text.slice(0, 80);
    if (!g.warned) { g.warned = true; broadcast({ type: "evt", thread: g.id, evt: { type: "note", level: "warn", text: GUEST_NOTE[engine] } }); }
    broadcast({ type: "you", thread: g.id, text: text.slice(0, 4000) });
    g.running = true;
    broadcast({ type: "thread", thread: guestState(g) });
    const ac = new AbortController();
    g.stop = () => ac.abort();
    await runGuest({
      engine, prompt: text, cwd: opts.cwd, signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "delta") broadcast({ type: "evt", thread: g!.id, evt: { type: "delta", kind: "text", text: e.text } });
        else if (e.type === "tool") broadcast({ type: "evt", thread: g!.id, evt: e });
        else if (e.error) broadcast({ type: "evt", thread: g!.id, evt: { type: "note", level: "error", text: e.error } });
      },
    });
    g.running = false;
    g.stop = undefined;
    broadcast({ type: "evt", thread: g.id, evt: { type: "turn" } });
    broadcast({ type: "thread", thread: guestState(g) });
  }

  async function open(resume?: string): Promise<AgentSession> {
    if (resume) {
      for (const s of threads.values()) if (s.session.file === resume) return s;
    }
    const holder: { s?: AgentSession } = {};
    const s = await new AgentSession({
      cwd: opts.cwd,
      model: opts.model,
      resume,
      asker: (req) => new Promise((resolve) => {
        const id = randomBytes(6).toString("hex");
        approvals.set(id, resolve);
        const detail = typeof req.args.command === "string" ? `$ ${req.args.command}` : JSON.stringify(req.args).slice(0, 1500);
        broadcast({ type: "approval", thread: holder.s!.session.id, id, title: `${req.tool.name}: ${req.summary}`, reason: req.reason, detail });
        setTimeout(() => { const fn = approvals.get(id); if (fn) { approvals.delete(id); fn("deny"); } }, 15 * 60_000);
      }),
    }).init();
    holder.s = s;
    threads.set(s.session.id, s);
    s.subscribe((e) => {
      const evt = pack(e);
      if (evt) broadcast({ type: "evt", thread: s.session.id, evt });
      if (e.type === "agent_end") broadcast({ type: "thread", thread: stateOf(s) });
    });
    broadcast({ type: "thread", thread: stateOf(s) });
    return s;
  }

  const recent = () => listSessions(opts.cwd, 12).map((s) => ({ file: s.file, title: s.title, messages: s.messages }));

  const server = Bun.serve({
    port: opts.port ?? 7799,
    hostname: host,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!authed(token, url.searchParams.get("token"))) return new Response("rcode center: unauthorized", { status: 401 });
      if (url.pathname === "/ws") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== req.headers.get("host")) return new Response("bad origin", { status: 403 });
        return srv.upgrade(req, { data: { id: randomBytes(4).toString("hex") } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:" } });
    },
    websocket: {
      open(ws: Sock) {
        sockets.add(ws);
        const live: object[] = [...threads.values()].map(stateOf);
        live.push(...[...guests.values()].map(guestState));
        send(ws, { type: "ready", cwd: opts.cwd, models: MODELS, recent: recent(), jobs: jobs(), threads: live });
      },
      close(ws: Sock) { sockets.delete(ws); },
      async message(ws: Sock, raw) {
        let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
        try {
          if (m.type === "new") {
            const engine = engineOf(m.engine);
            if (engine !== "rcode") {
              const g = { id: randomBytes(4).toString("hex"), engine, title: "New thread", running: false, warned: false };
              guests.set(g.id, g);
              send(ws, { type: "focus", id: g.id, messages: [] });
              broadcast({ type: "thread", thread: guestState(g) });
              return;
            }
            const s = await open(); send(ws, { type: "focus", id: s.session.id, messages: [] }); return;
          }
          if (m.type === "open" && typeof m.file === "string") {
            const s = await open(m.file);
            send(ws, { type: "focus", id: s.session.id, messages: transcript(s) });
            send(ws, { type: "thread", thread: stateOf(s) });
            return;
          }
          if (m.type === "prompt" && typeof m.text === "string" && m.text.trim()) {
            const engine = engineOf(m.engine);
            const text = m.text.trim();
            if (engine !== "rcode") {
              const same = m.thread && guests.get(String(m.thread))?.engine === engine ? String(m.thread) : undefined;
              await guestTurn(engine, text, same);
              return;
            }
            const s = (m.thread && threads.get(m.thread)) || await open();
            if (!m.thread) send(ws, { type: "focus", id: s.session.id, messages: transcript(s) });
            if (s.needsModel) { broadcast({ type: "evt", thread: s.session.id, evt: { type: "note", level: "warn", text: "No model yet. Pick Claude (your plan) after `claude` → /login, or set a model." } }); return; }
            broadcast({ type: "you", thread: s.session.id, text: m.text.trim().slice(0, 4000) });
            await s.prompt(m.text);
            broadcast({ type: "thread", thread: stateOf(s) });
            return;
          }
          if (m.type === "stop") { threads.get(String(m.thread))?.abort(); guests.get(String(m.thread))?.stop?.(); return; }
          const s = m.thread ? threads.get(String(m.thread)) : undefined;
          if (m.type === "mode" && s) { s.setMode(m.mode); broadcast({ type: "thread", thread: stateOf(s) }); return; }
          if (m.type === "plain" && s) { s.setPlain(!!m.on); broadcast({ type: "thread", thread: stateOf(s) }); return; }
          if (m.type === "model" && s && typeof m.ref === "string") {
            s.setModel(m.ref);
            broadcast({ type: "thread", thread: stateOf(s) });
            return;
          }
          if (m.type === "approval") { const fn = approvals.get(String(m.id)); if (fn) { approvals.delete(String(m.id)); fn(m.decision); } return; }
          if (m.type === "queue-add" && typeof m.text === "string" && m.text.trim()) {
            file ? add(m.text, opts.cwd, file) : add(m.text, opts.cwd);
            pushQueue();
            return;
          }
          if (m.type === "queue-clear") { file ? clearFinished(file) : clearFinished(); pushQueue(); return; }
          if (m.type === "queue-run") {
            if (queueRunning) { send(ws, { type: "note", text: "A mission run is already going.", level: "warn" }); return; }
            queueRunning = true; pushQueue();
            const model = typeof m.model === "string" ? m.model : opts.model;
            void drain((job) => runSessionJob(job, { mode: m.yes ? "full" : "auto-edit", model }), { file, onStart: pushQueue, onEnd: pushQueue })
              .then(() => { queueRunning = false; pushQueue(); })
              .catch((e) => { queueRunning = false; broadcast({ type: "note", text: (e as Error).message, level: "error" }); pushQueue(); });
            return;
          }
        } catch (e) { send(ws, { type: "note", text: (e as Error).message, level: "error" }); }
      },
    },
  });

  const shownHost = host === "0.0.0.0" ? "localhost" : host;
  const url = `http://${shownHost}:${server.port}/?token=${token}`;
  return {
    url, token, port: server.port,
    stop: () => { server.stop(true); for (const s of threads.values()) void s.dispose(); for (const g of guests.values()) g.stop?.(); },
  };
}

export async function runCenter(opts: CenterOptions): Promise<number> {
  const c = await startCenter(opts);
  console.log(`rcode center  ${c.url}\n  ${opts.cwd}\n  Ctrl+C to stop. This page stays on this computer.`);
  return new Promise(() => {});
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>rcode center</title><style>
:root{--bg:#0c0c0e;--fg:#eceae6;--mut:#8d8d93;--acc:#ff8a3d;--ok:#7dcea0;--bad:#e06c75;--card:#151518;--bd:#2a2a30;--line:#222228}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system;display:grid;grid-template-columns:280px 1fr;grid-template-rows:auto minmax(0,1fr) auto;height:100dvh;overflow:hidden}
header{grid-column:1/3;display:flex;gap:14px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--bd)}
header b{color:var(--acc);letter-spacing:.04em}#cwd{color:var(--mut);font:12px/1 ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#side{border-right:1px solid var(--bd);overflow:auto;padding:12px;min-height:0}
#main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
#bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--bd)}
#log{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
#dock{grid-column:1/3;display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--bd)}
textarea{flex:1;resize:none;background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:10px;padding:10px;font:inherit;min-height:44px;max-height:30vh}
button,select{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;cursor:pointer}
button.acc{background:var(--acc);color:#1a120c;border:0;font-weight:650}
h3{margin:14px 0 6px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:650}
.item{padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}.item:hover{background:var(--card)}.item.on{border-color:var(--acc);background:var(--card)}
.item small{display:block;color:var(--mut);font-size:11px}
.m{padding:8px 10px;border-radius:10px;background:var(--card);border:1px solid var(--bd);white-space:pre-wrap;word-wrap:break-word;max-width:860px}
.you{align-self:flex-end;background:#2a2118;border-color:#4a341f}
.tool{font:12px/1.4 ui-monospace,Menlo,monospace;color:var(--mut);border-left:2px solid var(--bd);padding:2px 8px}
.tool.ok{border-color:var(--ok)}.tool.fail{border-color:var(--bad);color:var(--bad)}
.chip{font:12px/1 ui-monospace,Menlo,monospace;color:var(--mut)}
.v-verified{color:var(--ok)}.v-failed,.v-unverified{color:var(--bad)}.v-read-only{color:var(--mut)}
#empty{color:var(--mut);padding:24px 4px}
label{color:var(--mut);display:flex;gap:6px;align-items:center}
@media(max-width:800px){body{grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto}#side{border-right:0;border-bottom:1px solid var(--bd);max-height:34dvh}}
</style></head><body>
<header><b>RCODE</b><span>center</span><select id="engine" title="Who does the work"><option value="rcode">rcode</option><option value="claude">Claude plan</option><option value="codex">Codex plan</option></select><span id="cwd"></span></header>
<nav id="side"></nav>
<section id="main"><div id="bar"></div><div id="log"></div></section>
<form id="dock"><textarea id="box" rows="1" placeholder="Ask, or queue it as a mission. Enter sends, Shift+Enter adds a line."></textarea><button class="acc" id="send">Send</button></form>
<script>
const q=new URLSearchParams(location.search), tok=q.get("token");
const side=document.getElementById("side"), log=document.getElementById("log"), bar=document.getElementById("bar"), box=document.getElementById("box");
let ws, active=null, threads=[], recent=[], jobs=[], queueRunning=false, models=[];
const view={};
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
function focus(id,messages){active=id;view[id]=messages||view[id]||[];paint();if(messages){log.replaceChildren();for(const m of messages)addLine(m.role==="user"?"you":"m",m.text)}}
function addLine(cls,text){const d=el("div",cls,text);log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
function thread(){return threads.find(t=>t.id===active)}
function paint(){
  side.replaceChildren();
  const a=el("button","acc","New thread");a.onclick=()=>ws.send(JSON.stringify({type:"new",engine:document.getElementById("engine").value}));side.appendChild(a);
  const h1=el("h3",null,"Threads");side.appendChild(h1);
  const all=[...threads];
  if(!all.length)side.appendChild(el("div","chip","No live thread yet."));
  for(const t of all){const d=el("div","item"+(t.id===active?" on":""));d.append(el("div",null,t.title));d.append(el("small",null,(t.running?"working · ":"")+t.model));d.onclick=()=>focus(t.id);side.appendChild(d)}
  const h2=el("h3",null,"Recent");side.appendChild(h2);
  for(const r of recent.slice(0,8)){const d=el("div","item");d.append(el("div",null,r.title||"(untitled)"));d.append(el("small",null,r.messages+" messages"));d.onclick=()=>ws.send(JSON.stringify({type:"open",file:r.file}));side.appendChild(d)}
  const h3=el("h3",null,"Missions");side.appendChild(h3);
  const row=el("div");row.style.display="flex";row.style.gap="6px";
  const run=el("button",null,queueRunning?"Running…":"Run queued");run.disabled=queueRunning;run.onclick=()=>{const t=thread();ws.send(JSON.stringify({type:"queue-run",model:t&&t.model}))};row.appendChild(run);
  const clr=el("button",null,"Clear done");clr.onclick=()=>ws.send(JSON.stringify({type:"queue-clear"}));row.appendChild(clr);
  side.appendChild(row);
  if(!jobs.length)side.appendChild(el("div","chip","Nothing queued. Queue adds work without sending it."));
  for(const j of jobs){const d=el("div","item");const mark=j.status==="done"?"✓":j.status==="failed"?"✗":j.status==="running"?"◐":"○";d.append(el("div",null,mark+" "+j.prompt.slice(0,80)));const sub=j.error||j.result||j.verdict||j.status;d.append(el("small",null,sub));side.appendChild(d)}
  bar.replaceChildren();
  const t=thread();
  if(!t){bar.appendChild(el("span","chip","Start a thread, or open a recent one."));return}
  if(t.guest){bar.appendChild(el("span","chip",t.model+" · its own tools, outside rcode's checks"));const stop=el("button",null,"Stop");stop.onclick=()=>ws.send(JSON.stringify({type:"stop",thread:t.id}));bar.appendChild(stop);return}
  for(const ref of models){const b=el("button",null,ref.replace("claude-cli/","claude "));if(t.model===ref)b.className="acc";b.onclick=()=>ws.send(JSON.stringify({type:"model",thread:t.id,ref:ref}));bar.appendChild(b)}
  const sel=el("select");for(const mode of["ask","auto-edit","full","plan"]){const o=el("option",null,mode);o.value=mode;if(mode===t.mode)o.selected=true;sel.appendChild(o)}sel.onchange=()=>ws.send(JSON.stringify({type:"mode",thread:t.id,mode:sel.value}));bar.appendChild(sel);
  const plain=el("label");const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!t.plain;cb.onchange=()=>ws.send(JSON.stringify({type:"plain",thread:t.id,on:cb.checked}));plain.append(cb,document.createTextNode("plain"));bar.appendChild(plain);
  if(t.receipt)bar.appendChild(el("span","chip v-"+t.receipt.verdict,t.receipt.verdict+" "+t.receipt.hash.slice(0,8)));
  bar.appendChild(el("span","chip","$"+Number(t.cost||0).toFixed(3)));
  const stop=el("button",null,"Stop");stop.onclick=()=>ws.send(JSON.stringify({type:"stop",thread:t.id}));bar.appendChild(stop);
}
function conn(){
  ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws?token="+encodeURIComponent(tok));
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.type==="ready"){document.getElementById("cwd").textContent=m.cwd;models=m.models;recent=m.recent;jobs=m.jobs;threads=m.threads;queueRunning=false;paint();if(!log.childElementCount)log.appendChild(el("div","chip",m.cwd))}
    else if(m.type==="focus")focus(m.id,m.messages);
    else if(m.type==="thread"){const i=threads.findIndex(t=>t.id===m.thread.id);if(i<0)threads.unshift(m.thread);else threads[i]=m.thread;if(!active)active=m.thread.id;paint()}
    else if(m.type==="you"&&m.thread===active)addLine("m you",m.text);
    else if(m.type==="queue"){jobs=m.jobs;queueRunning=m.running;paint()}
    else if(m.type==="note")addLine("m",m.text);
    else if(m.type==="approval"&&m.thread===active){const d=addLine("m","Approve: "+m.title+"\\n"+m.reason+(m.detail?"\\n"+m.detail:""));for(const[k,lab]of[["allow","Allow"],["allow-session","Always"],["deny","Deny"]]){const b=el("button",null,lab);b.onclick=()=>{ws.send(JSON.stringify({type:"approval",id:m.id,decision:k}));b.disabled=true};d.appendChild(b)}}
    else if(m.type==="evt"&&m.thread===active){const ev=m.evt;
      if(ev.type==="delta"&&ev.kind==="text"){let d=log.querySelector("[data-live]");if(!d){d=addLine("m","");d.dataset.live="1"}d.textContent+=ev.text;log.scrollTop=log.scrollHeight}
      else if(ev.type==="tool")addLine("tool "+(ev.status==="run"?"":ev.status),(ev.status==="run"?"→ ":"")+(ev.name||"")+" "+(ev.summary||ev.text||""));
      else if(ev.type==="note")addLine("m",ev.text);
      else if(ev.type==="turn"){const d=log.querySelector("[data-live]");if(d)delete d.dataset.live}
    }
  };
  ws.onclose=()=>setTimeout(conn,1200);
}
conn();
box.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();document.getElementById("dock").requestSubmit()}});
document.getElementById("dock").onsubmit=e=>{e.preventDefault();const v=box.value.trim();if(!v||!ws)return;box.value="";
  if(e.submitter&&e.submitter.id!=="send"){ws.send(JSON.stringify({type:"queue-add",text:v}));return}
  ws.send(JSON.stringify({type:"prompt",thread:active,text:v,engine:document.getElementById("engine").value}))};
const queueBtn=el("button",null,"Queue");queueBtn.type="button";queueBtn.onclick=()=>{const v=box.value.trim();if(!v)return;box.value="";ws.send(JSON.stringify({type:"queue-add",text:v}))};
document.getElementById("dock").appendChild(queueBtn);
</script></body></html>`;
