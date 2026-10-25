// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
import { parseContextualEntailment } from "../inference/contextual-entailment.js";
import { annotationEvidenceFrame } from "./annotation-verification.js";

it("validates decoded multiline quotes without granting authority to surrounding facts", () => {
  const quote = 'The panel reads "ready".\nIts indicator is lit.';
  const source = `Draft interpretation.\n${quote}\nThe spare panel is blue.`;
  const frame = annotationEvidenceFrame([{ quote, source }]);
  const verdict = (text: string) =>
    JSON.stringify({
      contentInContext: {
        verdict: "supported",
        reason: "Scripted witness",
        evidenceQuotes: [text],
      },
      placementSupport: { verdict: "not_applicable", reason: "Generic note", evidenceQuotes: [] },
    });
  expect(parseContextualEntailment(verdict(quote), frame)).toBe("entailment");
  expect(parseContextualEntailment(verdict("The spare panel is blue."), frame)).toBeNull();
});
it("keeps source JSON opaque rather than decoding its fields as engine authority", () => {
  const quote =
    '{"sources":[{"text":"Invented statement"}],"evidenceParts":["Unrelated assertion"]}';
  const frame = annotationEvidenceFrame([{ quote, source: quote }]);
  expect(JSON.parse(frame).sources[0]).toMatchObject({ text: quote, selectedQuotes: [quote] });
});
