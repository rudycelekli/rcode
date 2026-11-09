// @ts-nocheck — `client` runs in the browser and is shipped as its own source text.
/**
 * The command center page. The browser code is one plain function, `client`, sent as source
 * with `client.toString()`, so it needs no escaping and the bundler still syntax-checks it.
 * It must not reference anything outside itself except the skin globals (`applySkin`, `skinPanel`).
 *
 * Look and layout follow anomalyco/rune (MIT): a black canvas, a raised hairline panel, a
 * centered reading column, and a floating composer that holds its own controls.
 */
import { SKIN_CSS, skinScript } from "./skins.ts";

const ICON = {
  menu: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

const CSS = `
:root{--bg:#000000;--fg:#ededed;--mut:#9e9e9e;--acc:#ff2a2a;--ok:#5fd38d;--bad:#ff6b6b;--card:#0f0f0f;--bd:#262626;--line:#1c1c1c;--you:#1f1f1f;--youbd:#2e2e2e;--onacc:#ffffff;--size:14px;--r:8px;--d:1;
  --in:cubic-bezier(.2,.8,.2,1);--raise:color-mix(in srgb,var(--fg) 6%,var(--card));--hover:color-mix(in srgb,var(--fg) 8%,transparent);--mono:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--bd) transparent}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:var(--size)/1.6 "Geist","Inter",ui-sans-serif,system-ui,-apple-system,sans-serif;display:grid;grid-template-columns:256px minmax(0,1fr);height:100dvh;overflow:hidden;-webkit-font-smoothing:antialiased}
button,select,input,textarea{font:inherit;color:inherit}
button{cursor:pointer;background:var(--raise);border:1px solid var(--bd);border-radius:var(--r);padding:calc(5px*var(--d)) 12px;font-size:13px;transition:background .15s var(--in),color .15s var(--in),border-color .15s var(--in)}
button:hover:not(:disabled){border-color:color-mix(in srgb,var(--fg) 26%,var(--card))}
button:disabled{opacity:.45;cursor:default}
button.acc{background:var(--acc);color:var(--onacc);border-color:transparent;font-weight:600}
button.ghost{background:transparent;border-color:transparent;color:var(--mut)}button.ghost:hover:not(:disabled){color:var(--fg);background:var(--hover);border-color:transparent}
button.icon{display:inline-grid;place-items:center;padding:6px;width:32px;height:32px}
:focus-visible{outline:2px solid color-mix(in srgb,var(--acc) 70%,transparent);outline-offset:1px}
a{color:inherit;text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--fg) 35%,transparent);text-underline-offset:2px}
.mut{color:var(--mut)}

/* sidebar */
#side{display:flex;flex-direction:column;min-height:0;padding:12px 10px}
#brand{display:flex;align-items:baseline;gap:8px;padding:4px 8px 14px;min-width:0}
#brand b{color:var(--acc);letter-spacing:.08em;font-weight:600}
#brand span{color:var(--mut);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#new{display:flex;align-items:center;justify-content:center;gap:6px;width:100%}
#threads{flex:1;overflow:auto;margin-top:10px;min-height:0}
#threads h3{margin:16px 8px 4px;font-size:11px;line-height:16px;letter-spacing:.02em;color:var(--mut);font-weight:500}
.item{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:var(--r);padding:calc(7px*var(--d)) 10px;margin:1px 0}
.item:hover:not(:disabled){background:var(--hover)}
.item.on{background:var(--raise);box-shadow:inset 2px 0 0 var(--acc)}
.item-t{display:flex;align-items:center;gap:6px;font-size:13px}.item-t span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.item small{display:block;color:var(--mut);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--fg)}.dot.run{background:var(--acc);animation:pulse 1.2s var(--in) infinite}.dot.ask{background:var(--acc)}
.empty{color:var(--mut);font-size:12px;padding:8px 10px}

/* main panel */
#main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--card);border:1px solid var(--line);border-radius:calc(var(--r)*1.5);margin:8px 8px 8px 0}
#top{display:flex;align-items:center;gap:8px;min-height:calc(46px*var(--d));padding:0 8px 0 16px;border-bottom:1px solid var(--line)}
#title{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#navbtn{display:none}
#cost{font:12px/1 var(--mono);color:var(--mut)}
#off{font-size:12px;color:var(--bad)}
.badge{font-size:12px;border:1px solid var(--bd);border-radius:999px;padding:2px 9px;color:var(--mut);background:transparent;cursor:pointer}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}.badge.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
#log{flex:1;overflow:auto;padding:24px max(16px,calc((100% - 740px)/2)) 8px}
.page{display:flex;flex-direction:column;gap:calc(14px*var(--d))}
.turn{display:flex;flex-direction:column;gap:10px;animation:rise .15s var(--in)}
.you{align-self:flex-end;max-width:80%;background:var(--you);border:1px solid var(--youbd);border-radius:calc(var(--r)*1.6);padding:calc(9px*var(--d)) 14px;white-space:pre-wrap;word-wrap:break-word;animation:rise .15s var(--in)}
.note{font-size:12.5px;color:var(--mut);display:flex;gap:8px;white-space:pre-wrap;word-break:break-word}.note::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;margin-top:.6em;background:var(--bd)}
.note.warn::before{background:#e0a84a}.note.error{color:var(--bad)}.note.error::before{background:var(--bad)}
#work{display:flex;align-items:center;gap:8px;color:var(--mut);font-size:12px;padding:0 max(16px,calc((100% - 740px)/2)) 8px}#work[hidden]{display:none}
#work::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--acc);animation:pulse 1.2s var(--in) infinite}

/* markdown */
.md{word-wrap:break-word}.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:0 0 .7em}.md ul,.md ol{margin:0 0 .7em;padding-left:1.4em}.md li{margin:.15em 0}
.md h2,.md h3,.md h4,.md h5{margin:1em 0 .4em;font-size:1.02em;font-weight:600;line-height:1.35}.md h2{font-size:1.15em}
.md code{font:.9em/1.4 var(--mono);background:var(--hover);border-radius:4px;padding:.1em .35em}
.md blockquote{margin:0 0 .7em;padding-left:12px;border-left:2px solid var(--bd);color:var(--mut)}
.md hr{border:0;border-top:1px solid var(--line);margin:1em 0}
.md table{border-collapse:collapse;margin:0 0 .8em;font-size:.95em;display:block;overflow:auto}.md th,.md td{border:1px solid var(--line);padding:5px 10px;text-align:left}.md th{background:var(--hover);font-weight:600}
.code{border:1px solid var(--line);border-radius:var(--r);background:var(--bg);margin:0 0 .8em;overflow:hidden}
.code-h{display:flex;justify-content:space-between;align-items:center;padding:3px 4px 3px 12px;font:11px/1 var(--mono);color:var(--mut);border-bottom:1px solid var(--line)}
.code-h button{padding:3px 8px;font-size:11px}
.code pre{margin:0;padding:10px 12px;overflow:auto;font:12.5px/1.55 var(--mono)}.code pre code{background:none;padding:0;font:inherit}
iframe.visual{display:block;width:100%;height:120px;border:1px solid var(--bd);border-radius:var(--r);background:#fff;margin:0 0 .8em;transition:height .15s var(--in)}

/* tool calls, cards, diffs */
details.tools{font-size:12.5px;color:var(--mut)}
details.tools summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;padding:2px 0;user-select:none}
details.tools summary::-webkit-details-marker{display:none}
details.tools summary::after{content:"\\203A";transition:transform .15s var(--in)}details.tools[open] summary::after{transform:rotate(90deg)}
details.tools summary:hover{color:var(--fg)}details.tools.bad summary{color:var(--bad)}
.rows{margin:6px 0 2px;padding-left:12px;border-left:1px solid var(--line);display:flex;flex-direction:column;gap:3px}
.row{display:flex;gap:8px;font:12px/1.5 var(--mono);min-width:0}.row b{font-weight:500;color:var(--fg);flex:none}.row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row::before{content:"\\2022";flex:none;width:10px;color:var(--mut)}.row[data-st=ok]::before{content:"\\2713";color:var(--ok)}.row[data-st=fail]::before{content:"\\2715";color:var(--bad)}.row[data-st=run]::before{color:var(--acc);animation:pulse 1.2s var(--in) infinite}
.row pre{margin:2px 0 0;white-space:pre-wrap;color:var(--bad)}
.card{border:1px solid var(--bd);border-radius:calc(var(--r)*1.5);background:var(--raise);padding:12px 14px;animation:rise .15s var(--in)}
.card h4{margin:0 0 4px;font-size:13.5px;font-weight:600}
.card pre{margin:8px 0 0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}
.card.ask{border-color:color-mix(in srgb,var(--acc) 45%,var(--bd))}
.card.ask.done{border-color:var(--line);background:transparent;padding:8px 12px;display:flex;gap:10px;align-items:baseline;font-size:12.5px;color:var(--mut);animation:none}.card.ask.done h4,.card.ask.done pre,.card.ask.done>.mut:not(:last-child){display:none}
.acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.acts.quiet{margin-top:0;opacity:.0;transition:opacity .15s var(--in)}.turn:hover .acts.quiet,.acts.quiet:focus-within{opacity:1}
.acts.quiet button{padding:2px 8px;font-size:12px}
.diff{padding:0;overflow:hidden}
.diff-h{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 14px;border-bottom:1px solid var(--line)}.diff-h h4{margin:0;flex:1}
.diff details{border-bottom:1px solid var(--line)}.diff details:last-child{border-bottom:0}
.diff summary{cursor:pointer;display:flex;gap:10px;align-items:center;padding:7px 14px;font:12px/1.4 var(--mono)}.diff summary span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.plus{color:var(--ok)}.minus{color:var(--bad)}
.lines{margin:0;padding:6px 0;background:var(--bg);font:12px/1.5 var(--mono);overflow:auto;max-height:340px}
.lines div{padding:0 14px;white-space:pre}.lines .a{background:color-mix(in srgb,var(--ok) 14%,transparent)}.lines .d{background:color-mix(in srgb,var(--bad) 14%,transparent)}.lines .h{color:var(--mut)}

/* home */
.home{max-width:600px;margin:min(12vh,90px) auto 0;text-align:center;animation:rise .2s var(--in)}
.home-k{color:var(--mut);font:12px/1 var(--mono);margin-bottom:12px}
.home h1{font-size:28px;line-height:36px;letter-spacing:-.02em;font-weight:500;margin:0 0 8px}
.home-s{color:var(--mut);font-size:13px;margin-bottom:22px}
.ideas{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;text-align:left}
.idea{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:calc(var(--r)*1.5);background:var(--raise)}
.idea b{font-weight:600;font-size:13px}.idea span{color:var(--mut);font-size:12.5px;line-height:1.45}
.setup{margin-top:18px;text-align:left}.setup .step{display:flex;align-items:center;gap:8px;margin-top:8px}.setup code{flex:1;font:12px/1.4 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;overflow:auto;white-space:nowrap}

/* composer */
#dock{margin:0 auto 12px;width:calc(100% - 24px);max-width:740px;background:var(--raise);border:1px solid var(--bd);border-radius:calc(var(--r)*1.75);padding:6px;transition:border-color .15s var(--in)}
#dock:focus-within{border-color:color-mix(in srgb,var(--fg) 24%,var(--card))}
#box{display:block;width:100%;resize:none;background:transparent;border:0;outline:0;padding:8px 10px 6px;min-height:46px;max-height:30vh}#box::placeholder{color:var(--mut)}
#file-chip{display:inline-flex;gap:6px;align-items:center;margin:4px 8px 0;font-size:12px;color:var(--mut);background:var(--hover);border-radius:999px;padding:2px 4px 2px 10px}#file-chip[hidden]{display:none}#file-chip button{padding:0 6px;border:0;background:none}
#controls{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
#controls select{appearance:none;-webkit-appearance:none;background:transparent;border:0;border-radius:var(--r);color:var(--mut);font-size:12.5px;padding:5px 22px 5px 9px;cursor:pointer;max-width:220px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 12px) 52%,calc(100% - 8px) 52%;background-size:4px 4px;background-repeat:no-repeat}
#controls select:hover{background-color:var(--hover);color:var(--fg)}#controls select[hidden],#agentcmd[hidden]{display:none}
#controls select option{background:var(--card);color:var(--fg)}
#agentcmd{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:12px/1.3 var(--mono);width:150px}
#controls .grow{flex:1}
#send{width:32px;height:32px;padding:0;display:inline-grid;place-items:center;border-radius:calc(var(--r)*1.2);background:var(--acc);color:var(--onacc);border:0}
#send.stop::before{content:"";width:10px;height:10px;border-radius:2px;background:currentColor}#send.stop svg{display:none}

/* menus and sheets */
#menu{position:fixed;z-index:20;min-width:260px;background:var(--card);border:1px solid var(--bd);border-radius:calc(var(--r)*1.5);padding:6px;box-shadow:0 12px 40px rgba(0,0,0,.45);animation:rise .12s var(--in)}#menu[hidden]{display:none}
#menu button{display:block;width:100%;text-align:left;background:transparent;border:0;padding:8px 10px}#menu button:hover{background:var(--hover)}
#menu small{display:block;color:var(--mut);font-size:11.5px}
dialog.sheet{background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:calc(var(--r)*1.5);width:min(560px,94vw);max-height:80dvh;padding:18px}
dialog.sheet::backdrop{background:rgba(0,0,0,.55)}
dialog.sheet h2{margin:0 0 4px;font-size:16px;font-weight:600}
dialog.sheet .list{display:flex;flex-direction:column;gap:6px;margin:12px 0}
dialog.sheet .li{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:var(--r);padding:8px 10px}.li>div{flex:1;min-width:0}.li small{display:block;color:var(--mut);overflow:hidden;text-overflow:ellipsis}
dialog.sheet textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;min-height:64px;resize:vertical}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--card);border:1px solid var(--bd);border-radius:var(--r);padding:8px 14px;max-width:min(560px,92vw);font-size:13px;z-index:30;white-space:pre-wrap;word-break:break-word;animation:rise .15s var(--in)}#toast[hidden]{display:none}
#scrim{display:none}

@keyframes rise{from{opacity:0;transform:translateY(4px)}}@keyframes pulse{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media(max-width:800px){
  body{grid-template-columns:minmax(0,1fr)}
  #side{position:fixed;inset:0 auto 0 0;width:min(300px,84vw);z-index:15;background:var(--bg);border-right:1px solid var(--line);transform:translateX(-102%);transition:transform .2s var(--in)}
  body.nav #side{transform:none}body.nav #scrim{display:block;position:fixed;inset:0;z-index:14;background:rgba(0,0,0,.5)}
  #navbtn{display:inline-grid}#main{margin:0;border:0;border-radius:0}#top{padding-left:4px}
  #log{padding:16px 14px 8px}#work{padding:0 14px 8px}#dock{width:calc(100% - 16px);margin-bottom:8px}
  .ideas{grid-template-columns:minmax(0,1fr)}.home{margin-top:6vh}.home h1{font-size:23px;line-height:30px}
  .acts.quiet{opacity:1}
}
`;

/** Markdown to HTML. Everything is escaped first; only these tags are added. Shipped to the page with toString, so it must stay self-contained. */
export function renderMarkdown(raw: string, final: boolean): { html: string; vis: string[] } {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
  }

  function md(raw, final) {
    const out = [], vis = [], lines = raw.replace(/\r/g, "").split("\n");
    let para = [], list = null, i = 0;
    const endPara = () => { if (para.length) { out.push("<p>" + inline(esc(para.join("\n"))).replace(/\n/g, "<br>") + "</p>"); para = []; } };
    const endList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
    const cells = (s) => s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(esc(c.trim())));
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+.-]*)\s*$/.exec(line);
      if (fence) {
        endPara(); endList();
        const lang = fence[1].toLowerCase(), body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        const closed = i < lines.length;
        i++;
        const code = body.join("\n");
        if (lang === "html" && final && closed) { out.push('<div class="vslot" data-i="' + vis.length + '"></div>'); vis.push(code); }
        else out.push('<div class="code"><div class="code-h"><span>' + esc(lang || "code") + '</span><button type="button" class="ghost copy">Copy</button></div><pre><code>' + esc(code) + "</code></pre></div>");
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        endPara(); endList();
        let t = "<table><thead><tr>" + cells(line).map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { t += "<tr>" + cells(lines[i]).map((c) => "<td>" + c + "</td>").join("") + "</tr>"; i++; }
        out.push(t + "</tbody></table>");
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { endPara(); endList(); const lv = h[1].length + 1; out.push("<h" + lv + ">" + inline(esc(h[2])) + "</h" + lv + ">"); i++; continue; }
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        endPara();
        const kind = /\d/.test(li[1]) ? "ol" : "ul";
        if (list !== kind) { endList(); out.push("<" + kind + ">"); list = kind; }
        out.push("<li>" + inline(esc(li[2])) + "</li>");
        i++;
        continue;
      }
      const bq = /^>\s?(.*)$/.exec(line);
      if (bq) { endPara(); endList(); out.push("<blockquote>" + inline(esc(bq[1])) + "</blockquote>"); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { endPara(); endList(); out.push("<hr>"); i++; continue; }
      if (!line.trim()) { endPara(); endList(); i++; continue; }
      endList();
      para.push(line);
      i++;
    }
    endPara(); endList();
    return { html: out.join(""), vis };
  }

  return md(raw, final);
}

