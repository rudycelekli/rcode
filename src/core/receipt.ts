/**
 * Turn receipts — a hash-chained proof of what a prompt actually did.
 * The chain is local (sha256 over a canonical body). It is not a signature;
 * it makes a rewritten session detectable and gives evals a stable artifact.
 */
import { createHash } from "node:crypto";
import type { Message } from "../ai/types.ts";
import { countsAsVerify } from "./verify-gate.ts";
import { redact } from "../telemetry/redact.ts";

export type Verdict = "verified" | "unverified" | "failed" | "read-only" | "aborted";

export interface TurnReceipt {
  turn: number;
  prompt: string;
  filesRead: string[];
  filesChanged: string[];
  commands: Array<{ command: string; ok: boolean }>;
  toolCalls: number;
  toolErrors: number;
  verified: boolean;
  verdict: Verdict;
  /** USD, this turn only. */
  cost: number;
  stopReason: string;
  prev: string | null;
  /** First 16 hex chars of sha256(canonical body). */
  hash: string;
}

export type UnsignedReceipt = Omit<TurnReceipt, "prev" | "hash">;

function promptText(m: Message): string {
  if (m.role !== "user") return "";
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>\s*/g, "")
    .replace(/<active_goal>[\s\S]*?<\/active_goal>\s*/g, "")
    .replace(/<hook_context>[\s\S]*?<\/hook_context>\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Summarize one user turn (messages from the user prompt through the final assistant message). */
export function buildReceipt(messages: Message[], turn: number, cost: number): UnsignedReceipt {
  let prompt = "";
  const filesRead: string[] = [];
  const filesChanged: string[] = [];
  const commands: Array<{ command: string; ok: boolean }> = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  let toolCalls = 0;
  let toolErrors = 0;
  let stopReason = "stop";
  let step = 0;
  let lastChange = -1;
  let lastVerify = -1;

  for (const m of messages) {
    if (m.role === "user" && !prompt && m.timestamp !== 0) prompt = promptText(m);
    if (m.role === "assistant") {
      stopReason = m.stopReason;
      for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, { name: c.name, args: c.arguments });
    }
    if (m.role === "toolResult") {
      step++;
      toolCalls++;
      if (m.isError) toolErrors++;
      const args = calls.get(m.toolCallId)?.args ?? {};
      const path = typeof args.path === "string" ? args.path : "";
      if (m.toolName === "read" && path) filesRead.push(path);
      if ((m.toolName === "edit" || m.toolName === "write") && path && !m.isError) {
        filesChanged.push(path);
        lastChange = step;
      }
      if (m.toolName === "bash" && typeof args.command === "string") {
        commands.push({ command: redact(args.command).slice(0, 180), ok: !m.isError });
      }
      if (!m.isError && countsAsVerify(m.toolName, args)) lastVerify = step;
    }
  }

  const verified = lastChange >= 0 && lastVerify > lastChange;
  let verdict: Verdict;
  if (stopReason === "aborted") verdict = "aborted";
  else if (stopReason === "error") verdict = "failed";
  else if (filesChanged.length && verified) verdict = "verified";
  else if (filesChanged.length) verdict = "unverified";
  else verdict = "read-only";

  return {
    turn, prompt, filesRead: [...new Set(filesRead)], filesChanged: [...new Set(filesChanged)],
    commands, toolCalls, toolErrors, verified, verdict,
    cost: Math.round(cost * 1e6) / 1e6, stopReason,
  };
}

function canonical(r: UnsignedReceipt, prev: string | null): string {
  return JSON.stringify({
    turn: r.turn,
    prompt: r.prompt,
    filesRead: r.filesRead,
    filesChanged: r.filesChanged,
    commands: r.commands,
    toolCalls: r.toolCalls,
    toolErrors: r.toolErrors,
    verified: r.verified,
    verdict: r.verdict,
    cost: r.cost,
    stopReason: r.stopReason,
    prev,
  });
}

export function sealReceipt(r: UnsignedReceipt, prev?: string | null): TurnReceipt {
  const p = prev ?? null;
  const hash = createHash("sha256").update(canonical(r, p)).digest("hex").slice(0, 16);
  return { ...r, prev: p, hash };
}

/** True when each receipt names the previous hash and its own hash matches the body. */
export function verifyChain(receipts: TurnReceipt[]): boolean {
  let prev: string | null = null;
  for (const r of receipts) {
    if (r.prev !== prev) return false;
    const { prev: _p, hash, ...body } = r;
    if (sealReceipt(body, r.prev).hash !== hash) return false;
    prev = hash;
  }
  return true;
}

export function formatReceipt(r: TurnReceipt): string {
  const files = r.filesChanged.length ? r.filesChanged.join(", ") : "—";
  const verifiedBy = r.commands.filter((c) => c.ok).slice(-2).map((c) => c.command).join(" · ");
  return [
    `receipt ${r.hash} · ${r.verdict}`,
    `  changed: ${files}`,
    verifiedBy ? `  commands: ${verifiedBy}` : "",
    `  tools: ${r.toolCalls} (${r.toolErrors} errors) · $${r.cost.toFixed(4)}`,
  ].filter(Boolean).join("\n");
}

/** Group a transcript into user turns and seal them in order. */
export function deriveReceipts(messages: Message[]): TurnReceipt[] {
  const groups: Message[][] = [];
  let cur: Message[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.timestamp !== 0 && cur.length) { groups.push(cur); cur = [m]; }
    else cur.push(m);
  }
  if (cur.length) groups.push(cur);
  const out: TurnReceipt[] = [];
  let prev: string | null = null;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const cost = g.reduce((s, m) => s + (m.role === "assistant" ? m.usage.cost.total : 0), 0);
    const sealed = sealReceipt(buildReceipt(g, i + 1, cost), prev);
    out.push(sealed);
    prev = sealed.hash;
  }
  return out;
}
