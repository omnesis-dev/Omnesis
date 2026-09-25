// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { matchDevice } from "./device-picker.js";

const devices = [
  { id: "dev-laptop", name: "Maya-Laptop", revokedAt: null },
  { id: "dev-mini", name: "Studio-Mini" },
  { id: "dev-old", name: "Retired-Box", revokedAt: 1_700_000_000_000 },
];

describe("matchDevice", () => {
  test("matches by exact id or exact name, ignoring surrounding whitespace", () => {
    expect(matchDevice(devices, "dev-mini")).toEqual({ device: devices[1] });
    expect(matchDevice(devices, " Maya-Laptop ")).toEqual({ device: devices[0] });
  });

  test("a revoked device is neither matched nor listed", () => {
    const byId = matchDevice(devices, "dev-old");
    expect("error" in byId && byId.error).toContain('"dev-old"');
    const byName = matchDevice(devices, "Retired-Box");
    expect("error" in byName && byName.error).toContain("paired devices: Maya-Laptop, Studio-Mini");
  });

  test("a miss lists the paired devices, or (none) when there are none", () => {
    const miss = matchDevice(devices, "Nowhere-Box");
    expect("error" in miss && miss.error).toContain('No device named or ided "Nowhere-Box"');
    expect("error" in miss && miss.error).toContain("paired devices: Maya-Laptop, Studio-Mini");
    const none = matchDevice([], "anything");
    expect("error" in none && none.error).toContain("(none)");
  });

  test("an empty flag is refused", () => {
    expect(matchDevice(devices, "   ")).toEqual({ error: "--device cannot be empty" });
  });

  test("more than one match is refused rather than picked silently", () => {
    const twins = [...devices, { id: "dev-twin", name: "Studio-Mini" }];
    const res = matchDevice(twins, "Studio-Mini");
    expect("error" in res && res.error).toContain('Multiple devices match "Studio-Mini"');
    expect("error" in res && res.error).toContain("pass the device id");
    // The id still resolves one of them.
    expect(matchDevice(twins, "dev-twin")).toEqual({ device: twins[3] });
  });
});
