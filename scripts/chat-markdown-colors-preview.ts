import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.generated.ts";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

// A disposable demo using the real client, parser, renderer, theme settings and CSS.
// No real agent, herdr session, credentials, account, or user message is accessed.
const app = mkdtempSync(join(tmpdir(), "ovis-markdown-colors-"));
const output = process.env["UI_EVIDENCE_DIR"] ?? join(tmpdir(), "ovis-markdown-evidence");
const baseline = process.env["MARKDOWN_BASELINE"] === "1";
const firstOnly = process.env["MARKDOWN_FIRST_ONLY"] === "1";
const pane = panes.omp;
const results: unknown[] = [];

try {
  const source = readFileSync(new URL("../docs/examples/chat-markdown-colors.md", import.meta.url), "utf8");
  mkdirSync(output, { recursive: true });
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  const turns = [
    { role: "user", ts: "2026-11-19T10:00:00.000Z", parts: [{ kind: "text", text: "Show the complete Markdown specimen, without running any commands." }] },
    { role: "assistant", ts: "2026-11-19T10:00:05.000Z", parts: [{ kind: "text", text: source }] },
  ];
  const override = `<script>(() => {
    const demo = window.fetch;
    const turns = ${JSON.stringify(turns).replaceAll("<", "\\u003c")};
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(pane)}) {
        return Promise.resolve(new Response(JSON.stringify({ source: "claude-transcript", history_id: "markdown-colors", cursor: null, turns: url.searchParams.has("before") ? [] : turns }), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n${override}\n<script type="module"`));
  const server = serveDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const entries = firstOnly ? SUPPORTED_ENTRIES.slice(0, 1) : SUPPORTED_ENTRIES;
      for (const entry of entries) {
        const key = `${entry.id}-${entry.mode}`;
        const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: "en-US", deviceScaleFactor: 1 });
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await context.addInitScript(({ entry, pane }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, theme: entry.mode, palette: entry.id, darkTheme: entry.id, lightTheme: entry.id }));
          localStorage.setItem(`ovis:view:${pane}`, "chat");
        }, { entry, pane });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const scope = page.locator(`[data-layout-pane=${JSON.stringify(pane)}].is-current`);
        await scope.locator(".terminal-stack.is-chat").waitFor();
        assert.equal(await page.locator("html").getAttribute("data-palette"), entry.id, `${key}: actual theme ID`);
        assert.equal(await page.locator("html").getAttribute("data-theme"), entry.mode, `${key}: actual light/dark mode`);
        await scope.getByText("Markdown preview complete.", { exact: true }).waitFor();
        await appFaces(page, "Markdown café 日本語");
        await scope.locator(".markdown-math .katex").first().waitFor();
        await scope.locator(".markdown-mermaid svg").waitFor();
        const article = scope.locator("article.chat-turn-agent").last();
        const markdown = article.locator(".markdown").first();
        const colors = await markdown.evaluate(element => {
          const style = getComputedStyle(element);
          const color = (selector: string) => {
            const target = element.querySelector(selector);
            if (!target) throw new Error(`Missing ${selector}`);
            return getComputedStyle(target).color;
          };
          return { body: style.color, heading1: color(".markdown-h1"), heading2: color(".markdown-h2"), heading3: color(".markdown-h3"), strong: color("p strong"), emphasis: color("p em"), inlineCode: color("p code"), tableHeader: color("th"), quoteRail: getComputedStyle(element.querySelector("blockquote")!).borderLeftColor, background: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() };
        });
        // RED before the CSS change: headings currently inherit neutral body text.
        if (!baseline) {
          assert.notEqual(colors.heading1, colors.body, `${key}: H1 must be theme-colored rather than plain body text`);
          assert.notEqual(colors.heading2, colors.body, `${key}: H2 must be theme-colored`);
          assert.notEqual(colors.emphasis, colors.body, `${key}: emphasis must use a theme color`);
          assert.notEqual(colors.heading1, colors.heading3, `${key}: major and minor headings use distinct theme roles`);
        }
        for (let level = 1; level <= 6; level++) assert.ok(await markdown.locator(`.markdown-h${level}`).count() > 0);
        assert.ok(await markdown.locator("table").count() > 0);
        assert.ok(await markdown.locator("pre").count() >= 4);
        assert.ok(await markdown.locator("[role=checkbox]").count() === 3);
        const nestedEmphasis = await markdown.locator("strong em, em strong").count();
        assert.ok((await markdown.innerText()).includes("<u>underlined text</u>"), "raw HTML underline must remain escaped, not silently enabled");
        await scope.locator(".chat-view").evaluate(element => { element.scrollTop = 0; });
        await page.waitForFunction(() => {
          const heading = document.querySelector(".is-current .chat-turn-agent .markdown-h1");
          return heading !== null && heading.getBoundingClientRect().top > 0 && heading.getBoundingClientRect().top < 600;
        });
        await page.screenshot({ path: join(output, `${baseline ? "before-" : ""}${key}-app.png`) });
        // Grow the real viewport so the entire reply fits inside its scroll container.
        // Locator screenshots of a reply taller than that container otherwise have blank regions.
        const replyHeight = await article.evaluate(element => element.scrollHeight);
        await page.setViewportSize({ width: 1440, height: Math.ceil(replyHeight) + 700 });
        await scope.locator(".chat-view").evaluate(element => { element.scrollTop = 0; });
        await article.screenshot({ path: join(output, `${baseline ? "before-" : ""}${key}-markdown.png`), animations: "disabled", timeout: 30_000 });
        // The source remains unchanged when the user copies it.
        await article.hover();
        await article.getByRole("button", { name: "Copy as markdown", exact: true }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(copied, source, `${key}: copy preserves the original Markdown`);
        assert.deepEqual(errors, [], `${key}: no runtime errors`);
        results.push({ key, theme: entry.id, mode: entry.mode, colors, nestedEmphasis, errors });
        writeFileSync(join(output, baseline ? "baseline-manifest.json" : "manifest.json"), JSON.stringify({ expected: entries.length, actual: results.length, results }, null, 2));
        console.log(`PASS ${key}: H1–H6, emphasis, table, tasks, code, escaped HTML, source copy, screenshots`);
        await context.close();
      }
      assert.equal(results.length, entries.length);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
