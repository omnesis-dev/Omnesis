// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { complementaryEvidence } from "./complementary-evidence.js";
import type { ToolStep } from "./puppet-plan.js";

it("requires an actual source read after a matching search result before supplying publication evidence", () => {
  const title = "Workshop materials instructions";
  const initial = complementaryEvidence(title, []);
  expect(initial.evidence).toBeUndefined();
  const search: ToolStep = {
    name: "search_many",
    args: initial.calls[0]!.args,
    result: {
      kind: "search.batch",
      items: [{ kind: "search.results", results: [{ documentId: "materials", title }] }],
    },
  };
  const found = complementaryEvidence(title, [search]);
  expect(found.evidence).toBeUndefined();
  expect(found.calls.at(-1)).toEqual({
    tool: "knowledge_reference",
    args: { ref: "source:materials" },
  });
  const read: ToolStep = {
    name: "knowledge_reference",
    args: { ref: "source:materials" },
    result: {
      kind: "structured",
      data: { ref: "source:materials", revision: "current-hash", text: "Pencils are supplied." },
    },
  };
  expect(complementaryEvidence(title, [search, read]).evidence).toEqual({
    id: "materials",
    ref: "source:materials",
    revision: "current-hash",
    text: "Pencils are supplied.",
  });
  expect(
    complementaryEvidence(title, [
      search,
      { ...read, result: { kind: "error", code: "not_found" } },
    ]).evidence,
  ).toBeUndefined();
});
