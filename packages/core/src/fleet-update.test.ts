// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  deviceUpdateChannel,
  localDeviceUpdateCommands,
  planDeviceUpdate,
  planDeviceCommitUpdate,
} from "./fleet-update.js";

test("commit planning commands only verified source daemons not already on the target", () => {
  const base = {
    deviceKind: "collector" as const,
    versionState: "current" as const,
    reportedVersion: "0.5.4",
    revoked: false,
  };
  const commit = "c".repeat(40);
  expect(planDeviceCommitUpdate({ ...base, sourceCommit: commit }, commit)).toEqual({
    kind: "current",
  });
  expect(planDeviceCommitUpdate({ ...base, sourceCommit: "d".repeat(40) }, commit)).toEqual({
    kind: "update",
  });
  expect(planDeviceCommitUpdate({ ...base, sourceCommit: null }, commit)).toMatchObject({
    kind: "refused",
  });
});
import type { DeviceKind } from "@omnesis/types";

const base = {
  deviceKind: "collector" as DeviceKind,
  versionState: "behind" as const,
  reportedVersion: "0.4.0",
  revoked: false,
};

describe("deviceUpdateChannel", () => {
  test("only the kinds that run a daemon beside a CLI are commandable", () => {
    expect(deviceUpdateChannel("collector")).toBe("command");
    expect(deviceUpdateChannel("agent")).toBe("command");
    for (const kind of ["ios", "android", "browser"] as const) {
      expect(deviceUpdateChannel(kind)).toBe("store");
    }
    for (const kind of ["cli", "portal"] as const) {
      expect(deviceUpdateChannel(kind)).toBe("host");
    }
  });
});

describe("planDeviceUpdate", () => {
  test("a collector behind the gateway is commanded", () => {
    expect(planDeviceUpdate(base, "0.5.0")).toEqual({ kind: "update" });
  });

  test("a collector already at or ahead of the target is left alone", () => {
    expect(planDeviceUpdate({ ...base, reportedVersion: "0.5.0" }, "0.5.0")).toEqual({
      kind: "current",
    });
    expect(planDeviceUpdate({ ...base, reportedVersion: "0.6.0" }, "0.5.0")).toEqual({
      kind: "current",
    });
  });

  test("a device that never reported a version is never commanded", () => {
    const disposition = planDeviceUpdate(
      { ...base, versionState: "unknown", reportedVersion: null },
      "0.5.0",
    );
    expect(disposition).toMatchObject({ kind: "refused", code: "version-unknown" });
    expect((disposition as { reason: string }).reason).toContain("omnesis update");
  });

  test("a device below the supported floor is never commanded", () => {
    const disposition = planDeviceUpdate(
      { ...base, versionState: "unsupported", reportedVersion: "0.1.0" },
      "0.5.0",
    );
    expect(disposition).toMatchObject({ kind: "refused", code: "version-unsupported" });
  });

  test("phones and the extension are told to update the app, whatever their state", () => {
    for (const deviceKind of ["ios", "android", "browser"] as const) {
      // Even below the floor: the refusal an operator can act on is the store
      // one, not the version one.
      expect(
        planDeviceUpdate({ ...base, deviceKind, versionState: "unsupported" }, "0.5.0"),
      ).toMatchObject({ kind: "refused", code: "store-managed" });
    }
  });

  test("a CLI or portal device names the host command instead", () => {
    expect(planDeviceUpdate({ ...base, deviceKind: "cli" }, "0.5.0")).toMatchObject({
      kind: "refused",
      code: "host-managed",
    });
    const portal = planDeviceUpdate({ ...base, deviceKind: "portal" }, "0.5.0");
    expect(portal).toMatchObject({ kind: "refused", code: "host-managed" });
    expect((portal as { reason: string }).reason).toContain("served by the gateway");
  });

  test("a build that answered it cannot take the command is not offered again", () => {
    const collector = planDeviceUpdate({ ...base, updateState: "unsupported" }, "0.5.0");
    expect(collector).toMatchObject({ kind: "refused", code: "command-unsupported" });
    expect((collector as { reason: string }).reason).toContain("cannot be updated remotely");
    expect((collector as { reason: string }).reason).toContain("`omnesis update`");
    expect((collector as { reason: string }).reason).not.toContain("--refresh");

    const agent = planDeviceUpdate(
      { ...base, deviceKind: "agent", updateState: "unsupported", harness: "openclaw" },
      "0.5.0",
    );
    expect((agent as { reason: string }).reason).toContain(
      "`omnesis update`, then `omnesis connect openclaw --refresh`, then `openclaw gateway restart`",
    );
  });

  test("an unsupported record on a device already at the target still reads as current", () => {
    expect(
      planDeviceUpdate({ ...base, reportedVersion: "0.5.0", updateState: "unsupported" }, "0.5.0"),
    ).toEqual({ kind: "current" });
  });

  test("a failed update is still offered again", () => {
    expect(planDeviceUpdate({ ...base, updateState: "failed" }, "0.5.0")).toEqual({
      kind: "update",
    });
  });

  test("a revoked device outranks every other verdict", () => {
    expect(planDeviceUpdate({ ...base, revoked: true }, "0.5.0")).toMatchObject({
      kind: "refused",
      code: "revoked",
    });
  });

  test("an unparseable target reads as current rather than commanding a fleet", () => {
    // The gateway's own metadata is the only way to reach this: a device
    // reading is already `unknown` when it cannot be parsed.
    expect(planDeviceUpdate(base, "not-a-version")).toEqual({ kind: "current" });
  });
});

describe("localDeviceUpdateCommands", () => {
  test("a collector updates itself; a harness also refreshes and restarts its plugin", () => {
    expect(localDeviceUpdateCommands(null)).toEqual(["omnesis update"]);
    expect(localDeviceUpdateCommands("hermes")).toEqual([
      "omnesis update",
      "omnesis connect hermes --refresh",
      "hermes gateway restart",
    ]);
  });
});
