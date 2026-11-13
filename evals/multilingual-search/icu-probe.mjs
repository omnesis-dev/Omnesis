// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { jsonlRecords } from "./integration/jsonl.mjs";

const segmenters = new Map();
for await (const { text, language = "und" } of jsonlRecords(process.stdin)) {
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
