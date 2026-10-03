// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { vocabularyText } from "./text.js";

test("removes a complete metadata preamble and structured trailing footer", () => {
  const text = vocabularyText(
    "# Field notes\n\n**Origin:** fictional@example.org\n**Destination:** another@example.org\n**Recorded:** 2026-01-01\n\n---\n\nThe zeralith arrives.\n---\n**Files:** briefing (Portable document, 2KB), chart (Image, 8KB)",
  );
  expect(text).toContain("The zeralith arrives.");
  expect(text).not.toMatch(/Origin|Destination|Recorded|briefing|chart|Field notes/u);
});

test("preserves natural headings, metadata-looking prose and ordinary brackets", () => {
  const content =
    "# Plans\n\n**Priority:** high\n\n---\n[Keep: the unusual spelling]\n# Body heading\n---\n**Summary:** valuable prose (tomorrow, certainly)";
  expect(vocabularyText(content)).toBe(content);
  expect(
    vocabularyText("# Heading\n**First:** value\n**Second:** value\nActual prose\n---"),
  ).toContain("Heading");
});

test("excludes explicit quotes, fenced code and image destinations but retains link labels", () => {
  const content =
    "Fresh prose\n> Old reply\n~~~typescript\nconst unrelated = true;\n```\nstill code\n~~~\n![diagram](https://example.org/image) [zelarith](https://example.org/path)\nTail";
  const text = vocabularyText(content);
  expect(text).toContain("Fresh prose");
  expect(text).toContain("zelarith");
  expect(text).toContain("Tail");
  expect(text).not.toMatch(/Old reply|unrelated|still code|diagram|example/u);
});

test("keeps captions and transcripts while removing timestamp bylines and reaction rows", () => {
  const text = vocabularyText(
    "**09:04** Elara Quill: [Clip, 1:02]: Discuss the zeralith\n  → someone 👍\n**09:05** Rohan Vale: [Reminder: keep this] a caption\n普通の文：残す",
  );
  expect(text).toContain("Discuss the zeralith");
  expect(text).toContain("[Reminder: keep this] a caption");
  expect(text).toContain("普通の文：残す");
  expect(text).not.toMatch(/Elara|Rohan|09:|Clip|someone/u);
});

test("does not guess at signatures or unmarked multilingual quotations", () => {
  const text =
    "Bonjour\nLe projet Écloria avance.\n-- \nAvec mes salutations\nOn Tuesday someone wrote:\n引用を残す。\n  → ordinary arrow prose";
  expect(vocabularyText(text)).toBe(text);
});

test("handles unterminated fences and bounds pathological input without inventing suffixes", () => {
  expect(vocabularyText("Before\n````\nprivate code\n```\nstill code")).toBe("Before");
  const text = vocabularyText("[".repeat(70000) + "unscannedtail");
  expect(text).toHaveLength(65536);
  expect(text).not.toContain("unscannedtail");
});
