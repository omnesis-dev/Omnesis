// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { agentIntegrationVersion, describeVersionDrift } from "./version.js";

describe("plugin and gateway version drift", () => {
  test("says nothing when the two agree", () => {
    expect(describeVersionDrift("0.4.0", "0.4.0", "openclaw")).toEqual({ drift: "aligned" });
  });

  test("names the update and the refresh when the plugin is older", () => {
    const report = describeVersionDrift("0.3.9", "0.4.0", "openclaw");
    expect(report.drift).toBe("plugin-behind");
    expect(report.warning).toContain("omnesis connect openclaw --refresh");
    expect(report.warning).toContain("0.3.9");
    expect(report.warning).toContain("0.4.0");
  });

  test("points at the gateway when the plugin is newer", () => {
    const report = describeVersionDrift("0.5.0", "0.4.0", "hermes");
    expect(report.drift).toBe("plugin-ahead");
    expect(report.warning).toContain("Upgrade the gateway first");
  });

  test("orders by component, not by string", () => {
    expect(describeVersionDrift("0.10.0", "0.9.0", "openclaw").drift).toBe("plugin-ahead");
    expect(describeVersionDrift("1.0.0", "0.99.99", "openclaw").drift).toBe("plugin-ahead");
    expect(describeVersionDrift("0.4.2", "0.4.10", "openclaw").drift).toBe("plugin-behind");
  });

  test("ignores prerelease and build metadata, which never mean drift on their own", () => {
    expect(describeVersionDrift("0.4.0-rc.1", "0.4.0", "openclaw").drift).toBe("aligned");
    expect(describeVersionDrift("0.4.0+build7", "0.4.0", "openclaw").drift).toBe("aligned");
  });

  test("stays quiet about a version it cannot read", () => {
    // A development build is far more likely than a real mismatch, and a
    // warning nobody can act on is noise.
    for (const pair of [
      ["dev", "0.4.0"],
      ["0.4.0", undefined],
      [undefined, "0.4.0"],
      ["0.4", "0.4.0"],
    ] as const) {
      expect(describeVersionDrift(pair[0], pair[1], "openclaw")).toEqual({ drift: "unknown" });
    }
  });

  test("reports the version of the package it was loaded from", () => {
    expect(agentIntegrationVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
