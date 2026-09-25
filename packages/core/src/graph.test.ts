// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { PERSON_ROLES } from "./document.js";
import {
  NEAR_DUPLICATE_EDGE_TYPE,
  SAME_ENTITY_EDGE_TYPE,
  GRAPH_EDGE_TYPES,
  analyticsRowKey,
  parseAnalyticsRowKey,
  recordReference,
  graphEdgeDescriptors,
  graphEdgeDescriptor,
  graphEdgeProvenance,
  isGraphEdgeType,
  type GraphEdgeType,
} from "./graph.js";

// The complete set of `document_links.link_type` values, mirroring the
// `LinkType` union. Kept here so a drift between the union and the
// descriptors is caught by the coverage test below.
const LINK_TYPES = [
  "url",
  "shares-phone",
  "references",
  "contains",
  "part-of-thread",
  "replies-to",
  "succeeds",
  "accompanies",
  "bookmarks",
  "visited",
  "duplicate-content",
  "same-resource",
  "calendar-event",
  "cited",
] as const;

describe("graph edge vocabulary", () => {
  it("covers every edge type with exactly one descriptor", () => {
    const expected = [
      ...LINK_TYPES,
      NEAR_DUPLICATE_EDGE_TYPE,
      SAME_ENTITY_EDGE_TYPE,
      ...PERSON_ROLES,
    ];
    expect(GRAPH_EDGE_TYPES.length).toBe(expected.length);
    expect(new Set(GRAPH_EDGE_TYPES).size).toBe(GRAPH_EDGE_TYPES.length); // no dups
    for (const type of expected) {
      expect(isGraphEdgeType(type)).toBe(true);
      expect(graphEdgeDescriptor(type)).toBeDefined();
    }
    expect(graphEdgeDescriptors().length).toBe(expected.length);
  });

  it("classifies document_links edges as directed document↔document", () => {
    for (const type of LINK_TYPES) {
      const d = graphEdgeDescriptor(type)!;
      expect(d.storage).toBe("document_links");
      expect(d.directed).toBe(true);
      expect(d.endpoints).toBe("document-document");
    }
  });

  it("maps each link type to the right provenance", () => {
    expect(graphEdgeProvenance("url")).toBe("content-derived");
    expect(graphEdgeProvenance("references")).toBe("source-declared");
    expect(graphEdgeProvenance("part-of-thread")).toBe("source-declared");
    expect(graphEdgeProvenance("contains")).toBe("source-declared");
    expect(graphEdgeProvenance("replies-to")).toBe("source-declared");
    expect(graphEdgeProvenance("succeeds")).toBe("source-declared");
    expect(graphEdgeProvenance("accompanies")).toBe("source-declared");
    expect(graphEdgeProvenance("calendar-event")).toBe("source-declared");
    expect(graphEdgeProvenance("duplicate-content")).toBe("cross-source-derived");
    expect(graphEdgeProvenance("same-resource")).toBe("cross-source-derived");
    expect(graphEdgeProvenance("cited")).toBe("llm-derived");
  });

  it("classifies the near-duplicate edge as symmetric cross-source", () => {
    const d = graphEdgeDescriptor(NEAR_DUPLICATE_EDGE_TYPE)!;
    expect(d.storage).toBe("near_dup_edges");
    expect(d.directed).toBe(false);
    expect(d.endpoints).toBe("document-document");
    expect(d.provenance).toBe("cross-source-derived");
  });

  it("classifies the same-entity edge as a synthesized document↔analytics-row edge", () => {
    const d = graphEdgeDescriptor(SAME_ENTITY_EDGE_TYPE)!;
    expect(d.storage).toBe("synthesized");
    expect(d.directed).toBe(false);
    expect(d.endpoints).toBe("document-analytics-row");
    // Type-level default; cross-source-derived same-entity edges carry per-edge
    // provenance when #430 lands.
    expect(d.provenance).toBe("source-declared");
  });

  it("classifies every person role as a source-declared document↔person edge", () => {
    for (const role of PERSON_ROLES) {
      const d = graphEdgeDescriptor(role)!;
      expect(d.storage).toBe("document_people");
      expect(d.directed).toBe(false);
      expect(d.endpoints).toBe("document-person");
      expect(d.provenance).toBe("source-declared");
    }
  });

  it("returns undefined for strings outside the documented set", () => {
    expect(isGraphEdgeType("not-a-real-edge")).toBe(false);
    expect(graphEdgeDescriptor("not-a-real-edge")).toBeUndefined();
    expect(graphEdgeProvenance("not-a-real-edge")).toBeUndefined();
  });

  it("descriptor.type round-trips its key", () => {
    for (const type of GRAPH_EDGE_TYPES) {
      expect(graphEdgeDescriptor(type)!.type).toBe(type);
    }
  });

  it("GraphEdgeType accepts a near-duplicate literal at the type level", () => {
    // Compile-time guard: NEAR_DUPLICATE_EDGE_TYPE is a member of the union.
    const t: GraphEdgeType = NEAR_DUPLICATE_EDGE_TYPE;
    expect(t).toBe("near-duplicate");
  });
});

describe("record reference identity (#757)", () => {
  it("recordReference mints the same recordKey analyticsRowKey would", () => {
    const ref = recordReference("bank_transactions", [
      { name: "account_key", value: "acct-1", castType: "VARCHAR" },
      { name: "transaction_key", value: "txn-1", castType: "VARCHAR" },
    ]);
    expect(ref.table).toBe("bank_transactions");
    expect(ref.recordKey).toBe(analyticsRowKey("bank_transactions", "acct-1:txn-1"));
  });

  it("a reference round-trips: recordKey ⇆ (table, primaryKey)", () => {
    const ref = recordReference("strava_activities", [{ name: "id", value: "98765" }]);
    const parsed = parseAnalyticsRowKey(ref.recordKey);
    expect(parsed).toEqual({ table: "strava_activities", primaryKey: "98765" });
  });

  it("round-trips a composite key whose values contain the ':' delimiter", () => {
    // The percent-encoding in analyticsRowKey must survive a value that itself
    // contains a colon, so the join separator can't be confused with data.
    const ref = recordReference("notion_db", [
      { name: "page_id", value: "a:b" },
      { name: "block_id", value: "c" },
    ]);
    const parsed = parseAnalyticsRowKey(ref.recordKey);
    expect(parsed).toEqual({ table: "notion_db", primaryKey: "a:b:c" });
  });

  it("parseAnalyticsRowKey rejects strings that are not row keys", () => {
    expect(parseAnalyticsRowKey("doc:abc")).toBeNull();
    expect(parseAnalyticsRowKey("row:")).toBeNull();
    expect(parseAnalyticsRowKey("row:onlytable")).toBeNull();
  });
});
