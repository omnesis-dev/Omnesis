// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { AccountId, SourceType, SourceId, type DeviceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { setSourceMeta, setSyncState, getSyncState } from "./SyncStateRepository.js";
import { createDevice } from "./DeviceRepository.js";
import { completeSourceStreamCleanup } from "./SourceStreamCleanupRepository.js";
import {
  createSource,
  createSourceWithId,
  getSource,
  getSourceMemberConfigOverride,
  getSourceForMember,
  isSourceMember,
  listSources,
  listSourceMembers,
  updateSource,
  deleteSource,
  findRemovedSourceIds,
  markSourceRemoved,
  clearSourceRemoved,
  isSourceRemoved,
  listRemovedSources,
  addSourceMember,
  removeSourceMember,
  listSourcesForMember,
  setSourceMemberConfigOverride,
} from "./SourceRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-sources-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function newCollector(name = "mac"): DeviceId {
  return createDevice(db, { name, kind: "collector" }).id;
}

describe("sources CRUD", () => {
  test("existing rows adopt refreshed discovery identity without resetting cursors or legacy metadata", () => {
    const deviceId = newCollector();
    const opts = { type: SourceType("example-source"), accountId: AccountId("local"), deviceId };
    const source = createSource(db, opts);
    const account = {
      id: "local",
      label: "Example account",
      subject: { kind: "opaque" as const, value: "subject-1" },
    };
    setSyncState(db, source.id, { bookmark: "retained" });
    setSourceMeta(db, source.id, { account });
    expect(getSource(db, source.id)?.account).toEqual(account);
    expect(JSON.parse(getSyncState(db, source.id)!.cursor)).toEqual({ bookmark: "retained" });
    setSourceMeta(db, source.id, { label: "Legacy label" });
    expect(createSource(db, opts).account).toEqual(account);
    const renamed = { ...account, label: "Updated account" };
    expect(createSource(db, { ...opts, account: renamed }).account).toEqual(renamed);
    createSource(db, { ...opts, deviceId: newCollector("sibling"), account });
    expect(getSource(db, source.id)?.account).toEqual(renamed);
    setSourceMeta(db, source.id, { account: { ...account, id: "another" } });
    expect(getSource(db, source.id)?.account).toEqual(renamed);
  });
  test("adopting that identity leaves a timestamp its clients can still decode", () => {
    // The descriptor write stamps `updated_at` as a side effect, and SQLite
    // keeps whatever type the binding had. The iOS and Android clients decode
    // the column as a 64-bit integer for every row of `/admin/sources`, so one
    // row stamped as text costs them the whole page — not just that source.
    const source = createSource(db, {
      type: SourceType("example-source"),
      accountId: AccountId("local"),
      deviceId: newCollector(),
    });
    const before = Date.now();
    setSourceMeta(db, source.id, {
      account: {
        id: "local",
        label: "Example account",
        subject: { kind: "opaque" as const, value: "subject-1" },
      },
    });
    const stored = db
      .prepare(
        "SELECT typeof(created_at) AS created, typeof(updated_at) AS updated, updated_at FROM sources WHERE id = ?",
      )
      .get(source.id) as { created: string; updated: string; updated_at: number };
    expect(stored).toMatchObject({ created: "integer", updated: "integer" });
    expect(stored.updated_at).toBeGreaterThanOrEqual(before);
    expect(getSource(db, source.id)!.updatedAt).toBeGreaterThanOrEqual(before);
  });
  test("createSource returns a SourceRecord with derived id", () => {
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("user@gmail.com"),
      deviceId: dev,
      config: { syncInterval: "5m" },
    });
    expect(s.id).toBe("gmail:user@gmail.com");
    expect(s.deviceId).toBe(dev);
    expect(s.config.syncInterval).toBe("5m");
    expect(s.enabled).toBe(true);
  });

  test("persists the authoritative multi-device mode and preserves it on idempotent create", () => {
    const dev = newCollector();
    const first = createSource(db, {
      type: SourceType("fictional-notes"),
      accountId: AccountId("local"),
      deviceId: dev,
      multiDeviceMode: "replicated",
    });
    const raced = createSource(db, {
      type: SourceType("fictional-notes"),
      accountId: AccountId("local"),
      deviceId: dev,
      multiDeviceMode: "partitioned",
    });

    expect(first.multiDeviceMode).toBe("replicated");
    expect(raced.multiDeviceMode).toBe("replicated");
    expect(getSource(db, first.id)?.multiDeviceMode).toBe("replicated");
    expect(listSources(db)[0]?.multiDeviceMode).toBe("replicated");
    expect(listSourcesForMember(db, dev)[0]?.multiDeviceMode).toBe("replicated");
  });

  test("fresh databases constrain persisted multi-device modes", () => {
    const dev = newCollector();
    expect(() =>
      db
        .prepare(
          `INSERT INTO sources (
             id, type, account_id, device_id, config, enabled,
             multi_device_mode, created_at, updated_at
           ) VALUES ('bad-mode', 'fictional-notes', 'local', ?, '{}', 1, 'fanout', 1, 1)`,
        )
        .run(dev),
    ).toThrow(/CHECK constraint/i);
  });

  test("createSourceWithId is idempotent when registration races", () => {
    const dev = newCollector();
    const id = SourceId("singleton");
    const opts = {
      type: SourceType("singleton"),
      accountId: AccountId("local"),
      deviceId: dev,
    };

    expect(createSourceWithId(db, id, { ...opts, multiDeviceMode: "handoff" })).toMatchObject({
      id,
      multiDeviceMode: "handoff",
    });
    expect(createSourceWithId(db, id, { ...opts, multiDeviceMode: "partitioned" })).toMatchObject({
      id,
      multiDeviceMode: "handoff",
    });
    expect(listSources(db)).toHaveLength(1);
  });

  test("getSource returns null for missing", () => {
    expect(getSource(db, SourceId("nope"))).toBeNull();
  });

  test("explicit-id creation preserves its declared account without replacing a racing winner", () => {
    const dev = newCollector();
    const id = SourceId("example-singleton");
    const account = {
      id: "local",
      label: "Example account",
      subject: { kind: "email" as const, value: "maya@example.org" },
    };
    const opts = {
      type: SourceType("example-singleton"),
      accountId: AccountId("local"),
      deviceId: dev,
      account,
    };
    expect(createSourceWithId(db, id, opts)?.account).toEqual(account);
    expect(getSource(db, id)?.account).toEqual(account);
    expect(listSources(db).find((source) => source.id === id)?.account).toEqual(account);
    expect(listSourcesForMember(db, dev).find((source) => source.id === id)?.account).toEqual(
      account,
    );
    expect(getSourceForMember(db, id, dev)?.account).toEqual(account);
    expect(
      createSourceWithId(db, id, { ...opts, account: { id: "local", label: "Another" } })?.account,
    ).toEqual(account);
  });

  test("updateSource patches config + enabled", () => {
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev,
    });
    const updated = updateSource(db, s.id, { config: { syncInterval: "1h" }, enabled: false });
    expect(updated?.config.syncInterval).toBe("1h");
    expect(updated?.enabled).toBe(false);
  });

  test("updateSource can re-home to a different device", () => {
    const dev1 = newCollector("a");
    const dev2 = newCollector("b");
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev1,
    });
    const updated = updateSource(db, s.id, { deviceId: dev2 });
    expect(updated?.deviceId).toBe(dev2);
  });

  test("deleteSource removes and cascades when device removed", () => {
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev,
    });
    expect(deleteSource(db, s.id)).toBe(true);
    expect(getSource(db, s.id)).toBeNull();
  });

  test("device deletion is refused while sources still point at it", () => {
    // Removing a device must never destroy a source or its data — the FK
    // has no cascade, so a hard delete fails loudly until the operator
    // moves or removes the device's sources. Unpairing revokes instead
    // (devices.revoked_at), which keeps the row entirely.
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev,
    });
    expect(() => db.prepare("DELETE FROM devices WHERE id = ?").run(dev)).toThrow(/FOREIGN KEY/i);
    expect(getSource(db, s.id)).not.toBeNull();
  });

  test("createSource records the creating device as a member", () => {
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev,
    });
    expect(isSourceMember(db, s.id, dev)).toBe(true);
    expect(listSourceMembers(db, s.id).map((m) => m.deviceId)).toEqual([dev]);
  });

  test("a deviceId update replaces the membership", () => {
    const dev1 = newCollector("member-a");
    const dev2 = newCollector("member-b");
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev1,
    });
    updateSource(db, s.id, { deviceId: dev2 });
    expect(listSourceMembers(db, s.id).map((m) => m.deviceId)).toEqual([dev2]);
  });

  test("member listings overlay nested params without leaking a sibling's local path", () => {
    const owner = newCollector("collector-north");
    const sibling = newCollector("collector-south");
    const source = createSource(db, {
      type: SourceType("claude-code"),
      accountId: AccountId("local"),
      deviceId: owner,
      config: {
        enabled: true,
        syncInterval: "10m",
        params: { sessionsPath: "~/.claude/projects", includeArchived: true },
      },
      multiDeviceMode: "partitioned",
    });
    expect(addSourceMember(db, source.id, sibling)).toBe(true);
    expect(
      setSourceMemberConfigOverride(db, source.id, owner, {
        params: { sessionsPath: "/tmp/fictional-north/claude" },
      }),
    ).toBe(true);
    expect(
      setSourceMemberConfigOverride(db, source.id, sibling, {
        params: { sessionsPath: "/tmp/fictional-south/claude" },
      }),
    ).toBe(true);

    expect(listSourcesForMember(db, owner)[0]?.config).toEqual({
      enabled: true,
      syncInterval: "10m",
      params: {
        sessionsPath: "/tmp/fictional-north/claude",
        includeArchived: true,
      },
    });
    expect(listSourcesForMember(db, sibling)[0]?.config).toEqual({
      enabled: true,
      syncInterval: "10m",
      params: {
        sessionsPath: "/tmp/fictional-south/claude",
        includeArchived: true,
      },
    });
    expect(getSourceForMember(db, source.id, sibling)?.config).toEqual(
      listSourcesForMember(db, sibling)[0]?.config,
    );
  });

  test("corrupt member overrides fail safe without hiding the source", () => {
    const owner = newCollector("collector-safe");
    const source = createSource(db, {
      type: SourceType("codex"),
      accountId: AccountId("local"),
      deviceId: owner,
      config: { params: { codexHome: "~/.codex" } },
    });
    db.prepare(
      "UPDATE source_devices SET config_override = 'not json' WHERE source_id = ? AND device_id = ?",
    ).run(source.id, owner);

    expect(getSourceMemberConfigOverride(db, source.id, owner)).toEqual({});
    expect(listSourcesForMember(db, owner)[0]?.config).toEqual({
      params: { codexHome: "~/.codex" },
    });
  });

  test("detach discards a local override and rejoin starts from the shared config", () => {
    const owner = newCollector("collector-owner");
    const sibling = newCollector("collector-detach");
    const source = createSource(db, {
      type: SourceType("codex"),
      accountId: AccountId("local"),
      deviceId: owner,
      config: { params: { codexHome: "~/.codex" } },
      multiDeviceMode: "partitioned",
    });
    addSourceMember(db, source.id, sibling);
    setSourceMemberConfigOverride(db, source.id, sibling, {
      params: { codexHome: "/tmp/fictional-detached/codex" },
    });

    const detached = removeSourceMember(db, source.id, sibling);
    expect(detached).toMatchObject({ removed: true });
    expect(getSourceMemberConfigOverride(db, source.id, sibling)).toBeNull();
    if (!detached.removed || !detached.streamCleanup) throw new Error("expected cleanup journal");
    expect(completeSourceStreamCleanup(db, detached.streamCleanup)).toBe(true);
    expect(addSourceMember(db, source.id, sibling)).toBe(true);
    expect(getSourceMemberConfigOverride(db, source.id, sibling)).toEqual({});
    expect(listSourcesForMember(db, sibling)[0]?.config).toEqual({
      params: { codexHome: "~/.codex" },
    });
  });

  test("implicit pushes cannot rejoin a partitioned member after completed detach", () => {
    const owner = newCollector("fictional-owner");
    const sibling = newCollector("fictional-sibling");
    const source = createSource(db, {
      type: SourceType("fictional-local"),
      accountId: AccountId("local"),
      deviceId: owner,
      multiDeviceMode: "partitioned",
    });
    const implicitJoin = () =>
      addSourceMember(db, source.id, sibling, undefined, undefined, undefined, false);
    expect(implicitJoin()).toBe(true);
    const detached = removeSourceMember(db, source.id, sibling);
    if (!detached.removed || !detached.streamCleanup) throw new Error("expected cleanup journal");
    expect(implicitJoin()).toBe(false);
    expect(completeSourceStreamCleanup(db, detached.streamCleanup)).toBe(true);
    expect(implicitJoin()).toBe(false);
    expect(isSourceMember(db, source.id, sibling)).toBe(false);
    expect(addSourceMember(db, source.id, sibling)).toBe(true);
    expect(implicitJoin()).toBe(true);
  });

  test("owner handoff keeps each surviving member's own override", () => {
    const owner = newCollector("collector-handoff-owner");
    const successor = newCollector("collector-handoff-successor");
    const source = createSource(db, {
      type: SourceType("fictional-local"),
      accountId: AccountId("local"),
      deviceId: owner,
      config: { params: { root: "~/fictional" } },
      multiDeviceMode: "handoff",
    });
    addSourceMember(db, source.id, successor, 10);
    setSourceMemberConfigOverride(db, source.id, owner, {
      params: { root: "/tmp/fictional-owner" },
    });
    setSourceMemberConfigOverride(db, source.id, successor, {
      params: { root: "/tmp/fictional-successor" },
    });

    expect(removeSourceMember(db, source.id, owner)).toMatchObject({
      removed: true,
      ownerReassignedTo: successor,
    });
    expect(getSourceMemberConfigOverride(db, source.id, owner)).toBeNull();
    expect(getSourceMemberConfigOverride(db, source.id, successor)).toEqual({
      params: { root: "/tmp/fictional-successor" },
    });
    expect(listSourcesForMember(db, successor)[0]?.config).toEqual({
      params: { root: "/tmp/fictional-successor" },
    });
  });

  test("an explicit move preserves the target's override and never copies the old owner's", () => {
    const owner = newCollector("collector-move-owner");
    const target = newCollector("collector-move-target");
    const freshTarget = newCollector("collector-move-fresh");
    const source = createSource(db, {
      type: SourceType("fictional-local"),
      accountId: AccountId("local"),
      deviceId: owner,
      config: { params: { root: "~/fictional" } },
    });
    addSourceMember(db, source.id, target);
    setSourceMemberConfigOverride(db, source.id, owner, {
      params: { root: "/tmp/fictional-old-owner" },
    });
    setSourceMemberConfigOverride(db, source.id, target, {
      params: { root: "/tmp/fictional-target" },
    });

    expect(updateSource(db, source.id, { deviceId: target })?.deviceId).toBe(target);
    expect(getSourceMemberConfigOverride(db, source.id, target)).toEqual({
      params: { root: "/tmp/fictional-target" },
    });
    expect(getSourceMemberConfigOverride(db, source.id, owner)).toBeNull();

    expect(updateSource(db, source.id, { deviceId: freshTarget })?.deviceId).toBe(freshTarget);
    expect(getSourceMemberConfigOverride(db, source.id, freshTarget)).toEqual({});
    expect(JSON.stringify(listSourcesForMember(db, freshTarget)[0]?.config)).not.toContain(
      "fictional-old-owner",
    );
  });

  test("removeSourceMember hands ownership to the oldest remaining member and refuses the last one", () => {
    const owner = newCollector("member-owner");
    const second = newCollector("member-second");
    const third = newCollector("member-third");
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: owner,
    });
    addSourceMember(db, s.id, second, 10);
    addSourceMember(db, s.id, third, 5);
    // Joining twice is a no-op; a source that no longer exists refuses.
    expect(addSourceMember(db, s.id, second, 11)).toBe(true);
    expect(addSourceMember(db, SourceId("gmail:nobody@example.com"), second)).toBe(false);
    expect(listSourceMembers(db, s.id).map((m) => m.deviceId)).toEqual([third, second, owner]);
    expect(listSourcesForMember(db, second).map((x) => x.id)).toEqual([s.id]);
    // The owner is a member too, and appears once.
    expect(listSourcesForMember(db, owner).map((x) => x.id)).toEqual([s.id]);

    const ownerLeft = removeSourceMember(db, s.id, owner);
    expect(ownerLeft).toMatchObject({ removed: true, ownerReassignedTo: third });
    expect(getSource(db, s.id)?.deviceId).toBe(third);

    expect(removeSourceMember(db, s.id, owner)).toEqual({ removed: false, reason: "not-member" });
    expect(removeSourceMember(db, s.id, second)).toMatchObject({
      removed: true,
      ownerReassignedTo: null,
    });
    expect(removeSourceMember(db, s.id, third)).toEqual({
      removed: false,
      reason: "last-member",
    });
    expect(getSource(db, s.id)?.deviceId).toBe(third);
    expect(removeSourceMember(db, SourceId("gmail:nobody@example.com"), third)).toEqual({
      removed: false,
      reason: "not-found",
    });
  });

  test("deleting a source removes its membership rows", () => {
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("a@example.com"),
      deviceId: dev,
    });
    deleteSource(db, s.id);
    expect(listSourceMembers(db, s.id)).toEqual([]);
  });
});

