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
      if (!provider || (!PROVIDERS[provider] && !["telegram", "slack", "slack-app", "discord"].includes(provider))) { console.log(`Usage: rcode login <provider> [key]\nProviders: ${Object.keys(PROVIDERS).join(", ")}\nChannels: telegram, slack (xoxb-), slack-app (xapp-), discord`); return 2; }
      let key = args[1];
      if (!key) { const rl = createInterface({ input: process.stdin, output: process.stdout }); key = (await rl.question(`${provider} API key: `)).trim(); rl.close(); }
      if (!key) return 2;
      saveAuth(provider, key);
      console.log(`Saved ${provider} key to ${RCODE_HOME}/auth.json (mode 600).`);
      return 0;
    }
    case "doctor": return doctor(cwd);
    case "setup": return setup(cwd);
    case "gateway": return gateway(args, flags, cwd);
    case "update": return selfUpdate();
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
  console.log(c.bold("\nBrowser & desktop"));
  const { findCli, INSTALL_HINT } = await import("./tools/native-cli.ts");
  for (const n of ["agent-browser", "agent-desktop"] as const) { const b = findCli(n); b ? ok(`${n}: ${b}`) : console.log(c.dim(`  · ${n} not installed — ${INSTALL_HINT[n]}`)); }
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
  console.log(c.bold("\nBrowser & desktop control (optional)"));
  const { findCli } = await import("./tools/native-cli.ts");
  const missing = (["agent-browser", "agent-desktop"] as const).filter((n) => !findCli(n));
  if (!missing.length) ok("agent-browser and agent-desktop detected — browser and desktop tools enabled");
  else {
    const a = await ask(`Install ${missing.join(" + ")} (Vercel Labs, Apache-2.0) into ~/.rcode/tools via npm? (y/n)`, "n");
    if (a.toLowerCase().startsWith("y")) {
      const { join } = await import("node:path");
      const r = Bun.spawnSync(["npm", "install", "--prefix", join(RCODE_HOME, "tools"), ...missing.map((m) => (m === "agent-desktop" ? "agent-desktop" : m))], { stdout: "inherit", stderr: "inherit" });
      if (r.exitCode === 0) {
        ok("installed");
        if (missing.includes("agent-browser")) { console.log(c.dim("  fetching Chrome for agent-browser (uses system Chrome if present)…")); Bun.spawnSync([join(RCODE_HOME, "tools", "node_modules", ".bin", "agent-browser"), "install"], { stdout: "inherit", stderr: "inherit" }); }
        if (missing.includes("agent-desktop") && process.platform === "darwin") console.log(c.dim("  macOS: grant Accessibility to your terminal app (System Settings → Privacy & Security → Accessibility). Run `agent-desktop permissions --guide`."));
      } else bad("npm install failed — install manually later (see `rcode doctor`)");
    }
  }
  rl.close();
  console.log(`\n${c.green("Ready.")} Run ${c.bold("rcode")} to start, or ${c.bold("rcode doctor")} to verify.\n`);
  return 0;
}

async function gateway(args: string[], flags: Record<string, any>, cwd: string): Promise<number> {
  const sub = args[0];
  const st = await import("./gateway/state.ts");
  if (sub === "pair") {
    const r = args[1] ? st.pairCode(args[1], flags.user ? "user" : "owner") : undefined;
    console.log(r ? `Paired ${r.who} on ${r.channel} as ${flags.user ? "user (chat only)" : "owner"}.` : "Unknown or expired code.");
    return r ? 0 : 1;
  }
  if (sub === "link") {
    const role = flags.user ? "user" : "owner";
    const tok = st.createLinkToken(role);
    const tg = process.env.TELEGRAM_BOT_TOKEN ?? loadAuth().telegram ?? (loadConfig(cwd) as any).gateway?.telegram?.token;
    let url: string | undefined;
    if (tg) {
      try { const me: any = await (await fetch(`https://api.telegram.org/bot${tg}/getMe`)).json(); if (me.ok) url = `https://t.me/${me.result.username}?start=${tok}`; } catch {}
    }
    console.log(c.bold(`One-time pairing link (${role}, valid 15 minutes):`));
    if (url) {
      console.log(`\n  ${c.cyan(url)}\n`);
      try { const qr: any = (await import("qrcode-terminal")).default; qr.generate(url, { small: true }, (q: string) => console.log(q)); } catch {}
      console.log(c.dim("Scan with your phone camera, then tap Start in Telegram."));
    }
    console.log(c.dim(`Slack / Discord: DM the bot:  pair ${tok}`));
    return 0;
  }
  if (sub === "users") {
    const s = st.loadState();
    let n = 0;
    for (const [ch, us] of Object.entries(s.users)) for (const [id, u] of Object.entries(us)) { n++; console.log(`${ch.padEnd(9)} ${id.padEnd(22)} ${u.role.padEnd(6)} ${u.name ?? ""} ${c.dim(new Date(u.since).toLocaleDateString())}`); }
    if (!n) console.log("No paired users yet. Run: rcode gateway link");
    return 0;
  }
  if (sub === "revoke") {
    const ok = args[1] && args[2] ? st.removeUser(args[1], args[2]) : false;
    console.log(ok ? "Revoked." : "Usage: rcode gateway revoke <channel> <userId>   (see: rcode gateway users)");
    return ok ? 0 : 1;
  }
  if (sub === "install" || sub === "uninstall") return serviceInstall(sub, cwd);
  if (sub === "help" || flags.help) {
    console.log(`rcode gateway — talk to rcode from your phone and chat apps

  rcode gateway                 start (web UI always; Telegram/Slack/Discord when tokens are set)
  rcode gateway link [--user]   one-tap pairing link + QR (owner by default)
  rcode gateway pair <CODE> [--user]   approve a pairing code a user received
  rcode gateway users | revoke <channel> <id>
  rcode gateway install | uninstall    run as a background service (launchd / systemd)

Tokens:  rcode login telegram <bot-token>
         rcode login slack <xoxb-bot-token> ; rcode login slack-app <xapp-app-token>
         rcode login discord <bot-token>`);
    return 0;
  }
  const { runGateway } = await import("./gateway/server.ts");
  return runGateway({ cwd, model: flags.model, web: !flags["no-web"], port: flags.port ? Number(flags.port) : undefined, host: flags.host, mode: flags.plan ? "plan" : undefined });
}

