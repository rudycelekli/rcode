/**
 * Durable task queue. Jobs live in ~/.rcode/queue.json and survive crashes, reboots and Ctrl+C.
 *
 * Semantics (at-least-once):
 *  - A job claimed by a runner records that runner's pid. If the pid is gone, the job was
 *    interrupted and goes back to pending on the next pass.
 *  - Each claim counts as an attempt. After MAX_ATTEMPTS interrupted attempts a job is failed,
 *    so a job that kills its own runner can't loop forever.
 *  - A job that finishes with an error is failed at once. Model errors are not retried blindly.
 *  - One runner at a time, enforced by a lock file that a dead pid can't hold.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { RCODE_HOME } from "../session/store.ts";

export const MAX_ATTEMPTS = 3;
export const QUEUE_FILE = join(RCODE_HOME, "queue.json");

export type JobStatus = "pending" | "running" | "done" | "failed";
export interface Job {
  id: string;
  cwd: string;
  prompt: string;
  status: JobStatus;
  attempts: number;
  pid?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  verdict?: string;
  result?: string;
  error?: string;
}
export interface Outcome { verdict?: string; result?: string; error?: string }

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Missing file = empty queue. Corrupt file = throw, so a save can never silently wipe jobs. */
export function load(file = QUEUE_FILE): Job[] {
  if (!existsSync(file)) return [];
  const jobs = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(jobs)) throw new Error(`${file} is not a job list; move it aside to reset`);
  return jobs as Job[];
}

/** Write to a temp file, then rename: readers see the old list or the new one, never half of it. */
export function save(jobs: Job[], file = QUEUE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  renameSync(tmp, file);
}

export function add(prompt: string, cwd: string, file = QUEUE_FILE): Job {
  const jobs = load(file);
  const job: Job = { id: randomUUID().slice(0, 8), cwd, prompt: prompt.trim(), status: "pending", attempts: 0, createdAt: Date.now() };
  jobs.push(job);
  save(jobs, file);
  return job;
}

/** Reclaim work whose runner died. Mutates and returns the list. */
export function recover(jobs: Job[]): Job[] {
  for (const j of jobs) {
    if (j.status !== "running" || (j.pid && pidAlive(j.pid))) continue;
    j.pid = undefined;
    if (j.attempts >= MAX_ATTEMPTS) {
      j.status = "failed";
      j.error = `interrupted ${j.attempts} times; giving up`;
      j.finishedAt = Date.now();
    } else j.status = "pending";
  }
  return jobs;
}

/** Take the oldest pending job. Mutates the list. */
export function claim(jobs: Job[], pid = process.pid): Job | undefined {
  const j = jobs.find((x) => x.status === "pending");
  if (!j) return undefined;
  Object.assign(j, { status: "running", pid, attempts: j.attempts + 1, startedAt: Date.now() });
  return j;
}

/** Write a job's outcome by id, reloading first so jobs added during the run are kept. */
function settle(id: string, out: Outcome, file: string): void {
  const jobs = load(file);
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.pid = undefined;
  j.finishedAt = Date.now();
  if (out.error) { j.status = "failed"; j.error = out.error; }
  else { j.status = "done"; j.result = out.result; }
  if (out.verdict) j.verdict = out.verdict;
  save(jobs, file);
}

/** Single-runner lock. A lock whose pid is dead is stale and gets replaced. */
function acquire(file: string): () => void {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch {
      let holder = 0;
      try { holder = Number(readFileSync(lock, "utf8").trim()) || 0; } catch {}
      if (holder && holder !== process.pid && pidAlive(holder)) throw new Error(`another queue runner is working (pid ${holder})`);
      rmSync(lock, { force: true });
    }
  }
  throw new Error("could not lock the queue");
}

/**
 * Work through pending jobs until none are left. `run` does the actual work for one job.
 * Returns counts for this pass.
 */
export async function drain(run: (job: Job) => Promise<Outcome>, opts: { file?: string; onStart?: (job: Job) => void; onEnd?: (job: Job) => void } = {}): Promise<{ done: number; failed: number }> {
  const file = opts.file ?? QUEUE_FILE;
  const release = acquire(file);
  const counts = { done: 0, failed: 0 };
  try {
    for (;;) {
      const jobs = recover(load(file));
      const job = claim(jobs);
      save(jobs, file);
      if (!job) break;
      opts.onStart?.(job);
      let out: Outcome;
      try { out = await run(job); } catch (e) { out = { error: (e as Error).message || String(e) }; }
      settle(job.id, out, file);
      out.error ? counts.failed++ : counts.done++;
      opts.onEnd?.({ ...job, ...out, status: out.error ? "failed" : "done" });
    }
  } finally {
    release();
  }
  return counts;
}

export function clearFinished(file = QUEUE_FILE): number {
  const jobs = load(file);
  const keep = jobs.filter((j) => j.status === "pending" || j.status === "running");
  save(keep, file);
  return jobs.length - keep.length;
}
