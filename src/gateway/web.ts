/**
 * Built-in web channel: a single-page chat UI over WebSocket (Bun.serve), works from a phone.
 * Binds 127.0.0.1 by default; reach it remotely via Tailscale / SSH tunnel / `--host 0.0.0.0`.
 * Auth: random bearer token (printed at startup) required as ?token= on the page and the socket.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalRequest, ChannelAdapter, IncomingMessage, OutgoingHandle } from "./types.ts";

export class WebChannel implements ChannelAdapter {
  readonly name = "web";
  readonly token: string;
  private server?: ReturnType<typeof Bun.serve>;
  private sockets = new Map<string, Set<any>>();
  private seq = 0;

  constructor(private port = 7788, private host = "127.0.0.1", token?: string) {
    this.token = token ?? randomBytes(18).toString("base64url");
  }

  get url() { return `http://${this.host === "0.0.0.0" ? "localhost" : this.host}:${this.port}/?token=${this.token}`; }

  private authed(t: string | null) {
    if (!t) return false;
    const a = Buffer.from(t), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private emit(conv: string, msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets.get(conv) ?? []) { try { ws.send(s); } catch {} }
  }

  async start(onMessage: (m: IncomingMessage) => void, onApproval: (id: string, d: "allow" | "allow-session" | "deny", userId: string) => void) {
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      fetch(req, server) {
        const url = new URL(req.url);
        if (!self.authed(url.searchParams.get("token"))) return new Response("rcode gateway: unauthorized (missing or wrong ?token=)", { status: 401 });
        if (url.pathname === "/ws") {
          const conv = url.searchParams.get("c") || "web";
          return server.upgrade(req, { data: { conv } }) ? undefined : new Response("upgrade failed", { status: 400 });
        }
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:" } });
      },
      websocket: {
        open(ws: any) { const c = ws.data.conv; if (!self.sockets.has(c)) self.sockets.set(c, new Set()); self.sockets.get(c)!.add(ws); },
        close(ws: any) { self.sockets.get(ws.data.conv)?.delete(ws); },
        message(ws: any, raw) {
          let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
          if (m.type === "prompt" && typeof m.text === "string") onMessage({ channel: "web", conversationId: `web:${ws.data.conv}`, userId: "web-owner", text: m.text, images: m.images });
          else if (m.type === "approval") onApproval(String(m.id), m.decision, "web-owner");
        },
      },
    });
    console.log(`[gateway] web UI: ${this.url}`);
  }

  async stop() { this.server?.stop(true); }
  private conv(c: string) { return c.replace(/^web:/, ""); }

  async send(c: string, text: string) { this.emit(this.conv(c), { type: "message", text }); }
  async typing(c: string) { this.emit(this.conv(c), { type: "typing" }); }
  async reply(c: string, initial: string): Promise<OutgoingHandle> {
    const id = `r${++this.seq}`;
    const conv = this.conv(c);
    this.emit(conv, { type: "stream", id, text: initial });
    return { update: async (t) => this.emit(conv, { type: "stream", id, text: t }), finish: async (t) => this.emit(conv, { type: "final", id, text: t }) };
  }
  async askApproval(c: string, req: ApprovalRequest) { this.emit(this.conv(c), { type: "approval", ...req }); }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>rcode</title><style>
:root{--bg:#0d0d0f;--fg:#e8e6e3;--mut:#8a8a90;--acc:#ff8a3d;--card:#17171b;--bd:#26262c}
@media (prefers-color-scheme:light){:root{--bg:#fafaf9;--fg:#1c1c1e;--mut:#6b6b70;--card:#fff;--bd:#e4e4e7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system;display:flex;flex-direction:column;height:100dvh}
header{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;gap:8px;align-items:center}header b{color:var(--acc)}#st{color:var(--mut);font-size:13px;margin-left:auto}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.m{max-width:min(760px,100%);white-space:pre-wrap;word-wrap:break-word;padding:10px 14px;border-radius:14px;background:var(--card);border:1px solid var(--bd)}
.u{align-self:flex-end;background:var(--acc);color:#111;border:0}.ap{border-color:var(--acc)}.ap button{margin:8px 8px 0 0;padding:6px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);font:inherit}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--bd)}textarea{flex:1;resize:none;background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:12px;padding:10px;font:inherit;min-height:44px;max-height:40vh}
button.s{background:var(--acc);color:#111;border:0;border-radius:12px;padding:0 18px;font-weight:600}code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
</style></head><body><header><b>rcode</b><span>remote</span><span id="st">connecting…</span></header><div id="log"></div>
<form id="f"><textarea id="t" placeholder="Message rcode…  (/new /stop /status /mode /model /undo)" rows="1"></textarea><button class="s">Send</button></form>
<script>
const q=new URLSearchParams(location.search),tok=q.get('token'),c=q.get('c')||'web';const log=document.getElementById('log'),st=document.getElementById('st');let ws,streams={};
function add(cls,text){const d=document.createElement('div');d.className='m '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
function conn(){ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?token='+encodeURIComponent(tok)+'&c='+encodeURIComponent(c));
ws.onopen=()=>st.textContent='connected';ws.onclose=()=>{st.textContent='reconnecting…';setTimeout(conn,1500)};
ws.onmessage=e=>{const m=JSON.parse(e.data);
 if(m.type==='stream'){(streams[m.id]||(streams[m.id]=add('a',''))).textContent=m.text||'…';log.scrollTop=log.scrollHeight}
 else if(m.type==='final'){(streams[m.id]||add('a','')).textContent=m.text;delete streams[m.id];st.textContent='connected'}
 else if(m.type==='message')add('a',m.text);else if(m.type==='typing')st.textContent='working…';
 else if(m.type==='approval'){const d=add('ap','⚠️ '+m.title+'\\n('+m.reason+')');for(const[k,l]of[['allow','Allow'],['allow-session','Always'],['deny','Deny']]){const b=document.createElement('button');b.textContent=l;b.onclick=()=>{ws.send(JSON.stringify({type:'approval',id:m.id,decision:k}));d.append(' → '+l);d.querySelectorAll('button').forEach(x=>x.remove())};d.appendChild(b)}}}}
conn();const t=document.getElementById('t');t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('f').requestSubmit()}});
document.getElementById('f').onsubmit=e=>{e.preventDefault();const v=t.value.trim();if(!v)return;add('u',v);ws.send(JSON.stringify({type:'prompt',text:v}));t.value=''};
</script></body></html>`;