async function serviceInstall(action: "install" | "uninstall", cwd: string): Promise<number> {
  const { homedir } = await import("node:os");
  const { writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const bun = process.execPath;
  const cli = new URL("./cli.ts", import.meta.url).pathname;
  if (process.platform === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "dev.rcode.gateway.plist");
    if (action === "uninstall") { Bun.spawnSync(["launchctl", "unload", plist]); rmSync(plist, { force: true }); console.log("Removed launchd service."); return 0; }
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.rcode.gateway</string>
<key>ProgramArguments</key><array><string>${bun}</string><string>${cli}</string><string>gateway</string><string>--cwd</string><string>${cwd}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${RCODE_HOME}/gateway.log</string><key>StandardErrorPath</key><string>${RCODE_HOME}/gateway.log</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
</dict></plist>`);
    Bun.spawnSync(["launchctl", "load", "-w", plist]);
    console.log(`Installed launchd service (logs: ${RCODE_HOME}/gateway.log).`);
    return 0;
  }
  const unit = join(homedir(), ".config", "systemd", "user", "rcode-gateway.service");
  if (action === "uninstall") { Bun.spawnSync(["systemctl", "--user", "disable", "--now", "rcode-gateway"]); rmSync(unit, { force: true }); console.log("Removed systemd user service."); return 0; }
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unit, `[Unit]\nDescription=rcode gateway\nAfter=network-online.target\n\n[Service]\nExecStart=${bun} ${cli} gateway --cwd ${cwd}\nRestart=always\nEnvironment=PATH=${process.env.PATH}\n\n[Install]\nWantedBy=default.target\n`);
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
  Bun.spawnSync(["systemctl", "--user", "enable", "--now", "rcode-gateway"]);
  console.log("Installed systemd user service: systemctl --user status rcode-gateway");
  return 0;
}

/** Self-update for compiled binaries: latest GitHub release, SHA-256 verified, atomic replace. */
async function selfUpdate(): Promise<number> {
  const { VERSION } = await import("./version.ts");
  const exe = process.execPath;
  const compiled = !/\/bun(\.exe)?$/.test(exe);
  if (!compiled) { console.log("Running from source. Update with: git pull && bun install   (or: bun install -g github:rudycelekli/rcode)"); return 0; }
  const rel: any = await (await fetch("https://api.github.com/repos/rudycelekli/rcode/releases/latest", { headers: { accept: "application/vnd.github+json" } })).json();
  const tag = String(rel.tag_name ?? "");
  if (!tag) { console.log("No release published yet."); return 1; }
  if (tag.replace(/^v/, "") === VERSION) { console.log(`rcode ${VERSION} is up to date.`); return 0; }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const asset = `rcode-${process.platform}-${arch}`;
  const base = `https://github.com/rudycelekli/rcode/releases/download/${tag}`;
  console.log(`Updating ${VERSION} → ${tag} (${asset})…`);
  const [bin, sums] = await Promise.all([fetch(`${base}/${asset}`), fetch(`${base}/SHA256SUMS`)]);
  if (!bin.ok || !sums.ok) { console.log("Download failed."); return 1; }
  const buf = Buffer.from(await bin.arrayBuffer());
  const want = (await sums.text()).split("\n").find((l) => l.endsWith(` ${asset}`))?.split(/\s+/)[0];
  const got = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
  if (!want || want !== got) { console.log("Checksum mismatch — not updating."); return 1; }
  const { writeFileSync, renameSync, chmodSync } = await import("node:fs");
  const tmp = `${exe}.new`;
  writeFileSync(tmp, buf); chmodSync(tmp, 0o755); renameSync(tmp, exe);
  console.log(`Updated to ${tag}.`);
  return 0;
}
