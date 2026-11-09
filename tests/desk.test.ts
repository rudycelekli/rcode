import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceArgv, startShare, tunnelUrl, writeDesktopApp } from "../src/center/desk.ts";
import { loadCenterToken } from "../src/center/token.ts";
import { parseSimctlAll } from "../src/center/studio.ts";

describe("desk", () => {
  test("a cloudflared line is the public link, and a fake tunnel prints one", async () => {
    expect(tunnelUrl("log https://safe-name.trycloudflare.com more")).toBe("https://safe-name.trycloudflare.com");
    expect(tunnelUrl("no link")).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "rcode-flare-"));
    const bin = join(dir, "cloudflared");
    writeFileSync(bin, "#!/bin/sh\necho https://safe-name.trycloudflare.com >&2\nsleep 30\n");
    chmodSync(bin, 0o755);
    const prev = process.env.RCODE_CLOUDFLARED_BIN;
    process.env.RCODE_CLOUDFLARED_BIN = bin;
    const share = startShare(9);
    try {
      expect(await share.url).toBe("https://safe-name.trycloudflare.com");
    } finally { share.stop(); if (prev === undefined) delete process.env.RCODE_CLOUDFLARED_BIN; else process.env.RCODE_CLOUDFLARED_BIN = prev; }
  });

  test("device commands are the simctl and adb lists, and a tap needs a real point", () => {
    expect(deviceArgv("boot", { id: "A1", kind: "ios" })).toEqual(["xcrun", "simctl", "boot", "A1"]);
    expect(deviceArgv("appearance", { id: "A1", kind: "ios" })).toEqual(["xcrun", "simctl", "ui", "A1", "appearance", "dark"]);
    expect(deviceArgv("home", { id: "emulator-5554", kind: "android" })).toEqual(["adb", "-s", "emulator-5554", "shell", "input", "keyevent", "3"]);
    expect(deviceArgv("tap", { id: "emulator-5554", kind: "android" }, { x: 10.4, y: 20 })).toEqual(["adb", "-s", "emulator-5554", "shell", "input", "tap", "10", "20"]);
    expect(deviceArgv("tap", { id: "A1", kind: "ios" })).toEqual({ error: "Tap needs a point." });
    expect(deviceArgv("home", { id: "A1", kind: "ios" })).toHaveProperty("error");
    expect(deviceArgv("boot", { id: "../x", kind: "ios" })).toEqual({ error: "Unknown device." });
  });

  test("shut-down simulators are listed so they can be started", () => {
    const all = parseSimctlAll(JSON.stringify({ devices: { iOS: [{ name: "iPhone 16", udid: "A1", state: "Shutdown" }, { name: "iPhone", udid: "B2", state: "Booted" }] } }));
    expect(all.map((d) => d.state)).toEqual(["Shutdown", "Booted"]);
  });

  test("the center link keeps the same key, and a broken key file is replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "rcode-key-"));
    const first = loadCenterToken(dir);
    expect(loadCenterToken(dir)).toBe(first);
    expect(statSync(join(dir, "center.token")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "center.token"), "nope\n");
    expect(loadCenterToken(dir)).not.toBe("nope");
    expect(loadCenterToken(dir)).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  test("the desktop launcher is a bundle that starts the center and opens it", () => {
    const dest = join(mkdtempSync(join(tmpdir(), "rcode-app-")), process.platform === "darwin" ? "Rcode.app" : "apps");
    const path = writeDesktopApp({ exe: "/usr/bin/rcode", args: ["center"], dest });
    const text = readFileSync(process.platform === "darwin" ? join(path, "Contents", "MacOS", "rcode") : join(dest, "rcode-center.sh"), "utf8");
    expect(text).toContain("center");
    expect(text).toContain("/usr/bin/rcode");
    expect(text).toContain("open");
    expect(text).toContain("xdg-open");
    if (process.platform === "darwin") expect(readFileSync(join(path, "Contents", "Info.plist"), "utf8")).toContain("ai.rcode.center");

    const root = mkdtempSync(join(tmpdir(), "rcode-open-"));
    const fake = join(root, "rcode");
    const opened = join(root, "opened");
    writeFileSync(fake, "#!/bin/sh\necho 'rcode center  http://127.0.0.1:7799/?token=abc'\nsleep 2\n");
    writeFileSync(join(root, "open"), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
    writeFileSync(join(root, "xdg-open"), "#!/bin/sh\nexit 0\n");
    for (const f of [fake, join(root, "open"), join(root, "xdg-open")]) chmodSync(f, 0o755);
    const launchAt = join(root, process.platform === "darwin" ? "Rcode.app" : "apps");
    writeDesktopApp({ exe: fake, args: ["center"], dest: launchAt });
    const script = process.platform === "darwin" ? join(launchAt, "Contents", "MacOS", "rcode") : join(launchAt, "rcode-center.sh");
    const ran = spawnSync(script, { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 8000 });
    expect(ran.status).toBe(0);
    expect(readFileSync(opened, "utf8")).toBe("http://127.0.0.1:7799/?token=abc");
  });
});
