/**
 * Git checkpoints (t3code technique): before each prompt, snapshot the working tree into a hidden ref
 * using a temporary index — the user's index, branch and stash are never touched. `/undo` restores the
 * worktree to the snapshot exactly (including changes made by bash), deleting files created since.
 *   refs/rcode/checkpoints/<session>/<turn>
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, input, maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export class Checkpoints {
  readonly enabled: boolean;
  private root = "";
  private stack: Array<{ turn: number; commit: string; tree: string }> = [];

  constructor(private cwd: string, private sessionId: string, enabled = true) {
    const r = enabled ? git(cwd, ["rev-parse", "--show-toplevel"]) : { ok: false, out: "" };
    this.enabled = r.ok;
    this.root = r.out;
  }

  /** Tree object of the current worktree (tracked + untracked, respecting .gitignore). */
  private worktreeTree(): string | undefined {
    const idx = join(tmpdir(), `rcode-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const env = { GIT_INDEX_FILE: idx };
    try {
      const head = git(this.root, ["rev-parse", "--verify", "-q", "HEAD"]);
      if (head.ok) git(this.root, ["read-tree", "HEAD"], env);
      if (!git(this.root, ["add", "-A", "--", "."], env).ok) return undefined;
      const t = git(this.root, ["write-tree"], env);
      return t.ok ? t.out : undefined;
    } finally { rmSync(idx, { force: true }); }
  }

  snapshot(turn: number): boolean {
    if (!this.enabled) return false;
    const tree = this.worktreeTree();
    if (!tree) return false;
    const head = git(this.root, ["rev-parse", "--verify", "-q", "HEAD"]);
    const c = git(this.root, ["commit-tree", tree, ...(head.ok ? ["-p", head.out] : []), "-m", `rcode checkpoint ${this.sessionId} turn ${turn}`], { GIT_AUTHOR_NAME: "rcode", GIT_AUTHOR_EMAIL: "rcode@localhost", GIT_COMMITTER_NAME: "rcode", GIT_COMMITTER_EMAIL: "rcode@localhost" });
    if (!c.ok) return false;
    git(this.root, ["update-ref", `refs/rcode/checkpoints/${this.sessionId}/${turn}`, c.out]);
    this.stack.push({ turn, commit: c.out, tree });
    if (this.stack.length > 200) this.stack.shift();
    return true;
  }

  /** Restore the worktree to the most recent checkpoint that differs from now. Returns changed paths. */
  undo(): { turn: number; files: string[] } | undefined {
    if (!this.enabled) return undefined;
    const current = this.worktreeTree();
    if (!current) return undefined;
    while (this.stack.length) {
      const cp = this.stack.pop()!;
      if (cp.tree === current) continue; // nothing changed during that prompt; look further back
      const diff = git(this.root, ["diff", "--name-status", "--no-renames", current, cp.tree]);
      if (!diff.ok) return undefined;
      const files: string[] = [];
      const restore: string[] = [];
      for (const line of diff.out.split("\n").filter(Boolean)) {
        const [status, path] = line.split("\t");
        if (!path) continue;
        files.push(path);
        if (status === "A" || status === "M" || status === "T") restore.push(path); // exists in checkpoint
        else if (status === "D") rmSync(join(this.root, path), { force: true }); // created after checkpoint
      }
      if (restore.length) {
        // `restore --worktree` (without --staged) leaves the user's index untouched.
        const r = git(this.root, ["restore", `--source=${cp.commit}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {}, restore.join("\0"));
        if (!r.ok) return undefined;
      }
      git(this.root, ["update-ref", "-d", `refs/rcode/checkpoints/${this.sessionId}/${cp.turn}`]);
      return { turn: cp.turn, files };
    }
    return undefined;
  }
}
