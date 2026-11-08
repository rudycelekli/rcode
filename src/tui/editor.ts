/**
 * Multi-line input editor: history, word motions, kill/yank, bracketed paste (large pastes collapse
 * to a token), Tab completion for /commands and @file paths.
 */
export interface Completion { label: string; insert: string; hint?: string }

export class Editor {
  lines: string[] = [""];
  row = 0;
  col = 0;
  history: string[] = [];
  private hIdx = -1;
  private draft = "";
  private kill = "";
  pastes = new Map<string, string>();
  private pasteSeq = 0;
  completions: Completion[] = [];
  compIdx = 0;

  get text() { return this.lines.join("\n"); }
  set text(t: string) { this.lines = t.split("\n"); this.row = this.lines.length - 1; this.col = this.lines[this.row]!.length; }
  clear() { this.lines = [""]; this.row = 0; this.col = 0; this.hIdx = -1; this.completions = []; this.pastes.clear(); }
  isEmpty() { return this.text.length === 0; }

  /** Expand collapsed paste tokens back to their content. */
  expanded(): string {
    let t = this.text;
    for (const [k, v] of this.pastes) t = t.replace(k, v);
    return t;
  }

  insert(s: string) {
    const parts = s.split("\n");
    const line = this.lines[this.row]!;
    const before = line.slice(0, this.col), after = line.slice(this.col);
    if (parts.length === 1) { this.lines[this.row] = before + s + after; this.col += s.length; return; }
    const newLines = [before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1]! + after];
    this.lines.splice(this.row, 1, ...newLines);
    this.row += parts.length - 1;
    this.col = parts[parts.length - 1]!.length;
  }

  paste(s: string) {
    s = s.replace(/\r\n?/g, "\n");
    const n = s.split("\n").length;
    if (n > 8 || s.length > 1500) {
      const token = `[Pasted #${++this.pasteSeq}: ${n} lines]`;
      this.pastes.set(token, s);
      this.insert(token);
    } else this.insert(s);
  }

  newline() { this.insert("\n"); }

  backspace() {
    if (this.col > 0) { const l = this.lines[this.row]!; this.lines[this.row] = l.slice(0, this.col - 1) + l.slice(this.col); this.col--; }
    else if (this.row > 0) { const prev = this.lines[this.row - 1]!; this.col = prev.length; this.lines[this.row - 1] = prev + this.lines[this.row]; this.lines.splice(this.row, 1); this.row--; }
  }
  del() {
    const l = this.lines[this.row]!;
    if (this.col < l.length) this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + 1);
    else if (this.row < this.lines.length - 1) { this.lines[this.row] = l + this.lines[this.row + 1]; this.lines.splice(this.row + 1, 1); }
  }
  left() { if (this.col > 0) this.col--; else if (this.row > 0) { this.row--; this.col = this.lines[this.row]!.length; } }
  right() { if (this.col < this.lines[this.row]!.length) this.col++; else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; } }
  home() { this.col = 0; }
  end() { this.col = this.lines[this.row]!.length; }
  wordLeft() { const l = this.lines[this.row]!; let c = this.col; while (c > 0 && /\s/.test(l[c - 1]!)) c--; while (c > 0 && !/\s/.test(l[c - 1]!)) c--; this.col = c; }
  wordRight() { const l = this.lines[this.row]!; let c = this.col; while (c < l.length && /\s/.test(l[c]!)) c++; while (c < l.length && !/\s/.test(l[c]!)) c++; this.col = c; }
  killWordBack() { const l = this.lines[this.row]!; const end = this.col; this.wordLeft(); this.kill = l.slice(this.col, end); this.lines[this.row] = l.slice(0, this.col) + l.slice(end); }
  killToEnd() { const l = this.lines[this.row]!; this.kill = l.slice(this.col); this.lines[this.row] = l.slice(0, this.col); }
  killToStart() { const l = this.lines[this.row]!; this.kill = l.slice(0, this.col); this.lines[this.row] = l.slice(this.col); this.col = 0; }
  yank() { this.insert(this.kill); }

  up(): boolean {
    if (this.row > 0) { this.row--; this.col = Math.min(this.col, this.lines[this.row]!.length); return true; }
    if (!this.history.length) return false;
    if (this.hIdx === -1) { this.draft = this.text; this.hIdx = this.history.length; }
    if (this.hIdx > 0) { this.hIdx--; this.text = this.history[this.hIdx]!; }
    return true;
  }
  down(): boolean {
    if (this.row < this.lines.length - 1) { this.row++; this.col = Math.min(this.col, this.lines[this.row]!.length); return true; }
    if (this.hIdx === -1) return false;
    this.hIdx++;
    if (this.hIdx >= this.history.length) { this.hIdx = -1; this.text = this.draft; } else this.text = this.history[this.hIdx]!;
    return true;
  }
  pushHistory(t: string) { if (t.trim() && this.history[this.history.length - 1] !== t) this.history.push(t); if (this.history.length > 500) this.history.shift(); }

  /** Current token being typed (for completion). */
  currentToken(): { token: string; start: number } {
    const l = this.lines[this.row]!.slice(0, this.col);
    const m = l.match(/(\S*)$/)!;
    return { token: m[1]!, start: this.col - m[1]!.length };
  }
  applyCompletion(c: Completion) {
    const { start } = this.currentToken();
    const l = this.lines[this.row]!;
    this.lines[this.row] = l.slice(0, start) + c.insert + l.slice(this.col);
    this.col = start + c.insert.length;
    this.completions = [];
  }
}
