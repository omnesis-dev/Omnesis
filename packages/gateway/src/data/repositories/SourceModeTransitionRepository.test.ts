// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vitest";
import { AccountId, ProviderId, SourceType } from "@omnesis/types";
import {
  beginSyncAttempt,
  createDatabase,
  getWipeEpoch,
  setSyncState,
  upsertDocuments,
  upsertWithCursor,
} from "../../db.js";
import { createDevice, updateDeviceCapabilities } from "./DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  deleteSource,
  effectiveSourceConfig,
  getSourceMemberConfigOverride,
  getSource,
  markSourceRemoved,
  removeSourceMember,
  setSourceMemberConfigOverride,
  updateSource,
} from "./SourceRepository.js";
import { enqueueSourceStreamCleanup } from "./SourceStreamCleanupRepository.js";
import { getSourceMemberConfigContract } from "./SourceMemberConfigContractRepository.js";
import {
  adoptSourceModeTransitionBatch,
  finalizeSourceModeTransition,
  getSourceModeTransition,
  listPendingSourceModeTransitions,
  prepareSourceModeTransition,
} from "./SourceModeTransitionRepository.js";
import type { SourceId } from "@omnesis/types";

function drainSqliteAdoption(db: ReturnType<typeof createDatabase>, sourceId: SourceId) {
  for (;;) {
    const batch = adoptSourceModeTransitionBatch(db, sourceId);
    if (batch.complete) return;
  }
}

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const owner = createDevice(db, {
    name: "collector-north",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "partitioned" },
      memberScopedParams: { "notes-synth": ["dataPath"] },
    },
  });
  const source = createSource(db, {
    type: SourceType("notes-synth"),
    accountId: AccountId("fictional"),
    deviceId: owner.id,
    multiDeviceMode: "exclusive",
  });
  return { db, owner, source };
}

