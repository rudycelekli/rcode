/**
 * Public library surface. The CLI lives in src/cli.ts; embedders drive AgentSession.
 */
export { VERSION } from "./version.ts";
export { AgentSession, type SessionOptions } from "./core/session.ts";
export { Agent } from "./agent/loop.ts";
export { buildReceipt, sealReceipt, verifyChain, deriveReceipts, formatReceipt, type TurnReceipt, type Verdict } from "./core/receipt.ts";
export { renderHandoff, handoffForCwd } from "./core/handoff.ts";
export { ThreatGuard, auditRules, BUILTIN_RULES, isSecretPath, isEgress } from "./guard/rules.ts";
export { shouldEscalate } from "./ai/router.ts";
export { runSuite, runCase, loadSuite, wilson, formatReport, type EvalCase, type SuiteReport } from "./eval/run.ts";
export { Telemetry } from "./telemetry/beacon.ts";
export { redact } from "./telemetry/redact.ts";
export { syntaxNote, diagnosticsTool } from "./tools/diagnostics.ts";
