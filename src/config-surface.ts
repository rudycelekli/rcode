/**
 * Extra config fields. Merged onto RcodeConfig so the layered JSON loader
 * (which already deep-merges unknown keys) picks them up without a second parser.
 */
declare module "./config.ts" {
  interface RcodeConfig {
    /** Retry a failed fast-tier subagent once on the main model. Default true. */
    router?: { escalate?: boolean };
    /** Local JSONL event log under the rcode home. Default on. Never leaves the machine. */
    telemetry?: "on" | "off";
    /** Append a syntax note after TS/JS edits. Default on. */
    diagnostics?: "syntax" | "off";
    /** Built-in threat rules. They block pipe-to-shell and secret-then-egress even in full mode. Default on. */
    rules?: "builtin" | "off";
  }
}

export {};
