// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { lexicalText } from "./lexical-analysis.js";

const words = (text: string): string[] => lexicalText(text).split(/\s+/).filter(Boolean);

describe("lexicalText", () => {
  test("Latin-script text is returned unchanged", () => {
    for (const text of [
      "The quarterly budget review, l’école — café!",
      "Die Häuser am Fluß, les bibliothèques, las ciudades",
    ]) {
      expect(lexicalText(text)).toBe(text);
    }
  });

  test("Chinese, Japanese and Thai sentences are split into words", () => {
    expect(words("我昨天在图书馆借了三本书")).toContain("昨天");
    expect(words("明日の会議は午後三時に始まります")).toEqual(
      expect.arrayContaining(["明日", "会议", "午后"]),
    );
    expect(words("ฉันไปตลาดเมื่อวานนี้").length).toBeGreaterThan(3);
  });

  // Lexical version 1 is these exact splits. Word splitting comes from the
  // runtime's ICU dictionaries, so a Node release whose ICU splits these
  // sentences differently fails here: the rules then ship as a new lexical
  // version, which rebuilds existing indexes, instead of silently cutting new
  // chunks and queries differently from what installs already indexed.
  test("sample sentences split exactly as version 1 indexed them", () => {
    expect(words("我昨天在图书馆借了三本书")).toEqual([
      "我",
      "昨天",
      "在",
      "图书",
      "馆",
      "借了",
      "三本",
      "书",
    ]);
    expect(words("明日の会議は午後三時に始まります")).toEqual([
      "明日",
      "の",
      "会议",
      "は",
      "午后",
      "三",
      "时",
      "に",
      "始まり",
      "ます",
    ]);
    expect(words("東京駅で友達と待ち合わせをしました")).toEqual([
      "东京",
      "駅",
      "で",
      "友",
      "达",
      "と",
      "待ち合わせ",
      "を",
      "しま",
      "した",
    ]);
    expect(words("ฉันไปตลาดเมื่อวานนี้เพื่อซื้อผลไม้")).toEqual([
      "ฉัน",
      "ไป",
      "ตลาด",
      "เมื่อ",
      "วาน",
      "นี้",
      "เพื่อ",
      "ซื้อ",
      "ผล",
      "ไม้",
    ]);
  });

  test("a word is split the same way alone and inside a sentence", () => {
    const sentence = new Set(words("我昨天在图书馆借了三本书"));
    for (const term of words("图书馆")) expect(sentence.has(term)).toBe(true);
  });

  test("a Korean run becomes its syllable pairs", () => {
    expect(words("우체통입니다")).toEqual(["우체", "체통", "통입", "입니", "니다"]);
    expect(words("파란고래")).toEqual(["파란", "란고", "고래"]);
    expect(words("고래")).toEqual(["고래"]);
    expect(words("권")).toEqual(["권"]);
  });

  test("a Korean noun matches the same noun carrying a particle", () => {
    expect(words("승차권을")).toEqual(words("승차권"));
    expect(words("도서관에서는")).toEqual(words("도서관"));
    expect(words("고래가")).toEqual(words("고래"));
  });

  test("a particle is kept when the word without it would be one syllable", () => {
    expect(words("나는")).toEqual(["나는"]);
    expect(words("우리")).toEqual(["우리"]);
  });

  test("a Persian plural matches its singular", () => {
    expect(lexicalText("کتابها")).toBe(lexicalText("کتاب"));
    expect(lexicalText("بزرگترین")).toBe(lexicalText("بزرگ"));
  });

  test("a joiner inside an Indic word is ignored", () => {
    expect(lexicalText("హెమింగ్\u200Cవే")).toBe(lexicalText("హెమింగ్వే"));
  });

  test("decomposed Hangul is composed before pairing", () => {
    expect(words("고래".normalize("NFD"))).toEqual(["고래"]);
  });

  test("Russian word forms share a stem", () => {
    expect(lexicalText("Книгами")).toBe(lexicalText("книга"));
    expect(lexicalText("в библиотеках города")).toBe(lexicalText("в библиотека город"));
  });

  test("Arabic word forms share a stem", () => {
    expect(lexicalText("الكتابات")).toBe(lexicalText("كتاب"));
  });

  test("Arabic and Hebrew vowel points are removed", () => {
    expect(lexicalText("مُحَمَّد")).toBe(lexicalText("محمد"));
    expect(lexicalText("שָׁלוֹם")).toBe("שלום");
  });

  test("a stress accent on a Russian word is ignored", () => {
    expect(lexicalText("Кари́бский кризис")).toBe(lexicalText("Карибский кризис"));
  });

  test("Chinese matches across its traditional and simplified characters", () => {
    expect(lexicalText("圖書館裡的書籍")).toBe(lexicalText("图书馆里的书籍"));
  });

  test("full-width and half-width forms are read as the ordinary characters", () => {
    expect(lexicalText("ＩＮＶ－２０４１ ｶﾀｶﾅ")).toBe(lexicalText("INV-2041 カタカナ"));
  });

  test("a Hindi letter matches with or without its dot, however it is encoded", () => {
    expect(lexicalText("मेज़")).toBe(lexicalText("मेज"));
    expect(lexicalText("\u0958")).toBe(lexicalText("\u0915\u093C"));
    expect(lexicalText("हँस")).toBe(lexicalText("हंस"));
  });

  test("Hindi, Bengali and Telugu word forms share a stem", () => {
    expect(lexicalText("किताबें")).toBe(lexicalText("किताब"));
    expect(lexicalText("लड़कियों")).toBe(lexicalText("लड़की"));
    expect(lexicalText("বইগুলো")).toBe(lexicalText("বই"));
    expect(lexicalText("শহরের")).toBe(lexicalText("শহর"));
    expect(lexicalText("దేశంలో")).toBe(lexicalText("దేశం"));
    expect(lexicalText("పుస్తకాలను")).toBe(lexicalText("పుస్తకాలు"));
  });

  test("a stem is its own stem", () => {
    for (const word of ["লড়াইগুলোর", "దేశాలలోని", "लड़कियों", "библиотеками"]) {
      const stem = lexicalText(word);
      expect(lexicalText(stem)).toBe(stem);
    }
  });

  test("an ending is kept when removing it would leave one character", () => {
    expect(lexicalText("का")).toBe("का");
    expect(lexicalText("తో")).toBe("తో");
  });

  test("mixed text keeps its Latin words and identifiers intact", () => {
    expect(words("Meeting 明日 at 東京駅 re: INV-2041")).toEqual(
      expect.arrayContaining(["Meeting", "明日", "at", "re:", "INV-2041"]),
    );
  });
});
