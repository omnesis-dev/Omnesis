// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { manageNotesHref, notesDayForDocument } from "./notes.js";

describe("notesDayForDocument", () => {
  test("prefers the external id when it is a day", () => {
    expect(notesDayForDocument({ external_id: "2026-03-01" })).toBe("2026-03-01");
    expect(notesDayForDocument({ externalId: "2026-03-01" })).toBe("2026-03-01");
  });

  test("falls back to the creation date", () => {
    expect(notesDayForDocument({ source_created_at: "2026-03-01T10:00:00Z" })).toBe(
      "2026-03-01",
    );
    expect(notesDayForDocument({ sourceCreatedAt: "2026-03-01T10:00:00Z" })).toBe(
      "2026-03-01",
    );
  });

  test("returns null when nothing is day-shaped", () => {
    expect(notesDayForDocument({ external_id: "run-001" })).toBe(null);
    expect(notesDayForDocument({})).toBe(null);
    expect(notesDayForDocument(null)).toBe(null);
  });

  test("a regex-shaped but impossible day still seeds (the server serves it empty)", () => {
    // Validation stays shape-level on purpose: the history endpoint
    // answers an empty day with "no notes", so the link degrades
    // gracefully instead of needing calendar logic in every client.
    expect(notesDayForDocument({ external_id: "2026-99-99" })).toBe("2026-99-99");
  });
});

describe("manageNotesHref", () => {
  test("seeds the history at the day", () => {
    expect(manageNotesHref("2026-03-01")).toBe("/portal/capture?day=2026-03-01");
  });

  test("opens the latest notes without a day", () => {
    expect(manageNotesHref(null)).toBe("/portal/capture");
  });
});
