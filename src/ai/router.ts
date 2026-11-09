/**
 * Cost router v2: a fast-tier subagent that fails is retried once on the main model.
 * Aborts are not retried (the user already stopped the work).
 */
export function shouldEscalate(input: {
  tier?: string;
  stopReason?: string;
  report: string;
  toolErrors: number;
  toolCalls: number;
}): boolean {
  if (input.tier !== "fast") return false;
  if (input.stopReason === "aborted") return false;
  if (input.stopReason === "error" || input.stopReason === "max_turns") return true;
  const report = input.report.trim();
  if (!report || report === "(no final report)" || report.startsWith("FAILED:")) return true;
  if (input.toolCalls >= 2 && input.toolErrors === input.toolCalls) return true;
  return false;
}
