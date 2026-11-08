import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "../src/core/checkpoints.ts";
import { VerifyGate } from "../src/core/verify-gate.ts";

const sh = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

describe("git checkpoints", () => {
  test("undo restores bash-made changes, deletes new files, and never touches the user's index", () => {
    const d = mkdtempSync(join(tmpdir(), "rcode-ck-"));
    sh(d, "init", "-q"); sh(d, "config", "user.email", "t@t"); sh(d, "config", "user.name", "t");
    writeFileSync(join(d, "a.txt"), "v1\n"); writeFileSync(join(d, "b.txt"), "keep\n");
    sh(d, "add", "."); sh(d, "commit", "-qm", "init");
    writeFileSync(join(d, "a.txt"), "staged\n"); sh(d, "add", "a.txt"); // user has a staged change
    const stagedBefore = sh(d, "diff", "--cached");
    const ck = new Checkpoints(d, "sess1");
    expect(ck.enabled).toBe(true);
    expect(ck.snapshot(1)).toBe(true);
    // "agent" changes things via bash
    writeFileSync(join(d, "a.txt"), "agent wrote\n");
    writeFileSync(join(d, "new.txt"), "created\n");
    spawnSync("rm", [join(d, "b.txt")]);
    const r = ck.undo();
    expect(r?.files.sort()).toEqual(["a.txt", "b.txt", "new.txt"]);
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("staged\n");
    expect(readFileSync(join(d, "b.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(d, "new.txt"))).toBe(false);
    expect(sh(d, "diff", "--cached")).toBe(stagedBefore);
    expect(sh(d, "for-each-ref", "refs/rcode")).toBe("");
  });
  test("disabled outside git repos", () => {
    expect(new Checkpoints(mkdtempSync(join(tmpdir(), "rcode-nogit-")), "s").enabled).toBe(false);
  });
});

describe("verify gate", () => {
  test("nudges once after unverified edits; passes after tests or honest admission", () => {
    const g = new VerifyGate();
    g.onTool("edit", { path: "a" }, false);
    expect(g.check("All done!")).toContain("verify");
    expect(g.check("All done!")).toBeUndefined(); // only once
    g.reset(); g.onTool("edit", {}, false); g.onTool("bash", { command: "bun test" }, false);
    expect(g.check("done")).toBeUndefined();
    g.reset(); g.onTool("write", {}, false);
    expect(g.check("Changed it; this is unverified because there are no tests.")).toBeUndefined();
    g.reset(); g.onTool("read", {}, false);
    expect(g.check("done")).toBeUndefined();
  });
});
