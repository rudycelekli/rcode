/**
 * The two studio pieces T3 Code ships as apps: a desktop launcher, and the
 * device commands. The simctl and adb argument lists follow
 * pingdotgg/t3code apps/server/src/device/DeviceActions.ts (MIT, T3 Tools Inc.).
 * Their Effect wrapper, relay account, and desktop shell are not included.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function tunnelUrl(text: string): string | undefined {
  return text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
}

/** A public link to the local center. cloudflared is the same tunnel program T3 Connect runs. */
export function startShare(port: number): { url: Promise<string>; stop: () => void } {
  let child: ChildProcess | undefined;
  let settled = false;
  const url = new Promise<string>((resolve, reject) => {
    const bin = process.env.RCODE_CLOUDFLARED_BIN || "cloudflared";
    child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const take = (chunk: Buffer) => {
      buf += chunk.toString();
      const hit = tunnelUrl(buf);
      if (hit && !settled) { settled = true; resolve(hit); }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(new Error(err.code === "ENOENT" ? "cloudflared is not installed. brew install cloudflared" : err.message));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`cloudflared exited (${code ?? "?"}).`));
    });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error("The tunnel did not come up.")); } }, 25_000);
  });
  return { url, stop: () => child?.kill("SIGTERM") };
}

export interface DeviceRef { id: string; kind: "ios" | "android"; name?: string; state?: string }

const ID = /^[A-Za-z0-9:._-]{1,80}$/;

/** Argv for one device action. Returns an error string when the platform cannot do it. */
export function deviceArgv(action: string, device: DeviceRef, at?: { x: number; y: number }): string[] | { error: string } {
  if (!ID.test(device.id)) return { error: "Unknown device." };
  if (device.kind === "ios") {
    if (action === "boot") return ["xcrun", "simctl", "boot", device.id];
    if (action === "shutdown") return ["xcrun", "simctl", "shutdown", device.id];
    if (action === "appearance") return ["xcrun", "simctl", "ui", device.id, "appearance", "dark"];
    if (action === "tap") {
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return { error: "Tap needs a point." };
      return ["idb", "ui", "tap", String(Math.round(at.x)), String(Math.round(at.y)), "--udid", device.id];
    }
    if (action === "home" || action === "back") return { error: "That key is not available through simctl. Tap the screen, or use the Simulator menu." };
    return { error: "Unknown device action." };
  }
  if (device.kind === "android") {
    if (action === "home") return ["adb", "-s", device.id, "shell", "input", "keyevent", "3"];
    if (action === "back") return ["adb", "-s", device.id, "shell", "input", "keyevent", "4"];
    if (action === "tap") {
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return { error: "Tap needs a point." };
      return ["adb", "-s", device.id, "shell", "input", "tap", String(Math.round(at.x)), String(Math.round(at.y))];
    }
    if (action === "boot" || action === "shutdown") return { error: "Start the Android emulator from Android Studio. rcode attaches once adb lists it." };
    return { error: "Unknown device action." };
  }
  return { error: "Unknown device." };
}

/** A double-clickable app that starts the center. macOS gets a bundle. Linux gets a desktop file. */
export function writeDesktopApp(o: { exe: string; args: string[]; dest: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = [o.exe, ...o.args].map(q).join(" ");
  if (process.platform === "darwin") {
    const mac = join(o.dest, "Contents", "MacOS");
    mkdirSync(mac, { recursive: true });
    writeFileSync(join(o.dest, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Rcode</string>
<key>CFBundleDisplayName</key><string>Rcode</string>
<key>CFBundleIdentifier</key><string>ai.rcode.center</string>
<key>CFBundleExecutable</key><string>rcode</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`);
    const bin = join(mac, "rcode");
    writeFileSync(bin, `#!/bin/sh\nexec ${cmd}\n`);
    chmodSync(bin, 0o755);
    return o.dest;
  }
  mkdirSync(o.dest, { recursive: true });
  const file = join(o.dest, "rcode.desktop");
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Rcode\nExec=${cmd}\nTerminal=true\nCategories=Development;\n`);
  return file;
}
