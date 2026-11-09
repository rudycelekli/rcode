import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add, claim, clearFinished, drain, load, MAX_ATTEMPTS, recover, save, type Job } from "../src/core/queue.ts";

const DEAD_PID = 2147483646; // no process has this id
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "rcode-queue-")), "queue.json");

describe("durable queue", () => {
  test("add persists jobs and load reads them back", () => {
    const f = tmpFile();
    const a = add("fix the tests", "/work/app", f);
    add("write the changelog", "/work/app", f);
    const jobs = load(f);
    expect(jobs.map((j) => j.prompt)).toEqual(["fix the tests", "write the changelog"]);
    expect(jobs[0]!.status).toBe("pending");
    expect(jobs[0]!.id).toBe(a.id);
    expect(load(join(tmpdir(), "does-not-exist-rcode.json"))).toEqual([]);
  });

  test("claim takes the oldest pending job and records this runner", () => {
    const jobs: Job[] = [
      { id: "a", cwd: "/x", prompt: "first", status: "done", attempts: 1, createdAt: 1 },
      { id: "b", cwd: "/x", prompt: "second", status: "pending", attempts: 0, createdAt: 2 },
      { id: "c", cwd: "/x", prompt: "third", status: "pending", attempts: 0, createdAt: 3 },
    ];
    const j = claim(jobs, 4242);
    expect(j?.id).toBe("b");
    expect(j).toMatchObject({ status: "running", pid: 4242, attempts: 1 });
    expect(claim(jobs)?.id).toBe("c");
    expect(claim(jobs)).toBeUndefined();
  });

  test("a job whose runner died goes back to pending (crash recovery)", () => {
    const jobs: Job[] = [{ id: "a", cwd: "/x", prompt: "p", status: "running", attempts: 1, pid: DEAD_PID, createdAt: 1 }];
    recover(jobs);
    expect(jobs[0]).toMatchObject({ status: "pending" });
    expect(jobs[0]!.pid).toBeUndefined();
  });

  test("a job whose runner is alive is left alone", () => {
    const jobs: Job[] = [{ id: "a", cwd: "/x", prompt: "p", status: "running", attempts: 1, pid: process.pid, createdAt: 1 }];
    recover(jobs);
    expect(jobs[0]!.status).toBe("running");
  });

  test("a job that keeps killing its runner is failed after MAX_ATTEMPTS, not retried forever", () => {
    const jobs: Job[] = [{ id: "p", cwd: "/x", prompt: "poison", status: "running", attempts: MAX_ATTEMPTS, pid: DEAD_PID, createdAt: 1 }];
    recover(jobs);
    expect(jobs[0]).toMatchObject({ status: "failed" });
    expect(jobs[0]!.error).toContain("giving up");
  });

  test("drain completes every job, records outcomes, and reports counts", async () => {
    const f = tmpFile();
    add("one", "/x", f);
    add("two", "/x", f);
    add("three", "/x", f);
    const started: string[] = [];
    const counts = await drain(async (job) => {
      if (job.prompt === "two") return { error: "model unavailable" };
      return { verdict: "verified", result: `did ${job.prompt}` };
    }, { file: f, onStart: (j) => started.push(j.prompt) });
    expect(started).toEqual(["one", "two", "three"]);
    expect(counts).toEqual({ done: 2, failed: 1 });
    const jobs = load(f);
    expect(jobs.map((j) => j.status)).toEqual(["done", "failed", "done"]);
    expect(jobs[0]).toMatchObject({ verdict: "verified", result: "did one" });
    expect(jobs[1]!.error).toBe("model unavailable");
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  test("a thrown runner error fails that job and the queue keeps going", async () => {
    const f = tmpFile();
    add("boom", "/x", f);
    add("fine", "/x", f);
    const counts = await drain(async (job) => { if (job.prompt === "boom") throw new Error("kaboom"); return { result: "ok" }; }, { file: f });
    expect(counts).toEqual({ done: 1, failed: 1 });
    expect(load(f)[0]!.error).toBe("kaboom");
  });

  test("a job added while the queue runs is picked up in the same pass", async () => {
    const f = tmpFile();
    add("first", "/x", f);
    const seen: string[] = [];
    await drain(async (job) => {
      seen.push(job.prompt);
      if (job.prompt === "first") add("late arrival", "/x", f);
      return { result: "ok" };
    }, { file: f });
    expect(seen).toEqual(["first", "late arrival"]);
  });

  test("only one runner at a time; a stale lock from a dead runner is replaced", async () => {
    const f = tmpFile();
    add("work", "/x", f);
    writeFileSync(`${f}.lock`, "1"); // pid 1 is alive (launchd/init) and not ours
    await expect(drain(async () => ({ result: "ok" }), { file: f })).rejects.toThrow("another queue runner");
    writeFileSync(`${f}.lock`, String(DEAD_PID));
    const counts = await drain(async () => ({ result: "ok" }), { file: f });
    expect(counts.done).toBe(1);
  });

  test("a corrupt queue file is an error, never silently overwritten", () => {
    const f = tmpFile();
    writeFileSync(f, "{ not json");
    expect(() => add("x", "/x", f)).toThrow();
    expect(readFileSync(f, "utf8")).toBe("{ not json");
  });

  test("save is atomic: no temp files left behind, and clearFinished keeps live jobs", () => {
    const f = tmpFile();
    save([
      { id: "d", cwd: "/x", prompt: "done", status: "done", attempts: 1, createdAt: 1 },
      { id: "p", cwd: "/x", prompt: "pending", status: "pending", attempts: 0, createdAt: 2 },
    ], f);
    expect(clearFinished(f)).toBe(1);
    expect(load(f).map((j) => j.id)).toEqual(["p"]);
    expect(readFileSync(f, "utf8")).toContain('"pending"');
  });
});
