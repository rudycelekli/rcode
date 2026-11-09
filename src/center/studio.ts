/**
 * The parts of a coding studio that belong next to a thread: a diff of the turn,
 * a copy of the repo, a booted phone, dictation's text, a sandboxed picture,
 * and what the plans have already spent. Nothing here talks to a model.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { basename, join } from "node:path";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

/** ```html fences, at most three. The page draws each in a sandbox. */
export function htmlFences(text: string): string[] {
  const out: string[] = [];
  const re = /```html\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out.slice(0, 3);
}

/**
 * A document for an iframe with no origin and no network. Scripts the model wrote
 * can draw, and they cannot read the center, the disk, or the token.
 */
export function sandboxDocument(html: string): string {
  const body = html.replace(/<\/?(html|head|body)\b[^>]*>/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"></head><body>${body}</body></html>`;
}

/** A long message stays on disk. The model gets the start and the path. */
export function spillPaste(text: string, limit = 12_000): { keep: string; spill?: string } {
  if (text.length <= limit) return { keep: text };
  return { keep: `${text.slice(0, 2_000)}\n\n[${(text.length - 2_000).toLocaleString()} more characters are in the attached file.]`, spill: text };
}

export function saveSpill(text: string, name = "paste.txt"): string {
  const dir = join(tmpdir(), "rcode-inbox");
  mkdirSync(dir, { recursive: true });
  const safe = basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "").slice(0, 60) || "paste.txt";
  const path = join(dir, `${Date.now().toString(36)}-${safe}`);
  writeFileSync(path, text);
  return path;
}

