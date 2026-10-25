// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Marked } from "marked";
import { expect, it } from "vitest";
import { parseClaimMarkup } from "./claims.js";
import { assertKnowledgeMarkdown } from "./markdown-authoring.js";

it.each(["<## Heading", "\n <# Heading", "Introduction\n<### Heading", "- <## Heading"])(
  "rejects malformed authored heading %s with repair guidance",
  (text) => expect(() => assertKnowledgeMarkdown("wiki", text)).toThrow(/use "## Heading"/),
);

it.each([
  "## Heading\n\nProse.",
  "`<## literal`",
  "`multiline\n<## literal`",
  "```md\n<## literal\n```",
  "~~~md\n<## literal\n~~~",
  "    <## indented example",
  "\\<## escaped example",
  "> <## quoted example",
  '<div title="example">\n<## HTML example\n</div>',
  "<!--\n<## comment\n-->",
  "A literal <## inside prose.",
  "<https://example.com>",
  "a < b",
  "<####### not an ATX heading",
])("preserves valid Markdown and literal examples: %s", (text) => {
  expect(() => assertKnowledgeMarkdown("root", text)).not.toThrow();
});

it("renders ordinary headings inside nested claim tags without changing claim text", () => {
  const parsed = parseClaimMarkup(
    '<claim id="section" refs="">## Workshop\n\n<claim id="fact" refs="source:manual">Keep the path clear.</claim></claim>',
  );
  assertKnowledgeMarkdown("wiki", parsed.text);
  expect(new Marked().parse(parsed.text)).toContain("<h2>Workshop</h2>");
  expect(parsed.claims[1]?.text).toBe("Keep the path clear.");
});

it("does not reinterpret legacy owner descriptions or historical reads", () => {
  expect(() => assertKnowledgeMarkdown("doc_annotation", "<## literal")).not.toThrow();
  expect(parseClaimMarkup('<claim id="old" refs=""><## preserved</claim>').text).toBe(
    "<## preserved",
  );
});
