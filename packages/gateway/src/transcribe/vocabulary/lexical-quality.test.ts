// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { vocabularyLexicalQuality } from "./lexical-quality.js";

test("structural laughter and stretched common prose do not supply vocabulary hints", () => {
  for (const word of [
    "hahaha",
    "ahahaha",
    "xDDD",
    "xPPP",
    "xppp",
    "HEHEHE",
    "jajajaja",
    "kkkkkk",
    "sooooo",
    "helloooo",
    "travaaaail",
  ])
    expect(vocabularyLexicalQuality(word)).toBe(0);
});

test("short nicknames, ordinary prose and uncommon spellings retain their identity", () => {
  for (const word of [
    "Coco",
    "Lulu",
    "Mimi",
    "Nana",
    "banana",
    "Zorvella",
    "myOS",
    "QVL",
    "XDDD",
    "XPPP",
    "O’Zorvella",
    "Zorvelllla",
  ])
    expect(vocabularyLexicalQuality(word)).toBe(1);
  for (const word of ["Tatata", "AAAA", "helloooo", "xDDD"])
    expect(vocabularyLexicalQuality(word, { grounded: true })).toBe(1);
});

test("uppercase acronyms bypass stretched common-word collapse only", () => {
  expect(vocabularyLexicalQuality("HELLLO")).toBe(1);
  for (const word of ["Helllo", "helllo", "AAAA", "HEHEHE"])
    expect(vocabularyLexicalQuality(word)).toBe(0);
});
