// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { formatFleetVersionSummary } from "@omnesis/core";
import { describe, expect, test } from "vitest";
import { statusFleetVersions } from "./status.js";

describe("statusFleetVersions", () => {
  test("a fresh install's own CLI token does not read as an unknown device", () => {
    const summary = statusFleetVersions([
      { kind: "collector", versionState: "current" },
      // The installer's bootstrap device: plain requests, no version.
      { kind: "cli", versionState: "unknown" },
    ]);
    expect(formatFleetVersionSummary(summary)).toBe("1 current");
  });

  test("a CLI that reported a build, and any other silent device, still count", () => {
    const summary = statusFleetVersions([
      { kind: "cli", versionState: "behind" },
      { kind: "collector" },
      { kind: "ios", versionState: "unsupported", revokedAt: 1 },
    ]);
    expect(formatFleetVersionSummary(summary)).toBe("1 behind, 1 unknown");
  });
});
