// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fleetDoctorOk,
  renderFleetDoctor,
  resolveDeviceSelector,
  runFleetDoctor,
  type FleetDoctorDeps,
  type FleetDoctorEntry,
} from "./doctor-fleet.js";
import type { DoctorReport } from "@omnesis/core/doctor";

const cleanReport: DoctorReport = {
  ok: true,
  summary: { errors: 0, warnings: 0 },
  checks: [{ id: "auth.token", section: "Auth", status: "pass", message: "Token is valid" }],
};

const failedReport: DoctorReport = {
  ok: false,
  summary: { errors: 1, warnings: 0 },
  checks: [
    {
      id: "security.permissions",
      section: "Security",
      status: "fail",
      message: "1 Omnesis config entry is not owner-only: token (644, expected 600)",
      hint: "Run `omnesis doctor --fix-permissions` on studio-mini to repair safe local modes.",
    },
  ],
};

function entry(overrides: Partial<FleetDoctorEntry>): FleetDoctorEntry {
  return {
    deviceId: "dev-1",
    name: "studio-mini",
    kind: "collector",
    online: true,
    state: "pending",
    detail: null,
    report: null,
    ...overrides,
  };
}

/** A gateway whose entries move through the given states, one per poll. */
function fakeDeps(sequence: FleetDoctorEntry[][]): FleetDoctorDeps & { polls: number } {
  let clock = 0;
  const deps = {
    polls: 0,
    listDevices: async () => [
      { id: "dev-1", name: "studio-mini" },
      { id: "dev-2", name: "Studio-Mini" },
      { id: "dev-3", name: "laptop" },
    ],
    request: async () => sequence[0]!,
    list: async () => {
      deps.polls += 1;
      return sequence[Math.min(deps.polls, sequence.length - 1)]!;
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return deps;
}

describe("resolveDeviceSelector", () => {
  const devices = [
    { id: "dev-1", name: "studio-mini" },
    { id: "dev-2", name: "laptop" },
    { id: "dev-3", name: "Laptop" },
  ];

  test("an exact id wins, then an exact name, case-insensitively", () => {
    expect(resolveDeviceSelector(devices, "dev-2")).toBe("dev-2");
    expect(resolveDeviceSelector(devices, "STUDIO-MINI")).toBe("dev-1");
  });

  test("a name two devices share must be disambiguated by id", () => {
    expect(() => resolveDeviceSelector(devices, "laptop")).toThrow(/pick one by id: dev-2, dev-3/u);
  });

  test("an unknown name points at the device list", () => {
    expect(() => resolveDeviceSelector(devices, "phone")).toThrow(/omnesis devices list/u);
  });
});

describe("runFleetDoctor", () => {
  test("waits until every requested device has settled, then returns their entries", async () => {
    const deps = fakeDeps([
      [entry({ state: "pending" }), entry({ deviceId: "dev-3", name: "laptop", state: "pending" })],
      [entry({ state: "running" }), entry({ deviceId: "dev-3", name: "laptop", state: "running" })],
      [
        entry({ state: "complete", report: cleanReport }),
        entry({ deviceId: "dev-3", name: "laptop", state: "failed", detail: "timed out" }),
      ],
    ]);
    const entries = await runFleetDoctor(deps, ["dev-1", "dev-3"]);
    expect(entries.map((e) => e.state)).toEqual(["complete", "failed"]);
    expect(deps.polls).toBe(2);
    expect(fleetDoctorOk(entries)).toBe(false);
  });

  test("only the selected device is waited on, even when the gateway lists others", async () => {
    const deps = fakeDeps([
      [entry({ state: "pending" }), entry({ deviceId: "dev-3", name: "laptop", state: "pending" })],
      [
        entry({ state: "complete", report: cleanReport }),
        entry({ deviceId: "dev-3", state: "running" }),
      ],
    ]);
    const entries = await runFleetDoctor(deps, ["dev-1"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ deviceId: "dev-1", state: "complete" });
    expect(fleetDoctorOk(entries)).toBe(true);
  });

  test("a phone settles at once as not applicable", async () => {
    const deps = fakeDeps([
      [
        entry({
          deviceId: "dev-9",
          name: "phone",
          kind: "ios",
          state: "not-applicable",
          detail: "phones audit themselves",
        }),
      ],
    ]);
    const entries = await runFleetDoctor(deps);
    expect(entries[0]?.state).toBe("not-applicable");
    expect(deps.polls).toBe(0);
    expect(fleetDoctorOk(entries)).toBe(true);
  });

  test("gives up after the deadline and reports the unsettled state rather than hanging", async () => {
    const deps = fakeDeps([[entry({ state: "pending", online: false })]]);
    const entries = await runFleetDoctor(deps, ["dev-1"], 4_000);
    expect(entries[0]?.state).toBe("pending");
    expect(deps.polls).toBeGreaterThan(0);
    expect(fleetDoctorOk(entries)).toBe(false);
  });
});

describe("renderFleetDoctor", () => {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  afterEach(() => {
    lines.length = 0;
  });

  test("prints each device's report with the host named in its remedies", () => {
    renderFleetDoctor([
      entry({ state: "complete", report: failedReport }),
      entry({ deviceId: "dev-3", name: "laptop", online: false, state: "pending" }),
      entry({
        deviceId: "dev-9",
        name: "phone",
        kind: "ios",
        state: "not-applicable",
        detail: "phones audit themselves",
      }),
    ]);
    const text = lines.join("\n");
    expect(text).toContain("studio-mini");
    expect(text).toContain("not owner-only");
    expect(text).toContain("--fix-permissions` on studio-mini");
    expect(text).toContain("the collector is offline; it runs the check when it reconnects");
    expect(text).toContain("N/A — phones audit themselves");
    log.mockRestore();
  });
});
