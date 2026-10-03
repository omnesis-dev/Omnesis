// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { adaptTranscriptionVocabulary, WHISPER_MAX_PROMPT_TOKENS } from "./vocabulary-adapter.js";

const vocabulary = (...entries: [string, number][]) => ({
  entries: entries.map(([text, score]) => ({ text, score })),
});

describe("adaptTranscriptionVocabulary", () => {
  test("selects the highest ranked phrases without truncating a phrase", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["lower", 1], ["Northstar", 10], ["too long to fit", 5], ["QX", 2]),
      { runtime: "smart-whisper", maxPromptTokens: 13 },
    );
    expect(result).toEqual({
      initial_prompt: "Northstar, QX",
      no_context: true,
      n_max_text_ctx: 13,
    });
  });

  test("counts UTF-8 bytes and separators, including accents and non-Latin phrases", () => {
    const result = adaptTranscriptionVocabulary(vocabulary(["étoile", 3], ["星光", 2], ["Z", 1]), {
      runtime: "smart-whisper",
      maxPromptTokens: 13,
    });
    expect(result?.initial_prompt).toBe("étoile, Z");
    expect(Buffer.byteLength(result!.initial_prompt, "utf8")).toBeLessThanOrEqual(13);
    expect(
      adaptTranscriptionVocabulary(vocabulary(["星光", 1]), {
        runtime: "smart-whisper",
        maxPromptTokens: 5,
      }),
    ).toBeUndefined();
  });

  test("normalizes whitespace and Unicode and retains the highest ranked duplicate", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["  E\u0301toile  \n Labs ", 3], ["étoile labs", 2], ["\u0000bad", 5], ["", 9]),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe("Étoile Labs");
  });

  test("packed names cover their contiguous components and leave room for other hints", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(
        ["Tessa Rowan Vale", 10],
        ["Rowan Vale", 9],
        ["Tessa", 8],
        ["Vale", 7],
        ["Umbriolet", 6],
      ),
      { runtime: "smart-whisper", maxPromptTokens: 27 },
    );
    expect(result?.initial_prompt).toBe("Tessa Rowan Vale, Umbriolet");
  });

  test("a skipped oversized name does not cover a component", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["Tessa Rowan Vale", 10], ["Rowan", 9]),
      { runtime: "smart-whisper", maxPromptTokens: 5 },
    );
    expect(result?.initial_prompt).toBe("Rowan");
  });

  test("component matching normalizes Unicode whitespace, case and accents", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["E\u0301loria\u00a0\tLabs", 10], ["ÉLORIA", 9], ["labs", 8], ["Velmora", 7]),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe("Éloria Labs, Velmora");
  });

  test("hyphens and apostrophes retain their complete word boundaries", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(
        ["North-Rill Labs", 10],
        ["Sylvara d’Arven", 9],
        ["Labs", 8],
        ["d’Arven", 7],
        ["Rill", 6],
        ["Arven", 5],
      ),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe("North-Rill Labs, Sylvara d’Arven, Rill, Arven");
  });

  test("unsegmented CJK text does not cover substrings", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["雨庭工房", 10], ["雨庭", 9], ["工房", 8]),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe("雨庭工房, 雨庭, 工房");
  });

  test("coverage never joins separate packed hints or noncontiguous words", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(
        ["Tessa", 10],
        ["Rowan", 9],
        ["Tessa Rowan", 8],
        ["Miro Sela Vale", 7],
        ["Miro Vale", 6],
      ),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe("Tessa Rowan, Miro Sela Vale, Miro Vale");
  });

  test("equal-ranked full names replace a prefix component within an exact budget", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["Nevara", 10], ["Nevara Quenil", 10], ["Quenil", 10]),
      { runtime: "smart-whisper", maxPromptTokens: 13 },
    );
    expect(result?.initial_prompt).toBe("Nevara Quenil");
    expect(Buffer.byteLength(result!.initial_prompt, "utf8")).toBe(13);
  });

  test("later full spellings preserve higher-ranked unrelated hints and their order", () => {
    const input = vocabulary(["AX", 12], ["Ruvella", 10], ["KX", 9], ["Ruvella Research", 2]);
    expect(
      adaptTranscriptionVocabulary(input, { runtime: "smart-whisper", maxPromptTokens: 24 })
        ?.initial_prompt,
    ).toBe("AX, Ruvella Research, KX");
    expect(
      adaptTranscriptionVocabulary(input, { runtime: "smart-whisper", maxPromptTokens: 23 })
        ?.initial_prompt,
    ).toBe("AX, Ruvella, KX");
  });

  test("one full phrase can replace multiple independently packed complete components", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["Quenil", 12], ["KX", 11], ["Nevara", 10], ["Nevara Quenil", 2]),
      { runtime: "smart-whisper", maxPromptTokens: 18 },
    );
    expect(result?.initial_prompt).toBe("Nevara Quenil, KX");
  });

  test("phrase upgrades preserve normalized multilingual spellings", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(
        ["ÉVÉRIA", 12],
        ["Veyro", 11],
        ["星苑", 10],
        ["Évéria Nuvorel", 3],
        ["Lurena del Veyro", 2],
        ["雲輪 星苑", 1],
      ),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe("Évéria Nuvorel, Lurena del Veyro, 雲輪 星苑");
  });

  test("phrase upgrades cannot cover unrelated substrings, hyphens or apostrophes", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(
        ["Rill", 12],
        ["Arven", 11],
        ["Nuvor", 10],
        ["Vale", 9],
        ["North-Rill Labs", 3],
        ["Sylvara d’Arven", 2],
        ["Nuvorel Valera", 1],
      ),
      { runtime: "smart-whisper" },
    );
    expect(result?.initial_prompt).toBe(
      "Rill, Arven, Nuvor, Vale, North-Rill Labs, Sylvara d’Arven, Nuvorel Valera",
    );
  });

  test("an oversized lower-ranked phrase does not remove affordable components", () => {
    const result = adaptTranscriptionVocabulary(
      vocabulary(["Nevara", 10], ["KX", 9], ["Nevara " + "Quenil ".repeat(40), 2]),
      { runtime: "smart-whisper", maxPromptTokens: 20 },
    );
    expect(result?.initial_prompt).toBe("Nevara, KX");
  });

  test("fails closed for unknown capabilities and unusable candidates", () => {
    expect(
      adaptTranscriptionVocabulary(vocabulary(["Northstar", 1]), { runtime: "unknown" }),
    ).toBeUndefined();
    expect(
      adaptTranscriptionVocabulary(vocabulary(["A", NaN], ["B", Infinity], ["C", 0], ["D", -1]), {
        runtime: "smart-whisper",
      }),
    ).toBeUndefined();
    for (const maxPromptTokens of [0, -1, NaN, Infinity]) {
      expect(
        adaptTranscriptionVocabulary(vocabulary(["A", 1]), {
          runtime: "smart-whisper",
          maxPromptTokens,
        }),
      ).toBeUndefined();
    }
  });

  test("caps oversized caller budgets and does not retain previous vocabulary", () => {
    const first = adaptTranscriptionVocabulary(vocabulary(["Northstar", 5]), {
      runtime: "smart-whisper",
    });
    const second = adaptTranscriptionVocabulary(vocabulary(["Z".repeat(225), 5], ["QX", 1]), {
      runtime: "smart-whisper",
      maxPromptTokens: 1000,
    });
    expect(first?.initial_prompt).toBe("Northstar");
    expect(second).toEqual({
      initial_prompt: "QX",
      no_context: true,
      n_max_text_ctx: WHISPER_MAX_PROMPT_TOKENS,
    });
    expect(
      adaptTranscriptionVocabulary(vocabulary(), { runtime: "smart-whisper" }),
    ).toBeUndefined();
  });
});