describe("source mode transition journal", () => {
  test("a legacy exclusive source pins the owner's contract after the owner upgrades", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const owner = createDevice(db, {
      name: "collector-legacy",
      kind: "collector",
      capabilities: { hostableSourceTypes: [SourceType("notes-synth")] },
    });
    const source = createSource(db, {
      type: SourceType("notes-synth"),
      accountId: AccountId("legacy-fictional"),
      deviceId: owner.id,
      multiDeviceMode: "exclusive",
    });
    expect(getSourceMemberConfigContract(db, source.id)).toBeNull();

    updateDeviceCapabilities(db, owner.id, {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "partitioned" },
      memberScopedParams: { "notes-synth": ["sessionsPath"] },
    });
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);

    expect(getSourceMemberConfigContract(db, source.id)).toEqual(["sessionsPath"]);
  });

  test("prepare atomically promotes legacy member-local params into the owner override", () => {
    const { db, owner, source } = fixture();
    updateDeviceCapabilities(db, owner.id, {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "partitioned" },
      memberScopedParams: { "notes-synth": ["cachePath", "dataPath"] },
    });
    updateSource(db, source.id, {
      config: {
        syncInterval: "5m",
        params: {
          cachePath: "/srv/fictional-owner/cache",
          dataPath: "/srv/fictional-owner/archive",
          sharedLabel: "fictional-team",
        },
      },
    });
    setSourceMemberConfigOverride(db, source.id, owner.id, {
      params: { dataPath: "/srv/fictional-owner/selected-archive" },
    });
    const sibling = createSource(db, {
      type: SourceType("notes-synth"),
      accountId: AccountId("fictional-sibling"),
      deviceId: owner.id,
      multiDeviceMode: "exclusive",
    });
    setSourceMemberConfigOverride(db, sibling.id, owner.id, {
      params: { dataPath: "/srv/fictional-sibling/archive" },
    });
    const before = getSource(db, source.id)!;
    const beforeEffective = effectiveSourceConfig(
      before.config,
      getSourceMemberConfigOverride(db, source.id, owner.id)!,
    );

    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123, [
      "cachePath",
      "dataPath",
    ]);

    const shared = getSource(db, source.id)!;
    const ownerOverride = getSourceMemberConfigOverride(db, source.id, owner.id)!;
    expect(shared.config).toEqual({
      syncInterval: "5m",
      params: { sharedLabel: "fictional-team" },
    });
    expect(ownerOverride).toEqual({
      params: {
        cachePath: "/srv/fictional-owner/cache",
        dataPath: "/srv/fictional-owner/selected-archive",
      },
    });
    expect(effectiveSourceConfig(shared.config, ownerOverride)).toEqual(beforeEffective);
    expect(getSourceMemberConfigOverride(db, sibling.id, owner.id)).toEqual({
      params: { dataPath: "/srv/fictional-sibling/archive" },
    });

    // Retrying prepare after a process interruption is a no-op for both halves
    // of the move rather than deleting or duplicating the promoted value.
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 124, [
      "cachePath",
      "dataPath",
    ]);
    expect(getSource(db, source.id)?.config).toEqual(shared.config);
    expect(getSourceMemberConfigOverride(db, source.id, owner.id)).toEqual(ownerOverride);
  });

  test("prepare fences the shared and future owner cursors while keeping the source exclusive", () => {
    const { db, owner, source } = fixture();
    const sharedBefore = beginSyncAttempt(db, source.id, "");
    const ownerBefore = getWipeEpoch(db, source.id, owner.id);

    const pending = prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);

    expect(pending).toMatchObject({
      sourceId: source.id,
      fromMode: "exclusive",
      toMode: "partitioned",
      ownerDeviceId: owner.id,
      preparedAt: 123,
    });
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getWipeEpoch(db, source.id, "")).toBeGreaterThan(sharedBefore);
    expect(getWipeEpoch(db, source.id, owner.id)).toBeGreaterThan(ownerBefore);
    expect(
      upsertWithCursor(db, {
        providerId: "notes-synth",
        sourceId: source.id,
        documents: [],
        cursor: { stale: true },
        hasMore: false,
        wipeEpoch: sharedBefore,
        streamId: "",
        cursorDeviceId: "",
      }).rejected,
    ).toBe(true);
  });

  test("an old shared-page epoch stays stale after finalize reroutes writes to the owner scope", () => {
    const { db, owner, source } = fixture();
    const oldSharedEpoch = beginSyncAttempt(db, source.id, "");

    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);
    drainSqliteAdoption(db, source.id);
    finalizeSourceModeTransition(db, source.id, 456);

    expect(getWipeEpoch(db, source.id, owner.id)).toBeGreaterThan(oldSharedEpoch);
    expect(
      upsertWithCursor(db, {
        providerId: "notes-synth",
        sourceId: source.id,
        documents: [],
        cursor: { stale: true },
        hasMore: false,
        wipeEpoch: oldSharedEpoch,
        streamId: owner.id,
        cursorDeviceId: owner.id,
      }).rejected,
    ).toBe(true);
  });

  test("prepare assigns both cursor scopes one generation above every prior scope", () => {
    const { db, owner, source } = fixture();
    beginSyncAttempt(db, source.id, "");
    beginSyncAttempt(db, source.id, owner.id);
    beginSyncAttempt(db, source.id, owner.id);
    const priorMax = beginSyncAttempt(db, source.id, owner.id);

    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);

    expect(getWipeEpoch(db, source.id, "")).toBe(priorMax + 1);
    expect(getWipeEpoch(db, source.id, owner.id)).toBe(priorMax + 1);
  });

  test("a prepared transition atomically refuses queued lifecycle writes", () => {
    const { db, owner, source } = fixture();
    const other = createDevice(db, {
      name: "collector-south",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [SourceType("notes-synth")],
        multiDeviceModes: { "notes-synth": "partitioned" },
      },
    });
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);

    expect(updateSource(db, source.id, { deviceId: other.id })).toBeNull();
    expect(updateSource(db, source.id, { enabled: false })).toBeNull();
    expect(addSourceMember(db, source.id, other.id)).toBe(false);
    expect(removeSourceMember(db, source.id, owner.id)).toMatchObject({
      removed: false,
      reason: "transition-pending",
    });
    expect(deleteSource(db, source.id)).toBe(false);

    expect(getSource(db, source.id)).toMatchObject({
      deviceId: owner.id,
      enabled: true,
      multiDeviceMode: "exclusive",
    });
    expect(getSourceModeTransition(db, source.id)).not.toBeNull();
  });

  test("finalize refuses a journal whose owner or membership authority drifted", () => {
    const { db, owner, source } = fixture();
    const other = createDevice(db, {
      name: "collector-south",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [SourceType("notes-synth")],
        multiDeviceModes: { "notes-synth": "partitioned" },
      },
    });
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);
    drainSqliteAdoption(db, source.id);

    db.prepare("UPDATE sources SET device_id = ? WHERE id = ?").run(other.id, source.id);
    db.prepare(
      "INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, 124)",
    ).run(source.id, other.id);

    expect(() => finalizeSourceModeTransition(db, source.id, 456)).toThrow(/owner.*changed/i);
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).not.toBeNull();
  });

  test("finalize refuses when the owner no longer advertises the target mode", () => {
    const { db, owner, source } = fixture();
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);
    drainSqliteAdoption(db, source.id);
    updateDeviceCapabilities(db, owner.id, {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "exclusive" },
    });

    expect(() => finalizeSourceModeTransition(db, source.id, 456)).toThrow(
      /no longer supports partitioned/i,
    );
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).not.toBeNull();
  });

  test("finalize refuses when the owner drops the prepared member-config contract", () => {
    const { db, owner, source } = fixture();
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);
    drainSqliteAdoption(db, source.id);
    updateDeviceCapabilities(db, owner.id, {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "partitioned" },
    });

    expect(() => finalizeSourceModeTransition(db, source.id, 456)).toThrow(
      /member-local configuration contract/i,
    );
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).not.toBeNull();
  });

  test("finalize refuses when the owner was revoked during adoption", () => {
    const { db, owner, source } = fixture();
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);
    drainSqliteAdoption(db, source.id);
    db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(owner.id);

    expect(() => finalizeSourceModeTransition(db, source.id, 456)).toThrow(
      /owner no longer supports partitioned/i,
    );
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).not.toBeNull();
  });

  test("finalize adopts every SQLite stream-scoped row and the shared cursor atomically", () => {
    const { db, owner, source } = fixture();
    upsertDocuments(db, [
      {
        providerId: ProviderId("notes-synth"),
        sourceId: source.id,
        externalId: "entry-1",
        title: "Fictional entry",
        content: "Synthetic body",
        contentHash: "hash-1",
        metadata: {},
        sourceCreatedAt: "1970-01-01T00:00:00.000Z",
        sourceUpdatedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
    db.prepare(
      `INSERT INTO removed_documents
         (provider_id, source_id, external_id, stream_id, removed_at)
       VALUES (?, ?, 'entry-removed', '', 10)`,
    ).run("notes-synth", source.id);
    db.prepare(
      `INSERT OR REPLACE INTO document_absence_scopes
         (provider_id, source_id, stream_id, generation, revision)
       VALUES (?, ?, '', 2, 3)`,
    ).run("notes-synth", source.id);
    db.prepare(
      `INSERT INTO document_absences
         (document_id, provider_id, source_id, stream_id, external_id,
          first_absent_at, last_absent_at, observations)
       SELECT id, provider_id, source_id, stream_id, external_id, 10, 11, 1
         FROM documents WHERE source_id = ? LIMIT 1`,
    ).run(source.id);
    db.prepare(
      `INSERT INTO document_absence_observations
         (provider_id, source_id, stream_id, observation_id, created_at)
       VALUES (?, ?, '', 'snapshot-1', 11)`,
    ).run("notes-synth", source.id);
    db.prepare(
      `INSERT INTO snapshot_absence_deletions
         (deleted_at, provider_id, source_id, stream_id, external_ids, document_count)
       VALUES (12, ?, ?, '', '["entry-old"]', 1)`,
    ).run("notes-synth", source.id);
    setSyncState(db, source.id, { cursor: { page: 7 } });
    db.prepare(
      `UPDATE sync_state
          SET icon = 'fictional-icon', label = 'Fictional notes',
              bg_color = '#112233', accent_color = '#445566'
        WHERE source_id = ? AND device_id = ''`,
    ).run(source.id);
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);
    drainSqliteAdoption(db, source.id);

    const transitioned = finalizeSourceModeTransition(db, source.id, 456);

    expect(transitioned.multiDeviceMode).toBe("partitioned");
    expect(getSourceModeTransition(db, source.id)).toBeNull();
    for (const table of [
      "documents",
      "removed_documents",
      "document_absences",
      "document_absence_scopes",
      "document_absence_observations",
      "snapshot_absence_deletions",
    ]) {
      expect(
        db.prepare(`SELECT DISTINCT stream_id FROM ${table} WHERE source_id = ?`).all(source.id),
      ).toEqual([{ stream_id: owner.id }]);
    }
    expect(
      db
        .prepare("SELECT device_id, cursor FROM sync_state WHERE source_id = ? AND device_id = ?")
        .all(source.id, owner.id),
    ).toEqual([{ device_id: owner.id, cursor: '{"cursor":{"page":7}}' }]);
    expect(
      db
        .prepare(
          `SELECT cursor, last_synced_at, icon, label, bg_color, accent_color,
                  minimum_gateway_version
             FROM sync_state WHERE source_id = ? AND device_id = ''`,
        )
        .get(source.id),
    ).toEqual({
      cursor: "{}",
      last_synced_at: null,
      icon: "fictional-icon",
      label: "Fictional notes",
      bg_color: "#112233",
      accent_color: "#445566",
      minimum_gateway_version: 0,
    });
    expect(listPendingSourceModeTransitions(db)).toEqual([]);
  });

  test("exclusive to replicated preserves shared history while adopting the owner cursor", () => {
    const { db, owner, source } = fixture();
    updateDeviceCapabilities(db, owner.id, {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "replicated" },
      memberScopedParams: { "notes-synth": ["dataPath"] },
      syncLease: true,
    });
    upsertDocuments(db, [
      {
        providerId: ProviderId("notes-synth"),
        sourceId: source.id,
        externalId: "shared-entry",
        title: "Fictional shared entry",
        content: "Synthetic replicated body",
        contentHash: "replicated-hash",
        metadata: {},
        sourceCreatedAt: "1970-01-01T00:00:00.000Z",
        sourceUpdatedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
    setSyncState(db, source.id, { cursor: { page: 7 } });

    const pending = prepareSourceModeTransition(db, source.id, "replicated", owner.id, 123);

    expect(pending?.toMode).toBe("replicated");
    expect(adoptSourceModeTransitionBatch(db, source.id)).toEqual({ moved: 0, complete: true });
    const transitioned = finalizeSourceModeTransition(db, source.id, 456);

    expect(transitioned.multiDeviceMode).toBe("replicated");
    expect(
      db.prepare("SELECT stream_id FROM documents WHERE source_id = ?").all(source.id),
    ).toEqual([{ stream_id: "" }]);
    expect(
      db
        .prepare("SELECT cursor FROM sync_state WHERE source_id = ? AND device_id = ?")
        .get(source.id, owner.id),
    ).toEqual({ cursor: '{"cursor":{"page":7}}' });
    expect(
      db
        .prepare("SELECT cursor FROM sync_state WHERE source_id = ? AND device_id = ''")
        .get(source.id),
    ).toEqual({ cursor: "{}" });
    expect(getSourceModeTransition(db, source.id)).toBeNull();
    expect(prepareSourceModeTransition(db, source.id, "replicated", owner.id, 789)).toBeNull();
    expect(getSourceModeTransition(db, source.id)).toBeNull();
  });

  test("adopts at most the fixed batch size and derives restart progress from shared rows", () => {
    const { db, owner, source } = fixture();
    const insert = db.prepare(
      `INSERT INTO removed_documents
         (provider_id, source_id, external_id, stream_id, removed_at)
       VALUES ('notes-synth', ?, ?, '', 10)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 101; index += 1) insert.run(source.id, `entry-${index}`);
    })();
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123);

    expect(adoptSourceModeTransitionBatch(db, source.id)).toEqual({ moved: 100, complete: false });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM removed_documents WHERE source_id = ? AND stream_id = ''",
        )
        .get(source.id),
    ).toEqual({ n: 1 });

    // A new repository call has no in-memory progress token: the remaining
    // shared row is the durable checkpoint after a process restart.
    expect(adoptSourceModeTransitionBatch(db, source.id)).toEqual({ moved: 1, complete: false });
    expect(adoptSourceModeTransitionBatch(db, source.id)).toEqual({ moved: 0, complete: true });
    finalizeSourceModeTransition(db, source.id, 456);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM removed_documents WHERE source_id = ? AND stream_id = ?",
        )
        .get(source.id, owner.id),
    ).toEqual({ n: 101 });
  });

  test("every bounded-adoption candidate predicate is index-served", () => {
    const { db } = fixture();
    for (const table of [
      "documents",
      "removed_documents",
      "document_absences",
      "document_absence_scopes",
      "document_absence_observations",
      "snapshot_absence_deletions",
    ]) {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM ${table}
            WHERE source_id = ? AND stream_id = '' LIMIT 100`,
        )
        .all("source") as Array<{ detail: string }>;
      expect(plan.map((step) => step.detail).join("\n")).toContain(`idx_${table}_source_stream`);
      expect(plan.map((step) => step.detail).join("\n")).not.toMatch(/\bSCAN\b/);
      const ambiguityPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM ${table}
            INDEXED BY idx_${table}_source_nonshared_stream
            WHERE source_id = ? AND stream_id != '' LIMIT 1`,
        )
        .all("source") as Array<{ detail: string }>;
      expect(ambiguityPlan.map((step) => step.detail).join("\n")).toContain(
        `idx_${table}_source_nonshared_stream`,
      );
      expect(ambiguityPlan.map((step) => step.detail).join("\n")).not.toMatch(/\bSCAN\b/);
    }
    const cursorPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT device_id FROM sync_state
          INDEXED BY idx_sync_state_source_nonshared_device
          WHERE source_id = ? AND device_id != '' LIMIT 1`,
      )
      .all("source") as Array<{ detail: string }>;
    expect(cursorPlan.map((step) => step.detail).join("\n")).toContain(
      "idx_sync_state_source_nonshared_device",
    );
    expect(cursorPlan.map((step) => step.detail).join("\n")).not.toMatch(/\bSCAN\b/);
  });

  test("ambiguous pre-existing streams refuse before journaling or fencing", () => {
    const { db, owner, source } = fixture();
    db.prepare(
      `INSERT INTO removed_documents
         (provider_id, source_id, external_id, stream_id, removed_at)
       VALUES (?, ?, 'entry-other', ?, 10)`,
    ).run("notes-synth", source.id, "00000000-0000-4000-8000-000000000099");
    const sharedBefore = getWipeEpoch(db, source.id, "");

    expect(() => prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 123)).toThrow(
      /already has partitioned stream data/,
    );
    expect(getSourceModeTransition(db, source.id)).toBeNull();
    expect(getWipeEpoch(db, source.id, "")).toBe(sharedBefore);

    db.prepare("DELETE FROM removed_documents WHERE source_id = ?").run(source.id);
    db.prepare("INSERT INTO sync_state (source_id, device_id, cursor) VALUES (?, ?, '{}')").run(
      source.id,
      "00000000-0000-4000-8000-000000000099",
    );
    expect(() => prepareSourceModeTransition(db, source.id, "partitioned", owner.id, 124)).toThrow(
      /already has a per-device cursor/,
    );
  });

  test("prepare refuses removal and stream-cleanup work already holding the source", () => {
    const first = fixture();
    enqueueSourceStreamCleanup(first.db, first.source.id, first.owner.id);
    expect(() =>
      prepareSourceModeTransition(first.db, first.source.id, "partitioned", first.owner.id),
    ).toThrow(/stream cleanup is still pending/);
    expect(getSourceModeTransition(first.db, first.source.id)).toBeNull();

    const second = fixture();
    markSourceRemoved(second.db, second.source.id, { cleanupPending: true });
    expect(() =>
      prepareSourceModeTransition(second.db, second.source.id, "partitioned", second.owner.id),
    ).toThrow(/removal is still pending/);
    expect(getSourceModeTransition(second.db, second.source.id)).toBeNull();
  });
});