/** The working-tree diff of the files a turn changed, capped so the page stays small. */
export function turnDiff(cwd: string, files: string[], maxChars = 6_000): string {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return "";
  const top = root.out.trim();
  const safe = files.filter((f) => f && !f.startsWith("-") && !f.includes("\0")).slice(0, 20);
  if (!safe.length) return "";
  const tracked = new Set(git(top, ["ls-files", "--", ...safe]).out.split("\n").filter(Boolean));
  const known = safe.filter((f) => tracked.has(f));
  const fresh = safe.filter((f) => !tracked.has(f));
  const parts: string[] = [];
  if (known.length) {
    const d = git(top, ["diff", "--no-color", "HEAD", "--", ...known]);
    if (d.out.trim()) parts.push(d.out.trim());
  }
  // A file the turn created is untracked: diff it against /dev/null so the new lines show.
  for (const f of fresh) {
    const r = spawnSync("git", ["diff", "--no-color", "--no-index", "--", "/dev/null", f], { cwd: top, encoding: "utf8", timeout: 10_000 });
    if (r.stdout?.trim()) parts.push(r.stdout.trim());
  }
  const text = parts.join("\n");
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… diff truncated` : text;
}

/** A second checkout on its own branch, beside the repo. The name is not a path. */
export function addWorktree(cwd: string, name: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return { ok: false, error: "Name the copy with letters, numbers, and dashes." };
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return { ok: false, error: "This folder is not a git repo." };
  const top = root.out.trim();
  const dest = join(top, "..", `${basename(top)}-${name}`);
  const r = git(top, ["worktree", "add", "-b", `rcode/${name}`, dest, "HEAD"]);
  if (!r.ok) return { ok: false, error: (r.err || "Could not make a copy.").slice(0, 300) };
  return { ok: true, path: dest };
}

export interface Device { id: string; name: string; kind: "ios" | "android" }

function simctlDevices(raw: string, states: string[]): Array<Device & { state: string }> {
  try {
    const devices = JSON.parse(raw).devices ?? {};
    const out: Array<Device & { state: string }> = [];
    for (const list of Object.values(devices) as Array<Array<{ state?: string; udid?: string; name?: string }>>) {
      for (const d of list ?? []) if (d?.udid && d.state && states.includes(d.state)) out.push({ id: String(d.udid), name: String(d.name ?? "iPhone"), kind: "ios", state: d.state });
    }
    return out;
  } catch { return []; }
}

export function parseSimctl(raw: string): Device[] {
  return simctlDevices(raw, ["Booted"]);
}

/** Booted and shut-down simulators, so the page can start one. */
export function parseSimctlAll(raw: string): Array<Device & { state: string }> {
  return simctlDevices(raw, ["Booted", "Shutdown"]);
}

export function parseAdb(raw: string): Device[] {
  return raw.split("\n").slice(1).map((l) => l.trim()).filter((l) => /\tdevice$/.test(l)).map((l) => {
    const id = l.split("\t")[0]!;
    return { id, name: id, kind: "android" as const };
  });
}

function run(cmd: string, args: string[], ms = 2_000): string {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: ms });
    return r.status === 0 ? r.stdout ?? "" : "";
  } catch { return ""; }
}

/** Simulators Xcode knows about, plus phones adb already lists. */
export function listDevices(): Array<Device & { state?: string }> {
  const ios = parseSimctlAll(run("xcrun", ["simctl", "list", "devices", "-j"])).slice(0, 12);
  const android = parseAdb(run("adb", ["devices"])).map((d) => ({ ...d, state: "Booted" }));
  return [...ios, ...android];
}

const DEVICE_ID = /^[A-Za-z0-9:._-]{1,80}$/;

/** One screenshot, asked for by the person at the page. Returned as base64, capped. */
export function deviceShot(kind: string, id: string): { png: string } | { error: string } {
  if (!DEVICE_ID.test(id)) return { error: "Unknown device." };
  const file = join(tmpdir(), `rcode-shot-${process.pid}.png`);
  if (kind === "ios") {
    const r = spawnSync("xcrun", ["simctl", "io", id, "screenshot", file], { timeout: 8_000 });
    if (r.status !== 0) return { error: "The simulator did not take a screenshot." };
  } else if (kind === "android") {
    const r = spawnSync("adb", ["-s", id, "exec-out", "screencap", "-p"], { timeout: 8_000, maxBuffer: 8_000_000 });
    if (r.status !== 0 || !r.stdout?.length) return { error: "The phone did not take a screenshot." };
    writeFileSync(file, r.stdout);
  } else return { error: "Unknown device." };
  try {
    const buf = readFileSync(file);
    if (buf.length > 1_500_000) return { error: "The screenshot is too large to show here." };
    return { png: buf.toString("base64") };
  } catch { return { error: "No screenshot was saved." }; }
}

export interface ModelSpend { model: string; input: number; output: number; cost: number }

/** Claude Code's own stats cache: token counts only. Login files are never read. */
export function claudePlanUsage(raw: string): ModelSpend[] {
  try {
    const usage = JSON.parse(raw).modelUsage ?? {};
    const rows: ModelSpend[] = [];
    for (const [model, v] of Object.entries(usage) as Array<[string, any]>) {
      rows.push({
        model,
        input: Number(v?.inputTokens) || 0,
        output: Number(v?.outputTokens) || 0,
        cost: Number(v?.costUSD) || 0,
      });
    }
    return rows.sort((a, b) => b.input - a.input).slice(0, 6);
  } catch { return []; }
}

/** Codex publishes threads, not a dollar total. Count the index and stop. */
export function codexThreadCount(raw: string): number {
  return raw.split("\n").filter((l) => l.includes('"id"')).length;
}

/** github.com, gitlab.com, or the host of origin. Empty when there is no remote. */
export function remoteHost(url: string): string {
  const m = url.match(/(?:git@|https?:\/\/)([^/:]+)/);
  return m?.[1]?.replace(/^[^@]*@/, "") ?? "";
}

/** A pull request on GitHub, through the gh command the person already logged in. */
export function githubPullRequest(cwd: string): { ok: true; url: string } | { ok: false; error: string } {
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) return { ok: false, error: "This folder has no origin remote." };
  if (!remoteHost(remote.out).endsWith("github.com")) return { ok: false, error: `Origin is ${remoteHost(remote.out) || "unknown"}. The diff is here; open that host to review it.` };
  const r = spawnSync("gh", ["pr", "create", "--fill", "--head", "HEAD"], { cwd, encoding: "utf8", timeout: 30_000 });
  const url = (r.stdout ?? "").trim();
  if (r.status !== 0 || !url.startsWith("http")) return { ok: false, error: (r.stderr || "gh could not open a pull request.").trim().slice(0, 300) };
  return { ok: true, url };
}

export function lanHosts(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === "IPv4" && !n.internal) out.push(n.address);
  }
  return out;
}
