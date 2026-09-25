// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal is plain JS without sibling declarations.
import { hasMobileSource, shouldShowMobilePromos } from "./mobile-promo.js";

describe("hasMobileSource", () => {
  test("honors explicit type and opaque colon-bearing accounts", () => {
    expect(hasMobileSource([{ id: "photos:fixture:member" }])).toBe(true);
    expect(hasMobileSource([{ id: "opaque", type: "photos" }])).toBe(true);
    expect(hasMobileSource([{ id: "photos:fixture", type: "gmail" }])).toBe(false);
    expect(hasMobileSource([{ id: ":photos" }])).toBe(false);
  });
  test("matches the iOS source type and scoped ids", () => {
    expect(hasMobileSource([{ id: "apple-health:local", type: "apple-health" }])).toBe(true);
    expect(hasMobileSource([{ id: "apple-health:local" }])).toBe(true);
  });

  test("matches every other iOS-pushed source type", () => {
    for (const type of ["core-location-visits", "activity-segments", "photos"]) {
      expect(hasMobileSource([{ id: `${type}:local`, type }])).toBe(true);
    }
  });

  test("matches every Android-pushed source type", () => {
    for (const type of [
      "health-connect",
      "photos",
      "android-app-usage",
      "android-call-log",
      "android-activity-segments",
    ]) {
      expect(hasMobileSource([{ id: `${type}:device`, type }])).toBe(true);
    }
  });

  test("is false when no mobile source is present", () => {
    expect(hasMobileSource([{ id: "gmail", type: "gmail" }, { id: "web", type: "web" }])).toBe(false);
    expect(hasMobileSource([])).toBe(false);
  });

  test("tolerates malformed input", () => {
    expect(hasMobileSource(null)).toBe(false);
    expect(hasMobileSource(undefined)).toBe(false);
    expect(hasMobileSource({ id: "apple-health" })).toBe(false);
    expect(hasMobileSource([{ id: null }, {}, { id: 42 }])).toBe(false);
  });
});

describe("shouldShowMobilePromos", () => {
  test("shows when no mobile source exists", () => {
    expect(shouldShowMobilePromos({ sources: [{ id: "gmail", type: "gmail" }] })).toBe(true);
  });

  test("hides once an iOS source exists", () => {
    expect(
      shouldShowMobilePromos({ sources: [{ id: "apple-health:local", type: "apple-health" }] }),
    ).toBe(false);
  });

  test("hides once an Android source exists", () => {
    expect(
      shouldShowMobilePromos({ sources: [{ id: "health-connect:phone", type: "health-connect" }] }),
    ).toBe(false);
  });
});
