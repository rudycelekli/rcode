import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDefs } from "../src/context/symbols.ts";
import { rankRepo, repoMap, outline } from "../src/context/repomap.ts";
import { promoteToAgentsMd } from "../src/memory/promote.ts";
import { FlatMemory } from "../src/memory/flat.ts";

describe("symbols", () => {
  test("extracts definitions across languages", () => {
    expect(extractDefs("a.ts", "export async function loadUser(id: string) {\n}\nexport class Repo {\n  find(id: string): User {\n  }\n}\nexport const handler = async (req) => {}\ninterface User { id: string }").map((d) => d.name)).toEqual(["loadUser", "Repo", "find", "handler", "User"]);
    expect(extractDefs("a.py", "class Svc:\n    async def run(self):\n        pass\ndef main():\n  pass").map((d) => d.name)).toEqual(["Svc", "run", "main"]);
    expect(extractDefs("a.go", "func (s *Server) Start() error {\n}\ntype Config struct {\n}").map((d) => d.name)).toEqual(["Start", "Config"]);
    expect(extractDefs("a.rs", "pub struct Db;\nimpl Db {\n    pub async fn query(&self) {}\n}").map((d) => d.name)).toEqual(["Db", "Db", "query"]);
  });
});

describe("repo map", () => {
  const d = mkdtempSync(join(tmpdir(), "rcode-rm-"));
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src/db.ts"), "export class Database {\n  query(sql: string) {\n  }\n}\nexport function connectDatabase() {}\n");
  writeFileSync(join(d, "src/users.ts"), "import { Database, connectDatabase } from './db';\nexport function listUsers(db: Database) { return db.query('x'); }\n");
  writeFileSync(join(d, "src/orders.ts"), "import { Database } from './db';\nexport function listOrders(db: Database) { connectDatabase(); return db.query('y'); }\n");
  writeFileSync(join(d, "src/billing.ts"), "export function chargeInvoice(amount: number) { return amount; }\nexport function refundInvoice() {}\n");
  test("central file ranks first; query re-ranks toward relevant files", () => {
    expect(rankRepo(d)[0]!.path).toBe("src/db.ts");
    expect(rankRepo(d, { query: "invoice refund billing" })[0]!.path).toBe("src/billing.ts");
    const m = repoMap(d, { maxTokens: 300 });
    expect(m).toContain("src/db.ts:");
    expect(m).toContain("class Database");
  });
  test("outline lists defs with line numbers", () => {
    expect(outline("x.ts", readFileSync(join(d, "src/db.ts"), "utf8"))).toContain("5│ export function connectDatabase()");
  });
});

describe("memory v3", () => {
  test("promote writes a conventions section into AGENTS.md idempotently", () => {
    const d = mkdtempSync(join(tmpdir(), "rcode-pr-"));
    writeFileSync(join(d, "AGENTS.md"), "# Project\n\nUse bun.\n\n## Testing\n\nRun bun test.\n");
    expect(promoteToAgentsMd(d, ["Never use npm; use pnpm."]).added).toBe(1);
    expect(promoteToAgentsMd(d, ["Never use npm; use pnpm."]).added).toBe(0);
    const src = readFileSync(join(d, "AGENTS.md"), "utf8");
    expect(src).toContain("## Conventions learned by rcode\n\n- Never use npm; use pnpm.");
    expect(src).toContain("## Testing");
  });
  test("semantic embedder improves recall for paraphrases", async () => {
    const m = new FlatMemory(join(mkdtempSync(join(tmpdir(), "rcode-sem-")), "m.jsonl"));
    await m.init();
    await m.add({ text: "Deployments go through the staging cluster first", scope: "global" });
    await m.add({ text: "Use tabs for indentation in Go files", scope: "global" });
    // Toy embedder: maps a few concepts to axes (stands in for MiniLM).
    const axes = [/deploy|release|ship|staging|production/i, /indent|tabs|format/i];
    const emb = async (t: string) => Float32Array.from(axes.map((r) => (r.test(t) ? 1 : 0)));
    await m.useSemantic({ name: "toy", embedQuery: emb, embedPassage: emb });
    const hits = await m.search("how do we ship to production?", { minScore: 0.1 });
    expect(hits[0]?.item.text).toContain("staging");
    expect(m.name).toBe("flat+toy");
  });
});
