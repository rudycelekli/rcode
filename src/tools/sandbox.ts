/**
 * OS sandbox for shell commands.
 *   macOS: sandbox-exec (Seatbelt) profile — writes only inside the project, temp dirs and tool caches;
 *          outbound network only to localhost (when network is off).
 *   Linux: bubblewrap — read-only root, project + /tmp writable, --unshare-net when network is off.
 * The sandbox contains *what the agent runs on its own*; anything that needs to escape it must be
 * re-run with `unsandboxed: true`, which goes through the approval flow.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxPolicy { enabled: boolean; network: boolean; extraWritable?: string[] }

let cachedAvail: "seatbelt" | "bwrap" | null | undefined;
export function sandboxBackend(): "seatbelt" | "bwrap" | null {
  if (cachedAvail !== undefined) return cachedAvail;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return (cachedAvail = "seatbelt");
  if (process.platform === "linux" && Bun.which("bwrap")) return (cachedAvail = "bwrap");
  return (cachedAvail = null);
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function writableDirs(cwd: string, extra: string[] = []): string[] {
  const h = homedir();
  const dirs = [cwd, tmpdir(), "/tmp", "/private/tmp", "/private/var/folders",
    join(h, ".cache"), join(h, "Library", "Caches"), join(h, ".npm"), join(h, ".bun"), join(h, ".cargo"), join(h, "go", "pkg"), join(h, ".gradle"), join(h, ".m2"), join(h, ".pnpm-store"), join(h, ".local", "share", "pnpm"),
    ...extra];
  return [...new Set(dirs.filter((d) => existsSync(d)).map(real))];
}

export function seatbeltProfile(cwd: string, policy: SandboxPolicy): string {
  const writes = writableDirs(real(cwd), policy.extraWritable).map((d) => `(subpath "${esc(d)}")`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))`,
    // Protect git metadata from rewrites that bypass rcode's checkpoints? Keep writable: git commit is a normal workflow.
    ...(policy.network ? [] : [
      "(deny network-outbound)",
      '(allow network-outbound (remote ip "localhost:*"))',
      "(allow network-outbound (remote unix-socket))",
    ]),
  ].join("\n");
}

/** Wrap a shell invocation. Returns the argv to spawn instead of [shell, "-c", command]. */
export function wrapCommand(shell: string, command: string, cwd: string, policy: SandboxPolicy): { bin: string; args: string[]; sandboxed: boolean } {
  const backend = policy.enabled ? sandboxBackend() : null;
  if (backend === "seatbelt") return { bin: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(cwd, policy), shell, "-c", command], sandboxed: true };
  if (backend === "bwrap") {
    const binds = writableDirs(real(cwd), policy.extraWritable).flatMap((d) => ["--bind", d, d]);
    return { bin: Bun.which("bwrap")!, args: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...binds, ...(policy.network ? [] : ["--unshare-net"]), "--die-with-parent", "--chdir", cwd, shell, "-c", command], sandboxed: true };
  }
  return { bin: shell, args: ["-c", command], sandboxed: false };
}

const BLOCKED = /operation not permitted|permission denied|read-only file system|sandbox|could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|network is unreachable|failed to connect|connection refused|EPERM|EROFS/i;
export function looksSandboxBlocked(output: string): boolean { return BLOCKED.test(output); }