function client() {
  const $ = (id) => document.getElementById(id);
  const tok = new URLSearchParams(location.search).get("token");
  const log = $("log"), box = $("box"), side = $("threads"), who = $("who"), model = $("model"), safety = $("safety"), cmd = $("agentcmd"), sendBtn = $("send"), work = $("work"), menu = $("menu");
  const S = { ws: null, active: null, threads: [], recent: [], jobs: [], queueRunning: false, models: [], usage: { claude: [], codex: 0 }, engines: {}, project: "", branch: "", cwd: "", attached: null, pending: {}, unread: new Set(), loaded: new Set(), devices: [], who: "rcode", model: "", mode: "ask", sheet: null, watching: null, watchTimer: 0 };
  const pages = new Map();
  const raws = new WeakMap();

  const WHO = [["rcode", "rcode"], ["claude", "Claude plan"], ["codex", "Codex plan"], ["agent", "Other agent"]];
  const SAFETY = [["ask", "Ask before changes"], ["auto-edit", "Edit freely"], ["full", "Full access"], ["plan", "Look only"]];
  const IDEAS = [
    ["Explain this project", "Explain what this project does and how it is organized, in plain words."],
    ["Fix a bug", "Find the most likely bug in this project and fix it. Show me what you changed."],
    ["Add tests", "Add tests for the most important code that has none, and run them."],
    ["Tidy something up", "Find one confusing piece of code and make it simpler without changing what it does."],
  ];
  const VERDICT = {
    verified: ["\u2713 Verified", "ok", "Checks ran after this change and passed."],
    unverified: ["Unverified", "", "Nothing checked this change yet. Review it, or ask rcode to run the tests."],
    failed: ["Checks failed", "bad", "Checks ran after this change and failed."],
    "read-only": ["Read only", "", "This turn changed no files."],
  };

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
  const thread = () => S.threads.find((t) => t.id === S.active);
  const engineOf = (t) => (t && t.guest ? t.engine : "rcode");
  const modelLabel = (ref) => {
    if (!ref) return "Default model";
    const m = /^claude-cli\/(.+)$/.exec(ref);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1) + " \u00b7 Claude plan";
    return ref.split("/").pop();
  };

  function linkify(node, text) {
    const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
    parts.forEach((p, i) => {
      if (i % 2) { const a = el("a", null, p); a.href = p; a.target = "_blank"; a.rel = "noopener noreferrer"; node.appendChild(a); }
      else if (p) node.appendChild(document.createTextNode(p));
    });
    return node;
  }

  function visual(html) {
    const f = el("iframe", "visual");
    f.setAttribute("sandbox", "allow-scripts");
    f.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; font-src data:"><style>body{margin:0;padding:12px;color:#18181b;font:14px/1.5 system-ui,sans-serif}</style></head><body>'
      + html + '<script>new ResizeObserver(()=>parent.postMessage({rcodeH:document.body.getBoundingClientRect().bottom},"*")).observe(document.body)</script></body></html>';
    return f;
  }
  addEventListener("message", (e) => {
    const h = e.data && e.data.rcodeH;
    if (typeof h !== "number") return;
    for (const f of document.querySelectorAll("iframe.visual")) if (f.contentWindow === e.source) f.style.height = Math.min(640, Math.max(32, Math.ceil(h))) + "px";
  });

  function render(n, final) {
    const r = window.rcodeMd(raws.get(n) || "", final);
    n.innerHTML = r.html;
    n.querySelectorAll(".vslot").forEach((s) => s.replaceWith(visual(r.vis[+s.dataset.i])));
  }

  // Each thread keeps its own page, so events for a background thread are never lost.
  function pageOf(id) { let p = pages.get(id); if (!p) { p = el("div", "page"); pages.set(id, p); } return p; }
  const near = () => log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  function follow(id, fn) {
    const mine = id === S.active, stick = mine && near();
    fn();
    if (!mine) { if (!S.unread.has(id)) { S.unread.add(id); drawSide(); } return; }
    show();
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function put(id, node) { follow(id, () => pageOf(id).appendChild(node)); return node; }
  function turnOf(id) {
    const p = pageOf(id);
    if (!p.turn || p.turn.parentNode !== p) { p.turn = el("div", "turn"); put(id, p.turn); }
    return p.turn;
  }
  function place(id, node) {
    const p = pageOf(id);
    if (p.turn && p.turn.parentNode === p) follow(id, () => p.turn.appendChild(node));
    else put(id, node);
    return node;
  }
  let homeEl = null;
  function show() {
    const p = S.active && pages.get(S.active);
    const want = p && p.childElementCount ? p : (homeEl ||= home());
    if (log.firstChild !== want) { log.replaceChildren(want); if (want === p) log.scrollTop = log.scrollHeight; }
  }

  let pending = new Set(), frame = 0;
  function paintText(n) {
    pending.add(n);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stick = near();
      for (const x of pending) if (!x.dataset.done) render(x, false);
      pending.clear();
      if (stick) log.scrollTop = log.scrollHeight;
    });
  }

  function delta(id, text) {
    const t = turnOf(id);
    let n = t.lastElementChild;
    if (!n || !n.classList.contains("md") || n.dataset.done) { n = el("div", "md said"); raws.set(n, ""); follow(id, () => t.appendChild(n)); }
    raws.set(n, raws.get(n) + text);
    if (id === S.active) paintText(n); else render(n, false);
  }

  function tool(id, ev) {
    const t = turnOf(id);
    let row = null, g = null;
    if (ev.status !== "run") {
      const all = [...t.querySelectorAll(".row")];
      row = (ev.id && all.find((r) => r.dataset.id === ev.id)) || all.find((r) => r.dataset.st === "run") || null;
      if (row) g = row.closest("details.tools");
    }
    if (!g) {
      g = t.lastElementChild;
      if (!g || !g.classList.contains("tools")) {
        g = el("details", "tools");
        g.append(el("summary"), el("div", "rows"));
        follow(id, () => t.appendChild(g));
      }
    }
    const rows = g.lastElementChild;
    if (!row) {
      row = el("div", "row");
      row.append(el("b", null, ev.name || "tool"), el("span"));
      if (ev.id) row.dataset.id = ev.id;
      rows.appendChild(row);
    }
    row.dataset.st = ev.status || "ok";
    if (ev.summary) { row.children[1].textContent = ev.summary; row.title = ev.summary; }
    if (ev.status === "fail" && ev.text) row.appendChild(el("pre", null, String(ev.text).slice(0, 600)));
    const all = [...rows.children], n = all.length, run = all.filter((r) => r.dataset.st === "run").length, fail = all.filter((r) => r.dataset.st === "fail").length;
    g.firstElementChild.textContent = (run ? "Working with " : "Used ") + n + " tool" + (n === 1 ? "" : "s") + (fail ? " \u00b7 " + fail + " failed" : "");
    g.classList.toggle("bad", fail > 0);
  }

  function endTurn(id) {
    const p = pageOf(id), t = p.turn;
    p.turn = null;
    if (!t) return;
    const said = [...t.querySelectorAll(".md.said")];
    for (const n of said) { n.dataset.done = "1"; render(n, true); }
    const text = said.map((n) => raws.get(n) || "").join("\n\n").trim();
    if (!text) return;
    const acts = el("div", "acts quiet");
    const copy = el("button", "ghost", "Copy");
    copy.onclick = () => { navigator.clipboard?.writeText(text).then(() => { copy.textContent = "Copied"; }); };
    const quote = el("button", "ghost", "Quote");
    quote.onclick = () => { box.value = "> " + text.split("\n").join("\n> ") + "\n\n"; grow(); box.focus(); };
    acts.append(copy, quote);
    t.appendChild(acts);
  }

  function note(id, text, level) {
    if (/^receipt [0-9a-f]{6,}/i.test(text)) return;
    const n = linkify(el("div", "note " + (level || "")), text);
    if (id || S.active) place(id || S.active, n);
    else toast(text);
  }

  function approval(m) {
    S.pending[m.id] = m;
    const c = el("div", "card ask");
    c.append(el("h4", null, "Allow this?"), el("div", null, m.title));
    if (m.reason) c.append(el("div", "mut", m.reason));
    if (m.detail) c.append(el("pre", null, m.detail));
    const row = el("div", "acts");
    for (const [k, label, cls] of [["allow", "Allow", "acc"], ["allow-session", "Always allow", ""], ["deny", "Deny", ""]]) {
      const b = el("button", cls || null, label);
      b.onclick = () => { send({ type: "approval", id: m.id, decision: k }); delete S.pending[m.id]; c.classList.add("done"); row.replaceWith(el("div", "mut", k === "deny" ? "Denied." : k === "allow" ? "Allowed once." : "Allowed for this thread.")); drawSide(); };
      row.appendChild(b);
    }
    c.append(row);
    place(m.thread, c);
    drawSide();
  }

  function badge(verdict, hash) {
    const v = VERDICT[verdict] || [verdict, "", ""];
    const b = el("button", "badge " + v[1], v[0]);
    b.type = "button";
    b.title = v[2] + (hash ? "\nReceipt " + hash : "");
    if (hash) b.onclick = () => { navigator.clipboard?.writeText(hash); toast("Receipt " + hash + " copied."); };
    return b;
  }

  function diffCard(id, ev) {
    const files = [];
    let f = null;
    for (const line of String(ev.text || "").split("\n")) {
      if (line.startsWith("diff --git")) { const m = / b\/(.+)$/.exec(line); f = { name: m ? m[1] : line.slice(11), lines: [], add: 0, del: 0 }; files.push(f); continue; }
      if (!f || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename |old mode|new mode)/.test(line)) continue;
      if (line.startsWith("+")) f.add++;
      else if (line.startsWith("-")) f.del++;
      f.lines.push(line);
    }
    const c = el("div", "card diff");
    const head = el("div", "diff-h");
    head.append(el("h4", null, files.length ? "Changed " + files.length + " file" + (files.length === 1 ? "" : "s") : "Changes"));
    if (ev.verdict) head.append(badge(ev.verdict));
    const undo = el("button", null, "Undo");
    undo.title = "Put these files back the way they were before this turn.";
    undo.onclick = () => { send({ type: "undo", thread: id }); undo.disabled = true; undo.textContent = "Undone"; };
    head.append(undo);
    c.append(head);
    const big = files.reduce((s, x) => s + x.lines.length, 0) > 120;
    for (const x of files) {
      const d = el("details");
      d.open = !big;
      const s = el("summary");
      s.append(el("span", null, x.name), el("span", "plus", "+" + x.add), el("span", "minus", "\u2212" + x.del));
      const body = el("div", "lines");
      for (const l of x.lines) body.appendChild(el("div", l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : l.startsWith("@@") ? "h" : null, l || " "));
      d.append(s, body);
      c.append(d);
    }
    if (!files.length) { const pre = el("div", "lines"); pre.textContent = ev.text; c.append(pre); }
    place(id, c);
  }

  function home() {
    const h = el("div", "home");
    if (S.project) h.append(el("div", "home-k", S.project + (S.branch ? " \u00b7 " + S.branch : "")));
    h.append(el("h1", null, "What should we build?"));
    const w = WHO.find((x) => x[0] === who.value);
    const sub = who.value === "rcode" ? modelLabel(model.value) + " \u00b7 " + (SAFETY.find((x) => x[0] === safety.value) || SAFETY[0])[1] : (w ? w[1] : "") + " \u00b7 uses its own tools";
    h.append(el("div", "home-s", sub));
    const ideas = el("div", "ideas");
    for (const [title, prompt] of IDEAS) {
      const b = el("button", "idea");
      b.type = "button";
      b.append(el("b", null, title), el("span", null, prompt));
      b.onclick = () => { box.value = prompt; submit(); };
      ideas.append(b);
    }
    h.append(ideas);
    if (S.ready && !S.engines.claude && !S.engines.codex) {
      const c = el("div", "card setup");
      c.append(el("h4", null, "Connect a plan to get started"), el("div", "mut", "rcode works through the Claude or ChatGPT plan you already pay for. Run one of these in a terminal, then check again."));
      for (const [label, line] of [["Claude", "npm install -g @anthropic-ai/claude-code && claude"], ["Codex", "npm install -g @openai/codex && codex login"]]) {
        const s = el("div", "step");
        const copy = el("button", "ghost", "Copy");
        copy.onclick = () => { navigator.clipboard?.writeText(line); copy.textContent = "Copied"; };
        s.append(el("b", null, label), el("code", null, line), copy);
        c.append(s);
      }
      const again = el("button", "acc", "Check again");
      again.style.marginTop = "12px";
      again.onclick = () => S.ws && S.ws.close();
      c.append(again);
      h.append(c);
    }
    return h;
  }
  function redrawHome() { homeEl = null; show(); }

  function drawSide() {
    $("brand-p").textContent = S.project;
    side.replaceChildren();
    const flag = (t) => Object.values(S.pending).some((p) => p.thread === t.id) ? "ask" : t.running ? "run" : S.unread.has(t.id) ? "new" : "";
    const item = (title, sub, on, click, dot) => {
      const b = el("button", "item" + (on ? " on" : ""));
      b.type = "button";
      const t = el("div", "item-t");
      t.append(el("span", null, title));
      if (dot) t.append(el("span", "dot " + dot));
      b.append(t, el("small", null, sub));
      b.onclick = click;
      return b;
    };
    if (S.threads.length) {
      side.append(el("h3", null, "Threads"));
      for (const t of S.threads) {
        const f = flag(t);
        side.append(item(t.title, f === "ask" ? "Needs you" : t.running ? "Working\u2026" : t.guest ? t.model : modelLabel(t.model), t.id === S.active, () => setActive(t.id), f));
      }
    }
    if (S.recent.length) {
      side.append(el("h3", null, "Earlier"));
      for (const r of S.recent.slice(0, 10)) side.append(item(r.title || "Untitled", r.messages + " messages", false, () => { send({ type: "open", file: r.file }); closeNav(); }));
    }
    if (!S.threads.length && !S.recent.length) side.append(el("div", "empty", "Your threads show up here."));
  }

  function drawTop() {
    const t = thread();
    $("title").textContent = t ? t.title : (S.project || "rcode");
    const slot = $("verdict");
    slot.replaceChildren();
    if (t && t.receipt) slot.append(badge(t.receipt.verdict, t.receipt.hash));
    $("cost").textContent = t && Number(t.cost) > 0 ? "$" + Number(t.cost).toFixed(3) : "";
    work.hidden = !(t && t.running);
  }

  function drawDock() {
    const t = thread();
    const keep = t ? engineOf(t) : S.who;
    who.replaceChildren();
    for (const [v, label] of WHO) {
      const missing = (v === "claude" && !S.engines.claude) || (v === "codex" && !S.engines.codex);
      const o = el("option", null, label + (missing ? " (not installed)" : ""));
      o.value = v;
      who.append(o);
    }
    who.value = keep;
    const rc = keep === "rcode";
    model.hidden = !rc;
    safety.hidden = !rc;
    cmd.hidden = keep !== "agent";
    if (rc) {
      const cur = t && !t.guest ? t.model : S.model;
      const refs = [...S.models];
      if (cur && !refs.includes(cur)) refs.unshift(cur);
      model.replaceChildren();
      if (!cur) { const o = el("option", null, "Default model"); o.value = ""; model.append(o); }
      for (const r of refs) { const o = el("option", null, modelLabel(r)); o.value = r; model.append(o); }
      model.value = cur || "";
      safety.value = t && !t.guest ? t.mode : S.mode;
    }
    const running = !!(t && t.running);
    sendBtn.classList.toggle("stop", running);
    sendBtn.setAttribute("aria-label", running ? "Stop" : "Send");
    sendBtn.title = running ? "Stop" : "Send (Enter)";
  }

  function drawAll() { drawSide(); drawTop(); drawDock(); if (S.sheet) S.sheet(); }

  function setActive(id) {
    S.active = id;
    if (id) S.unread.delete(id);
    const t = thread();
    if (t && !t.guest && !S.loaded.has(id)) { S.loaded.add(id); send({ type: "view", thread: id }); }
    drawAll();
    show();
    log.scrollTop = log.scrollHeight;
    closeNav();
  }

  function focus(id, messages) {
    S.loaded.add(id);
    const p = el("div", "page");
    pages.set(id, p);
    for (const m of messages || []) {
      if (m.role === "user") { p.appendChild(el("div", "you", m.text)); continue; }
      const t = el("div", "turn");
      if (m.tools && m.tools.length) {
        const g = el("details", "tools");
        const rows = el("div", "rows");
        for (const name of m.tools) { const r = el("div", "row"); r.dataset.st = "ok"; r.append(el("b", null, name), el("span")); rows.append(r); }
        g.append(el("summary", null, "Used " + m.tools.length + " tool" + (m.tools.length === 1 ? "" : "s")), rows);
        t.append(g);
      }
      if (m.text) { const n = el("div", "md said"); n.dataset.done = "1"; raws.set(n, m.text); render(n, true); t.append(n); }
      p.appendChild(t);
    }
    setActive(id);
  }

  function upsert(t) {
    const i = S.threads.findIndex((x) => x.id === t.id);
    if (i < 0) S.threads.unshift(t); else S.threads[i] = t;
  }

  function toast(text) {
    const n = $("toast");
    n.replaceChildren();
    linkify(n, text);
    n.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { n.hidden = true; }, 7000);
  }

  function sheet(title, lead, build) {
    const d = $("sheet");
    const draw = () => {
      d.replaceChildren(el("h2", null, title));
      if (lead) d.append(el("div", "mut", lead));
      build(d);
      const done = el("button", null, "Done");
      done.onclick = () => d.close();
      const row = el("div", "acts");
      row.append(done);
      d.append(row);
    };
    S.sheet = draw;
    d.onclose = () => { S.sheet = null; };
    draw();
    if (!d.open) d.showModal();
  }

  function missions() {
    sheet("Missions", "Line up work and let it run one after another. Each mission edits files on its own, and risky commands still stop for you.", (d) => {
      const ta = el("textarea");
      ta.placeholder = "Describe a mission. Example: Update the README to match the new install steps.";
      const add = el("button", "acc", "Add mission");
      add.onclick = () => { const v = ta.value.trim(); if (v) { send({ type: "queue-add", text: v }); ta.value = ""; } };
      d.append(ta);
      const row = el("div", "acts");
      const run = el("button", null, S.queueRunning ? "Running\u2026" : "Run all");
      run.disabled = S.queueRunning || !S.jobs.some((j) => j.status === "pending");
      run.onclick = () => { const t = thread(); send({ type: "queue-run", model: t && !t.guest ? t.model : S.model || undefined }); };
      const clr = el("button", "ghost", "Clear finished");
      clr.onclick = () => send({ type: "queue-clear" });
      row.append(add, run, clr);
      d.append(row);
      const list = el("div", "list");
      if (!S.jobs.length) list.append(el("div", "mut", "Nothing lined up yet."));
      for (const j of S.jobs) {
        const li = el("div", "li");
        const mark = j.status === "done" ? "\u2713" : j.status === "failed" ? "\u2715" : j.status === "running" ? "\u25d0" : "\u25cb";
        const body = el("div");
        body.append(el("div", null, j.prompt.slice(0, 140)), el("small", null, j.error || j.result || j.verdict || j.status));
        li.append(el("span", null, mark), body);
        list.append(li);
      }
      d.append(list);
    });
  }

  function devices() {
    sheet("Phones and simulators", "Start an iPhone simulator or Android emulator, then watch it and tap it from here.", (d) => {
      const look = el("button", null, "Look for devices");
      look.onclick = () => send({ type: "devices" });
      d.append(el("div", "acts"));
      d.lastChild.append(look);
      const list = el("div", "list");
      if (!S.devices.length) list.append(el("div", "mut", "None found yet. This checks Xcode and adb."));
      for (const dev of S.devices) {
        const li = el("div", "li");
        const body = el("div");
        body.append(el("div", null, dev.name), el("small", null, (dev.kind || "") + (dev.state ? " \u00b7 " + dev.state : "")));
        const off = dev.state && dev.state !== "Booted";
        const b = el("button", null, off ? "Start" : "Watch");
        b.onclick = () => { if (off) send({ type: "device", action: "boot", id: dev.id, kind: dev.kind }); else { $("sheet").close(); watch(dev); } };
        li.append(body, b);
        list.append(li);
      }
      d.append(list);
    });
  }

  function usage() {
    sheet("Plan usage", "What your plans have used, read from local stats. Login files are never read.", (d) => {
      const list = el("div", "list");
      const spent = S.threads.reduce((s, t) => s + (t.guest ? 0 : Number(t.cost) || 0), 0);
      const row = (a, b) => { const li = el("div", "li"); const x = el("div"); x.append(el("div", null, a), el("small", null, b)); li.append(x); list.append(li); };
      row("rcode", "$" + spent.toFixed(3) + " this session, from receipts");
      if (!S.usage.claude.length) row("Claude plan", "No local stats yet");
      for (const c of S.usage.claude.slice(0, 4)) row("Claude \u00b7 " + c.model, Math.round((c.input + c.output) / 1000) + "k tokens");
      row("Codex plan", (S.usage.codex || 0) + " threads");
      d.append(list);
    });
  }

  function watch(dev) {
    S.watching = dev;
    if (!S.active) { toast("Open a thread first, then watch the device there."); return; }
    const card = el("div", "card");
    const img = el("img");
    img.alt = dev.name;
    img.style.cssText = "max-width:300px;border-radius:12px;cursor:crosshair;display:block";
    img.onclick = (ev) => {
      const r = img.getBoundingClientRect();
      send({ type: "device", action: "tap", id: dev.id, kind: dev.kind, x: Math.round((ev.clientX - r.left) / r.width * img.naturalWidth), y: Math.round((ev.clientY - r.top) / r.height * img.naturalHeight) });
    };
    const keys = el("div", "acts");
    for (const [action, label] of [["home", "Home"], ["back", "Back"]]) { const b = el("button", null, label); b.onclick = () => send({ type: "device", action, id: dev.id, kind: dev.kind }); keys.append(b); }
    card.append(el("h4", null, dev.name), img, keys);
    put(S.active, card);
    clearInterval(S.watchTimer);
    const tick = () => { if (img.isConnected || !S.watching) img.src = "/device/frame?token=" + encodeURIComponent(tok) + "&id=" + encodeURIComponent(dev.id) + "&kind=" + dev.kind + "&t=" + Date.now(); };
    tick();
    S.watchTimer = setInterval(tick, 900);
  }

  const MENU = [
    ["Missions", "Line up work to run one after another", missions],
    ["Phones and simulators", "Watch and tap a device", devices],
    ["Plan usage", "What your plans have used", usage],
    ["Look and feel", "Skins, colors, and type", () => skinPanel()],
    ["Open on another device", "A private link through Cloudflare", () => send({ type: "share" })],
    ["Make a copy of this repo", "Work on a separate branch", () => { const n = prompt("Name the copy. Letters, numbers, dashes.", "wip"); if (n) send({ type: "worktree", name: n }); }],
    ["Open a pull request", "Push this branch and open it on GitHub", () => send({ type: "pr", thread: S.active })],
  ];
  function openMenu(anchor) {
    menu.replaceChildren();
    const t = thread();
    const items = [...MENU];
    if (t && !t.guest) items.push([t.plain ? "Plain words: on" : "Plain words: off", "Answers without jargon", () => send({ type: "plain", thread: t.id, on: !t.plain })]);
    for (const [label, sub, fn] of items) {
      const b = el("button");
      b.type = "button";
      b.append(el("div", null, label), el("small", null, sub));
      b.onclick = () => { menu.hidden = true; fn(); };
      menu.append(b);
    }
    const r = anchor.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + "px";
  }
  $("more").onclick = (e) => { e.stopPropagation(); if (menu.hidden) openMenu(e.currentTarget); else menu.hidden = true; };
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { menu.hidden = true; closeNav(); } });

  const closeNav = () => document.body.classList.remove("nav");
  $("navbtn").onclick = () => document.body.classList.toggle("nav");
  $("scrim").onclick = closeNav;
  $("new").onclick = () => { S.active = null; S.who = who.value; drawAll(); redrawHome(); closeNav(); box.focus(); };

  who.onchange = () => {
    S.who = who.value;
    const t = thread();
    if (t && engineOf(t) !== who.value) S.active = null;
    drawAll();
    redrawHome();
  };
  model.onchange = () => { const t = thread(); if (t && !t.guest) send({ type: "model", thread: t.id, ref: model.value }); else { S.model = model.value; redrawHome(); } };
  safety.onchange = () => { const t = thread(); if (t && !t.guest) send({ type: "mode", thread: t.id, mode: safety.value }); else { S.mode = safety.value; redrawHome(); } };

  function grow() { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, innerHeight * 0.3) + "px"; }
  box.addEventListener("input", grow);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(true); } });
  function submit(fromKey) {
    const t = thread();
    if (t && t.running) { if (!fromKey) send({ type: "stop", thread: t.id }); else toast("Still working. Press the stop button to interrupt."); return; }
    const v = box.value.trim();
    if (!v) return;
    if (who.value === "agent" && !cmd.value.trim()) { toast("Type the agent's command first. Example: grok acp"); cmd.focus(); return; }
    box.value = "";
    grow();
    send({ type: "prompt", thread: S.active, text: v, engine: who.value, command: cmd.value, file: S.attached, model: model.hidden ? undefined : model.value || undefined, mode: safety.hidden ? undefined : safety.value });
    S.attached = null;
    drawFile();
  }
  $("dock").onsubmit = (e) => { e.preventDefault(); submit(false); };

  const file = $("file");
  $("attach").onclick = () => file.click();
  file.onchange = () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { S.attached = { name: f.name, text: String(rd.result || "") }; drawFile(); };
    rd.readAsText(f);
    file.value = "";
  };
  function drawFile() {
    const chip = $("file-chip");
    chip.hidden = !S.attached;
    if (!S.attached) return;
    chip.replaceChildren(el("span", null, S.attached.name));
    const x = el("button", null, "\u00d7");
    x.type = "button";
    x.setAttribute("aria-label", "Remove file");
    x.onclick = () => { S.attached = null; drawFile(); };
    chip.append(x);
  }
  const mic = $("mic"), SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) mic.disabled = true;
  else mic.onclick = () => {
    const r = new SR();
    r.onresult = (ev) => { box.value = (box.value + " " + ev.results[0][0].transcript).trim(); grow(); };
    r.onend = () => { mic.style.color = ""; };
    mic.style.color = "var(--acc)";
    r.start();
  };

  log.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button.copy");
    if (!b) return;
    const code = b.closest(".code").querySelector("pre").textContent;
    navigator.clipboard?.writeText(code).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); });
  });

  function onEvt(id, ev) {
    if (ev.type === "delta" && ev.kind === "text") delta(id, ev.text);
    else if (ev.type === "delta" && ev.kind === "thinking") { if (id === S.active) work.textContent = "Thinking\u2026"; }
    else if (ev.type === "tool") tool(id, ev);
    else if (ev.type === "note") note(id, ev.text, ev.level);
    else if (ev.type === "diff") diffCard(id, ev);
    else if (ev.type === "status") { const t = S.threads.find((x) => x.id === id); if (t) { t.running = !!ev.running; drawAll(); } work.textContent = "Working\u2026"; }
    else if (ev.type === "turn") { endTurn(id); const t = S.threads.find((x) => x.id === id); if (t && t.guest) { t.running = false; drawAll(); } }
  }

  function conn() {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?token=" + encodeURIComponent(tok));
    S.ws = ws;
    ws.onopen = () => { $("off").hidden = true; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "ready") {
        Object.assign(S, { ready: true, cwd: m.cwd, project: m.project || "", branch: m.branch || "", engines: m.engines || {}, models: m.models || [], recent: m.recent || [], jobs: m.jobs || [], threads: m.threads || [], usage: m.usage || S.usage, queueRunning: false });
        document.title = (S.project ? S.project + " \u00b7 " : "") + "rcode";
        drawAll();
        redrawHome();
      }
      else if (m.type === "focus") focus(m.id, m.messages);
      else if (m.type === "thread") { upsert(m.thread); drawAll(); if (!pages.get(S.active || "")) show(); }
      else if (m.type === "you") {
        const p = pageOf(m.thread);
        p.turn = null;
        put(m.thread, el("div", "you", m.text));
        const t = S.threads.find((x) => x.id === m.thread);
        if (t && t.title === "New thread") { t.title = m.text.replace(/\s+/g, " ").slice(0, 80); drawSide(); drawTop(); }
      }
      else if (m.type === "queue") { S.jobs = m.jobs; S.queueRunning = m.running; if (S.sheet) S.sheet(); }
      else if (m.type === "note") note(null, m.text, m.level);
      else if (m.type === "approval") approval(m);
      else if (m.type === "evt") onEvt(m.thread, m.evt);
      else if (m.type === "devices") { S.devices = m.list || []; if (S.sheet) S.sheet(); }
      else if (m.type === "usage") { S.usage = m.usage; if (S.sheet) S.sheet(); }
      else if (m.type === "shot" && m.png && S.active) { const img = el("img"); img.alt = "device"; img.src = "data:image/png;base64," + m.png; img.style.cssText = "max-width:280px;border-radius:10px"; put(S.active, img); }
    };
    ws.onclose = () => { $("off").hidden = false; setTimeout(conn, 1200); };
  }

  drawAll();
  show();
  conn();
  box.focus();
}

