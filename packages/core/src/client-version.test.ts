// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { DEVICE_KINDS } from "@omnesis/types";
import { readPackageVersion } from "./package-version.js";
import {
  MINIMUM_CLIENT_VERSIONS,
  compareProductVersions,
  parseProductVersion,
  computeClientVersionState,
  summarizeFleetVersions,
  formatFleetVersionSummary,
  type ClientVersionInput,
} from "./client-version.js";

/**
 * A gateway on 1.4.0 that speaks protocol 3 and supports clients from
 * 1.2.0 up. Every case below varies exactly one axis against this baseline
 * so the reason for a verdict is unambiguous.
 */
const baseline: ClientVersionInput = {
  gatewayVersion: "1.4.0",
  minimumVersion: "1.2.0",
  reportedVersion: "1.4.0",
  gatewayProtocolVersion: 3,
  reportedProtocolVersion: 3,
};

const state = (over: Partial<ClientVersionInput> = {}) =>
  computeClientVersionState({ ...baseline, ...over });

describe("parseProductVersion", () => {
  it("reads a plain triple", () => {
    expect(parseProductVersion("1.4.0")).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseProductVersion("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it("ignores a pre-release or build suffix", () => {
    expect(parseProductVersion("1.4.0-rc.1")).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseProductVersion("1.4.0+abc123")).toEqual({ major: 1, minor: 4, patch: 0 });
  });

  it("rejects anything that is not a triple", () => {
    for (const bad of ["", "1.4", "v1.4.0", "1.4.0.1", "next", "1.x.0", null, undefined]) {
      expect(parseProductVersion(bad)).toBeNull();
    }
  });
});

describe("compareProductVersions", () => {
  it("orders on major, then minor, then patch", () => {
    expect(compareProductVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareProductVersions("1.3.0", "1.4.0")).toBeLessThan(0);
    expect(compareProductVersions("1.4.1", "1.4.0")).toBeGreaterThan(0);
    expect(compareProductVersions("1.4.0", "1.4.0")).toBe(0);
  });

  it("treats a release candidate as its release", () => {
    expect(compareProductVersions("1.4.0-rc.2", "1.4.0")).toBe(0);
  });

  it("returns null when either side is uncomparable", () => {
    expect(compareProductVersions("nightly", "1.4.0")).toBeNull();
    expect(compareProductVersions("1.4.0", "")).toBeNull();
  });
});

describe("computeClientVersionState", () => {
  it("calls a device on the gateway's own version current", () => {
    expect(state()).toBe("current");
  });

  it("calls a device ahead of the gateway current, not a fault of its own", () => {
    expect(state({ reportedVersion: "1.5.0" })).toBe("current");
    expect(state({ reportedVersion: "2.0.0" })).toBe("current");
  });

  it("calls a device older than the gateway but above the floor behind", () => {
    expect(state({ reportedVersion: "1.3.9" })).toBe("behind");
    expect(state({ reportedVersion: "1.2.0" })).toBe("behind");
  });

  it("calls a device below the floor unsupported", () => {
    expect(state({ reportedVersion: "1.1.9" })).toBe("unsupported");
    expect(state({ reportedVersion: "0.9.0" })).toBe("unsupported");
  });

  it("calls a device that never reported a version unknown", () => {
    expect(state({ reportedVersion: null })).toBe("unknown");
    expect(state({ reportedVersion: undefined })).toBe("unknown");
    expect(state({ reportedVersion: "" })).toBe("unknown");
  });

  it("calls an unparseable reported version unknown rather than a failure", () => {
    expect(state({ reportedVersion: "nightly" })).toBe("unknown");
    expect(state({ reportedVersion: "1.4" })).toBe("unknown");
  });

  it("calls a device on an older wire protocol unsupported whatever its version says", () => {
    expect(state({ reportedProtocolVersion: 2 })).toBe("unsupported");
    // Even a version newer than the gateway's cannot rescue it: the hello
    // itself would be refused.
    expect(state({ reportedProtocolVersion: 2, reportedVersion: "9.9.9" })).toBe("unsupported");
    // And a device with no version at all reads as unsupported, not unknown.
    expect(state({ reportedProtocolVersion: 2, reportedVersion: null })).toBe("unsupported");
  });

  it("does not flag a device whose protocol is newer than the gateway's", () => {
    expect(state({ reportedProtocolVersion: 4 })).toBe("current");
  });

  it("ignores the protocol for a device that has never opened a socket", () => {
    expect(state({ reportedProtocolVersion: null, reportedVersion: "1.3.0" })).toBe("behind");
    expect(state({ reportedProtocolVersion: undefined })).toBe("current");
  });

  it("treats the floor as inclusive", () => {
    expect(state({ reportedVersion: "1.2.0", minimumVersion: "1.2.0" })).toBe("behind");
    expect(state({ reportedVersion: "1.4.0", minimumVersion: "1.4.0" })).toBe("current");
  });

  it("does not invent a fault from an unparseable gateway version", () => {
    expect(state({ gatewayVersion: "dev", reportedVersion: "1.3.0" })).toBe("current");
    // The floor still applies — it is a separate declaration.
    expect(state({ gatewayVersion: "dev", reportedVersion: "1.1.0" })).toBe("unsupported");
  });
});

describe("MINIMUM_CLIENT_VERSIONS", () => {
  it("declares a floor for every device kind", () => {
    for (const kind of DEVICE_KINDS) {
      expect(parseProductVersion(MINIMUM_CLIENT_VERSIONS[kind])).not.toBeNull();
    }
  });

  it("keeps every floor strictly below the current release", () => {
    // The floor is a policy declaration, and raising it to the release being
    // shipped would collapse `behind` into an empty band: every device that
    // has not updated yet would jump straight to `unsupported`, turning an
    // ordinary lag into a doctor failure and a portal warning across the whole
    // fleet. Nothing else in the system notices that, so it is checked here.
    const productVersion = readPackageVersion(import.meta.url);
    for (const kind of DEVICE_KINDS) {
      expect(compareProductVersions(MINIMUM_CLIENT_VERSIONS[kind], productVersion)).toBeLessThan(0);
    }
  });
});

describe("summarizeFleetVersions", () => {
  it("counts each state and the total", () => {
    expect(
      summarizeFleetVersions(["current", "current", "behind", "unsupported", "unknown"]),
    ).toEqual({ current: 2, behind: 1, unsupported: 1, unknown: 1, total: 5 });
  });

  it("handles an empty fleet", () => {
    expect(summarizeFleetVersions([])).toEqual({
      current: 0,
      behind: 0,
      unsupported: 0,
      unknown: 0,
      total: 0,
    });
  });
});

describe("formatFleetVersionSummary", () => {
  it("omits states with no devices", () => {
    expect(formatFleetVersionSummary(summarizeFleetVersions(["current", "current"]))).toBe(
      "2 current",
    );
    expect(
      formatFleetVersionSummary(summarizeFleetVersions(["current", "behind", "unknown"])),
    ).toBe("1 current, 1 behind, 1 unknown");
  });

  it("says so when there is nothing to report", () => {
    expect(formatFleetVersionSummary(summarizeFleetVersions([]))).toBe("no devices");
  });
});
