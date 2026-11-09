/**
 * Local Beacon-compatible event log.
 * Field names follow agent-beacon's normalized schema (harness.name = rcode) so a
 * collector can read this file without an adapter. Nothing leaves the machine.
 * ~/.rcode/telemetry/runtime.jsonl, rotated at 10 MiB, five files kept.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent } from "../agent/types.ts";
import { redact } from "./redact.ts";

export interface BeaconFields {
  "event.action": string;
  "event.id": string;
  "event.fidelity": "observed";
  "session.id": string;
  "prompt.id"?: string;
  "harness.name": "rcode";
  "harness.collection_method": "plugin";
  "gen_ai.tool.call.id"?: string;
  "gen_ai.tool.name"?: string;
  "command.command"?: string;
  "file.path"?: string;
  "tool.error"?: boolean;
  "rcode.verdict"?: string;
  "rcode.receipt"?: string;
  ts: string;
}

const MAX = 10 * 1024 * 1024;

export class Telemetry {
  private seq = 0;
  constructor(private file: string, readonly enabled = true) {}

  prompt(sessionId: string, promptId: string, text: string) {
    this.write(sessionId, promptId, { "event.action": "prompt.submitted", preview: redact(text).slice(0, 160) });
  }

  completed(sessionId: string, promptId: string, verdict: string, receipt: string, stopReason: string) {
    this.write(sessionId, promptId, { "event.action": "prompt.completed", "rcode.verdict": verdict, "rcode.receipt": receipt, "rcode.stop": stopReason });
  }

  denied(sessionId: string, promptId: string, tool: string, reason: string) {
    this.write(sessionId, promptId, { "event.action": "approval.denied", "gen_ai.tool.name": tool, "rcode.reason": redact(reason).slice(0, 240) });
  }

  /** Map a loop event into zero or more beacon records. Never throws. */
  onAgent(sessionId: string, promptId: string, e: AgentEvent) {
    if (!this.enabled) return;
    if (e.type === "tool_start") {
      const file = typeof e.args.path === "string" ? e.args.path : typeof e.args.url === "string" ? e.args.url : undefined;
      const command = e.name === "bash" && typeof e.args.command === "string" ? redact(e.args.command).slice(0, 500) : undefined;
      this.write(sessionId, promptId, { "event.action": "tool.invoked", "gen_ai.tool.name": e.name, "gen_ai.tool.call.id": e.toolCallId, "file.path": file, "command.command": command });
      if (e.name === "read" && file) this.write(sessionId, promptId, { "event.action": "file.read", "gen_ai.tool.call.id": e.toolCallId, "file.path": file });
      if ((e.name === "edit" || e.name === "write") && file) this.write(sessionId, promptId, { "event.action": "file.modified", "gen_ai.tool.call.id": e.toolCallId, "file.path": file });
      if (command) this.write(sessionId, promptId, { "event.action": "command.executed", "gen_ai.tool.call.id": e.toolCallId, "command.command": command });
    } else if (e.type === "tool_end") {
      this.write(sessionId, promptId, { "event.action": "tool.result", "gen_ai.tool.name": e.name, "gen_ai.tool.call.id": e.toolCallId, "tool.error": e.result.isError });
    }
  }

  private write(sessionId: string, promptId: string, fields: Record<string, unknown>) {
    if (!this.enabled || !this.file) return;
    try {
      this.rotate();
      const id = createHash("sha256").update(`${sessionId}|${promptId}|${fields["event.action"]}|${this.seq++}`).digest("hex").slice(0, 16);
      const row: Record<string, unknown> = {
        "event.action": fields["event.action"],
        "event.id": id,
        "event.fidelity": "observed",
        "session.id": sessionId,
        "prompt.id": promptId,
        "harness.name": "rcode",
        "harness.collection_method": "plugin",
        ts: new Date().toISOString(),
        ...fields,
      };
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(row) + "\n");
    } catch { /* telemetry must never break a turn */ }
  }

  private rotate() {
    if (!existsSync(this.file) || statSync(this.file).size < MAX) return;
    for (let i = 4; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) { try { renameSync(from, `${this.file}.${i + 1}`); } catch {} }
    }
    try { renameSync(this.file, `${this.file}.1`); } catch {}
  }
}
