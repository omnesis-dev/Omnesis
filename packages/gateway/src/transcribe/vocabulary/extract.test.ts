// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { extractTranscriptionVocabulary } from "./extract.js";
import type { VocabularyDocument, VocabularySettings } from "./types.js";

const settings: VocabularySettings = {
  enabled: true,
  maxTerms: 64,
  maxPromptTokens: 96,
  batchSize: 4,
  maxDocumentChars: 32768,
  maxTermsPerDocument: 64,
  periodMs: 1000,
  idlePeriodMs: 60000,
};

function terms(content: string, names: string[] = []): string[] {
  const doc: VocabularyDocument = {
    id: "fictional-document",
    contentHash: "fictional-hash",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    generation: 1,
    title: "",
    content,
    sourceId: "fictional:benchmark",
    threadId: null,
    recordedAt: "2026-01-01T00:00:00.000Z",
    people: names.map((name, index) => ({
      personId: `fictional-person-${index}`,
      name,
      isSelf: false,
      role: "sender",
    })),
  };
  return extractTranscriptionVocabulary([doc], settings)[0].terms.map((term) => term.term);
}

test("removes complete identifiers while preserving surrounding uncommon vocabulary", () => {
  const selected = terms(
    "Nexularis https://velquorin.example.org/path www.velquorin.example.org " +
      "velquorin@example.org (velquorin.example.org) <velquorin@example.org> " +
      "velquorin@https://example.org velquorin@ @velquorin " +
      "Virellune. Orelvax-Navrel",
  );
  expect(selected).toEqual(expect.arrayContaining(["nexularis", "virellune", "orelvax-navrel"]));
  expect(selected).toHaveLength(3);
  expect(
    terms("https://velquorin.example.org/path velquorin@example.org velquorin.example.org"),
  ).toEqual([]);
});

test("canonical identifier fallbacks never supply grounded names or their fragments", () => {
  expect(
    terms("", [
      "velquorin@example.org",
      "https://velquorin.example.org",
      "velquorin.example.org",
      "<velquorin@example.org>",
    ]),
  ).toEqual([]);
  expect(terms("Nexularis Virellune", ["Nexularis Virellune <velquorin@example.org>"])).toEqual(
    expect.arrayContaining(["nexularis virellune", "nexularis", "virellune"]),
  );
  expect(
    terms("Nexularis Virellune", ["Nexularis Virellune <velquorin@example.org>"]),
  ).toHaveLength(3);
});

test("scans long delimiter-free and hyphenated runs without losing subsequent vocabulary", () => {
  for (const token of [
    "z".repeat(32000),
    "za-".repeat(10666),
    "Z".repeat(32000),
    `a${"-".repeat(31998)}z`,
  ]) {
    expect(terms(token)).toEqual([]);
    expect(terms(`${token} Nexularis`)).toEqual(["nexularis"]);
  }
});

test("a separate valid word cannot turn an oversized token suffix into a phrase", () => {
  expect(terms(`Nexularis ${"A".repeat(200)}-Nexularis Virellune`)).toEqual(
    expect.arrayContaining(["nexularis", "virellune"]),
  );
  expect(terms(`Nexularis ${"A".repeat(200)}-Nexularis Virellune`)).toHaveLength(2);
});

test("keeps complete uncommon phrases, including names with sentence punctuation", () => {
  expect(terms("'Nexularis Virellune'.")).toEqual(
    expect.arrayContaining(["nexularis virellune", "nexularis", "virellune"]),
  );
  expect(terms("Project Nexularis.")).toEqual(["nexularis"]);
});

test("retains the existing Unicode code-point cap for complete lexical words", () => {
  const word = "\u{10400}".repeat(40);
  expect(terms(word)).toEqual([word.toLocaleLowerCase("und")]);
});

test("discards long email and dotted identifiers without retaining their fragments", () => {
  for (const token of [
    `${"z".repeat(16000)}@${"q".repeat(16000)}`,
    `${"za-".repeat(5000)}.${"qa-".repeat(5000)}example`,
  ]) {
    expect(terms(`${token} Nexularis`)).toEqual(["nexularis"]);
  }
});

test("keeps clean full names ahead of components and removes display annotations", () => {
  expect(terms("Nexularis Virellune", ["Nexularis Virellune | Stellar Sound (team)"])).toEqual([
    "nexularis virellune",
    "nexularis",
    "virellune",
  ]);
  expect(terms("Nexularis Virellune", ["Nexularis Virellune (guest)"])).toEqual([
    "nexularis virellune",
    "nexularis",
    "virellune",
  ]);
  // A frequent single word is not useful just because it labels a person;
  // full names retain common components as a complete grounded phrase.
  expect(terms("", ["They"])).toEqual([]);
  expect(terms("Will May", ["Will May"])).toContain("will may");
  expect(terms("山田 花子", ["山田 花子"])).toContain("山田 花子");
});

test("does not turn ordinary capitalized prose into multiword personal hints", () => {
  expect(terms("Hello Nexularis. Project Virellune. Thank You.")).toEqual([
    "nexularis",
    "virellune",
  ]);
});

test("uppercase template text does not outrank uncommon prose or a grounded name", () => {
  const selected = terms("VELQUORIN Nexularis Virellune Orelvax", ["Virellune Orelvax"]);
  expect(selected.indexOf("virellune orelvax")).toBeLessThan(selected.indexOf("virellune"));
  expect(selected.indexOf("nexularis")).toBeLessThan(selected.indexOf("velquorin"));
});

test("uses prose rather than rendered metadata as evidence in any language", () => {
  expect(
    terms(
      "# Export\n**Origine:** Byrelune\n**Destination:** Tyrelune\n**Horodatage:** ZORVEL\n---\n" +
        "**08:12** Wyrelune: [Audio, 0:07]: Nexularis Virellune\n" +
        "> Quoted Zeralith\n---\n**Files:** chart (QZP, 3KB)",
    ),
  ).toEqual(expect.arrayContaining(["nexularis", "virellune", "nexularis virellune"]));
  expect(
    terms(
      "# Export\n**Origine:** Byrelune\n**Destination:** Tyrelune\n**Horodatage:** ZORVEL\n---\n" +
        "**08:12** Wyrelune: [Audio, 0:07]: Nexularis Virellune\n" +
        "> Quoted Zeralith\n---\n**Files:** chart (QZP, 3KB)",
    ),
  ).toHaveLength(3);
});

test("linked names need a complete occurrence in cleaned prose", () => {
  expect(terms("", ["Nexularis Virellune"])).toEqual([]);
  expect(terms("> Nexularis Virellune", ["Nexularis Virellune"])).toEqual([]);
  expect(terms("Nexularis Virellunette", ["Nexularis Virellune"])).not.toContain(
    "nexularis virellune",
  );
  expect(terms("Will Maybe", ["Will May"])).not.toContain("will may");
  expect(terms("will   may arrived", ["Will May"])).toContain("will may");
});
