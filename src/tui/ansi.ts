export const ESC = "\x1b[";
export const a = {
  reset: "\x1b[0m", bold: (s: string) => `\x1b[1m${s}\x1b[22m`, dim: (s: string) => `\x1b[2m${s}\x1b[22m`, italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  under: (s: string) => `\x1b[4m${s}\x1b[24m`, inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`, green: (s: string) => `\x1b[32m${s}\x1b[39m`, yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`, magenta: (s: string) => `\x1b[35m${s}\x1b[39m`, cyan: (s: string) => `\x1b[36m${s}\x1b[39m`, gray: (s: string) => `\x1b[90m${s}\x1b[39m`,
  accent: (s: string) => `\x1b[38;5;208m${s}\x1b[39m`,
  bgCode: (s: string) => `\x1b[48;5;236m${s}\x1b[49m`,
};

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
export const strip = (s: string) => s.replace(ANSI_RE, "");

/** Display width (handles wide CJK/emoji roughly). */
export function width(s: string): number {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) ? 2 : 1;
  }
  return w;
}

/** Hard-wrap a line (preserving ANSI codes) to `cols`. */
export function wrap(line: string, cols: number): string[] {
  if (cols <= 0) return [line];
  if (width(line) <= cols) return [line];
  const out: string[] = [];
  let cur = "", w = 0, i = 0;
  while (i < line.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(line);
    if (m && m.index === i) { cur += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const cw = width(ch);
    if (w + cw > cols) { out.push(cur + "\x1b[0m"); cur = ""; w = 0; }
    cur += ch; w += cw; i += ch.length;
  }
  if (cur) out.push(cur);
  return out;
}

export const truncate = (s: string, cols: number) => (width(s) <= cols ? s : wrap(s, Math.max(1, cols - 1))[0] + "…");
