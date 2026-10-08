// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JavaScript.
import { debugNavigation } from "./debug-navigation.js";

it("keeps stable timeline and system tools available without exposing Brain", () => {
  const { groups, active } = debugNavigation(false, "calendar");
  const keys = groups.flatMap((group: { items: { key: string }[] }) =>
    group.items.map((item) => item.key),
  );
  expect(keys).toContain("calendar");
  expect(keys).toContain("doctor");
  expect(keys).toContain("graph");
  expect(keys.some((key: string) => key.startsWith("cognition/"))).toBe(false);
  expect(keys).not.toContain("watch");
  expect(active.key).toBe("cognition");
});

it("unifies library and activity while preserving routed selections", () => {
  expect(debugNavigation(true, "cognition", "knowledge").active.key).toBe("cognition");
  expect(debugNavigation(true, "cognition", "loops").active.key).toBe("cognition");
  expect(debugNavigation(true, "cognition", "maintenance").active.key).toBe("cognition");
  expect(debugNavigation(true, "cognition", "scheduled").key).toBe("cognition/runs");
  expect(debugNavigation(true, "cognition").key).toBe("cognition/runs");
  expect(debugNavigation(true, "cognition", "unknown").key).toBe("cognition/runs");
  expect(debugNavigation(true, "graph").active.key).toBe("data");
});


it("offers one Cognition area with all existing view URLs", () => {
  const { groups, active } = debugNavigation(true, "cognition", "knowledge");
  expect(groups.map((group: { label: string }) => group.label)).toEqual([
    "Cognition", "System", "Data tools",
  ]);
  expect(active.items.map((item: { key: string }) => item.key)).toEqual([
    "cognition/knowledge", "calendar",
    "cognition/runs", "cognition/maintenance", "cognition/bootstrap",
    "cognition/calibration", "cognition/notes",
  ]);
  for (const section of ["knowledge", "loops", "runs", "briefs", "maintenance", "bootstrap"])
    expect(debugNavigation(true, "cognition", section).active.key).toBe("cognition");
});

it("keeps memory deep links on the behavioral notes view", () => {
  expect(debugNavigation(true, "cognition", "memory").key).toBe("cognition/notes");
});
