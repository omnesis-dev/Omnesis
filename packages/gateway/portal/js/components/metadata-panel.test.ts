// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { formatExtractedDate, formatIsoDate, MetadataPanel } from "./metadata-panel.js";

// `formatExtractedDate` turns one Omnesis-extracted date (as returned by
// GET /documents/:id/dates) into the string shown in the "Enriched by Omnesis"
// metadata section. It must read cleanly for every ExtractedDate.kind.
describe("formatExtractedDate", () => {
  test("a point date renders as a calendar date", () => {
    expect(formatExtractedDate({ kind: "date", resolvedStart: "2022-01-22", resolvedEnd: null })).toBe(
      "Jan 22, 2022",
    );
  });

  test("a year-granularity date renders as just the year", () => {
    expect(formatExtractedDate({ kind: "date", resolvedStart: "2026", resolvedEnd: null })).toBe("2026");
  });

  test("a month-granularity date renders month + year", () => {
    expect(formatExtractedDate({ kind: "date", resolvedStart: "2024-08", resolvedEnd: null })).toBe(
      "Aug 2024",
    );
  });

  test("an open-ended deadline renders with its modifier", () => {
    expect(
      formatExtractedDate({ kind: "range", mod: "before", resolvedStart: null, resolvedEnd: "2024-08-04" }),
    ).toBe("before Aug 4, 2024");
  });

  test("a bounded range renders both ends", () => {
    expect(
      formatExtractedDate({ kind: "range", resolvedStart: "2022-01-24", resolvedEnd: "2022-01-26" }),
    ).toBe("Jan 24, 2022 – Jan 26, 2022");
  });
});

describe("formatIsoDate — granularity-aware", () => {
  test("year", () => expect(formatIsoDate("2026")).toBe("2026"));
  test("month", () => expect(formatIsoDate("2024-08")).toBe("Aug 2024"));
  test("day", () => expect(formatIsoDate("2022-01-22")).toBe("Jan 22, 2022"));
  test("passes through an unparseable value", () => {
    expect(formatIsoDate("not-a-date")).toBe("not-a-date");
  });
  test("empty in, empty out", () => expect(formatIsoDate("")).toBe(""));
});

// Headless VNode-expansion harness (same as cognition-doclist.test.ts): no
// jsdom, so the component renders to its preact VNode tree and function
// components expand recursively into a flat host-element list.
/* eslint-disable @typescript-eslint/no-explicit-any */
function expandToHostNodes(vnode: any, out: any[] = []): any[] {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const v of vnode) expandToHostNodes(v, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number") return out;
  if (!vnode.type) return out;
  if (typeof vnode.type === "function") {
    // The paging sentinel owns hooks and must only execute under Preact's
    // renderer. Its parent/section mounting is what this pure VNode harness
    // verifies.
    if (vnode.type.name === "ViewportSentinel") return out;
    return expandToHostNodes(vnode.type(vnode.props ?? {}), out);
  }
  out.push({
    tag: vnode.type,
    class: vnode.props?.class ?? "",
    text: collectText(vnode.props?.children),
  });
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

function collectText(children: any): string {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type && typeof children.type !== "function")
    return collectText(children.props?.children);
  return "";
}

// The "Enriched by Omnesis" section — agent annotations render as
// [claim-type chip · confidence] + claim text + evidence quote, and the
// section appears when EITHER extracted dates or annotations exist.
describe("MetadataPanel — agent annotations section", () => {
  const DOC = { id: "doc-12345678901234", source_id: "gmail:someone@example.com", metadata: "{}" };
  const ANNOTATION = {
    id: "ann_1",
    claimType: "commitment-status",
    claimText: "The studio deposit has not been paid yet",
    evidenceDocId: "doc-evidence",
    evidenceQuote: "The studio deposit is due on Friday.",
    confidence: 0.6,
    createdAt: "2026-07-01T00:00:00.000Z",
  };

  test("annotations alone light up the enriched section with type, confidence, claim, and quote", () => {
    const nodes = expandToHostNodes(
      MetadataPanel({ document: DOC, extractedDates: [], annotations: [ANNOTATION] }),
    );
    expect(nodes.find((n) => n.class === "meta-enriched")).toBeDefined();
    const chip = nodes.find((n) => n.class === "meta-enriched-value");
    expect(chip?.text).toBe("commitment-status");
    expect(nodes.find((n) => n.class === "meta-annotation-confidence")?.text.trim()).toBe("60%");
    expect(nodes.find((n) => n.class === "meta-annotation-claim")?.text).toBe(
      "The studio deposit has not been paid yet",
    );
    expect(nodes.find((n) => n.class.includes("meta-annotation-quote"))?.text).toContain(
      "The studio deposit is due on Friday.",
    );
  });

  test("no dates and no annotations → no enriched section", () => {
    const nodes = expandToHostNodes(
      MetadataPanel({ document: DOC, extractedDates: [], annotations: [] }),
    );
    expect(nodes.find((n) => n.class === "meta-enriched")).toBeUndefined();
  });

  test("an empty but pageable annotation result keeps the enriched section mounted", () => {
    const nodes = expandToHostNodes(
      MetadataPanel({
        document: DOC,
        extractedDates: [],
        annotations: [],
        annotationPage: {
          hasMore: true,
          loading: false,
          loadingMore: false,
          error: null,
          loadMoreError: null,
          loadMore: () => {},
        },
      }),
    );
    expect(nodes.find((n) => n.class === "meta-enriched")).toBeDefined();
  });

  test("initial annotation loading and failure also keep the enriched section mounted", () => {
    for (const annotationPage of [
      { loading: true },
      { error: new Error("fictional annotation failure"), reload: () => {} },
    ]) {
      const nodes = expandToHostNodes(
        MetadataPanel({
          document: DOC,
          extractedDates: [],
          annotations: [],
          annotationPage,
        }),
      );
      expect(nodes.find((n) => n.class === "meta-enriched")).toBeDefined();
    }
  });
});

describe("MetadataPanel — partition origin", () => {
  test("shows the friendly device name for a partitioned document", () => {
    const nodes = expandToHostNodes(
      MetadataPanel({
        document: {
          id: "doc-partitioned-1234",
          source_id: "notes-synth:local",
          stream_id: "device-maya",
          device_name: "Maya-Laptop",
          metadata: "{}",
        },
      }),
    );
    const deviceRow = nodes.find((node) => node.class.includes("meta-row-device"));
    expect(deviceRow?.text).toContain("Device");
    expect(deviceRow?.text).toContain("Maya-Laptop");
  });

  test("does not invent an origin for a shared-stream document", () => {
    const nodes = expandToHostNodes(
      MetadataPanel({
        document: {
          id: "doc-shared-12345678",
          source_id: "notes-synth:local",
          stream_id: "",
          device_name: null,
          metadata: "{}",
        },
      }),
    );
    expect(nodes.find((node) => node.class.includes("meta-row-device"))).toBeUndefined();
  });
});
