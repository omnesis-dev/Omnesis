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
  expect(active.key).toBe("knowledge");
});

it("separates readable knowledge from maintenance while preserving routed selections", () => {
  expect(debugNavigation(true, "cognition", "knowledge").active.key).toBe("knowledge");
  expect(debugNavigation(true, "cognition", "loops").active.key).toBe("knowledge");
  expect(debugNavigation(true, "cognition", "maintenance").active.key).toBe("brain");
  expect(debugNavigation(true, "cognition", "scheduled").key).toBe("cognition/runs");
  expect(debugNavigation(true, "cognition").key).toBe("cognition/overview");
  expect(debugNavigation(true, "cognition", "unknown").key).toBe("cognition/overview");
  expect(debugNavigation(true, "graph").active.key).toBe("data");
});
