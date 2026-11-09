/**
 * Session handoff: a Markdown brief another person — or another agent — can resume from.
 * Built from sealed receipts when the session has them, otherwise derived from the transcript.
 */
import { readFileSync } from "node:fs";
import type { TurnReceipt } from "./receipt.ts";
import { deriveReceipts } from "./receipt.ts";
import { Session, listSessions } from "../session/store.ts";
import type { Message } from "../ai/types.ts";

export function renderHandoff(o: { cwd: string; title?: string; sessionId?: string; receipts: TurnReceipt[] }): string {
  const last = o.receipts[o.receipts.length - 1];
  const changed = [...new Set(o.receipts.flatMap((r) => r.filesChanged))];
  const commands = o.receipts.flatMap((r) => r.commands.map((c) => `${c.ok ? "ok" : "fail"}  ${c.command}`));
  const lines = [
    "# Handoff",
    "",
    `- Project: \`${o.cwd}\``,
    o.sessionId ? `- Session: \`${o.sessionId}\`` : "",
    o.title ? `- Title: ${o.title}` : "",
    last ? `- Last verdict: **${last.verdict}** (\`${last.hash}\`)` : "- Last verdict: (no turns)",
    last?.prompt ? `- Last ask: ${last.prompt}` : "",
    "",
    "## Files changed",
    changed.length ? changed.map((f) => `- \`${f}\``).join("\n") : "_None._",
    "",
    "## Commands",
    commands.length ? commands.slice(-12).map((c) => `- ${c}`).join("\n") : "_None._",
    "",
    "## Turns",
    o.receipts.length
      ? o.receipts.map((r) => `- ${r.hash} · ${r.verdict} · ${r.filesChanged.length} file(s) · ${r.toolCalls} tools${r.prev ? ` · prev ${r.prev}` : ""}`).join("\n")
      : "_None._",
    "",
    "Resume by reading the files above and the last verdict before changing anything else.",
    "",
  ];
  return lines.filter((l) => l !== "").join("\n") + "\n";
}

export function receiptsInFile(file: string): TurnReceipt[] {
  const found: TurnReceipt[] = [];
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  for (const line of raw.split("\n")) {
    if (!line.includes('"kind":"receipt"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "custom" && e.kind === "receipt" && e.data?.hash) found.push(e.data as TurnReceipt);
    } catch { /* skip */ }
  }
  return found;
}

export function handoffForCwd(cwd: string): string | undefined {
  const latest = listSessions(cwd)[0];
  if (!latest) return undefined;
  let receipts = receiptsInFile(latest.file);
  let title = latest.title;
  let sessionId = latest.id;
  if (!receipts.length) {
    try {
      const s = Session.open(latest.file);
      title = s.title ?? title;
      sessionId = s.id;
      receipts = deriveReceipts(s.buildContext().messages as Message[]);
    } catch { return undefined; }
  }
  return renderHandoff({ cwd, title, sessionId, receipts });
}
