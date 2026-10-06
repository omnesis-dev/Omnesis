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

test("keeps written captions but excludes rendered ASR and reaction rows", () => {
  const text = vocabularyText(
    "**09:04** Elara Quill: [Clip, 1:02]: Discuss the zeralith\n  → someone 👍\n**09:05** Rohan Vale: [Reminder: keep this] a caption\n普通の文：残す",
  );
  expect(text).not.toContain("Discuss the zeralith");
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

test("extracts only recognized layout text and decodes JSON escapes", () => {
  const layout = JSON.stringify([
    { bbox: [0, 1, 20, 30], category: "Heading", text: "Virelith\nQorven" },
    { category: "Picture", bbox: [0, 0, 1, 1] },
    { category: "Text", text: 'A "quoted" café' },
  ]);
  expect(vocabularyText(`  \n${layout}`)).toBe('Virelith\nQorven\n\nA "quoted" café');
});

test("keeps complete region text from a truncated layout without its schema", () => {
  expect(
    vocabularyText('[{"bbox":[0,1,2,3],"category":"Text","text":"Virelith\\nQorven"},{"bbox":[0'),
  ).toBe("Virelith\nQorven");
  expect(vocabularyText('[{"bbox":[0,1],"text":"unfinished')).toBe("");
  expect(vocabularyText('[{"category":"Text","bbox":[0')).toBe("");
});

test("malformed layout escapes do not throw or leak raw JSON", () => {
  expect(vocabularyText('[{"bbox":[0],"text":"invalid\\q"}')).toBe("");
});

test("caps layout recovery before parsing and preserves ordinary bracketed prose", () => {
  const layout = '[{"bbox":[0],"text":"Virelith"},{"bbox":[0],"text":"' + "x".repeat(70000) + '"}]';
  expect(vocabularyText(layout)).toBe("Virelith");
  expect(vocabularyText("  [Reminder] keep the original prose.")).toBe(
    "  [Reminder] keep the original prose.",
  );
  expect(vocabularyText('["ordinary", "list"]')).toBe('["ordinary", "list"]');
});

test("omits text-first incomplete layouts rather than learning JSON escapes", () => {
  expect(vocabularyText('[{"text":"Virelith\\nQorven","bbox":[0')).toBe("");
});

test("excludes multiline transcripts with known, unknown and missing durations", () => {
  for (const prefix of ["[Audio, 1:02]:", "[Voice note, ?]:", "[Audio]:"]) {
    const text = vocabularyText(`**09:04** Elara Quill: ${prefix} Spokenquorin
Transcripttail

**09:05** Rohan Vale: Writtenquorin`);
    expect(text).not.toMatch(/Spokenquorin|Transcripttail/u);
    expect(text).toContain("Writtenquorin");
  }
});

test("retains original written body before transcribed attachments", () => {
  const text = vocabularyText(
    "**09:04** Elara Quill: Writtenquorin\n[Audio]: Spokenquorin\nTranscripttail\n**09:05** Rohan Vale: Independentquorin",
  );
  expect(text).toContain("Writtenquorin");
  expect(text).toContain("Independentquorin");
  expect(text).not.toMatch(/Spokenquorin|Transcripttail/u);
  expect(vocabularyText("[Audio]: ordinary unmarked prose")).toBe(
    "[Audio]: ordinary unmarked prose",
  );
});

test("unclosed markup inside ASR does not swallow the next written message", () => {
  const text = vocabularyText(
    "**09:04** Elara Quill: [Audio]: Spokenquorin\n```\nASRtail\n**09:05** Rohan Vale: Writtenquorin",
  );
  expect(text).not.toMatch(/Spokenquorin|ASRtail/u);
  expect(text).toContain("Writtenquorin");
});
