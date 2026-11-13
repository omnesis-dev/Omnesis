// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createInterface } from "node:readline";

const segmenters = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  const { text, language = "und" } = JSON.parse(line);
  let segmenter = segmenters.get(language);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(language, { granularity: "word" });
    segmenters.set(language, segmenter);
  }
  const tokens = [...segmenter.segment(text)]
    .filter((part) => part.isWordLike)
    .map((part) => ({
      text: part.segment.normalize("NFKC").toLocaleLowerCase(language),
      start: part.index,
      end: part.index + part.segment.length,
    }));
  process.stdout.write(`${JSON.stringify({ tokens, icu: process.versions.icu })}\n`);
}
