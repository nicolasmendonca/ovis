import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { parseMarkdown } from "../../shared/markdown.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PREVIEW_CHUNK_ELEMENTS, previewElements } from "../lib/textPreview.ts";
import { Markdown, ParsedMarkdown, ProgressiveMarkdown } from "./Markdown.tsx";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem() {} } },
    document: { documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("a long Markdown preview is partial until its last chunk commits with all headings", async () => {
  const headingCount = PREVIEW_CHUNK_ELEMENTS + 1;
  const blocks = parseMarkdown(Array.from({ length: headingCount }, (_, index) => `# Section ${index + 1}`).join("\n\n"));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(ProgressiveMarkdown, { blocks }) }));
  });
  const preview = renderer?.root.findByType("div");
  expect(preview?.props["data-drawn"]).toBe("partial");

  for (let step = 0; step < 10 && preview?.props["data-drawn"] === "partial"; step++) {
    await act(async () => { jest.runOnlyPendingTimers(); });
  }
  expect(preview?.props["data-drawn"]).toBe("complete");
  expect(preview?.findAllByProps({ className: "markdown-h1" })).toHaveLength(headingCount);
});

async function renderQuote(source: string): Promise<void> {
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(Markdown, { children: source }) }));
  });
}

const quoteCopy = () => renderer!.root.findByProps({ className: "btn markdown-quote-copy" });

test("a quote has an icon-only accessible Copy action that copies inner Markdown and reports success", async () => {
  const writes: string[] = [];
  Object.assign(navigator, { clipboard: { writeText: async (text: string) => { writes.push(text); } } });
  await renderQuote("> **hello**");
  expect(quoteCopy().props.type).toBe("button");
  expect(quoteCopy().props["aria-label"]).toBe("Copy");
  expect(quoteCopy().props.title).toBe("Copy");
  expect(quoteCopy().findAllByType("span")).toHaveLength(0);
  expect(quoteCopy().findByType("svg").props["aria-hidden"]).toBe("true");
  await act(async () => { await quoteCopy().props.onClick(); });
  expect(writes).toEqual(["**hello**"]);
  expect(quoteCopy().props["aria-label"]).toBe("Copied");
  expect(quoteCopy().props.title).toBe("Copied");
  expect(quoteCopy().findAllByType("span")).toHaveLength(0);
  expect(quoteCopy().findByType("svg").props["aria-hidden"]).toBe("true");
});

test("quote copy labels and titles use the current UI language without visible text", async () => {
  Object.assign(navigator, { languages: ["ja"] });
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
  await renderQuote("> hello");
  expect(quoteCopy().props["aria-label"]).toBe("コピー");
  expect(quoteCopy().props.title).toBe("コピー");
  await act(async () => { await quoteCopy().props.onClick(); });
  expect(quoteCopy().props["aria-label"]).toBe("コピーしました");
  expect(quoteCopy().props.title).toBe("コピーしました");
  expect(quoteCopy().findAllByType("span")).toHaveLength(0);
});

