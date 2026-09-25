// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { releaseUpdateFromStatus } from "./release-update.js";

const AVAILABLE = {
  release: {
    currentVersion: "1.9.0",
    latestVersion: "1.10.0",
    installMethod: "source",
    checkedAt: "2026-09-07T12:00:00.000Z",
    updateAvailable: true,
  },
};

describe("releaseUpdateFromStatus", () => {
  test("returns the versions for a valid newer stable release", () => {
    expect(releaseUpdateFromStatus(AVAILABLE)).toEqual({
      currentVersion: "1.9.0",
      latestVersion: "1.10.0",
    });
  });

  test("returns null when the check is absent or no update is available", () => {
    expect(releaseUpdateFromStatus({ release: null })).toBeNull();
    expect(
      releaseUpdateFromStatus({
        release: { ...AVAILABLE.release, latestVersion: "1.9.0", updateAvailable: false },
      }),
    ).toBeNull();
  });

  test.each([
    { ...AVAILABLE.release, currentVersion: "1.09.0" },
    { ...AVAILABLE.release, latestVersion: "1.10.0-beta.1" },
    { ...AVAILABLE.release, installMethod: "unknown" },
    { ...AVAILABLE.release, checkedAt: "not-a-date" },
    { ...AVAILABLE.release, updateAvailable: false },
    { ...AVAILABLE.release, currentVersion: "2.0.0", latestVersion: "1.10.0" },
  ])("rejects malformed or inconsistent snapshots", (release) => {
    expect(releaseUpdateFromStatus({ release })).toBeNull();
  });
});
