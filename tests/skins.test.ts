import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKINS, cleanSkin, skinScript } from "../src/center/skins.ts";

describe("skins", () => {
  test("a pasted skin keeps colors and numbers, and nothing that could run", () => {
    const s = cleanSkin({ name: "Mine</style><script>", bg: "red;}body{display:none", acc: "#ABCDEF", size: 99, radius: -4, density: "110", font: "comic", fx: "glow", evil: "x" });
    expect(s.bg).toBe("#000000");
    expect(s.acc).toBe("#abcdef");
    expect(s.size).toBe(18);
    expect(s.radius).toBe(0);
    expect(s.density).toBe(110);
    expect(s.font).toBe("geist");
    expect(s.fx).toBe("glow");
    expect(s.name).toBe("Minestylescript");
    expect("evil" in s).toBe(false);
    expect(cleanSkin("not json")).toEqual(SKINS[0]);
  });

  test("every preset is already clean and has its own name", () => {
    for (const p of SKINS) expect(cleanSkin(p)).toEqual(p);
    expect(new Set(SKINS.map((s) => s.name)).size).toBe(SKINS.length);
    expect(SKINS.map((s) => s.name)).toContain("Llama");
  });

  test("the validator still works after it is turned into page script", () => {
    const again = new Function(`return (${cleanSkin.toString()})`)() as typeof cleanSkin;
    expect(again({ acc: "#123456", size: 3 })).toEqual(cleanSkin({ acc: "#123456", size: 3 }));
    expect(skinScript()).toContain("Surprise me");
  });

  test("the center page ships the skin button and its whole script compiles", async () => {
    const { startCenter } = await import("../src/modes/center.ts");
    const cwd = mkdtempSync(join(tmpdir(), "rcode-skin-"));
    const c = await startCenter({ cwd, port: 0, token: "skin-test-token", queueFile: join(cwd, "q.json") });
    try {
      const page = await (await fetch(c.url)).text();
      expect(page).toContain("Paste skin");
      expect(page).toContain("--onacc");
      const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
      expect(() => new Function(script)).not.toThrow();
    } finally { c.stop(); }
  });
});
