// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayJson: vi.fn(),
    withSpinner: (_label: string, operation: () => unknown) => operation(),
  };
});

import { gatewayJson } from "../utils.js";
import {
  attentionPhrase,
  describeMemberState,
  membersCommand,
  renderMembers,
  requireMemberDevice,
  statusByMember,
  type AdminDeviceEntry,
  type AdminSourceEntry,
  type MemberSyncStatus,
} from "./members.js";

const devices: AdminDeviceEntry[] = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: false },
  { id: "dev-phone", name: "Maya-Phone", kind: "ios", online: true },
];

const source: AdminSourceEntry = {
  id: "notes-synth:local",
  type: "notes-synth",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop", "dev-mini"],
  multiDeviceMode: "handoff",
  leaseHolder: "dev-laptop",
  pushBased: false,
};

const NOW = Date.parse("2030-01-01T12:00:00.000Z");

function run(args: Record<string, unknown>): Promise<void> {
  return (membersCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run(
    { args },
  );
}

describe("requireMemberDevice", () => {
  const usage = "Usage: omnesis sources join <id> --device <name|id>";

  test("resolves the flag by id or by name", () => {
    expect(requireMemberDevice(devices, "dev-mini", usage)).toBe(devices[1]);
    expect(requireMemberDevice(devices, "Maya-Phone", usage)).toBe(devices[2]);
  });

  test("a missing flag fails with the usage line; a miss with the device names", () => {
    expect(() => requireMemberDevice(devices, undefined, usage)).toThrow(
      expect.objectContaining({ exitCode: 2, message: expect.stringContaining(usage) }),
    );
    expect(() => requireMemberDevice(devices, "Nowhere-Box", usage)).toThrow(
      expect.objectContaining({
        exitCode: 2,
        message: expect.stringContaining("Maya-Laptop, Studio-Mini, Maya-Phone"),
      }),
    );
  });
});

describe("statusByMember", () => {
  test("a per-member breakdown is keyed by device", () => {
    const status: MemberSyncStatus = {
      sourceId: source.id,
      state: "synced",
      members: [
        { sourceId: source.id, deviceId: "dev-mini", state: "error", errorMessage: "boom" },
        { sourceId: source.id, deviceId: "dev-laptop", state: "synced" },
      ],
    };
    const byMember = statusByMember(source, status);
    expect(byMember.get("dev-laptop")?.state).toBe("synced");
    expect(byMember.get("dev-mini")?.state).toBe("error");
  });

  test("a single row goes to the device it names, else to the owner", () => {
    const named = statusByMember(source, {
      sourceId: source.id,
      deviceId: "dev-mini",
      state: "syncing",
    });
    expect(named.get("dev-mini")?.state).toBe("syncing");
    expect(named.get("dev-laptop")).toBeUndefined();

    const unnamed = statusByMember(source, { sourceId: source.id, state: "synced" });
    expect(unnamed.get("dev-laptop")?.state).toBe("synced");
    expect(unnamed.get("dev-mini")).toBeUndefined();
  });

  test("no status at all leaves every member without a row", () => {
    const byMember = statusByMember(source, undefined);
    expect([...byMember.values()]).toEqual([undefined, undefined]);
  });
});

describe("attentionPhrase", () => {
  const base = { sourceId: source.id };

  test("names the trouble for a source the operator has to act on", () => {
    expect(attentionPhrase({ ...base, state: "error", errorMessage: "cannot open store" })).toBe(
      "error: cannot open store",
    );
    expect(attentionPhrase({ ...base, state: "needs-auth" })).toBe("needs sign-in");
  });

  test("a member's error that names its remedy reads as the remedy", () => {
    expect(
      describeMemberState(
        {
          ...base,
          state: "error",
          errorMessage: "Cannot open the database.",
          remediation: {
            summary: "Disk access is required",
            steps: ["Grant it."],
            restartRequired: true,
          },
        },
        { online: true, standby: false },
      ),
    ).toBe("needs access: Disk access is required");
  });

  test("an error that names its remedy is described by the remedy, not the message", () => {
    expect(
      attentionPhrase({
        ...base,
        state: "error",
        errorMessage: "Cannot open the database — disk access is required.",
        remediation: {
          summary: "Disk access is required",
          steps: ["Open the pane."],
          restartRequired: true,
        },
      }),
    ).toBe("needs access: Disk access is required");
  });

  test("speaks up for every state that needs the operator, not just the two loudest", () => {
    // None of these clears on its own, and each has a different remedy: a
    // consent to renew, a program to restart, a permission to grant, data the
    // device cannot reach.
    for (const state of [
      "auth-expiring",
      "permission-degraded",
      "background-access-missing",
      "unavailable",
      "stale",
    ] as const) {
      expect(attentionPhrase({ ...base, state }), state).toBeDefined();
    }
  });

  test("stays quiet for every state the source recovers from on its own", () => {
    expect(attentionPhrase(undefined)).toBeUndefined();
    expect(attentionPhrase({ ...base, state: "idle" })).toBeUndefined();
    expect(attentionPhrase({ ...base, state: "syncing" })).toBeUndefined();
    expect(attentionPhrase({ ...base, state: "synced" })).toBeUndefined();
    expect(attentionPhrase({ ...base, state: "rate-limited" })).toBeUndefined();
  });
});

describe("describeMemberState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = { sourceId: source.id };
  const present = { online: true, standby: false };

  test("uses the portal's words for what the device is doing now", () => {
    expect(describeMemberState({ ...base, state: "syncing" }, present)).toBe("syncing now");
    expect(describeMemberState({ ...base, state: "needs-auth" }, present)).toBe("needs sign-in");
    expect(describeMemberState({ ...base, state: "error", errorMessage: "quota" }, present)).toBe(
      "error: quota",
    );
    expect(describeMemberState({ ...base, state: "error" }, present)).toBe("error: unknown");
  });

  test("a replica holding items another device deleted says so before its sync time", () => {
    const lastSyncAt = new Date(NOW - 5 * 60_000).toISOString();
    expect(
      describeMemberState({ ...base, state: "synced", lastSyncAt, restoredClaims: 1 }, present),
    ).toBe("keeping 1 item another device no longer has");
    expect(
      describeMemberState({ ...base, state: "synced", lastSyncAt, restoredClaims: 3 }, present),
    ).toBe("keeping 3 items another device no longer has");
  });

  test("a replica dispute reads the gateway's notice, which names the deleting device", () => {
    expect(
      describeMemberState(
        {
          ...base,
          state: "synced",
          restoredClaims: 2,
          notices: [
            {
              kind: "replica-dispute",
              severity: "info",
              title: "Keeping 2 notes that studio-desk no longer has",
            },
          ],
        },
        present,
      ),
    ).toBe("keeping 2 notes that studio-desk no longer has");
  });

  test("a last sync is dated even when the device is now offline or on standby", () => {
    const lastSyncAt = new Date(NOW - 5 * 60_000).toISOString();
    expect(describeMemberState({ ...base, state: "synced", lastSyncAt }, present)).toBe(
      "synced 5m ago",
    );
    expect(
      describeMemberState({ ...base, state: "idle", lastSyncAt }, { online: false, standby: true }),
    ).toBe("synced 5m ago");
    expect(describeMemberState({ ...base, state: "synced" }, present)).toBe("synced");
  });

  test("with nothing else to say: offline, then standby, then idle", () => {
    expect(describeMemberState(undefined, { online: false, standby: true })).toBe("offline");
    expect(describeMemberState({ ...base, state: "idle" }, { online: false, standby: false })).toBe(
      "offline",
    );
    expect(describeMemberState(undefined, { online: true, standby: true })).toBe("standby");
    expect(describeMemberState(undefined, present)).toBe("idle");
    expect(describeMemberState({ ...base, state: "idle" }, present)).toBe("idle");
  });

  test("a state the portal has no word for reads idle, as the portal shows it", () => {
    expect(describeMemberState({ ...base, state: "rate-limited" }, present)).toBe("idle");
  });
});

