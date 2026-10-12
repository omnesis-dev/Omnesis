// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { normalizeAnswerProse } from "./answer-prose.js";

const marker = "\uE200cite\uE202invented-document\uE201";
it("removes reserved markers from paragraphs and list prose without creating links", () => {
  expect(
    normalizeAnswerProse(`The gate opens Friday. ${marker}\n\n1. **Arrive early.** ${marker}`),
  ).toBe("The gate opens Friday.\n\n1. **Arrive early.**");
});
it.each([
  `\`${marker}\``,
  `\`\`\`text\n${marker}\n\`\`\``,
  `    ${marker}\n`,
  `> Quoted text ${marker}\n`,
  `"Literal ${marker}"`,
  `“Literal ${marker}”`,
  `"An **emphasized** example ${marker}"`,
  `'${marker}'`,
  `[A legitimate link ${marker}](https://example.com)`,
  `**Code: \`${marker}\`**`,
])("preserves literal or protected Markdown: %s", (text) => {
  expect(normalizeAnswerProse(text)).toBe(text);
});
it("leaves ordinary references, footnotes, links and incomplete control strings untouched", () => {
  const text =
    "Reference [1], [^note], [source](https://example.com), and \uE200cite\uE202unfinished";
  expect(normalizeAnswerProse(text)).toBe(text);
});
it("handles a reserved marker assembled from several model deltas", () => {
  expect(normalizeAnswerProse(["Ready. \uE200ci", "te\uE202doc", "\uE201"].join(""))).toBe(
    "Ready.",
  );
});

it("preserves table cell literals while cleaning separate prose", () => {
  const table = `| Example | Meaning |\n| --- | --- |\n| \`${marker}\` | Literal code |`;
  expect(normalizeAnswerProse(`${table}\n\nReady. ${marker}`)).toBe(`${table}\n\nReady.`);
});
