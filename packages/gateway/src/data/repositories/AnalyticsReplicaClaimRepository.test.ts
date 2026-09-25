// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The replica deletion ledger's structured-row operations: what a member's
 * tombstones, rows and snapshot do to a row's history, and what the absence
 * sweep asks before it acts on a row of a replicated source.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { AccountId, SourceType, type DeviceId, type SourceId } from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import { addSourceMember, createSource } from "./SourceRepository.js";
import { beginSyncAttempt, getSyncState, getWipeEpoch } from "./SyncStateRepository.js";
import {
  analyticsClaimNamespace,
  analyticsSweepCandidateKey,
  planAnalyticsSweep,
  recordAnalyticsSweepVerdict,
  judgeAnalyticsTombstones,
  listRestoredAnalyticsKeys,
  recordAnalyticsPresence,
  recordAnalyticsRestorerOmissions,
} from "./AnalyticsReplicaClaimRepository.js";
import { recordDeletionClaims } from "./ReplicaDeletionClaimRepository.js";
import type { Db } from "../types.js";

const TYPE = SourceType("apple-health");
const TABLE = "hk_samples";
const POLICY = { minObservations: 2, minAgeMs: 100, maxMarksPerSnapshot: 200 };

describe("the replica deletion ledger for analytics rows", () => {
  let db: Db;
  let dbPath: string;
  let sourceId: SourceId;
  let single: SourceId;
  let phoneA: DeviceId;
  let phoneB: DeviceId;

  const rows = (source: SourceId = sourceId) =>
    db
      .prepare<
        [string, string],
        { external_id: string; device_id: string; role: string; omissions: number }
      >(
        "SELECT external_id, device_id, role, omissions FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? ORDER BY external_id, device_id",
      )
      .all(analyticsClaimNamespace(TABLE), source)
      .map((r) => `${r.external_id}/${name(r.device_id)}/${r.role}/${r.omissions}`)
      .sort();
  const name = (deviceId: string) =>
    deviceId === phoneA ? "a" : deviceId === phoneB ? "b" : deviceId;
  const host = (label: string) =>
    createDevice(db, {
      name: `${label}-${randomUUID()}`,
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [TYPE],
        multiDeviceModes: { [TYPE]: "replicated" },
        syncLease: true,
      },
    }).id;
  const judge = (deviceId: DeviceId, existingIds: string[], deletionAuthority: boolean) =>
    judgeAnalyticsTombstones(db, {
      sourceId,
      tableName: TABLE,
      deviceId,
      existingIds,
      deletionAuthority,
      now: 1_000,
    });
  const present = (deviceId: DeviceId, keyValues: string[]) =>
    recordAnalyticsPresence(db, { sourceId, tableName: TABLE, deviceId, keyValues, now: 2_000 });

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    phoneA = host("phone-a");
    phoneB = host("phone-b");
    sourceId = createSource(db, {
      type: TYPE,
      accountId: AccountId("shared"),
      deviceId: phoneA,
      multiDeviceMode: "replicated",
    }).id;
    addSourceMember(db, sourceId, phoneB);
    single = createSource(db, {
      type: TYPE,
      accountId: AccountId("single"),
      deviceId: phoneA,
    }).id;
    beginSyncAttempt(db, sourceId, phoneA);
    beginSyncAttempt(db, sourceId, phoneB);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  test("a fresh deletion led with authority is applied, recorded, and resets the siblings once", () => {
    const epochB = getWipeEpoch(db, sourceId, phoneB);
    expect(judge(phoneA, ["s-1", "s-2"], true)).toEqual({
      apply: ["s-1", "s-2"],
      deferred: [],
      disputed: [],
      newlyDisputed: 0,
    });
    expect(rows()).toEqual(["s-1/a/deleted/0", "s-2/a/deleted/0"]);
    expect(getSyncState(db, sourceId, phoneB)?.last_synced_at).toBeNull();
    expect(getWipeEpoch(db, sourceId, phoneB)).toBeGreaterThan(epochB);
    // The deleter itself is not reset.
    expect(getSyncState(db, sourceId, phoneA)).toBeNull();
  });

  test("a fresh deletion without authority is deferred and leaves no trace", () => {
    const epochB = getWipeEpoch(db, sourceId, phoneB);
    expect(judge(phoneB, ["s-1"], false)).toEqual({
      apply: [],
      deferred: ["s-1"],
      disputed: [],
      newlyDisputed: 0,
    });
    expect(rows()).toEqual([]);
    expect(getWipeEpoch(db, sourceId, phoneB)).toBe(epochB);
  });

  test("a restored row is disputed until its restorer agrees; then it settles with no reset", () => {
    judge(phoneA, ["s-1"], true);
    present(phoneB, ["s-1", "s-9"]);
    expect(rows()).toEqual(["s-1/a/deleted/0", "s-1/b/restored/0"]);
    expect(listRestoredAnalyticsKeys(db, sourceId, TABLE, phoneB)).toEqual(["s-1"]);

    // The holder repeats itself: recorded, stripped, nobody reset.
    const epochB = getWipeEpoch(db, sourceId, phoneB);
    expect(judge(phoneA, ["s-1"], true)).toEqual({
      apply: [],
      deferred: [],
      disputed: ["s-1"],
      newlyDisputed: 0,
    });
    expect(getWipeEpoch(db, sourceId, phoneB)).toBe(epochB);

    // The restorer's own tombstone settles it, without authority and without a reset.
    expect(judge(phoneB, ["s-1"], false)).toEqual({
      apply: ["s-1"],
      deferred: [],
      disputed: [],
      newlyDisputed: 0,
    });
    expect(rows()).toEqual(["s-1/a/deleted/0", "s-1/b/deleted/0"]);
    expect(getWipeEpoch(db, sourceId, phoneB)).toBe(epochB);
  });

  test("a deleter that holds the row again withdraws; with another deleter standing it restores instead", () => {
    judge(phoneA, ["s-1"], true);
    present(phoneA, ["s-1"]);
    expect(rows()).toEqual([]);

    judge(phoneA, ["s-2"], true);
    judge(phoneB, ["s-2"], false);
    present(phoneA, ["s-2"]);
    expect(rows()).toEqual(["s-2/a/restored/0", "s-2/b/deleted/0"]);
  });

  test("a restorer's snapshot omissions mature under the policy; naming the row starts over", () => {
    judge(phoneA, ["s-1", "s-2"], true);
    present(phoneB, ["s-1", "s-2"]);
    const omit = (snapshot: { named: string[]; omitted: string[] }, now: number) =>
      recordAnalyticsRestorerOmissions(db, {
        sourceId,
        tableName: TABLE,
        deviceId: phoneB,
        snapshot,
        absencePolicy: POLICY,
        now,
      });
    expect(omit({ named: ["s-2"], omitted: ["s-1"] }, 10_000)).toEqual([]);
    expect(rows()).toEqual([
      "s-1/a/deleted/0",
      "s-1/b/restored/1",
      "s-2/a/deleted/0",
      "s-2/b/restored/0",
    ]);
    // Too soon to count again; then spaced and past the age: matured.
    expect(omit({ named: ["s-2"], omitted: ["s-1"] }, 10_010)).toEqual([]);
    expect(omit({ named: ["s-2"], omitted: ["s-1"] }, 10_200)).toEqual(["s-1"]);
    // Naming the row again throws the count away.
    expect(omit({ named: ["s-1", "s-2"], omitted: [] }, 10_300)).toEqual([]);
    expect(rows()).toEqual([
      "s-1/a/deleted/0",
      "s-1/b/restored/0",
      "s-2/a/deleted/0",
      "s-2/b/restored/0",
    ]);
  });

  test("histories are per table: the same key in another table is a stranger", () => {
    judge(phoneA, ["s-1"], true);
    expect(
      judgeAnalyticsTombstones(db, {
        sourceId,
        tableName: "other_table",
        deviceId: phoneB,
        existingIds: ["s-1"],
        deletionAuthority: false,
        now: 1_000,
      }).deferred,
    ).toEqual(["s-1"]);
  });

  describe("the sweep's question", () => {
    const candidate = (source: SourceId, keyValue: string) => ({
      sourceId: source,
      tableName: TABLE,
      keyValue,
    });

    test("the plan names the replicated sources and the disputed rows of a batch", () => {
      recordDeletionClaims(db, analyticsClaimNamespace(TABLE), sourceId, phoneA, ["s-1", "s-2"], 1);
      present(phoneB, ["s-1"]);
      expect(
        planAnalyticsSweep(db, [
          candidate(sourceId, "s-1"),
          candidate(sourceId, "s-2"),
          candidate(sourceId, "s-3"),
          candidate(single, "s-1"),
        ]),
      ).toEqual({
        replicatedSources: [sourceId],
        disputed: [analyticsSweepCandidateKey(candidate(sourceId, "s-1"))],
      });
    });

    test("a deletion is the observer's verdict, and the first of a batch resets every member", () => {
      const epochB = getWipeEpoch(db, sourceId, phoneB);
      recordAnalyticsSweepVerdict(
        db,
        { ...candidate(sourceId, "s-1"), observedBy: phoneA, resetMembers: true },
        5_000,
      );
      expect(rows()).toEqual(["s-1/a/deleted/0"]);
      expect(getSyncState(db, sourceId, phoneA)?.last_synced_at).toBeNull();
      expect(getSyncState(db, sourceId, phoneB)?.last_synced_at).toBeNull();
      expect(getWipeEpoch(db, sourceId, phoneB)).toBeGreaterThan(epochB);

      const epochAfter = getWipeEpoch(db, sourceId, phoneB);
      recordAnalyticsSweepVerdict(
        db,
        { ...candidate(sourceId, "s-2"), observedBy: phoneA, resetMembers: false },
        5_001,
      );
      expect(rows()).toEqual(["s-1/a/deleted/0", "s-2/a/deleted/0"]);
      expect(getWipeEpoch(db, sourceId, phoneB)).toBe(epochAfter);
    });

    test("an unattributed absence records nobody's verdict", () => {
      recordAnalyticsSweepVerdict(
        db,
        { ...candidate(sourceId, "s-1"), observedBy: "", resetMembers: false },
        5_000,
      );
      expect(rows()).toEqual([]);
    });
  });
});
