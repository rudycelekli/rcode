/**
 * Verified-done gate: if the agent changed files during a prompt and is about to stop without having
 * run any verification afterwards (tests, type-check, build, lint, running the program, browsing the app)
 * and without honestly saying the change is unverified, nudge it once to verify or say so.
 * Cheap, deterministic, and fires at most once per prompt (no loops).
 */
const VERIFY_CMD = /\b(test|tests|pytest|jest|vitest|mocha|tsc|typecheck|type-check|lint|eslint|ruff|mypy|pyright|clippy|build|compile|cargo\s+(test|check|build|run)|go\s+(test|vet|build|run)|make|npm\s+(run|test)|pnpm|yarn|bun\s+(test|run|x)|deno\s+(test|check)|node\s+\S+\.(m?js|ts)|python3?\s+\S+\.py|ruby\s+\S+\.rb|curl\s+\S*localhost|php\s+\S+|dotnet\s+(test|build)|mvn|gradle|swift\s+(build|test)|xcodebuild)\b/i;
const HONEST = /\b(unverified|not (been )?(verified|tested|run)|couldn'?t (run|verify|test)|could not (run|verify|test)|didn'?t (run|verify|test)|did not (run|verify|test)|unable to (run|verify|test)|untested)\b/i;

/** A successful call that counts as evidence the change was checked. */
export function countsAsVerify(name: string, args: Record<string, unknown>): boolean {
  if (name === "bash" && typeof args.command === "string" && VERIFY_CMD.test(args.command)) return true;
  return name === "browser" || name === "desktop" || name === "task" || name === "diagnostics";
}

export class VerifyGate {
  private seq = 0;
  private lastEdit = -1;
  private lastVerify = -1;
  private fired = false;
  enabled = true;

  reset() { this.seq = 0; this.lastEdit = -1; this.lastVerify = -1; this.fired = false; }

  onTool(name: string, args: Record<string, unknown>, isError: boolean) {
    this.seq++;
    if ((name === "edit" || name === "write") && !isError) this.lastEdit = this.seq;
    else if (!isError && countsAsVerify(name, args)) this.lastVerify = this.seq;
  }

  /** Returns a nudge to inject, or undefined to allow stopping. */
  check(finalText: string): string | undefined {
    if (!this.enabled || this.fired || this.lastEdit < 0) return undefined;
    if (this.lastVerify > this.lastEdit) return undefined;
    if (HONEST.test(finalText)) return undefined;
    this.fired = true;
    return "[rcode verify-gate] You changed files but haven't run anything to verify the change since your last edit. Before finishing: run the relevant check (tests, type-check, build, lint, or execute the code / load the page) and report the actual result. If verification isn't possible here, say explicitly that the change is unverified and why. Do not claim success without evidence.";
  }
}
