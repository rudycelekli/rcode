/**
 * Commands that never touch a model provider: eval suites and handoff briefs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function runOffline(sub: string, args: string[], cwd: string): Promise<number> {
  if (sub === "eval") {
    const file = args[0];
    if (!file) { console.log("Usage: rcode eval <suite.json>"); return 2; }
    const { loadSuite, runSuite, formatReport } = await import("../eval/run.ts");
    try {
      const report = await runSuite(loadSuite(file));
      console.log(formatReport(report));
      return report.passed === report.total ? 0 : 1;
    } catch (e) { console.error((e as Error).message); return 1; }
  }
  if (sub === "handoff") {
    const { handoffForCwd } = await import("../core/handoff.ts");
    const md = handoffForCwd(cwd);
    if (!md) { console.log("No session in this directory yet."); return 1; }
    const dest = args[0];
    if (!dest) { process.stdout.write(md); return 0; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, md);
    console.log(`Wrote ${dest}`);
    return 0;
  }
  return 2;
}
