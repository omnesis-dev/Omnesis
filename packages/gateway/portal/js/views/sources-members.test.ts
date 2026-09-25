// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The pure halves of the Sources page's multi-device rendering: the member
// lines of the Device cell, the devices offered to join a source, the note a
// manual sync leaves behind and how long it stays, how a resync is offered
// and the note it leaves.

import { describe, expect, test } from "vitest";
import {
  buildMemberLines,
  memberDetachBody,
  wholeSourceRemovalBody,
  resyncChoices,
  resyncNote,
  syncNotesReducer,
  syncTargetNote,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./sources.js";
import {
  joinCandidates,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "../lib/join-candidates.js";

const NOW = Date.parse("2026-03-14T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** The line shape `buildMemberLines` returns, as the Device cell reads it. */
interface MemberLine {
  name: string;
  kind: string;
  label: string;
  tone: string;
  notices: Array<{ severity: string; title: string }>;
}
interface Candidate {
  id: string;
}

const laptop = { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true, revokedAt: null };
const mini = { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: true, revokedAt: null };
const phone = { id: "dev-phone", name: "Jamie-Phone", kind: "ios", online: false, revokedAt: null };
const deviceById = new Map([laptop, mini, phone].map((d: Candidate) => [d.id, d]));

describe("buildMemberLines", () => {
  test("a member's status word stays a status; its notices ride beside it", () => {
    const warning = { kind: "sync-issue", severity: "warning", title: "Example enumeration incomplete" };
    const dispute = { kind: "replica-dispute", severity: "info", title: "Keeping 2 notes that Maya-Laptop no longer has" };
    const lines = buildMemberLines({
      id: "notes:local", deviceId: laptop.id, members: [laptop.id, mini.id], multiDeviceMode: "replicated",
    }, deviceById, { members: [
      { deviceId: laptop.id, state: "synced", lastSyncAt: ago(60_000), notices: [] },
      {
        deviceId: mini.id,
        state: "synced",
        lastSyncAt: ago(30_000),
        restoredClaims: 2,
        issues: [{ message: "Example enumeration incomplete" }],
        notices: [warning, dispute],
      },
    ] }, NOW);
    expect(lines.map((line: MemberLine) => [line.name, line.label, line.tone, line.notices])).toEqual([
      ["Maya-Laptop", "synced 1m ago", "muted", []],
      ["Studio-Mini", "synced 30s ago", "muted", [warning, dispute]],
    ]);
  });

  test("a handoff source: the device syncing says so, the other stands by", () => {
    const source = {
      id: "notes:local",
      type: "notes",
      deviceId: laptop.id,
      members: [laptop.id, mini.id],
      multiDeviceMode: "handoff",
      leaseHolder: laptop.id,
    };
    const syncStatus = {
      sourceId: "notes:local",
      deviceId: laptop.id,
      state: "syncing",
      lastSyncAt: ago(60_000),
    };
    const lines = buildMemberLines(source, deviceById, syncStatus, NOW);
    expect(lines.map((l: MemberLine) => [l.name, l.kind, l.label, l.tone])).toEqual([
      ["Maya-Laptop", "collector", "syncing now", "syncing"],
      ["Studio-Mini", "collector", "standby", "muted"],
    ]);
  });

  test("a replicated source reads each member's own row", () => {
    const source = {
      id: "health:local",
      type: "health",
      deviceId: phone.id,
      members: [phone.id, mini.id],
      multiDeviceMode: "replicated",
      leaseHolder: null,
    };
    const syncStatus = {
      sourceId: "health:local",
      state: "synced",
      lastSyncAt: ago(11 * 60_000),
      members: [
        { sourceId: "health:local", deviceId: phone.id, state: "synced", lastSyncAt: ago(11 * 60_000) },
        { sourceId: "health:local", deviceId: mini.id, state: "synced", lastSyncAt: ago(3_600_000) },
      ],
    };
    const lines = buildMemberLines(source, deviceById, syncStatus, NOW);
    expect(lines.map((l: MemberLine) => l.label)).toEqual(["synced 11m ago", "synced 1h ago"]);
    expect(lines.every((l: MemberLine) => l.tone === "muted")).toBe(true);
  });

  test("needs-auth and error outrank a past sync; offline outranks standby", () => {
    const source = {
      id: "mail:maya@example.com",
      type: "mail",
      deviceId: laptop.id,
      members: [laptop.id, mini.id, phone.id],
      multiDeviceMode: "handoff",
      leaseHolder: laptop.id,
    };
    const syncStatus = {
      sourceId: source.id,
      state: "needs-auth",
      lastSyncAt: ago(1000),
      members: [
        { sourceId: source.id, deviceId: laptop.id, state: "needs-auth", lastSyncAt: ago(1000) },
        {
          sourceId: source.id,
          deviceId: mini.id,
          state: "error",
          lastSyncAt: ago(1000),
          errorMessage: "upstream timed out",
        },
      ],
    };
    const lines = buildMemberLines(source, deviceById, syncStatus, NOW);
    expect(lines.map((l: MemberLine) => [l.label, l.tone])).toEqual([
      ["needs sign-in", "warn"],
      ["error", "error"],
      ["offline", "muted"],
    ]);
  });

  test("an unknown device falls back to a short id and idle", () => {
    const source = {
      id: "notes:local",
      type: "notes",
      deviceId: laptop.id,
      members: [laptop.id, "dev-0123456789"],
      multiDeviceMode: "replicated",
      leaseHolder: null,
    };
    const lines = buildMemberLines(source, deviceById, null, NOW);
    expect(lines[1]).toMatchObject({ name: "dev-0123", kind: null, label: "idle" });
  });

  test("a source with no membership list has exactly its owner", () => {
    const lines = buildMemberLines(
      { id: "notes:local", type: "notes", deviceId: mini.id, multiDeviceMode: "exclusive" },
      deviceById,
      null,
      NOW,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("Studio-Mini");
  });
});

describe("joinCandidates", () => {
  const source = {
    id: "notes:local",
    type: "notes",
    deviceId: laptop.id,
    members: [laptop.id],
    multiDeviceMode: "replicated",
  };
  const capable = { ...mini, capabilities: { hostableSourceTypes: ["notes", "mail"] } };
  const offline = {
    ...capable,
    id: "dev-offline",
    name: "Offline-Box",
    online: false,
  };
  const other = { ...phone, capabilities: { hostableSourceTypes: ["health"] } };
  const silent = { id: "dev-silent", name: "Spare-Box", kind: "collector", revokedAt: null };
  const revoked = { ...capable, id: "dev-gone", name: "Old-Box", revokedAt: ago(1) };
  const portal = { id: "dev-portal", name: "Browser", kind: "portal", revokedAt: null };

  const everyone = [laptop, capable, other, silent, revoked, portal];

  test("offers the devices the gateway names, in its order, as device records", () => {
    const listed = { ...source, joinCandidates: [silent.id, capable.id] };
    expect(joinCandidates(listed, everyone)).toEqual([silent, capable]);
  });

  test("offers only available named devices while accepting an older device row without online", () => {
    const listed = { ...source, joinCandidates: [offline.id, capable.id, silent.id] };
    expect(joinCandidates(listed, [...everyone, offline])).toEqual([capable, silent]);
  });

  test("skips a named device the device list does not know", () => {
    const listed = { ...source, joinCandidates: [capable.id, "dev-unknown"] };
    expect(joinCandidates(listed, everyone)).toEqual([capable]);
  });

  test("trusts the gateway's list over its own filter", () => {
    // The gateway may admit a device the approximation would not (and vice
    // versa); its rule is the one that decides the join, so it wins.
    const availableOther = { ...other, online: true };
    const availableEveryone = everyone.map((device) =>
      device.id === availableOther.id ? availableOther : device,
    );
    expect(joinCandidates({ ...source, joinCandidates: [other.id] }, availableEveryone)).toEqual([
      availableOther,
    ]);
    expect(joinCandidates({ ...source, joinCandidates: [] }, everyone)).toEqual([]);
  });

  test("without a gateway list, offers devices that advertise the type or have not announced any", () => {
    const ids = joinCandidates(source, everyone).map((d: Candidate) => d.id);
    expect(ids).toEqual([capable.id, silent.id]);
  });

  test("offers nobody for an exclusive source, whatever the gateway lists", () => {
    expect(joinCandidates({ ...source, multiDeviceMode: "exclusive" }, [capable])).toEqual([]);
    expect(
      joinCandidates(
        { ...source, multiDeviceMode: "exclusive", joinCandidates: [capable.id] },
        [capable],
      ),
    ).toEqual([]);
  });

  test("without a gateway list, never offers a current member", () => {
    expect(joinCandidates({ ...source, members: [laptop.id, capable.id] }, [capable])).toEqual([]);
  });

  test("a source that names no mode is read as exclusive — a missing mode fails closed", () => {
    // A gateway too old to report `multiDeviceMode` says nothing about how
    // many hosts the type admits. Offering a join on that silence would send
    // a request the gateway refuses; reading it as exclusive offers nobody.
    const { multiDeviceMode: _mode, ...unstated } = source;
    expect(joinCandidates(unstated, [capable])).toEqual([]);
    expect(joinCandidates({ ...unstated, joinCandidates: [capable.id] }, [capable])).toEqual([]);
  });
});

describe("syncTargetNote", () => {
  test("names the one device a sync went to", () => {
    expect(syncTargetNote({ ok: true, result: {}, deviceId: mini.id }, deviceById)).toBe(
      "Sync sent to Studio-Mini",
    );
  });

  test("says only that the sync was sent when the target is not reported", () => {
    expect(syncTargetNote({ ok: true, result: {} }, deviceById)).toBe("Sync sent");
  });

  test("counts a fan-out and names its failures", () => {
    const response = {
      ok: true,
      results: [
        { deviceId: laptop.id, ok: true, triggered: 1 },
        { deviceId: mini.id, ok: true, triggered: 1 },
        { deviceId: phone.id, ok: false, error: "not connected" },
      ],
    };
    expect(syncTargetNote(response, deviceById)).toBe(
      "Sync sent to 2 devices; failed on Jamie-Phone (not connected)",
    );
  });

  test("a member that accepted the command but triggered nothing was skipped, not synced", () => {
    const response = {
      ok: true,
      results: [
        { deviceId: laptop.id, ok: true, triggered: 1 },
        { deviceId: mini.id, ok: true, triggered: 0, disabled: 1 },
      ],
    };
    expect(syncTargetNote(response, deviceById)).toBe("Sync sent to Maya-Laptop; Studio-Mini skipped");
    expect(
      syncTargetNote(
        { ok: true, results: [{ deviceId: mini.id, ok: true, triggered: 0, skipped: 1 }] },
        deviceById,
      ),
    ).toBe("Sync skipped on Studio-Mini");
  });

  test("names the single member a fan-out reached", () => {
    const response = { ok: true, results: [{ deviceId: laptop.id, ok: true, triggered: 1 }] };
    expect(syncTargetNote(response, deviceById)).toBe("Sync sent to Maya-Laptop");
  });

  test("a fan-out nobody accepted reads as a failure, not as sent to nobody", () => {
    const response = {
      ok: true,
      results: [
        { deviceId: mini.id, ok: false, error: "not connected" },
        { deviceId: phone.id, ok: false },
      ],
    };
    expect(syncTargetNote(response, deviceById)).toBe(
      "Sync failed on Studio-Mini (not connected), Jamie-Phone",
    );
    expect(syncTargetNote({ ok: true, results: [] }, deviceById)).toBe("Sync sent");
  });
});

describe("syncNotesReducer", () => {
  const shown = syncNotesReducer(
    {},
    { type: "show", sourceId: "notes:local", text: "Sync sent to Studio-Mini", until: 1_000 },
  );

  test("a shown note carries its text and deadline", () => {
    expect(shown).toEqual({ "notes:local": { text: "Sync sent to Studio-Mini", until: 1_000 } });
  });

  test("expiry at the note's deadline drops it", () => {
    expect(syncNotesReducer(shown, { type: "expire", sourceId: "notes:local", until: 1_000 })).toEqual(
      {},
    );
  });

  test("a note re-shown before its first expiry survives the first timer", () => {
    const reshown = syncNotesReducer(shown, {
      type: "show",
      sourceId: "notes:local",
      text: "Sync sent to Maya-Laptop",
      until: 4_000,
    });
    const afterStaleTimer = syncNotesReducer(reshown, {
      type: "expire",
      sourceId: "notes:local",
      until: 1_000,
    });
    expect(afterStaleTimer).toBe(reshown);
    expect(
      syncNotesReducer(afterStaleTimer, { type: "expire", sourceId: "notes:local", until: 4_000 }),
    ).toEqual({});
  });

  test("notes on other sources are untouched by a show or an expiry", () => {
    const two = syncNotesReducer(shown, {
      type: "show",
      sourceId: "mail:maya@example.com",
      text: "Sync sent",
      until: 2_000,
    });
    expect(Object.keys(two)).toEqual(["notes:local", "mail:maya@example.com"]);
    expect(syncNotesReducer(two, { type: "expire", sourceId: "notes:local", until: 1_000 })).toEqual({
      "mail:maya@example.com": { text: "Sync sent", until: 2_000 },
    });
    expect(syncNotesReducer(two, { type: "expire", sourceId: "unknown:x", until: 1 })).toBe(two);
  });
});

describe("resyncChoices", () => {
  const source = { id: "notes:local", type: "notes", deviceId: laptop.id };

  test("one member: the plain whole-source resync, whatever the mode", () => {
    expect(resyncChoices({ ...source, multiDeviceMode: "exclusive" })).toBe("single");
    expect(resyncChoices({ ...source, members: [laptop.id], multiDeviceMode: "replicated" })).toBe(
      "single",
    );
    expect(resyncChoices({ ...source, members: [], multiDeviceMode: "partitioned" })).toBe("single");
    expect(resyncChoices(undefined)).toBe("single");
  });

  test("several members on their own cursors: the whole source or one device", () => {
    const members = [laptop.id, mini.id];
    expect(resyncChoices({ ...source, members, multiDeviceMode: "replicated" })).toBe("per-device");
    expect(resyncChoices({ ...source, members, multiDeviceMode: "partitioned" })).toBe("per-device");
  });

  test("several members sharing one cursor: only the whole source", () => {
    expect(
      resyncChoices({ ...source, members: [laptop.id, mini.id], multiDeviceMode: "handoff" }),
    ).toBe("whole");
  });
});

describe("resyncNote", () => {
  test("names the device a whole-source resync went to", () => {
    expect(resyncNote({ ok: true, scope: "source", deviceIds: [mini.id] }, deviceById)).toBe(
      "Resync sent to Studio-Mini",
    );
    expect(
      resyncNote({ ok: true, scope: "source", deviceIds: [laptop.id, mini.id] }, deviceById),
    ).toBe("Resync sent to 2 devices");
  });

  test("says what a per-device resync kept", () => {
    expect(resyncNote({ ok: true, scope: "stream", deviceIds: [phone.id] }, deviceById)).toBe(
      "Resync sent to Jamie-Phone; its contribution was removed first",
    );
    expect(resyncNote({ ok: true, scope: "cursor", deviceIds: [phone.id] }, deviceById)).toBe(
      "Resync sent to Jamie-Phone; nothing was deleted",
    );
  });

  test("a resync nobody was online to take is queued, not sent", () => {
    expect(resyncNote({ ok: true, scope: "source", deviceIds: [] }, deviceById)).toBe(
      "Resync queued; no member is online",
    );
    expect(resyncNote({ ok: true, scope: "cursor" }, deviceById)).toBe(
      "Resync queued; no member is online",
    );
  });

  test("an unknown device falls back to a short id", () => {
    expect(
      resyncNote({ ok: true, scope: "source", deviceIds: ["dev-0123456789"] }, deviceById),
    ).toBe("Resync sent to dev-0123");
  });
});

describe("buildMemberLines — a failure that names its remedy", () => {
  const remediation = {
    summary: "Disk access is required",
    steps: ["Open the pane."],
    restartRequired: true,
  };

  test("only the member that hit the failure reads needs access", () => {
    const source = {
      id: "apple-health:local",
      deviceId: "dev-a",
      members: ["dev-a", "dev-b"],
      multiDeviceMode: "replicated",
    };
    const deviceById = new Map([
      ["dev-a", { name: "Maya-Laptop", kind: "collector", online: true }],
      ["dev-b", { name: "Jamie-Desk", kind: "collector", online: true }],
    ]);
    const lines: MemberLine[] = buildMemberLines(
      source,
      deviceById,
      {
        state: "error",
        members: [
          { deviceId: "dev-a", state: "synced", lastSyncAt: ago(60_000) },
          {
            deviceId: "dev-b",
            state: "error",
            errorMessage: "Cannot open the database.",
            remediation,
          },
        ],
      },
      NOW,
    );
    expect(lines.map((l) => [l.name, l.label, l.tone])).toEqual([
      ["Maya-Laptop", "synced 1m ago", "muted"],
      ["Jamie-Desk", "needs access", "warn"],
    ]);
  });
});

describe("syncTargetNote reads a single target's answer", () => {
  test("a target that answered without starting is skipped, not sent", () => {
    expect(
      syncTargetNote(
        { ok: true, result: { ok: true, triggered: 0, skipped: 1 }, deviceId: mini.id },
        deviceById,
      ),
    ).toBe("Sync skipped; Studio-Mini was already syncing");
    expect(
      syncTargetNote(
        { ok: true, result: { ok: true, triggered: 0, disabled: 1 }, deviceId: mini.id },
        deviceById,
      ),
    ).toBe("Sync skipped; the source is paused on Studio-Mini");
  });
});

describe("resyncNote reads each member's answer", () => {
  test("a member that was already syncing is skipped, not sent", () => {
    expect(
      resyncNote(
        { ok: true, scope: "source", deviceIds: [], restarting: [], skipped: [mini.id] },
        deviceById,
      ),
    ).toBe("Resync skipped; Studio-Mini was already syncing");
  });

  test("a member restarting its sync in flight says so", () => {
    expect(
      resyncNote(
        { ok: true, scope: "source", deviceIds: [], restarting: [mini.id], skipped: [] },
        deviceById,
      ),
    ).toBe("Resync restarting the sync in flight on Studio-Mini");
    expect(
      resyncNote(
        { ok: true, scope: "cursor", deviceIds: [], restarting: [phone.id], skipped: [] },
        deviceById,
      ),
    ).toBe("Resync restarting the sync in flight on Jamie-Phone; nothing was deleted");
  });

  test("mixed answers name every member under its verdict", () => {
    expect(
      resyncNote(
        {
          ok: true,
          scope: "source",
          deviceIds: [laptop.id],
          restarting: [mini.id],
          skipped: [phone.id],
        },
        deviceById,
      ),
    ).toBe(
      "Resync sent to Maya-Laptop; restarting the sync in flight on Studio-Mini; Jamie-Phone was already syncing",
    );
  });
});

describe("source removal consequences", () => {
  test("partition detach identifies the device scope even with stale or offline membership", () => {
    const body = memberDetachBody({ id: "observations:local", multiDeviceMode: "partitioned", members: [] }, { ...phone, name: "example device" });
    expect(body).toContain("Delete example device's managed gateway contribution");
    expect(body).toContain("Other members' data stays");
    expect(body).toContain("last member cannot detach");
    expect(body).toContain("ownership passes");
    expect(body).toContain("reconnects");
  });
  test("shared detach keeps indexed data", () => {
    expect(memberDetachBody({ id: "notes:local", multiDeviceMode: "replicated" }, laptop)).toContain("Shared indexed data stays");
  });
  test("whole removal includes offline siblings and explains cleanup and deletion limits", () => {
    const body = wholeSourceRemovalBody({ id: "notes:local", pushBased: true });
    for (const text of ["every device", "offline members", "background", "Re-add is blocked", "retained backups", "exported copies", "not physical secure erasure"]) expect(body).toContain(text);
  });
});
