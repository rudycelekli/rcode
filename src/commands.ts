/** Non-interactive subcommands: setup, doctor, models, sessions, login, mcp, acp. */
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { allModels, apiKeyFor, defaultModelRef, PROVIDERS, refreshFromModelsDev, resolveModel } from "./ai/models.ts";
import { complete } from "./ai/index.ts";
import { loadAuth, loadConfig, saveAuth, saveGlobalConfig, trust, isTrusted } from "./config.ts";
import { listSessions, RCODE_HOME } from "./session/store.ts";
import { getMemory } from "./memory/index.ts";
import { findBrainServer, findRufloBin } from "./integrations/ruvnet.ts";
import { loadAgents, loadCommands, loadSkills } from "./ext/resources.ts";
import { ripgrep } from "./tools/util.ts";
import { McpManager } from "./mcp/manager.ts";
import { RuvnetIntegration } from "./integrations/ruvnet.ts";

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m` };
const ok = (s: string) => console.log(`  ${c.green("✓")} ${s}`);
const bad = (s: string) => console.log(`  ${c.red("✗")} ${s}`);
const warn = (s: string) => console.log(`  ${c.yellow("!")} ${s}`);

export async function runSubcommand(sub: string, args: string[], flags: Record<string, any>, cwd: string): Promise<number> {
  switch (sub) {
    case "models": {
      if (flags.refresh) { const n = await refreshFromModelsDev(); console.log(`Merged ${n} models from models.dev`); }
      const auth = loadAuth();
      for (const m of allModels()) {
        const has = !!apiKeyFor(m, auth) || m.envKeys.length === 0;
        console.log(`${has ? c.green("●") : c.dim("○")} ${(m.provider + "/" + m.id).padEnd(40)} ${c.dim(`${Math.round(m.contextWindow / 1000)}k ctx  $${m.cost.input}/$${m.cost.output}`)}`);
      }
      console.log(c.dim(`\nDefault: ${defaultModelRef(auth)} · any provider/model id works, e.g. openrouter/<model>, ollama/<model>`));
      return 0;
    }
    case "sessions": {
      const s = listSessions(cwd, 30);
      if (!s.length) { console.log("No sessions for this directory yet."); return 0; }
      for (const x of s) console.log(`${new Date(x.mtime).toLocaleString().padEnd(24)} ${String(x.messages).padStart(4)} msgs  ${x.title}\n${c.dim("  " + x.file)}`);
      return 0;
    }
    case "login": {
      const provider = args[0];
      if (!provider || !PROVIDERS[provider]) { console.log(`Usage: rcode login <provider> [key]\nProviders: ${Object.keys(PROVIDERS).join(", ")}`); return 2; }
      let key = args[1];
      if (!key) { const rl = createInterface({ input: process.stdin, output: process.stdout }); key = (await rl.question(`${provider} API key: `)).trim(); rl.close(); }
      if (!key) return 2;
      saveAuth(provider, key);
      console.log(`Saved ${provider} key to ${RCODE_HOME}/auth.json (mode 600).`);
      return 0;
    }
    case "doctor": return doctor(cwd);
    case "setup": return setup(cwd);
    case "acp": { const { runAcp } = await import("./modes/acp.ts"); return runAcp({ cwd, model: flags.model, minimal: flags.minimal }); }
    case "mcp": {
      const cfg = loadConfig(cwd);
      const servers = { ...(cfg.mcpServers ?? {}), ...new RuvnetIntegration(cfg, cwd).mcpServers() };
      if (args[0] === "add") {
        const [name, ...cmd] = args.slice(1);
        if (!name || !cmd.length) { console.log("Usage: rcode mcp add <name> <command> [args…]   |   rcode mcp add <name> https://url"); return 2; }
        const entry = cmd[0]!.startsWith("http") ? { url: cmd[0] } : { command: cmd[0], args: cmd.slice(1) };
        saveGlobalConfig({ mcpServers: { [name]: entry } as any });
        console.log(`Added MCP server "${name}".`);
        return 0;
      }
      console.log(c.bold("MCP servers"));
      const mgr = new McpManager(servers, cwd);
      await mgr.connectAll(20_000);
      for (const s of mgr.servers.values()) (s.status === "ready" ? ok : s.status === "disabled" ? warn : bad)(`${s.name}: ${s.status}${s.status === "ready" ? ` (${s.tools} tools)` : s.error ? ` — ${s.error}` : ""}`);
      if (!mgr.servers.size) console.log(c.dim("  none configured — rcode mcp add <name> <command>"));
      await mgr.close();
      return 0;
    }
  }
  return 2;
}

async function doctor(cwd: string): Promise<number> {
  console.log(c.bold(`rcode doctor`) + c.dim(`  (home: ${RCODE_HOME})`));
  console.log(c.bold("\nRuntime"));
  ok(`bun ${Bun.version} on ${process.platform}/${process.arch}`);
  ripgrep() ? ok(`ripgrep: ${ripgrep()}`) : warn("ripgrep not found — grep uses the slower built-in fallback (brew install ripgrep)");
  console.log(c.bold("\nModels"));
  const auth = loadAuth();
  let any = false;
  for (const [p, def] of Object.entries(PROVIDERS)) {
    if (!def.envKeys.length) continue;
    const has = !!auth[p] || def.envKeys.some((k) => process.env[k]);
    if (has) { any = true; ok(`${p} credentials found`); }
  }
  try { const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) }); const j: any = await r.json(); ok(`ollama running (${j.models?.length ?? 0} local models)`); any = true; } catch { console.log(c.dim("  · ollama not running")); }
  if (!any) bad("No model credentials. Run `rcode login anthropic` (or openai, google, openrouter) or start ollama.");
  const ref = loadConfig(cwd).model ?? defaultModelRef(auth);
  const m = resolveModel(ref);
  if (m) {
    const r = await complete(m, { systemPrompt: "Reply with exactly: ok", messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }] }, { apiKey: apiKeyFor(m, auth), maxTokens: 64, thinking: "off" });
    r.error ? bad(`default model ${ref}: ${r.error.slice(0, 160)}`) : ok(`default model ${ref} responds`);
  }
  console.log(c.bold("\nMemory"));
  const mem = await getMemory("auto");
  ok(`provider: ${mem.name}${mem.name === "flat" ? c.dim(" (install `ruvector` for native HNSW: bun add ruvector)") : ""} · ${(await mem.list({ limit: 100000 })).length} memories`);
  console.log(c.bold("\nRuvNet stack"));
  const rf = findRufloBin(); rf ? ok(`ruflo: ${rf}`) : console.log(c.dim("  · ruflo not installed (npm i -g ruflo) — optional"));
  const br = findBrainServer(); br ? ok(`ruvnet-brain: ${br}`) : console.log(c.dim("  · ruvnet-brain not installed (npx ruvnet-brain) — optional"));
  console.log(c.bold("\nExtensions"));
  ok(`${loadCommands(cwd).length} slash commands · ${loadSkills(cwd).length} skills · ${loadAgents(cwd).length} agent types`);
  isTrusted(cwd) ? ok("project is trusted (project hooks/MCP/commands enabled)") : console.log(c.dim("  · project not trusted — project-level hooks/MCP are ignored (run `rcode setup` to trust)"));
  return 0;
}

async function setup(cwd: string): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = "") => ((await rl.question(`${q}${def ? c.dim(` [${def}]`) : ""} `)).trim() || def);
  console.log(c.bold(c.cyan("\n  rcode setup\n")));
  const auth = loadAuth();
  const providers = ["anthropic", "openai", "google", "openrouter"];
  const have = providers.filter((p) => auth[p] || PROVIDERS[p]!.envKeys.some((k) => process.env[k]));
  if (have.length) ok(`Found credentials for: ${have.join(", ")}`);
  else {
    const p = await ask(`Which provider? (${providers.join("/")}/ollama)`, "anthropic");
    if (p !== "ollama") { const k = await ask(`${p} API key:`); if (k) { saveAuth(p, k); ok(`saved ${p} key`); } }
  }
  const model = await ask("Default model:", loadConfig(cwd).model ?? defaultModelRef(loadAuth()));
  const mode = await ask("Approval mode (ask / auto-edit / full):", "auto-edit");
  saveGlobalConfig({ model, permissionMode: mode as any });
  ok(`config saved to ${RCODE_HOME}/config.json`);
  if (!isTrusted(cwd) && existsSync(cwd)) {
    const t = await ask(`Trust this project (${cwd}) so its hooks/MCP/commands load? (y/n)`, "y");
    if (t.toLowerCase().startsWith("y")) { trust(cwd); ok("project trusted"); }
  }
  const rf = findRufloBin(), br = findBrainServer();
  console.log(c.bold("\nRuvNet stack (optional, auto-detected)"));
  rf ? ok("ruflo detected — memory, routing & swarm tools will be wired in automatically") : console.log(c.dim("  · ruflo: npm i -g ruflo  (adds learning hooks + swarm tools)"));
  br ? ok("ruvnet-brain detected — RuvNet-grounded answers enabled") : console.log(c.dim("  · ruvnet-brain: npx ruvnet-brain  (source-grounded RuvNet knowledge)"));
  rl.close();
  console.log(`\n${c.green("Ready.")} Run ${c.bold("rcode")} to start, or ${c.bold("rcode doctor")} to verify.\n`);
  return 0;
}
