// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { groupRemediationsByDevice } from "./remediation-grouping.js";

const FDA = {
  summary: "Disk access is required",
  steps: ["Open the pane.", "Add the executable."],
  executable: "/opt/example/bin/node",
  restartRequired: true,
};

interface MemberStatus {
  deviceId: string;
  state: string;
  remediation?: typeof FDA;
}

interface Group {
  deviceId: string;
  remediation: typeof FDA;
}

function source(opts: {
  id: string;
  deviceId?: string;
  deviceName?: string;
  state: string;
  remediation?: typeof FDA;
  members?: MemberStatus[];
}) {
  return {
    id: opts.id,
    deviceId: opts.deviceId ?? "dev-a",
    deviceName: opts.deviceName ?? "Maya-Laptop",
    syncStatus: {
      state: opts.state,
      deviceId: opts.deviceId ?? "dev-a",
      remediation: opts.remediation,
      ...(opts.members ? { members: opts.members } : {}),
    },
  };
}

describe("groupRemediationsByDevice", () => {
  test("sources on one device sharing a remedy form one group naming the device", () => {
    const groups = groupRemediationsByDevice([
      source({ id: "apple-notes:local", state: "error", remediation: FDA }),
      source({ id: "apple-imessage:local", state: "error", remediation: FDA }),
      source({ id: "gmail:you@example.com", state: "synced" }),
    ]);
    expect(groups).toEqual([
      {
        deviceId: "dev-a",
        deviceName: "Maya-Laptop",
        memberScoped: false,
        remediation: FDA,
        affectedSourceIds: ["apple-imessage:local", "apple-notes:local"],
      },
    ]);
  });

  test("an error without a structured remedy is not a group", () => {
    expect(groupRemediationsByDevice([source({ id: "web:default", state: "error" })])).toEqual([]);
  });

  test("a remedy on a source that is no longer in error is not a group", () => {
    expect(
      groupRemediationsByDevice([
        source({ id: "apple-notes:local", state: "synced", remediation: FDA }),
      ]),
    ).toEqual([]);
  });

  test("different executables on different devices are different procedures", () => {
    const other = { ...FDA, executable: "/usr/local/bin/node" };
    const groups: Group[] = groupRemediationsByDevice([
      source({ id: "apple-notes:local", deviceId: "dev-a", state: "error", remediation: FDA }),
      source({
        id: "apple-calendar:local",
        deviceId: "dev-b",
        deviceName: "Jamie-Desk",
        state: "error",
        remediation: other,
      }),
    ]);
    expect(groups.map((g) => [g.deviceId, g.remediation.executable])).toEqual([
      ["dev-a", "/opt/example/bin/node"],
      ["dev-b", "/usr/local/bin/node"],
    ]);
  });

  test("on a multi-device source only the member that hit the failure is named", () => {
    const groups = groupRemediationsByDevice([
      source({
        id: "apple-health:local",
        deviceId: "dev-a",
        state: "error",
        members: [
          { deviceId: "dev-a", state: "synced" },
          { deviceId: "dev-b", state: "error", remediation: FDA },
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      deviceId: "dev-b",
      deviceName: null,
      memberScoped: true,
      affectedSourceIds: ["apple-health:local"],
    });
  });

  test("a non-array input yields no groups", () => {
    expect(groupRemediationsByDevice(undefined)).toEqual([]);
  });
});
