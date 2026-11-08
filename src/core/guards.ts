/**
 * Guard modes (agentic-qe-inspired), enforced natively before any tool runs — not just prompt text.
 *   freeze-tests — test files may not be modified (stops "fix the test instead of the code").
 *   no-skip      — edits may not introduce skipped/disabled tests.
 *   strict-tdd   — production code may not be edited in a prompt until a test was written or run first.
 */
import type { PermissionDecision } from "../agent/types.ts";

export type Guard = "freeze-tests" | "no-skip" | "strict-tdd";
export const GUARDS: Guard[] = ["freeze-tests", "no-skip", "strict-tdd"];

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$|_spec\.rb$/i;
const SKIP = /\b(it|test|describe|context)\.(skip|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|@unittest\.skip|\bt\.Skip(Now|f)?\s*\(|#\[ignore\]|@Disabled\b|@Ignore\b|\bpending\s*\(|test\.fixme\(/;
const TEST_CMD = /\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|go\s+test|cargo\s+test|bun\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|mix\s+test)\b/i;

export const isTestPath = (p: string) => TEST_PATH.test(p);

export class Guards {
  active = new Set<Guard>();
  private testTouched = false;

  constructor(initial: Guard[] = []) { for (const g of initial) this.active.add(g); }
  resetTurn() { this.testTouched = false; }
  toggle(g: Guard, on?: boolean) { (on ?? !this.active.has(g)) ? this.active.add(g) : this.active.delete(g); }
  list() { return [...this.active]; }

  check(tool: string, args: Record<string, unknown>): PermissionDecision | undefined {
    if (!this.active.size) return undefined;
    const path = typeof args.path === "string" ? args.path : "";
    const writing = tool === "edit" || tool === "write";
    if (tool === "bash" && typeof args.command === "string") {
      if (TEST_CMD.test(args.command)) this.testTouched = true;
      if (this.active.has("freeze-tests") && /(>|tee|sed\s+-i|perl\s+-pi|mv|rm|cp)\b[^|;&]*\b(test|spec)/i.test(args.command) && /\.(test|spec)\.|_test\.|\/tests?\//i.test(args.command))
        return { action: "deny", reason: "[guard freeze-tests] Shell edits to test files are blocked. Fix the production code instead." };
      return undefined;
    }
    if (!writing) return undefined;
    const newText = tool === "write" ? String(args.content ?? "") : ((args.edits as Array<{ new_text?: string }>) ?? []).map((e) => e.new_text ?? "").join("\n");
    const oldText = tool === "edit" ? ((args.edits as Array<{ old_text?: string }>) ?? []).map((e) => e.old_text ?? "").join("\n") : "";
    if (this.active.has("freeze-tests") && isTestPath(path))
      return { action: "deny", reason: `[guard freeze-tests] ${path} is a test file and tests are frozen. Make the production code satisfy the existing tests; if a test is genuinely wrong, explain why and ask the user.` };
    if (this.active.has("no-skip") && SKIP.test(newText) && !SKIP.test(oldText))
      return { action: "deny", reason: "[guard no-skip] This change skips or disables a test. Fix the cause instead, or ask the user for permission to skip it." };
    if (this.active.has("strict-tdd")) {
      if (isTestPath(path)) { this.testTouched = true; return undefined; }
      if (!this.testTouched) return { action: "deny", reason: "[guard strict-tdd] Write or update a failing test first (and run it), then change production code." };
    }
    return undefined;
  }
}
