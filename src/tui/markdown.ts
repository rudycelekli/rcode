/** Lightweight streaming-safe markdown → ANSI renderer (headings, emphasis, code, lists, quotes, tables). */
import { a } from "./ansi.ts";

const KW = /\b(const|let|var|function|return|if|else|for|while|import|from|export|class|new|async|await|def|fn|pub|struct|impl|type|interface|enum|match|try|catch|throw|yield|package|func|go|use|mod|self|this|true|false|null|None|nil|undefined)\b/g;

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c) => a.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => a.bold(t))
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, (_, p, t) => p + a.italic(t))
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, (_, p, t) => p + a.italic(t))
    .replace(/~~([^~]+)~~/g, (_, t) => `\x1b[9m${t}\x1b[29m`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `${a.under(t)} ${a.gray("(" + u + ")")}`);
}

function highlight(line: string, lang: string): string {
  if (/^(diff|patch)$/.test(lang)) return line.startsWith("+") ? a.green(line) : line.startsWith("-") ? a.red(line) : line.startsWith("@@") ? a.cyan(line) : line;
  if (/^(sh|bash|zsh|shell|console)$/.test(lang)) return line.replace(/^(\$ )/, a.gray("$1"));
  return line
    .replace(/(\/\/.*$|#(?!\[).*$)/, (m) => a.gray(m))
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (m) => a.green(m))
    .replace(KW, (m) => a.magenta(m));
}

export function renderMarkdown(src: string): string[] {
  const out: string[] = [];
  let inCode = false, lang = "";
  for (const raw of src.split("\n")) {
    const fence = raw.match(/^\s*```(\w*)/);
    if (fence) {
      if (!inCode) { inCode = true; lang = fence[1] ?? ""; out.push(a.gray(`╭─ ${lang || "code"}`)); }
      else { inCode = false; out.push(a.gray("╰─")); }
      continue;
    }
    if (inCode) { out.push(a.gray("│ ") + highlight(raw, lang)); continue; }
    let m;
    if ((m = raw.match(/^(#{1,6})\s+(.*)$/))) { out.push(m[1]!.length <= 2 ? a.bold(a.accent(m[2]!)) : a.bold(m[2]!)); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) { out.push(a.gray("─".repeat(40))); continue; }
    if ((m = raw.match(/^(\s*)[-*+]\s+\[( |x)\]\s+(.*)$/))) { out.push(`${m[1]}${m[2] === "x" ? a.green("☑") : "☐"} ${inline(m[3]!)}`); continue; }
    if ((m = raw.match(/^(\s*)[-*+]\s+(.*)$/))) { out.push(`${m[1]}${a.accent("•")} ${inline(m[2]!)}`); continue; }
    if ((m = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) { out.push(`${m[1]}${a.accent(m[2] + ".")} ${inline(m[3]!)}`); continue; }
    if ((m = raw.match(/^>\s?(.*)$/))) { out.push(a.gray("▌ ") + a.italic(inline(m[1]!))); continue; }
    if (/^\s*\|.*\|\s*$/.test(raw)) { if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; out.push(raw.replace(/\|/g, a.gray("│")).replace(/[^│]+/g, (c) => inline(c))); continue; }
    out.push(inline(raw));
  }
  return out;
}