describe("renderMembers", () => {
  test("a replicated source with deletions in dispute says so in its heading", () => {
    const lines = renderMembers(
      { ...source, multiDeviceMode: "replicated", disputedDeletions: 2 },
      devices,
      {
        sourceId: source.id,
        state: "synced",
        members: [
          { sourceId: source.id, deviceId: "dev-laptop", state: "synced" },
          { sourceId: source.id, deviceId: "dev-mini", state: "synced", restoredClaims: 2 },
        ],
      },
    );
    expect(lines[0]).toContain("2 deletions in dispute");
    expect(lines[2]).toContain("keeping 2 items another device no longer has");
  });

  test("prints the mode, the lease holder and one line per member", () => {
    const lines = renderMembers(source, devices, {
      sourceId: source.id,
      state: "synced",
      members: [
        { sourceId: source.id, deviceId: "dev-laptop", state: "syncing" },
        { sourceId: source.id, deviceId: "dev-mini", state: "needs-auth" },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("notes-synth:local");
    expect(lines[0]).toContain("(handoff)");
    expect(lines[0]).toContain("lease held by Maya-Laptop");
    expect(lines[1]).toContain("Maya-Laptop");
    expect(lines[1]).toContain("collector, online");
    expect(lines[1]).toContain("syncing now");
    expect(lines[1]).toContain("owner");
    expect(lines[2]).toContain("Studio-Mini");
    expect(lines[2]).toContain("collector, offline");
    expect(lines[2]).toContain("needs sign-in");
    expect(lines[2]).not.toContain("owner");
  });

  test("a handoff member without the lease and nothing to report is on standby", () => {
    const lines = renderMembers(
      source,
      devices.map((d) => ({ ...d, online: true })),
      { sourceId: source.id, deviceId: "dev-laptop", state: "syncing" },
    );
    expect(lines[1]).toContain("syncing now");
    expect(lines[2]).toContain("standby");
    // Offline wins over standby: the device is not there to wait its turn.
    const offline = renderMembers(source, devices, {
      sourceId: source.id,
      deviceId: "dev-laptop",
      state: "syncing",
    });
    expect(offline[2]).toContain("collector, offline");
    expect(offline[2]).toContain("offline");
    expect(offline[2]).not.toContain("standby");
  });

  test("a single member carries no owner tag", () => {
    const lines = renderMembers(
      { ...source, members: ["dev-laptop"], leaseHolder: null },
      devices,
      undefined,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("lease");
    expect(lines[1]).toContain("idle");
    expect(lines[1]).not.toContain("owner");
  });
});

describe("sources members", () => {
  let logged: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      switch (path) {
        case "/admin/sources":
          return Promise.resolve({ items: [source] });
        case "/admin/devices":
          return Promise.resolve({ items: devices });
        case "/admin/sync/status":
          return Promise.resolve({
            items: [
              {
                sourceId: source.id,
                state: "synced",
                lastSyncAt: "2030-01-01T11:00:00.000Z",
                members: [
                  {
                    sourceId: source.id,
                    deviceId: "dev-laptop",
                    state: "synced",
                    lastSyncAt: "2030-01-01T11:00:00.000Z",
                  },
                ],
              },
            ],
          });
        default:
          return Promise.reject(new Error(`unexpected path ${path}`));
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reads sources, devices and sync status, then lists every member", async () => {
    await run({ id: source.id });
    const paths = (gatewayJson as Mock).mock.calls.map(([path]) => path);
    expect(paths).toEqual(["/admin/sources", "/admin/devices", "/admin/sync/status"]);
    expect(logged[0]).toContain("notes-synth:local");
    expect(logged[1]).toContain("Maya-Laptop");
    expect(logged[2]).toContain("Studio-Mini");
    expect(logged[2]).toContain("offline");
  });

  test("--json emits the documented shape", async () => {
    await run({ id: source.id, json: true });
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toEqual({
      sourceId: "notes-synth:local",
      multiDeviceMode: "handoff",
      leaseHolder: "dev-laptop",
      members: [
        {
          deviceId: "dev-laptop",
          name: "Maya-Laptop",
          kind: "collector",
          online: true,
          state: "synced",
          lastSyncAt: "2030-01-01T11:00:00.000Z",
        },
        {
          deviceId: "dev-mini",
          name: "Studio-Mini",
          kind: "collector",
          online: false,
          state: "idle",
          lastSyncAt: null,
        },
      ],
    });
  });

  test("an unknown source id is a user error", async () => {
    await expect(run({ id: "nope:missing" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("No source with id: nope:missing"),
    });
  });
});
