// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { eventSourceId, isDuplicateLikeLinkType } from "./timeline.js";

// `eventSourceId` is the source-agnostic resolver that tells the timeline
// renderer which source to icon/colour a row by — `doc.sourceId` for a
// document (or deduped doc+record) event, `record.sourceId` for a
// record-only event (#757). It never branches on a specific source; the
// registry helpers do the per-source lookup downstream.
describe("eventSourceId", () => {
  test("a document event resolves its doc.sourceId", () => {
    expect(eventSourceId({ doc: { sourceId: "gmail:self" } })).toBe("gmail:self");
  });

  test("a record-only event resolves its record.sourceId", () => {
    expect(eventSourceId({ record: { sourceId: "demo-fitness:self" } })).toBe(
      "demo-fitness:self",
    );
  });

  test("a deduped doc+record event prefers the doc.sourceId", () => {
    expect(
      eventSourceId({
        doc: { sourceId: "gmail:self" },
        record: { sourceId: "demo-fitness:self" },
      }),
    ).toBe("gmail:self");
  });

  test("returns null when neither is present (no crash on a malformed event)", () => {
    expect(eventSourceId({})).toBeNull();
    expect(eventSourceId(undefined as unknown as object)).toBeNull();
  });
});

describe("isDuplicateLikeLinkType", () => {
  test("treats alternate URL representations as duplicate-like", () => {
    expect(isDuplicateLikeLinkType("same-resource")).toBe(true);
    expect(isDuplicateLikeLinkType("url")).toBe(false);
  });
});
