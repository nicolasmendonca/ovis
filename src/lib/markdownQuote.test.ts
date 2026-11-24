import { expect, test } from "bun:test";
import { parseMarkdown } from "../../shared/markdown.ts";

test("a source-backed quote keeps its inner Markdown for copying", () => {
  expect(parseMarkdown("> hello")[0]).toMatchObject({ type: "blockquote", source: "hello" });
});

test.each([
  ["> first\n> second", "first\nsecond"],
  ["> **bold** and [link](https://example.com)\n>\n> *next*", "**bold** and [link](https://example.com)\n\n*next*"],
  [">\n>   indented  \n>", "\n  indented  \n"],
  ["> ```text\n> > literal\n>   spaces > stay\n> ```", "```text\n> literal\n  spaces > stay\n```"],
  ["> x > y and \\> escaped", "x > y and \\> escaped"],
  ["> &gt; <script>alert(1)</script>", "&gt; <script>alert(1)</script>"],
  [">first\r\n> second", "first\nsecond"],
])("quote source removes only its outer layer: %s", (markdown, source) => {
  expect(parseMarkdown(markdown)[0]).toMatchObject({ type: "blockquote", source });
});

test("each nested quote retains its own inner Markdown", () => {
  expect(parseMarkdown("> outer\n>\n> > **inner**\n> >\n> > last")[0]).toMatchObject({
    type: "blockquote",
    source: "outer\n\n> **inner**\n>\n> last",
    blocks: [{ type: "paragraph" }, { type: "blockquote", source: "**inner**\n\nlast" }],
  });
});
