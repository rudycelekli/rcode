/**
 * `rcode queue` — queue tasks now, let them run unattended later.
 *   rcode queue add <task…>     queue a task for the current folder
 *   rcode queue list            show jobs and their results
 *   rcode queue run [--yes]     work through pending jobs (auto-edit; --yes = full auto)
 *   rcode queue clear           drop finished jobs
 */
import type { PermissionMode } from "../permissions/policy.ts";
import { add, clearFinished, drain, load, QUEUE_FILE, type Job, type Outcome } from "../core/queue.ts";

const ICON: Record<Job["status"], string> = { pending: "○", running: "◐", done: "✓", failed: "✗" };
const line = (s: string, n = 90) => s.replace(/\s+/g, " ").slice(0, n);

/** One job in a fresh session. Same contract as `rcode -p`: the verdict comes from the receipt. */
export async function runSessionJob(job: Job, opts: { mode?: PermissionMode; model?: string } = {}): Promise<Outcome> {
  const { AgentSession } = await import("../core/session.ts");
  const session = await new AgentSession({ cwd: job.cwd, mode: opts.mode ?? "auto-edit", model: opts.model }).init();
  try {
    await session.prompt(job.prompt);
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    const verdict = session.lastReceipt?.verdict;
    if (last?.role === "assistant" && last.stopReason === "error") return { verdict, error: last.errorMessage ?? "model error" };
    const text = last?.role === "assistant" ? last.content.filter((c) => c.type === "text").map((c: any) => c.text).join("") : "";
    return { verdict, result: text.trim().slice(0, 2000) };
  } finally {
    await session.dispose();
  }
}

export async function runQueue(args: string[], flags: Record<string, any>, cwd: string): Promise<number> {
  const [sub = "list", ...rest] = args;
  switch (sub) {
    case "add": {
      const prompt = rest.join(" ").trim();
      if (!prompt) { console.log("Usage: rcode queue add <task…>"); return 2; }
      const j = add(prompt, cwd);
      console.log(`queued ${j.id}: ${line(prompt, 70)}\n  run it with: rcode queue run`);
      return 0;
    }
    case "list": {
      const jobs = load();
      if (!jobs.length) { console.log("The queue is empty. Add work with: rcode queue add <task>"); return 0; }
      for (const j of jobs) {
        const tail = j.status === "done" ? (j.result ? line(j.result, 70) : "") : j.error ? `— ${line(j.error, 70)}` : "";
        console.log(`${ICON[j.status]} ${j.id} ${j.status.padEnd(7)} ${line(j.prompt, 50).padEnd(50)} ${tail}`);
      }
      return 0;
    }
    case "run": {
      const mode: PermissionMode = flags.yes ? "full" : "auto-edit";
      const model = flags.model as string | undefined;
      console.log(`Running queued work (${mode} mode). Ctrl+C is safe: unfinished jobs resume next time.`);
      try {
        const counts = await drain((job) => runSessionJob(job, { mode, model }), {
          onStart: (job) => console.log(`▶ ${job.id} ${line(job.prompt, 80)}`),
          onEnd: (job) => {
            if (job.status === "done") console.log(`  ✓ ${job.verdict ? `[${job.verdict}] ` : ""}${line(job.result || "finished", 120)}`);
            else console.log(`  ✗ ${line(job.error || "failed", 160)}`);
          },
        });
        console.log(`\n${counts.done} done · ${counts.failed} failed`);
        return counts.failed ? 1 : 0;
      } catch (e) {
        console.error(`rcode queue: ${(e as Error).message}`);
        return 1;
      }
    }
    case "clear": {
      const n = clearFinished();
      console.log(`cleared ${n} finished job(s) from ${QUEUE_FILE}`);
      return 0;
    }
    default:
      console.log("Usage: rcode queue [list | add <task…> | run [--yes] | clear]");
      return 2;
  }
}
