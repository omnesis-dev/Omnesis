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
  expect(keys.some((key: string) => key.startsWith("brain/"))).toBe(false);
  expect(keys).not.toContain("watch");
  expect(active.key).toBe("brain");
});

it("unifies library and activity while preserving routed selections", () => {
  expect(debugNavigation(true, "brain", "knowledge").active.key).toBe("brain");
  expect(debugNavigation(true, "brain", "loops").active.key).toBe("brain");
  expect(debugNavigation(true, "brain", "maintenance").active.key).toBe("brain");
  expect(debugNavigation(true, "brain", "scheduled").key).toBe("brain/runs");
  expect(debugNavigation(true, "brain").key).toBe("brain/runs");
  expect(debugNavigation(true, "brain", "unknown").key).toBe("brain/runs");
  expect(debugNavigation(true, "graph").active.key).toBe("data");
});


it("offers one Cognition area with all existing view URLs", () => {
  const { groups, active } = debugNavigation(true, "brain", "knowledge");
  expect(groups.map((group: { label: string }) => group.label)).toEqual([
    "Brain", "System", "Data tools",
  ]);
  expect(active.items.map((item: { key: string }) => item.key)).toEqual([
    "brain/knowledge", "calendar",
    "brain/runs", "brain/observations", "brain/interest", "brain/maintenance",
    "brain/bootstrap", "brain/calibration", "brain/notes",
  ]);
  for (const section of ["knowledge", "loops", "runs", "observations", "interest", "maintenance", "bootstrap"])
    expect(debugNavigation(true, "brain", section).active.key).toBe("brain");
});

it("keeps memory deep links on the behavioral notes view", () => {
  expect(debugNavigation(true, "brain", "memory").key).toBe("brain/notes");
});

it("gates Brain and Watch independently from experimental mode", () => {
  const keys = (lab: { brain: boolean; watches: boolean }) => debugNavigation(true, "data", null, lab).groups.flatMap((group: { items: { key: string }[] }) => group.items.map((item) => item.key));
  expect(keys({ brain: false, watches: true })).toContain("watch");
  expect(keys({ brain: false, watches: true })).not.toContain("brain/runs");
  expect(keys({ brain: true, watches: false })).toContain("brain/runs");
  expect(keys({ brain: true, watches: false })).not.toContain("watch");
});
