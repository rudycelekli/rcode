/**
 * Skins for the command center, in the spirit of Winamp: pick a look, tune it, and pass it
 * to a friend as a small JSON blob. A skin is data only. `cleanSkin` keeps hex colors, clamped
 * numbers, and a few named choices, so a pasted skin can never carry CSS or script.
 */

export interface Skin {
  name: string;
  bg: string; fg: string; mut: string; acc: string; ok: string; bad: string;
  card: string; bd: string; line: string; you: string; youbd: string; onacc: string;
  font: "geist" | "sans" | "mono" | "serif" | "classic";
  fx: "none" | "bevel" | "scan" | "glow";
  size: number;
  radius: number;
  density: number;
}

/** Runs on the server and, via toString, in the page. It must not reference anything outside itself. */
export function cleanSkin(raw: unknown): Skin {
  const out: Record<string, string | number> = {
    name: "Rune", bg: "#000000", fg: "#ededed", mut: "#9e9e9e", acc: "#ff2a2a", ok: "#5fd38d", bad: "#ff6b6b",
    card: "#0f0f0f", bd: "#262626", line: "#1c1c1c", you: "#1f1f1f", youbd: "#2e2e2e", onacc: "#ffffff",
    font: "geist", fx: "none", size: 14, radius: 8, density: 100,
  };
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  for (const k of ["bg", "fg", "mut", "acc", "ok", "bad", "card", "bd", "line", "you", "youbd", "onacc"]) {
    const v = r[k];
    if (typeof v === "string" && hex.test(v)) out[k] = v.toLowerCase();
  }
  const num = (k: string, lo: number, hi: number) => {
    const v = Number(r[k]);
    if (r[k] !== undefined && r[k] !== null && r[k] !== "" && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, Math.round(v)));
  };
  num("size", 12, 18); num("radius", 0, 16); num("density", 70, 130);
  if (typeof r.font === "string" && ["geist", "sans", "mono", "serif", "classic"].includes(r.font)) out.font = r.font;
  if (typeof r.fx === "string" && ["none", "bevel", "scan", "glow"].includes(r.fx)) out.fx = r.fx;
  if (typeof r.name === "string") out.name = r.name.replace(/[^\w .'-]/g, "").trim().slice(0, 32) || "Custom";
  return out as unknown as Skin;
}

export const SKINS: Skin[] = [
  {},
  { name: "Ember", bg: "#0c0c0e", fg: "#eceae6", mut: "#8d8d93", acc: "#ff8a3d", ok: "#7dcea0", bad: "#e06c75", card: "#151518", bd: "#2a2a30", line: "#222228", you: "#2a2118", youbd: "#4a341f", onacc: "#1a120c", font: "sans", radius: 10 },
  { name: "Rune Light", bg: "#f4f4f5", fg: "#18181b", mut: "#6b6b73", acc: "#e5202a", ok: "#15803d", bad: "#c62828", card: "#ffffff", bd: "#e2e2e5", line: "#ececef", you: "#f0f0f2", youbd: "#e0e0e4", onacc: "#ffffff" },
  { name: "Llama", bg: "#1d1d27", fg: "#00f000", mut: "#9fa0b8", acc: "#f0c818", ok: "#00f000", bad: "#ff4040", card: "#000000", bd: "#50506a", line: "#2c2c3a", you: "#102010", youbd: "#2f6f2f", onacc: "#000000", font: "classic", fx: "bevel", radius: 0, density: 90 },
  { name: "Paper", bg: "#f7f5f0", fg: "#1d1b18", mut: "#6e6a63", acc: "#c2410c", ok: "#15803d", bad: "#b91c1c", card: "#ffffff", bd: "#ddd8cf", line: "#e9e5dd", you: "#fff1e6", youbd: "#f3c9a6", onacc: "#ffffff", font: "serif", radius: 12, density: 110 },
  { name: "Synthwave", bg: "#1a0b2e", fg: "#f8e9ff", mut: "#a68cc4", acc: "#ff3ea5", ok: "#2de2e6", bad: "#ff6b6b", card: "#24103f", bd: "#4b2a75", line: "#2f1652", you: "#3a1048", youbd: "#ff3ea5", onacc: "#1a0b2e", fx: "glow", radius: 14 },
  { name: "Amber CRT", bg: "#0d0800", fg: "#ffb000", mut: "#a87400", acc: "#ffcc33", ok: "#ffd966", bad: "#ff5533", card: "#160e00", bd: "#3d2800", line: "#241800", you: "#241600", youbd: "#6b4a00", onacc: "#0d0800", font: "mono", fx: "scan", radius: 2 },
  { name: "Phosphor", bg: "#000a00", fg: "#33ff66", mut: "#1f9f45", acc: "#33ff66", ok: "#a3ff7a", bad: "#ff5555", card: "#001400", bd: "#0f3f1f", line: "#062206", you: "#002a0a", youbd: "#1f9f45", onacc: "#000000", font: "mono", fx: "scan", radius: 0 },
  { name: "Fjord", bg: "#2e3440", fg: "#eceff4", mut: "#9aa5b8", acc: "#88c0d0", ok: "#a3be8c", bad: "#bf616a", card: "#3b4252", bd: "#4c566a", line: "#434c5e", you: "#34404f", youbd: "#5e81ac", onacc: "#2e3440", radius: 8 },
  { name: "Contrast", bg: "#000000", fg: "#ffffff", mut: "#d0d0d0", acc: "#ffff00", ok: "#00ff7f", bad: "#ff4d4d", card: "#000000", bd: "#ffffff", line: "#ffffff", you: "#111111", youbd: "#ffff00", onacc: "#000000", size: 16, radius: 4, density: 115 },
].map(cleanSkin);

/** Styles keyed off the skin's variables and the data-font / data-fx attributes on <body>. */
export const SKIN_CSS = `
body[data-font=sans]{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body[data-font=mono]{font-family:ui-monospace,Menlo,monospace}
body[data-font=serif]{font-family:ui-serif,Georgia,"Times New Roman",serif}
body[data-font=classic]{font-family:Tahoma,Verdana,"MS Sans Serif",sans-serif}
body[data-fx=bevel] button,body[data-fx=bevel] select,body[data-fx=bevel] textarea,body[data-fx=bevel] .m{border-width:2px;border-style:outset}
body[data-fx=bevel] button:active{border-style:inset}
body[data-fx=bevel] header{background:linear-gradient(180deg,var(--bd),var(--bg))}
body[data-fx=bevel] header b{background:#000;color:var(--ok);padding:3px 8px;border:2px inset var(--bd);font-family:ui-monospace,Menlo,monospace}
body[data-fx=scan]::after{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px);z-index:50}
body[data-fx=scan]{text-shadow:0 0 4px color-mix(in srgb,var(--fg) 45%,transparent)}
body[data-fx=glow] header b,body[data-fx=glow] button.acc{text-shadow:0 0 8px var(--acc);box-shadow:0 0 14px color-mix(in srgb,var(--acc) 45%,transparent)}
body[data-fx=glow] .item.on{box-shadow:0 0 12px color-mix(in srgb,var(--acc) 35%,transparent)}
dialog#skins{background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:var(--r);max-width:min(640px,94vw);padding:16px}
dialog#skins::backdrop{background:rgba(0,0,0,.5)}
.skingrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:12px}
.skin{padding:8px;border-radius:var(--r);cursor:pointer;border:2px solid transparent;font-size:12px}
.skin.on{border-color:var(--acc)}
.swatch{display:flex;height:16px;border-radius:4px;overflow:hidden;margin-bottom:6px}.swatch i{flex:1}
.knobs{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;margin-bottom:12px}
`;

/** Page script: the picker, live knobs, Surprise me, copy and paste. Expects `el` from the page. */
export function skinScript(): string {
  return `
const SKINS=${JSON.stringify(SKINS)};
const cleanSkin=(${cleanSkin.toString()});
const FONT_STACK={geist:"Geist,Inter,ui-sans-serif,system-ui",sans:"ui-sans-serif,system-ui,-apple-system",mono:"ui-monospace,Menlo,monospace",serif:"ui-serif,Georgia,serif",classic:"Tahoma,Verdana,sans-serif"};
let skin=cleanSkin(SKINS[0]);
function applySkin(s){skin=cleanSkin(s);const st=document.documentElement.style;
  for(const k of["bg","fg","mut","acc","ok","bad","card","bd","line","you","youbd","onacc"])st.setProperty("--"+k,skin[k]);
  st.setProperty("--size",skin.size+"px");st.setProperty("--r",skin.radius+"px");st.setProperty("--d",String(skin.density/100));
  document.body.dataset.font=skin.font;document.body.dataset.fx=skin.fx;
  const meta=document.querySelector("meta[name=theme-color]");if(meta)meta.setAttribute("content",skin.bg);
  try{localStorage.setItem("rcode.skin",JSON.stringify(skin))}catch{}}
function hexOf(h,s,l){s/=100;l/=100;const f=n=>{const k=(n+h/30)%12;const c=l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));return Math.round(255*c).toString(16).padStart(2,"0")};return "#"+f(0)+f(8)+f(4)}
function surprise(){const h=Math.floor(Math.random()*360),a=(h+150+Math.floor(Math.random()*60))%360,dark=Math.random()<.75;
  const L=dark?[7,11,20,16,24,90,60]:[96,100,84,90,88,12,40];
  return {name:"Surprise "+h,bg:hexOf(h,22,L[0]),card:hexOf(h,20,L[1]),bd:hexOf(h,18,L[2]),line:hexOf(h,16,L[3]),you:hexOf(a,30,L[4]),youbd:hexOf(a,45,dark?38:70),fg:hexOf(h,12,L[5]),mut:hexOf(h,10,L[6]),acc:hexOf(a,85,dark?62:42),onacc:hexOf(a,30,dark?8:98),ok:hexOf(140,55,dark?62:32),bad:hexOf(355,70,dark?64:42),
    font:["geist","sans","mono","serif","classic"][Math.floor(Math.random()*5)],fx:["none","none","glow","scan","bevel"][Math.floor(Math.random()*5)],radius:Math.floor(Math.random()*17),size:14,density:90+Math.floor(Math.random()*30)}}
function skinPanel(){let d=document.getElementById("skins");if(!d){d=document.createElement("dialog");d.id="skins";document.body.appendChild(d)}
  d.replaceChildren();d.appendChild(el("h3",null,"Skins"));
  const grid=el("div","skingrid");
  for(const p of SKINS){const c=el("div","skin"+(p.name===skin.name?" on":""));c.style.background=p.bg;c.style.color=p.fg;c.style.fontFamily=FONT_STACK[p.font];
    const sw=el("div","swatch");for(const k of["card","acc","ok","bad","fg"]){const i=document.createElement("i");i.style.background=p[k];sw.appendChild(i)}
    c.append(sw,el("div",null,p.name));c.onclick=()=>{applySkin(p);skinPanel()};grid.appendChild(c)}
  d.appendChild(grid);
  d.appendChild(el("h3",null,"Make it yours"));
  const knobs=el("div","knobs");
  const knob=(label,input)=>{knobs.append(el("label",null,label),input)};
  const color=document.createElement("input");color.type="color";color.value=skin.acc.length===7?skin.acc:"#ff8a3d";color.oninput=()=>applySkin({...skin,acc:color.value,name:"Custom"});knob("Accent",color);
  const range=(k,lo,hi,label)=>{const r=document.createElement("input");r.type="range";r.min=lo;r.max=hi;r.value=skin[k];r.oninput=()=>applySkin({...skin,[k]:Number(r.value)});knob(label,r)};
  range("size",12,18,"Text size");range("radius",0,16,"Roundness");range("density",70,130,"Spacing");
  const pick=(k,opts,label)=>{const s=el("select");for(const o of opts){const op=el("option",null,o);op.value=o;if(skin[k]===o)op.selected=true;s.appendChild(op)}s.onchange=()=>applySkin({...skin,[k]:s.value});knob(label,s)};
  pick("font",["geist","sans","mono","serif","classic"],"Font");pick("fx",["none","bevel","scan","glow"],"Effect");
  d.appendChild(knobs);
  const row=el("div");row.style.display="flex";row.style.gap="8px";row.style.flexWrap="wrap";
  const sur=el("button","acc","Surprise me");sur.onclick=()=>{applySkin(surprise());skinPanel()};
  const copy=el("button",null,"Copy skin");copy.onclick=()=>{const t=JSON.stringify(skin);if(navigator.clipboard&&isSecureContext)navigator.clipboard.writeText(t).then(()=>{copy.textContent="Copied"});else prompt("Copy this skin and send it to a friend.",t)};
  const load=el("button",null,"Paste skin");load.onclick=()=>{const t=prompt("Paste a skin. Only colors and sizes are read.");if(!t)return;try{applySkin(JSON.parse(t));skinPanel()}catch{alert("That is not a skin.")}};
  const reset=el("button",null,"Reset");reset.onclick=()=>{applySkin(SKINS[0]);skinPanel()};
  const done=el("button",null,"Done");done.onclick=()=>d.close();
  row.append(sur,copy,load,reset,done);d.appendChild(row);
  if(!d.open)d.showModal()}
(()=>{const want=new URLSearchParams(location.search).get("skin");const named=want&&SKINS.find(s=>s.name.toLowerCase().replace(/ /g,"-")===want.toLowerCase());
  let saved=null;try{saved=JSON.parse(localStorage.getItem("rcode.skin")||"null")}catch{}
  applySkin(named||saved||SKINS[0]);
  const b=el("button",null,"Skin");b.title="Change how the center looks";b.onclick=skinPanel;document.querySelector("header").appendChild(b)})();
`;
}
