import { describe, expect, test } from "bun:test";
import { centerPage, renderMarkdown } from "../src/center/page.ts";

const shipped = new Function(`return (${renderMarkdown.toString()})`)() as typeof renderMarkdown;

describe("center page", () => {
  test("markdown renders the usual shapes and nothing a reply could inject", () => {
    const { html } = shipped("## Plan\n\n**Bold** and `code`\n\n- one\n- two\n\n1. first\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2\n```", true);
    expect(html).toContain("<h3>Plan</h3>");
    expect(html).toContain("<b>Bold</b>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li></ol>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("const x = 1 &lt; 2");

    const evil = shipped('<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>alert(2)</script> "q"', true).html;
    expect(evil).not.toContain("<img");
    expect(evil).not.toContain("<script");
    expect(evil).not.toContain('href="javascript');
    expect(evil).toContain("&lt;img");
  });

  test("an html block becomes a sandboxed preview only once the reply is finished", () => {
    const block = "Here:\n```html\n<b>hi</b>\n```";
    expect(shipped(block, true).vis).toEqual(["<b>hi</b>"]);
    expect(shipped(block, true).html).toContain('class="vslot"');
    expect(shipped(block, false).vis).toEqual([]);
    expect(shipped(block, false).html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(shipped("```html\n<b>still streaming", true).vis).toEqual([]);
  });

  test("links keep only http and https", () => {
    const { html } = shipped("see https://example.com/a?b=1&c=2 and [docs](https://x.dev)", true);
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('<a href="https://x.dev" target="_blank" rel="noopener noreferrer">docs</a>');
  });

  test("the page script compiles and never closes its own script tag early", () => {
    const page = centerPage();
    const start = page.indexOf("<script>") + 8, end = page.lastIndexOf("</script>");
    const script = page.slice(start, end);
    expect(script).not.toMatch(/<\/script/i);
    expect(() => new Function(script)).not.toThrow();
    for (const s of ["New thread", "What should we build?", "Ask before changes", "Claude plan", "Missions", "Undo"]) expect(page).toContain(s);
  });
});
