// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JavaScript.
import { libraryStateLabel, libraryStatusOptions, RetirementMetadata } from "./knowledge-canonical-library.js";
it("uses canonical owner states rather than synthesis validity", () => {
  expect(libraryStateLabel({ kind: "loop", validity: "stale", canonicalFields: { state: "open" } })).toBe("Open");
  expect(libraryStateLabel({ kind: "brief", canonicalFields: { state: "dismissed_snoozed" } })).toBe("Snoozed");
  expect(libraryStateLabel({ libraryType: "retired-loop", canonicalFields: { state: "deleted" } })).toBe("Retired · Deleted");
});
it("offers retirement filters alongside active outcomes and all prior brief state buckets", () => {
  expect(libraryStatusOptions("loop").map(([value]: string[]) => value)).toEqual(["all", "active", "resolved", "retired", "open", "snoozed", "done", "dismissed", "decayed", "deleted"]);
  expect(libraryStatusOptions("brief").map(([value]: string[]) => value)).toEqual(["all", "unread", "read", "snoozed", "dismissed"]);
  expect(libraryStatusOptions("wiki")).toEqual([]);
});
it("retains recurrence count and cadence on the existing owner card", () => {
  const node = RetirementMetadata({ node: { canonicalFields: { recurrenceCount: 3, cadenceDays: 14 } } });
  expect(JSON.stringify(node.props.children)).toContain("3");
  expect(JSON.stringify(node.props.children)).toContain("14 day cadence");
  expect(RetirementMetadata({ node: { canonicalFields: {} } })).toBeNull();
});
