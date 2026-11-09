import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxReset, fauxScript } from "../src/ai/providers/faux.ts";
import { keyProvider, rankLocal, starterIdeas } from "../src/core/welcome.ts";
import { firstJson, parseTeammate, parseWorkflow, renderTeammate, renderWorkflow, slug, transcriptDigest, writeUnique } from "../src/core/teach.ts";
import { parseFrontmatter } from "../src/ext/resources.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rcode-welcome-"));

describe("zero-config start", () => {
  test("a pasted key is recognized by shape, and only when it's the whole message", () => {
    expect(keyProvider("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")?.provider).toBe("anthropic");
    expect(keyProvider("  sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 ")?.provider).toBe("openrouter");
    expect(keyProvider("sk-proj-abcdefghijklmnopqrstuvwxyz")?.provider).toBe("openai");
    expect(keyProvider("AIzaSyA1234567890abcdefghijklmnopqrstu")?.provider).toBe("google");
    expect(keyProvider("gsk_abcdefghijklmnopqrstuvwxyz")?.provider).toBe("groq");
    expect(keyProvider("xai-abcdefghijklmnopqrstuvwxyz")?.provider).toBe("xai");
    expect(keyProvider("my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBeUndefined();
    expect(keyProvider("fix the tests")).toBeUndefined();
    expect(keyProvider("sk-short")).toBeUndefined();
  });

  test("picks the best local coding model and never an embedding model", () => {
    expect(rankLocal(["nomic-embed-text:latest", "llama3.2:3b", "qwen2.5-coder:14b"])).toBe("qwen2.5-coder:14b");
    expect(rankLocal(["gemma3:4b", "qwen3-coder:30b", "devstral:24b"])).toBe("qwen3-coder:30b");
    expect(rankLocal(["nomic-embed-text:latest"])).toBeUndefined();
    expect(rankLocal(["some-custom-model"])).toBe("some-custom-model");
    expect(rankLocal([])).toBeUndefined();
  });

  test("starter ideas fit the folder", () => {
    const empty = tmp();
    expect(starterIdeas(empty)[0]).toContain("website");
    const proj = tmp();
    writeFileSync(join(proj, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    mkdirSync(join(proj, ".git"));
    const ideas = starterIdeas(proj);
    expect(ideas).toHaveLength(3);
    expect(ideas[0]).toContain("plain English");
    expect(ideas).toContain("Run the tests and fix anything that fails");
    expect(ideas).toContain("Review my uncommitted changes and point out bugs");
  });
});

describe("hire and teach", () => {
  test("helpers: json extraction, slugs, safe names, unique files", () => {
    expect(firstJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(firstJson("no json")).toBeUndefined();
    expect(slug("A11y Reviewer!!")).toBe("a11y-reviewer");
    expect(parseTeammate({ name: "../../etc/passwd", instructions: "x" }, "fallback")!.name).toBe("etc-passwd");
    expect(parseTeammate({ name: "ok-name" }, "f")).toBeUndefined();
    const d = tmp();
    expect(writeUnique(d, "x", "1").name).toBe("x");
    expect(writeUnique(d, "x", "2").name).toBe("x-2");
  });

  test("teammate and workflow files parse back as rcode resources", () => {
    const t = renderTeammate(parseTeammate({ name: "a11y-reviewer", description: "Checks accessibility", readOnly: true, instructions: "You review UI for accessibility." }, "f")!);
    const pt = parseFrontmatter(t);
    expect(pt.meta.name).toBe("a11y-reviewer");
    expect(String(pt.meta.tools)).toContain("read");
    expect(String(pt.meta.tools)).not.toContain("bash");
    const w = renderWorkflow(parseWorkflow({ description: "Ship a release", body: "1. Bump $ARGUMENTS\n2. Run tests" })!);
    const pw = parseFrontmatter(w);
    expect(pw.meta.description).toBe("Ship a release");
    expect(pw.meta["argument-hint"]).toBeTruthy();
    expect(pw.body).toContain("$ARGUMENTS");
  });

  test("digest keeps asks and actions, drops injected context", () => {
    const digest = transcriptDigest([
      { role: "user", content: [{ type: "text", text: "<relevant_memories>\nsecret stuff\n</relevant_memories>\n\nbump the version" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "npm version patch" } }], provider: "faux", model: "t", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    ] as any);
    expect(digest).toContain("USER: bump the version");
    expect(digest).toContain("ACTION bash");
    expect(digest).not.toContain("secret stuff");
  });

  test("session.hire and session.teach write resources that load immediately", async () => {
    const { AgentSession } = await import("../src/core/session.ts");
    fauxReset();
    const d = tmp();
    const s = await new AgentSession({ cwd: d, model: "faux/test", minimal: true, ephemeral: true, mode: "full" }).init();
    const agents = join(d, "agents"), commands = join(d, "commands");

    fauxScript('{"name": "docs-writer", "description": "Writes friendly docs", "readOnly": false, "instructions": "You write docs."}');
    const h = await s.hire("someone who writes friendly docs", agents);
    expect(h.name).toBe("docs-writer");
    expect(s.agentDefs.some((a) => a.name === "docs-writer")).toBe(true);

    await expect(s.teach("release", commands)).rejects.toThrow("nothing to learn yet");

    fauxScript({ tools: [{ name: "write", args: { path: "VERSION", content: "1.0.1\n" } }] }, "bumped");
    await s.prompt("bump the version file");
    fauxScript('{"description": "Bump the version", "body": "1. Write the new version of $ARGUMENTS to VERSION"}');
    const t = await s.teach("release", commands);
    expect(t.name).toBe("release");
    expect(readFileSync(t.file, "utf8")).toContain("$ARGUMENTS");
    expect(s.commands.some((c) => c.name === "release")).toBe(true);
    await s.dispose();
  });
});
