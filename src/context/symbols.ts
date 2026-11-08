/**
 * Zero-dependency symbol extraction for ~15 languages (line-oriented regexes, tuned for definitions).
 * Good enough for a repo map / outline; exactness is not required (aider's insight: ranking beats parsing).
 */
export interface Def { name: string; kind: string; line: number; sig: string; depth: number }

type Rule = [RegExp, string, number]; // regex, kind, capture group index of the name

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "else", "do", "try", "with", "await", "typeof", "sizeof", "elif", "match", "constructor", "super", "this", "self"]);

const TS: Rule[] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, "function", 1],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class", 1],
  [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface", 1],
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, "type", 1],
  [/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum", 1],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function", 1],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function/, "function", 1],
  [/^\s*export\s+const\s+([A-Z][A-Za-z0-9_$]*)\s*[:=]/, "const", 1],
  [/^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{]+)?\{\s*$/, "method", 1],
];
const PY: Rule[] = [[/^\s*(?:async\s+)?def\s+(\w+)/, "function", 1], [/^\s*class\s+(\w+)/, "class", 1]];
const GO: Rule[] = [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/, "function", 1], [/^type\s+(\w+)\s+(?:struct|interface)/, "type", 1], [/^type\s+(\w+)\s+/, "type", 1]];
const RS: Rule[] = [
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, "function", 1],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+(\w+)/, "type", 1],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)/, "type", 1],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, "module", 1],
  [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?(\w+)/, "impl", 1],
];
const JAVA: Rule[] = [
  [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|object|struct)\s+(\w+)/, "class", 1],
  [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|suspend|inline|open|virtual|async|synchronized)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/, "function", 1],
  [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|unsafe|extern)\s+)+[\w<>\[\],.? ]+\s+(\w+)\s*\([^;]*$/, "method", 1],
];
const RB: Rule[] = [[/^\s*def\s+(?:self\.)?(\w+[?!=]?)/, "method", 1], [/^\s*(?:class|module)\s+([A-Z]\w*)/, "class", 1]];
const PHP: Rule[] = [[/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+(\w+)/, "function", 1], [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/, "class", 1]];
const SWIFT: Rule[] = [[/^\s*(?:(?:public|private|fileprivate|internal|open|static|final|override|@\w+)\s+)*func\s+(\w+)/, "function", 1], [/^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+(\w+)/, "type", 1]];
const C: Rule[] = [
  [/^(?:static\s+|inline\s+|extern\s+|virtual\s+|constexpr\s+)*[A-Za-z_][\w:<>,*&\s]*?[\s*&]([A-Za-z_]\w*(?:::\w+)?)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/, "function", 1],
  [/^\s*(?:typedef\s+)?(?:struct|class|union|enum)\s+(\w+)\s*[:{]?/, "type", 1],
  [/^#define\s+(\w+)/, "macro", 1],
];
const LUA: Rule[] = [[/^\s*(?:local\s+)?function\s+([\w.:]+)/, "function", 1]];
const ELIXIR: Rule[] = [[/^\s*defp?\s+(\w+[?!]?)/, "function", 1], [/^\s*defmodule\s+([\w.]+)/, "module", 1]];

const BY_EXT: Record<string, Rule[]> = {
  ts: TS, tsx: TS, js: TS, jsx: TS, mjs: TS, cjs: TS, mts: TS, cts: TS, vue: TS, svelte: TS,
  py: PY, pyi: PY, go: GO, rs: RS, java: JAVA, kt: JAVA, kts: JAVA, cs: JAVA, scala: JAVA,
  rb: RB, php: PHP, swift: SWIFT, c: C, h: C, cc: C, cpp: C, cxx: C, hpp: C, hh: C, m: C, mm: C,
  lua: LUA, ex: ELIXIR, exs: ELIXIR, dart: JAVA,
};

export function languageFor(path: string): Rule[] | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return BY_EXT[ext];
}

export function extractDefs(path: string, src: string): Def[] {
  const rules = languageFor(path);
  if (!rules) return [];
  const out: Def[] = [];
  const lines = src.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.length > 400) continue; // minified / generated
    const t = raw.trim();
    if (inBlockComment) { if (t.includes("*/")) inBlockComment = false; continue; }
    if (t.startsWith("/*") && !t.includes("*/")) { inBlockComment = true; continue; }
    if (!t || t.startsWith("//") || t.startsWith("#") && !t.startsWith("#define") || t.startsWith("*") || t.startsWith("--")) continue;
    for (const [re, kind, g] of rules) {
      const m = raw.match(re);
      if (!m) continue;
      const name = m[g]!;
      if (!name || KEYWORDS.has(name) || name.length < 2) continue;
      const depth = raw.match(/^\s*/)![0].replace(/\t/g, "    ").length;
      out.push({ name, kind, line: i + 1, sig: t.replace(/\s*\{\s*$/, "").replace(/\s+/g, " ").slice(0, 140), depth });
      break;
    }
  }
  return out;
}

/** Identifier occurrence counts (for the reference graph). */
export function identifiers(src: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of src.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) m.set(id[0], (m.get(id[0]) ?? 0) + 1);
  return m;
}