describe("removal tombstones", () => {
  test("mark / is / clear round-trips and is idempotent", () => {
    const id = SourceId("browser");
    expect(isSourceRemoved(db, id)).toBe(false);

    markSourceRemoved(db, id);
    expect(isSourceRemoved(db, id)).toBe(true);
    // Idempotent — marking again keeps it removed (no throw on PK conflict).
    markSourceRemoved(db, id);
    expect(isSourceRemoved(db, id)).toBe(true);

    clearSourceRemoved(db, id);
    expect(isSourceRemoved(db, id)).toBe(false);
    // Clearing a non-tombstoned id is a harmless no-op.
    clearSourceRemoved(db, id);
    expect(isSourceRemoved(db, id)).toBe(false);
  });

  test("findRemovedSourceIds returns only requested tombstones", () => {
    markSourceRemoved(db, SourceId("browser"));
    markSourceRemoved(db, SourceId("apple-health:local"));

    expect(findRemovedSourceIds(db, ["browser", "gmail:local"])).toEqual(new Set(["browser"]));
  });

  test("listRemovedSources returns all tombstoned ids", () => {
    expect(listRemovedSources(db)).toEqual([]);
    markSourceRemoved(db, SourceId("browser"));
    markSourceRemoved(db, SourceId("apple-health:local"));
    const removed = listRemovedSources(db);
    expect(new Set(removed)).toEqual(new Set(["browser", "apple-health:local"]));
  });

  test("tombstone is independent of the sources row", () => {
    const dev = newCollector();
    const s = createSource(db, {
      type: SourceType("browser"),
      accountId: AccountId("local"),
      deviceId: dev,
    });
    // Removing the row does not auto-create a tombstone at the repo layer —
    // that orchestration lives in SourceService.deleteSource. The repo just
    // stores whatever it's told.
    deleteSource(db, s.id);
    expect(isSourceRemoved(db, s.id)).toBe(false);
    markSourceRemoved(db, s.id);
    expect(isSourceRemoved(db, s.id)).toBe(true);
  });
});
