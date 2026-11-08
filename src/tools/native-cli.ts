/** Locate and run the optional native helper CLIs (agent-browser, agent-desktop). */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RCODE_HOME } from "../session/store.ts";

export function findCli(name: "agent-browser" | "agent-desktop"): string | undefined {
  const env = process.env[name === "agent-browser" ? "RCODE_AGENT_BROWSER" : "RCODE_AGENT_DESKTOP"];
  if (env && existsSync(env)) return env;
  const local = join(RCODE_HOME, "tools", "node_modules", ".bin", name);
  if (existsSync(local)) return local;
  return Bun.which(name) ?? undefined;
}

export const INSTALL_HINT = {
  "agent-browser": "npm install -g agent-browser && agent-browser install   (or: brew install agent-browser; or `rcode setup`)",
  "agent-desktop": "npm install -g agent-desktop && agent-desktop permissions --guide   (or: brew install agent-desktop; or `rcode setup`)",
} as const;

export function runCli(bin: string, args: string[], opts: { signal: AbortSignal; stdin?: string; timeoutMs?: number; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "", stderr = "", timedOut = false;
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000); });
    p.stderr.on("data", (d) => { stderr += d; });
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, opts.timeoutMs ?? 60_000);
    const onAbort = () => p.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: e.message, timedOut }); });
    p.on("close", (code) => { clearTimeout(t); opts.signal.removeEventListener("abort", onAbort); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
    p.stdin.end(opts.stdin ?? "");
  });
}

/** Refuse to type things that look like credentials (users sign in themselves). */
export function looksSecret(text: string): boolean {
  return /\b(sk-|ghp_|gho_|xox[bp]-|AKIA)[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(text) || /^\d{13,19}$/.test(text.replace(/[\s-]/g, ""));
}
export const SECRET_FIELD = /pass(word|code)?|otp|one.?time|2fa|mfa|totp|cvv|cvc|card.?number|security.?code|ssn|secret|api.?key|token/i;
