/**
 * bash: runs in its own process group (abort/timeout kills the whole tree), streams output,
 * keeps the tail on overflow (full log spilled to a file), and supports background jobs
 * (jcode-style) checked with `bash_output` / stopped with `bash_kill`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext } from "../agent/types.ts";
import { text, truncateTail } from "./util.ts";

interface Job { id: string; command: string; proc: ChildProcess; output: string; readPos: number; exitCode: number | null; startedAt: number }
const jobs = new Map<string, Job>();
let jobSeq = 0;

function shell(): string { return process.env.RCODE_SHELL ?? (process.platform === "win32" ? "cmd.exe" : Bun.which("bash") ?? "/bin/sh"); }

function start(command: string, cwd: string): ChildProcess {
  const isWin = process.platform === "win32";
  return spawn(shell(), isWin ? ["/c", command] : ["-c", command], {
    cwd,
    detached: !isWin,
    env: { ...process.env, RCODE: "1", GIT_PAGER: "cat", PAGER: "cat", TERM: "dumb", CI: process.env.CI ?? "", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function killTree(p: ChildProcess) {
  if (!p.pid) return;
  try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"]) : process.kill(-p.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { if (p.exitCode === null) process.kill(-p.pid!, "SIGKILL"); } catch {} }, 2000).unref?.();
}

const schema = z.object({
  command: z.string().describe("Shell command to run"),
  timeout: z.number().int().min(1).max(3600).optional().describe("Timeout in seconds (default 120)"),
  background: z.boolean().optional().describe("Run in background (dev servers, watchers, long builds). Returns a job id; check with bash_output."),
  description: z.string().optional().describe("5-10 word description of what this does"),
});

export const bashTool: Tool<typeof schema> = {
  name: "bash",
  label: "Bash",
  description:
    "Run a shell command in the project directory. Non-interactive (no TTY; avoid editors/pagers; pass -y flags). Output tail is kept if long (full log saved to a file). Use background:true for servers/watchers. Prefer read/grep/glob tools over cat/grep/find.",
  schema,
  concurrency: "exclusive",
  effects: { runsProcess: true },
  summarize: (a) => a.command.length > 120 ? a.command.slice(0, 117) + "…" : a.command,
  async execute(args, ctx) {
    if (args.background) {
      const id = `job${++jobSeq}`;
      const proc = start(args.command, ctx.cwd);
      const job: Job = { id, command: args.command, proc, output: "", readPos: 0, exitCode: null, startedAt: Date.now() };
      const onData = (d: Buffer) => { job.output += d.toString(); if (job.output.length > 4_000_000) { job.output = job.output.slice(-2_000_000); job.readPos = 0; } };
      proc.stdout?.on("data", onData); proc.stderr?.on("data", onData);
      proc.on("close", (c) => (job.exitCode = c ?? -1));
      jobs.set(id, job);
      await Bun.sleep(1500);
      const initial = job.output.slice(0, 4000);
      job.readPos = Math.min(job.output.length, 4000);
      return text(`Started background job ${id} (pid ${proc.pid}).${job.exitCode !== null ? ` It already exited with code ${job.exitCode}.` : ""}\n${initial}`, false, { jobId: id });
    }
    return runForeground(args.command, ctx, (args.timeout ?? 120) * 1000);
  },
};

export function runForeground(command: string, ctx: Pick<ToolContext, "cwd" | "signal" | "onUpdate">, timeoutMs: number): Promise<ReturnType<typeof text>> {
  return new Promise((resolve) => {
    const proc = start(command, ctx.cwd);
    let out = "";
    let timedOut = false;
    let lastUpdate = 0;
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 20_000_000) out = out.slice(-10_000_000);
      const now = Date.now();
      if (ctx.onUpdate && now - lastUpdate > 100) { lastUpdate = now; ctx.onUpdate({ text: out.slice(-4000) }); }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    const timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeoutMs);
    const onAbort = () => killTree(proc);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    proc.on("error", (e) => { clearTimeout(timer); resolve(text(`Failed to start: ${e.message}`, true)); });
    proc.on("close", (code, sig) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const t = truncateTail(out.trimEnd(), "bash");
      let suffix = "";
      if (timedOut) suffix = `\n[Timed out after ${timeoutMs / 1000}s and was killed. Use a larger timeout or background:true.]`;
      else if (ctx.signal.aborted) suffix = "\n[Aborted by user]";
      else if (code !== 0) suffix = `\n[exit code ${code ?? sig}]`;
      resolve(text((t.text || "(no output)") + suffix, timedOut || ctx.signal.aborted || code !== 0, { exitCode: code, timedOut, fullOutputPath: t.fullPath }));
    });
  });
}

const outSchema = z.object({ job_id: z.string(), wait: z.number().int().min(0).max(600).optional().describe("Seconds to wait for new output or exit (default 0)") });
export const bashOutputTool: Tool<typeof outSchema> = {
  name: "bash_output",
  label: "Job output",
  description: "Get new output from a background job started with bash(background:true).",
  schema: outSchema,
  concurrency: "shared",
  effects: { readOnly: true },
  summarize: (a) => a.job_id,
  async execute(args) {
    const job = jobs.get(args.job_id);
    if (!job) return text(`No job ${args.job_id}. Jobs: ${[...jobs.keys()].join(", ") || "none"}`, true);
    const deadline = Date.now() + (args.wait ?? 0) * 1000;
    while (Date.now() < deadline && job.exitCode === null && job.output.length === job.readPos) await Bun.sleep(250);
    const fresh = job.output.slice(job.readPos);
    job.readPos = job.output.length;
    const status = job.exitCode === null ? `running (${Math.round((Date.now() - job.startedAt) / 1000)}s)` : `exited with code ${job.exitCode}`;
    return text(`[${job.id}: ${status}]\n${truncateTail(fresh, job.id).text || "(no new output)"}`);
  },
};

const killSchema = z.object({ job_id: z.string() });
export const bashKillTool: Tool<typeof killSchema> = {
  name: "bash_kill",
  label: "Kill job",
  description: "Stop a background job.",
  schema: killSchema,
  concurrency: "exclusive",
  effects: { runsProcess: true },
  async execute(args) {
    const job = jobs.get(args.job_id);
    if (!job) return text(`No job ${args.job_id}`, true);
    killTree(job.proc);
    jobs.delete(args.job_id);
    return text(`Killed ${args.job_id}`);
  },
};

export function killAllJobs() { for (const j of jobs.values()) killTree(j.proc); jobs.clear(); }