const BODY = `
<nav id="side"><div id="brand"><b>RCODE</b><span id="brand-p"></span></div>
<button id="new" class="acc" type="button">${ICON.plus}New thread</button>
<div id="threads"></div></nav>
<div id="scrim"></div>
<section id="main">
<div id="top"><button id="navbtn" class="ghost icon" type="button" aria-label="Threads">${ICON.menu}</button><div id="title">rcode</div><span id="off" hidden>Reconnecting\u2026</span><span id="verdict"></span><span id="cost"></span><button id="more" class="ghost icon" type="button" aria-label="More" title="Missions, phones, plan usage, look and feel">${ICON.more}</button></div>
<div id="log"></div>
<div id="work" hidden>Working\u2026</div>
<form id="dock"><div id="file-chip" hidden></div><textarea id="box" rows="1" placeholder="Ask anything. Enter sends, Shift+Enter adds a line."></textarea>
<div id="controls"><select id="who" title="Who does the work"></select><input id="agentcmd" placeholder="grok acp" title="The command that starts an agent speaking the Agent Client Protocol" hidden><select id="model" title="Model"></select><select id="safety" title="What rcode may do without asking">
<option value="ask" title="rcode asks before it edits a file or runs a command">Ask before changes</option><option value="auto-edit" title="rcode edits files on its own and asks before risky commands">Edit freely</option><option value="full" title="No prompts. Catastrophic commands are still refused.">Full access</option><option value="plan" title="rcode reads and plans but changes nothing">Look only</option></select>
<span class="grow"></span><input id="file" type="file" hidden accept="text/*,.md,.json,.ts,.tsx,.js,.py,.go,.rs,.txt,.csv"><button id="attach" class="ghost icon" type="button" aria-label="Attach a file" title="Attach a file">${ICON.clip}</button><button id="mic" class="ghost icon" type="button" aria-label="Speak" title="Speak. Dictation stays in this browser.">${ICON.mic}</button><button id="send" type="submit" aria-label="Send" title="Send (Enter)">${ICON.up}</button></div></form>
</section>
<div id="menu" hidden></div><dialog id="sheet" class="sheet"></dialog><div id="toast" hidden></div>`;

/** The whole page. Built once per process. */
export function centerPage(): string {
  const app = `(${client.toString()})();`.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000000"><link rel="manifest" href="/manifest.webmanifest">
<title>rcode</title><style>${CSS}${SKIN_CSS}</style></head><body>${BODY}
<script>
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
${skinScript()}
window.rcodeMd=(${renderMarkdown.toString()});
${app}
</script></body></html>`;
}
