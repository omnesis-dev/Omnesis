// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { parseClaimMarkup } from "@omnesis/gateway/src/brain/knowledge/claims.js";
import { uncoveredKnowledgeSpans } from "@omnesis/gateway/src/brain/knowledge/coverage.js";
import { coverLegacyProse } from "./legacy-prose.js";

it("covers legacy prose without adding evidence or altering existing nested claim identities", () => {
  const markdown =
    '## Description\n<claim id="legacy-context-0" refs="source:doc">The workshop is on Friday.</claim>\n\n## Body\nBring materials.';
  const result = coverLegacyProse(markdown);
  const parsed = parseClaimMarkup(result.markdown);
  expect(uncoveredKnowledgeSpans(parsed)).toEqual([]);
  expect(parsed.text).toBe(parseClaimMarkup(markdown).text);
  expect(
    parsed.claims.find((claim) => claim.id === "legacy-context-0")?.refs.map((ref) => ref.raw),
  ).toEqual(["source:doc"]);
  expect(result.addedClaims).toEqual([{ id: "legacy-context-1", epistemicStatus: "unsupported" }]);
  expect(parsed.claims.find((claim) => claim.id === "legacy-context-1")?.refs).toEqual([]);
  expect(coverLegacyProse(result.markdown).addedClaims).toEqual([]);
});
it("leaves empty root text empty and tags evidence-free owner prose as unsupported", () => {
  expect(coverLegacyProse(" ")).toEqual({ markdown: " ", addedClaims: [] });
  expect(coverLegacyProse("Historical note.").addedClaims).toEqual([
    { id: "legacy-context-0", epistemicStatus: "unsupported" },
  ]);
});
