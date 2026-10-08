// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { parseClaimReference } from "./references.js";

describe("claim references", () => {
  it.each([
    ["source:doc_1#evidence:span_2", "source", "doc_1", "evidence", "span_2"],
    ["wiki:page-1#claim:c2", "wiki", "page-1", "claim", "c2"],
    ["loop:loop_1#field:state", "loop", "loop_1", "field", "state"],
    ["loop:loop_1#claim:reason", "loop", "loop_1", "claim", "reason"],
    ["annotation:a1#claim:c1", "annotation", "a1", "claim", "c1"],
    ["brief:b1#claim:c1", "brief", "b1", "claim", "c1"],
  ])("parses %s", (raw, kind, id, selectorKind, selectorId) => {
    expect(parseClaimReference(raw!)).toEqual({
      raw,
      kind,
      id,
      selector: { kind: selectorKind, id: selectorId },
    });
  });
  it("accepts document UUIDs and coarse dependency references", () => {
    expect(parseClaimReference("source:00000000-0000-4000-8000-000000000001")).toEqual({
      raw: "source:00000000-0000-4000-8000-000000000001",
      kind: "source",
      id: "00000000-0000-4000-8000-000000000001",
    });
  });
  it.each([
    "doc:example_document",
    "document:example_document",
    "https://example.com",
    "source:../secret",
    "source:x%22",
    "wiki:x#field:state",
    "source:x#claim:c",
    "brief:x#evidence:e",
    "person:x",
    "wiki:",
    "wiki:x#claim:",
    "wiki:x#claim:c#claim:d",
    "wiki:x\n",
    "wiki:<script>",
    `wiki:${"x".repeat(129)}`,
  ])("rejects %s", (raw) => {
    expect(() => parseClaimReference(raw)).toThrow(
      expect.objectContaining({
        code: "reference_invalid",
        message: expect.stringContaining("Use source:<documentId> for a whole fetched document"),
      }),
    );
  });
});
