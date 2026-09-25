// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import thingsDescriptor from "@omnesis/provider-things";
import { allDescriptors } from "./source-descriptors.js";

describe("built-in multi-device production readiness", () => {
  test("does not ship a handoff provider before provider-specific failover acceptance", () => {
    expect(
      allDescriptors.filter((descriptor) => descriptor.multiDevice?.mode === "handoff"),
    ).toEqual([]);
  });

  test.each([
    ["pi", "partitioned"],
    ["browser-history", "exclusive"],
    ["chrome-bookmarks", "exclusive"],
  ] as const)("pins %s to its reviewed mode", (sourceType, expectedMode) => {
    const descriptor = allDescriptors.find((candidate) => candidate.id === sourceType);
    expect(descriptor, `${sourceType} descriptor must be registered`).toBeDefined();
    expect(descriptor?.multiDevice?.mode ?? "exclusive").toBe(expectedMode);
  });

  test("pins the platform-filtered Things descriptor to replicated", () => {
    expect(thingsDescriptor.multiDevice?.mode).toBe("replicated");
  });
});
