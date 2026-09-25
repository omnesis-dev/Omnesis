// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { syncPage } from "./source.js";
import { SnapshotEnumeration } from "./snapshot.js";

describe("syncPage watermark", () => {
  it("preserves an assessed warning, explicit recovery, and an unassessed page distinctly", () => {
    const snapshot = new SnapshotEnumeration(["fixture"]);
    snapshot.gap("fixture", "temporarily unavailable");
    const issue = snapshot.withheldIssue()!;
    expect(syncPage([], {}, { issues: [issue] }).issues).toEqual([issue]);
    expect(syncPage([], {}, { issues: [] }).issues).toEqual([]);
    expect(syncPage([], {}).issues).toBeUndefined();
  });
  it("preserves a source coverage claim on a terminal result", () => {
    const watermark = {
      guarantee: "snapshot" as const,
      semanticTimeThrough: "2026-08-01T12:00:00.000Z",
      observedAt: "2026-08-01T12:01:00.000Z",
    };

    expect(syncPage([], { cursor: "next" }, { watermark })).toMatchObject({
      hasMore: false,
      watermark,
    });
  });
});
