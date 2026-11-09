/**
 * The command center's link is the key, so the key has to stay put.
 * One token lives in the rcode home directory and is reused on every launch,
 * which keeps the desktop app, a bookmark, and a phone home screen working.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RCODE_HOME } from "../session/store.ts";

const OK = /^[A-Za-z0-9_-]{16,128}$/;

export function loadCenterToken(dir = RCODE_HOME): string {
  const file = join(dir, "center.token");
  try {
    const got = readFileSync(file, "utf8").trim();
    if (OK.test(got)) return got;
  } catch { /* first launch, or a token file we should replace */ }
  const fresh = randomBytes(18).toString("base64url");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows has no POSIX mode */ }
  return fresh;
}