test("quote copy is ghost with primary hover/focus and transient accent press", () => {
  const css = readFileSync(new URL("./ChatView.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector + " {"), css.indexOf("}", css.indexOf(selector + " {")) + 1);
  const base = rule(".btn.markdown-quote-copy");
  expect(base).toContain("background: transparent;");
  expect(base).toContain("border: none;");
  const hover = rule(".btn.markdown-quote-copy:hover");
  expect(hover).toContain("background: transparent;");
  expect(hover).toContain("border: none;");
  expect(hover).toContain("color: var(--primary);");
  expect(rule(".btn.markdown-quote-copy:focus-visible")).toContain("color: var(--primary);");
  expect(rule(".btn.markdown-quote-copy:active")).toContain("color: var(--accent);");
  expect(css.indexOf(".btn.markdown-quote-copy:active {")).toBeGreaterThan(css.indexOf(".btn.markdown-quote-copy:hover {"));
});

test("a refused copy reports failure without claiming success and can retry", async () => {
  let refused = true;
  Object.assign(navigator, { clipboard: { writeText: async () => {
    if (refused) {
      Object.defineProperty(document, "activeElement", { configurable: true, value: {} });
      throw new Error("Clipboard refused");
    }
  } } });
  await renderQuote("> hello");
  await act(async () => { await quoteCopy().props.onClick(); });
  expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual(["Couldn't copy. Select the text and copy it manually."]);
  const toolbar = renderer!.root.findByProps({ className: "markdown-quote-tools" });
  expect(toolbar.findAll((node) => typeof node.type === "string")).toHaveLength(6);
  expect(renderer!.root.findAll((node) => typeof node.type === "string").length)
    .toBeLessThanOrEqual(previewElements(parseMarkdown("> hello")));
  expect(quoteCopy().props["aria-label"]).toBe("Copy");
  refused = false;
  await act(async () => { await quoteCopy().props.onClick(); });
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  expect(quoteCopy().props["aria-label"]).toBe("Copied");
});

test("copy feedback expires and repeated copies restart its timer", async () => {
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
  await renderQuote("> hello");
  await act(async () => { await quoteCopy().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(1000); });
  await act(async () => { await quoteCopy().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(quoteCopy().props["aria-label"]).toBe("Copied");
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(quoteCopy().props["aria-label"]).toBe("Copy");
});

test("streamed quote changes discard pending clipboard feedback", async () => {
  let finish!: () => void;
  Object.assign(navigator, { clipboard: { writeText: () => new Promise<void>((resolve) => { finish = resolve; }) } });
  await renderQuote("> old");
  let pending!: Promise<void>;
  await act(async () => { pending = quoteCopy().props.onClick(); });
  await act(async () => {
    renderer!.update(createElement(SettingsProvider, { children: createElement(Markdown, { children: "> new" }) }));
  });
  await act(async () => { finish(); await pending; });
  expect(quoteCopy().props["aria-label"]).toBe("Copy");
  expect(jest.getTimerCount()).toBe(0);
});

test("unmount clears feedback timers and ignores pending clipboard results", async () => {
  Object.assign(navigator, { clipboard: { writeText: async () => {} } });
  await renderQuote("> hello");
  await act(async () => { await quoteCopy().props.onClick(); });
  expect(jest.getTimerCount()).toBe(1);
  await act(async () => { renderer!.unmount(); });
  expect(jest.getTimerCount()).toBe(0);
  let finish!: () => void;
  Object.assign(navigator, { clipboard: { writeText: () => new Promise<void>((resolve) => { finish = resolve; }) } });
  await renderQuote("> hello");
  let pending!: Promise<void>;
  await act(async () => { pending = quoteCopy().props.onClick(); });
  await act(async () => { renderer!.unmount(); });
  await act(async () => { finish(); await pending; });
  expect(jest.getTimerCount()).toBe(0);
});

test("each nested quote copies its own source without changing the original message", async () => {
  const source = "> outer\n> > **inner**";
  const writes: string[] = [];
  Object.assign(navigator, { clipboard: { writeText: async (text: string) => { writes.push(text); } } });
  await renderQuote(source);
  const buttons = renderer!.root.findAllByProps({ className: "btn markdown-quote-copy" });
  expect(buttons).toHaveLength(2);
  await act(async () => { await buttons[0]!.props.onClick(); });
  await act(async () => { await buttons[1]!.props.onClick(); });
  expect(writes).toEqual(["outer\n> **inner**", "**inner**"]);
  expect(renderer!.root.findByProps({ children: source }).props.children).toBe(source);
});

test("only the latest copy attempt may report feedback", async () => {
  const finish: (() => void)[] = [];
  Object.assign(navigator, { clipboard: { writeText: () => new Promise<void>((resolve) => { finish.push(resolve); }) } });
  await renderQuote("> hello");
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => { first = quoteCopy().props.onClick(); second = quoteCopy().props.onClick(); });
  await act(async () => { finish[0]!(); await first; });
  expect(quoteCopy().props["aria-label"]).toBe("Copy");
  expect(jest.getTimerCount()).toBe(0);
  await act(async () => { finish[1]!(); await second; });
  expect(quoteCopy().props["aria-label"]).toBe("Copied");
});

test("source-less quote ASTs keep their rendering without a copy action", async () => {
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(ParsedMarkdown, {
      blocks: [{ type: "blockquote", blocks: [{ type: "paragraph", lines: [[{ type: "text", value: "Quote" }]] }] }],
    }) }));
  });
  expect(renderer!.root.findAllByType("blockquote")).toHaveLength(1);
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  expect(renderer!.root.findByType("p").findAllByType("span").at(-1)!.children).toEqual(["Quote"]);
});
