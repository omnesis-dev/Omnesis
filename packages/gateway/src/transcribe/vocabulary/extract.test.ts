// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { extractTranscriptionVocabulary } from "./extract.js";
import type { VocabularyCandidate, VocabularyDocument, VocabularySettings } from "./types.js";

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

function candidates(content: string, names: string[] = []): VocabularyCandidate[] {
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
  return extractTranscriptionVocabulary([doc], settings)[0].terms;
}

function terms(content: string, names: string[] = []): string[] {
  return candidates(content, names).map((candidate) => candidate.term);
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

test("repeated actual spelling beats one variant with a higher capitalization benefit", () => {
  expect(candidates("Velquorin vElQuOrIn Velquorin")).toContainEqual({
    term: "velquorin",
    text: "Velquorin",
    benefit: 2,
  });
  expect(candidates("vElQuOrIn velquorin velquorin")).toContainEqual({
    term: "velquorin",
    text: "velquorin",
    benefit: 1,
  });
});

test("preserves consistently observed mixed-case products and their selected benefit", () => {
  const selected = candidates("ZiLora ZiLora Zilora myOS myOS MYOS");
  expect(selected).toContainEqual({ term: "zilora", text: "ZiLora", benefit: 2.5 });
  expect(selected).toContainEqual({ term: "myos", text: "myOS", benefit: 2.5 });
});

test("grounded names preserve observed spelling without manufacturing canonical votes", () => {
  const selected = candidates("nexularis virellune; nexularis virellune; NeXuLaRiS ViReLlUnE", [
    "Nexularis Virellune",
    "Nexularis Virellune",
  ]);
  expect(selected).toContainEqual({
    term: "nexularis virellune",
    text: "nexularis virellune",
    benefit: 2.5,
  });
});

test("grounded Unicode names retain apostrophes and whitespace normalization", () => {
  expect(candidates("Zélor   O'Vantix", ["Zélor O'Vantix"])).toContainEqual({
    term: "zélor o'vantix",
    text: "Zélor O'Vantix",
    benefit: 2.5,
  });
});

function authoredDocument(overrides: Partial<VocabularyDocument> = {}): VocabularyDocument {
  return {
    id: "invented-authored-document",
    contentHash: "invented-authored-hash",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: 0,
    generation: 1,
    title: "",
    content: "Receivedquorin; Nexularis",
    sourceId: "fictional:mixed",
    threadId: "fictional-thread",
    recordedAt: "2026-10-01T00:00:00.000Z",
    people: [{ personId: "self", name: "You", isSelf: true, role: "author" }],
    ...overrides,
  };
}

test("mixed conversations promote only authored terms with their original timestamps", () => {
  const [result] = extractTranscriptionVocabulary(
    [
      authoredDocument({
        selfAuthoredText: [
          { text: "Nexularis", recordedAt: "2024-02-01T00:00:00.000Z" },
          { text: "Velquorin; Nexularis", recordedAt: "2026-09-28T01:00:00+01:00" },
        ],
      }),
    ],
    settings,
  );
  expect(result.terms.map((candidate) => candidate.term)).toContain("receivedquorin");
  expect(result.selfTerms).toEqual(
    expect.arrayContaining([
      { term: "nexularis", text: "Nexularis", benefit: 2, recordedAt: "2026-09-28T00:00:00.000Z" },
      { term: "velquorin", text: "Velquorin", benefit: 2, recordedAt: "2026-09-28T00:00:00.000Z" },
    ]),
  );
  expect(result.selfTerms).toHaveLength(2);
});

test("self author role and document timestamps supply no inferred authored evidence", () => {
  expect(
    extractTranscriptionVocabulary([authoredDocument()], settings)[0].selfTerms,
  ).toBeUndefined();
  expect(
    extractTranscriptionVocabulary([authoredDocument({ selfAuthoredText: [] })], settings)[0]
      .selfTerms,
  ).toEqual([]);
  expect(
    extractTranscriptionVocabulary(
      [authoredDocument({ selfAuthoredText: [{ text: "Velquorin", recordedAt: "invalid" }] })],
      settings,
    )[0].selfTerms,
  ).toEqual([]);
  expect(
    extractTranscriptionVocabulary([authoredDocument()], { ...settings, enabled: false }),
  ).toEqual([]);
});

test("authored spelling votes aggregate genuine occurrences across segments and deduplicate terms", () => {
  const [result] = extractTranscriptionVocabulary(
    [
      authoredDocument({
        selfAuthoredText: [
          { text: "Velquorin; Velquorin", recordedAt: "2026-09-20T00:00:00.000Z" },
          { text: "vElQuOrIn", recordedAt: "2026-09-25T00:00:00.000Z" },
        ],
      }),
    ],
    settings,
  );
  expect(result.selfTerms).toEqual([
    { term: "velquorin", text: "Velquorin", benefit: 2, recordedAt: "2026-09-25T00:00:00.000Z" },
  ]);
});

test("authored evidence obeys the same identifier and lexical safety and output cap", () => {
  const [result] = extractTranscriptionVocabulary(
    [
      authoredDocument({
        selfAuthoredText: [
          {
            text:
              "Velquorin; Nexularis https://hiddenquorin.example.com hiddenquorin@example.com " +
              "Z".repeat(200),
            recordedAt: "2026-09-25T00:00:00.000Z",
          },
        ],
      }),
    ],
    { ...settings, maxTermsPerDocument: 1 },
  );
  expect(result.selfTerms).toHaveLength(1);
  expect(result.selfTerms?.[0].term).toBe("nexularis");
});

test("ordinary French and English contractions never become recent authored vocabulary", () => {
  const prose =
    "C’est l’été, j’ai l’heure. Aujourd’hui, qu’un ami arrive. We're here; I’m ready, don’t wait. d’Orvelion O’Zorvella";
  const [result] = extractTranscriptionVocabulary(
    [
      authoredDocument({
        title: "",
        content: prose,
        people: [],
        selfAuthoredText: [{ text: prose, recordedAt: "2026-10-01T00:00:00.000Z" }],
      }),
    ],
    settings,
  );
  expect(result.terms.map((candidate) => candidate.text).sort()).toEqual(
    ["O’Zorvella", "d’Orvelion"].sort(),
  );
  expect(result.selfTerms?.map((candidate) => candidate.text).sort()).toEqual(
    ["O’Zorvella", "d’Orvelion"].sort(),
  );
});

test("left-curly apostrophes preserve uncommon names while ordinary contractions stay filtered", () => {
  const prose = "C‘est l‘été; don‘t wait. d‘Orvelion; O‘Zorvella.";
  const [result] = extractTranscriptionVocabulary(
    [
      authoredDocument({
        title: "",
        content: prose,
        people: [],
        selfAuthoredText: [{ text: prose, recordedAt: "2026-10-01T00:00:00.000Z" }],
      }),
    ],
    settings,
  );
  for (const selected of [result.terms, result.selfTerms ?? []]) {
    expect(selected.map((candidate) => candidate.text).sort()).toEqual(
      ["O‘Zorvella", "d‘Orvelion"].sort(),
    );
    expect(selected.map((candidate) => candidate.term)).not.toContain("zorvella");
    expect(selected.map((candidate) => candidate.term)).not.toContain("orvelion");
  }
});
