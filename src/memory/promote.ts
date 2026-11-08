/**
 * Review-gated promotion: a memory the user confirms becomes a durable, shareable project convention
 * in AGENTS.md (checked into the repo, read by rcode and other agents alike).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADING = "## Conventions learned by rcode";

export function promoteToAgentsMd(cwd: string, texts: string[]): { file: string; added: number } {
  const candidates = ["AGENTS.md", "RCODE.md", "CLAUDE.md"].map((f) => join(cwd, f));
  const file = candidates.find((f) => existsSync(f)) ?? candidates[0]!;
  let src = existsSync(file) ? readFileSync(file, "utf8") : "# AGENTS.md\n\nInstructions for AI coding agents working in this repository.\n";
  const fresh = texts.map((t) => t.trim()).filter((t) => t && !src.includes(t));
  if (!fresh.length) return { file, added: 0 };
  const bullets = fresh.map((t) => `- ${t}`).join("\n");
  if (src.includes(HEADING)) {
    // Append at the end of the existing section.
    const idx = src.indexOf(HEADING) + HEADING.length;
    const nextHeading = src.slice(idx).search(/\n## /);
    const insertAt = nextHeading === -1 ? src.length : idx + nextHeading;
    src = src.slice(0, insertAt).replace(/\s*$/, "\n") + bullets + "\n" + src.slice(insertAt);
  } else {
    src = src.replace(/\s*$/, "\n") + `\n${HEADING}\n\n${bullets}\n`;
  }
  writeFileSync(file, src);
  return { file, added: fresh.length };
}
