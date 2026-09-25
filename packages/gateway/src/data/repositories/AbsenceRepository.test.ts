// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The rule this file pins: a source's snapshot omitting a document is evidence,
 * not proof. Each test below fails if the gateway goes back to treating the two
 * as the same thing, or if either half of the deadline stops binding.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SourceType, type DocumentInput } from "@omnesis/types";
import {
  createDatabase,
  upsertDocuments,
  deleteDocuments,
  deleteDocumentsByIds,
  deleteAllBySource,
  deleteAllByStream,
  deleteAllByProvider,
} from "../../db.js";
import {
  applySnapshotAbsencePlan,
  computeSnapshotAbsencePlan,
  countPendingAbsences,
  listPendingAbsenceCascades,
  acknowledgeAbsenceCascade,
  listDueAbsences,
  listStaleAbsences,
  observationSpacingMs,
  reclaimStaleAbsences,
  sweepDueAbsences,
  forgetAbsenceObserver,
  SNAPSHOT_ABSENCE_AUDIT_KEEP,
  ABSENCE_WRITER_CHUNK,
  type SnapshotAbsencePolicy,
} from "./AbsenceRepository.js";
import { createDevice } from "./DeviceRepository.js";
import {
  listDisputedExternalIds,
  recordDeletionClaims,
  recordPresenceClaims,
} from "./ReplicaDeletionClaimRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const PROVIDER = "apple";
const SOURCE = "apple-notes";

/** Three corroborating snapshots, a day apart in total. The shipped defaults. */
const POLICY: SnapshotAbsencePolicy = {
  minObservations: 3,
  minAgeMs: 24 * 60 * 60_000,
  maxMarksPerSnapshot: 10_000,
};

const DAY = 24 * 60 * 60_000;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDoc(externalId: string): DocumentInput {
  return {
    providerId: PROVIDER,
    sourceId: SOURCE,
    externalId,
    title: `Note ${externalId}`,
    content: `Body of ${externalId}`,
    contentHash: `hash-${externalId}`,
    sourceCreatedAt: "2026-01-05T09:00:00.000Z",
    sourceUpdatedAt: "2026-01-05T09:00:00.000Z",
    metadata: { documentType: "note" },
  } as DocumentInput;
}

function storedIds(db: Db): string[] {
  return db
    .prepare<[], { external_id: string }>("SELECT external_id FROM documents ORDER BY external_id")
    .all()
    .map((r) => r.external_id);
}

/** What the sweep would find due if it ran at `now`. Mirrors its own query. */
function dueAt(db: Db, now: number, policy = POLICY) {
  return listDueAbsences(db, {
    dueBefore: now - policy.minAgeMs,
    minObservations: policy.minObservations,
    limit: 100,
  });
}

/** One snapshot arriving at `now`: compute the plan, apply it, return the plan. */
function snapshot(db: Db, present: string[], now: number, policy = POLICY, observedBy?: string) {
  const plan = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, present, policy, {
    now,
    observedBy,
  });
  const applied = applySnapshotAbsencePlan(db, plan);
  return { plan, applied };
}

describe("snapshot absence", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [makeDoc("note-1"), makeDoc("note-2"), makeDoc("note-3")]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("a snapshot that omits stored documents marks them and deletes nothing", () => {
    const { plan, applied } = snapshot(db, ["note-1"], Date.now());

    expect(plan.absentCount).toBe(2);
    expect(applied.marked).toBe(2);
    // The whole point: the corpus is intact.
    expect(storedIds(db)).toEqual(["note-1", "note-2", "note-3"]);
    expect(countPendingAbsences(db)).toBe(2);
  });

  test("an empty snapshot marks the whole source and still deletes nothing", () => {
    // The reproduction: a notes corpus 26 -> 0 in under a second.
    const { plan } = snapshot(db, [], Date.now());

    expect(plan.absentCount).toBe(3);
    expect(plan.storedCount).toBe(3);
    expect(storedIds(db)).toEqual(["note-1", "note-2", "note-3"]);
  });

  test("a snapshot naming a document again clears its mark", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0);
    expect(countPendingAbsences(db)).toBe(2);

    const { plan, applied } = snapshot(db, ["note-1", "note-2", "note-3"], t0 + DAY);
    expect(applied.cleared).toBe(2);
    expect(plan.absentCount).toBe(0);
    expect(countPendingAbsences(db)).toBe(0);
  });

  test("clearing touches only marks that exist, never every id in the snapshot", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0);
    // note-1 was never absent, so a snapshot naming all three has exactly two
    // marks to revoke — not three writes, and not one per snapshot id.
    const { plan } = snapshot(db, ["note-1", "note-2", "note-3"], t0 + DAY);
    expect(plan.clearDocumentIds).toHaveLength(2);
  });

  test("a mark that was cleared starts a fresh deadline rather than resuming", () => {
    const t0 = Date.now();
    snapshot(db, [], t0);
    snapshot(db, [], t0 + DAY);
    // Everything comes back, then goes away again.
    snapshot(db, ["note-1", "note-2", "note-3"], t0 + 2 * DAY);
    snapshot(db, [], t0 + 3 * DAY);

    // One observation on a clock that started at 3*DAY: nothing is due even
    // though four snapshots have now been seen.
    expect(dueAt(db, t0 + 4 * DAY)).toEqual([]);
  });

  test("the deadline needs corroboration AND elapsed time, not either one", () => {
    const t0 = Date.now();
    const spacing = observationSpacingMs(POLICY);
    snapshot(db, ["note-1"], t0);
    snapshot(db, ["note-1"], t0 + spacing);

    // Two observations, and only two spacings of elapsed time.
    expect(dueAt(db, t0 + 2 * spacing)).toEqual([]);

    snapshot(db, ["note-1"], t0 + 2 * spacing);
    // Three observations now, but the day has not passed.
    expect(dueAt(db, t0 + 2 * spacing)).toEqual([]);

    // A day later, with three observations already banked, both bind.
    const due = dueAt(db, t0 + DAY + 1);
    expect(due.map((d) => d.externalId).sort()).toEqual(["note-2", "note-3"]);
  });

  test("a source that stops syncing never ages its documents out", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0);
    // A year passes and the source never syncs again: one observation stands.
    expect(dueAt(db, t0 + 365 * DAY)).toEqual([]);
    expect(storedIds(db)).toEqual(["note-1", "note-2", "note-3"]);
  });

  test("snapshots inside the spacing window add no observation and write nothing", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0);
    // A source syncing every 30 seconds must not spend the window in an
    // afternoon: the second and third snapshots corroborate nothing.
    const second = snapshot(db, ["note-1"], t0 + 30_000);
    const third = snapshot(db, ["note-1"], t0 + 60_000);

    expect(second.applied.marked).toBe(0);
    expect(third.applied.marked).toBe(0);
    const observations = db
      .prepare<[], { observations: number }>("SELECT observations FROM document_absences")
      .all()
      .map((r) => r.observations);
    expect(observations).toEqual([1, 1]);
  });

  test("an older omission plan cannot recreate an absence after a newer recovery", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0);
    const staleOmission = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["note-1"], POLICY, {
      now: t0 + DAY,
    });
    const recovery = computeSnapshotAbsencePlan(
      db,
      PROVIDER,
      SOURCE,
      ["note-1", "note-2", "note-3"],
      POLICY,
      { now: t0 + DAY + 1 },
    );

    expect(applySnapshotAbsencePlan(db, recovery).cleared).toBe(2);
    expect(applySnapshotAbsencePlan(db, staleOmission)).toEqual({ marked: 0, cleared: 0 });
    expect(countPendingAbsences(db)).toBe(0);
  });

  test("two plans computed at one revision cannot double-count one observation window", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0);
    const first = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["note-1"], POLICY, {
      now: t0 + DAY,
    });
    const concurrent = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["note-1"], POLICY, {
      now: t0 + DAY + 1,
    });

    expect(applySnapshotAbsencePlan(db, first).marked).toBe(2);
    expect(applySnapshotAbsencePlan(db, concurrent)).toEqual({ marked: 0, cleared: 0 });
    expect(
      db
        .prepare<
          [],
          { observations: number }
        >("SELECT DISTINCT observations FROM document_absences")
        .all(),
    ).toEqual([{ observations: 2 }]);
  });

  test("an older completed observation replay adds no evidence after a newer attempt", () => {
    const t0 = Date.now();
    const first = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["note-1"], POLICY, {
      now: t0,
      observationId: "epoch-7:attempt-a",
    });
    applySnapshotAbsencePlan(db, first);

    const later = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["note-1"], POLICY, {
      now: t0 + DAY,
      observationId: "epoch-7:attempt-b",
    });
    expect(applySnapshotAbsencePlan(db, later).marked).toBe(2);

    const replay = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["note-1"], POLICY, {
      now: t0 + 2 * DAY,
      observationId: "epoch-7:attempt-a",
    });
    expect(applySnapshotAbsencePlan(db, replay)).toEqual({ marked: 0, cleared: 0 });
    expect(
      db
        .prepare<
          [],
          { observations: number }
        >("SELECT DISTINCT observations FROM document_absences")
        .all(),
    ).toEqual([{ observations: 2 }]);
  });

  test("one snapshot never records more absences than the mark ceiling", () => {
    const capped: SnapshotAbsencePolicy = { ...POLICY, maxMarksPerSnapshot: 2 };
    upsertDocuments(db, [makeDoc("note-4"), makeDoc("note-5")]);

    const { plan, applied } = snapshot(db, [], Date.now(), capped);
    expect(plan.absentCount).toBe(5);
    expect(applied.marked).toBe(2);
    expect(plan.deferredCount).toBe(3);
    expect(countPendingAbsences(db)).toBe(2);
  });

  test("the hard writer chunk bounds marks even when config allows more", () => {
    const extras = Array.from({ length: ABSENCE_WRITER_CHUNK + 5 }, (_, i) => `bulk-${i}`);
    upsertDocuments(db, extras.map(makeDoc));

    const { plan, applied } = snapshot(db, ["note-1", "note-2", "note-3"], Date.now(), {
      ...POLICY,
      maxMarksPerSnapshot: 100_000,
    });

    expect(plan.mark).toHaveLength(ABSENCE_WRITER_CHUNK);
    expect(applied.marked).toBe(ABSENCE_WRITER_CHUNK);
    expect(plan.deferredCount).toBe(5);
  });

  test("mass recovery invalidates every old deadline with one generation write", () => {
    const extras = Array.from({ length: ABSENCE_WRITER_CHUNK + 5 }, (_, i) => `recover-${i}`);
    upsertDocuments(db, extras.map(makeDoc));
    const presentBase = ["note-1", "note-2", "note-3"];
    const t0 = Date.now();
    snapshot(db, presentBase, t0, { ...POLICY, maxMarksPerSnapshot: 100_000 });
    // Inside the spacing window, existing marks cost no writer rows, so the
    // next five deferred documents receive their first mark.
    snapshot(db, presentBase, t0 + 1, { ...POLICY, maxMarksPerSnapshot: 100_000 });
    expect(countPendingAbsences(db)).toBe(extras.length);

    const recovered = snapshot(db, [...presentBase, ...extras], t0 + DAY, {
      ...POLICY,
      maxMarksPerSnapshot: 100_000,
    });

    expect(recovered.plan.clearDocumentIds).toHaveLength(ABSENCE_WRITER_CHUNK);
    expect(recovered.plan.clearCount).toBe(extras.length);
    expect(recovered.plan.invalidateGeneration).toBe(true);
    expect(recovered.applied.cleared).toBe(extras.length);
    expect(countPendingAbsences(db)).toBe(0);
    expect(dueAt(db, t0 + 2 * DAY)).toEqual([]);
    expect(
      db.prepare<[], { generation: number }>("SELECT generation FROM document_absence_scopes").get()
        ?.generation,
    ).toBe(1);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absences").get()?.n,
    ).toBe(extras.length);

    // Later source writes do no hidden ledger scan on the writer. The sweep's
    // IO-planned reclaimer owns physical cleanup independently.
    snapshot(db, [...presentBase, ...extras], t0 + DAY + 1, {
      ...POLICY,
      maxMarksPerSnapshot: 100_000,
    });
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absences").get()?.n,
    ).toBe(extras.length);
  });

  test("the sweep rejects a pre-read candidate invalidated by a mass recovery", () => {
    const extras = Array.from({ length: ABSENCE_WRITER_CHUNK + 5 }, (_, i) => `race-${i}`);
    upsertDocuments(db, extras.map(makeDoc));
    const presentBase = ["note-1", "note-2", "note-3"];
    const t0 = Date.now();
    const permissive = { ...POLICY, minObservations: 1, maxMarksPerSnapshot: 100_000 };
    snapshot(db, presentBase, t0 - DAY, permissive);
    snapshot(db, presentBase, t0 - DAY + 1, permissive);
    const candidates = listDueAbsences(db, {
      dueBefore: t0,
      minObservations: 1,
      limit: extras.length,
    });

    snapshot(db, [...presentBase, ...extras], t0, permissive);
    const physicallyStale = new Set(
      db
        .prepare<[], { document_id: string }>("SELECT document_id FROM document_absences")
        .all()
        .map((row) => row.document_id),
    );
    const staleCandidate = candidates.find((candidate) =>
      physicallyStale.has(candidate.documentId),
    );
    expect(staleCandidate).toBeDefined();

    const batch = sweep([staleCandidate!.documentId], t0);
    expect(batch).toMatchObject({ deletedDocumentIds: [], revoked: 1 });
    expect(storedIds(db)).toEqual([...presentBase, ...extras].sort());
  });

  test("stale generations are reclaimed in bounded batches without another source snapshot", () => {
    const extras = Array.from({ length: 2 * ABSENCE_WRITER_CHUNK + 5 }, (_, i) => `stale-${i}`);
    upsertDocuments(db, extras.map(makeDoc));
    const presentBase = ["note-1", "note-2", "note-3"];
    const t0 = Date.now();
    const permissive = { ...POLICY, maxMarksPerSnapshot: 100_000 };
    snapshot(db, presentBase, t0, permissive);
    snapshot(db, presentBase, t0 + 1, permissive);
    snapshot(db, presentBase, t0 + 2, permissive);
    snapshot(db, [...presentBase, ...extras], t0 + DAY, permissive);

    const first = listStaleAbsences(db, 50);
    expect(first).toHaveLength(50);
    expect(reclaimStaleAbsences(db, first)).toBe(50);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absences").get()!.n,
    ).toBe(355);
    const rest = listStaleAbsences(db, 500);
    expect(rest).toHaveLength(355);
    expect(reclaimStaleAbsences(db, rest)).toBe(355);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absences").get()!.n,
    ).toBe(0);
  });

  test("stale reclamation revalidates the candidate generation on the writer", () => {
    const extras = Array.from({ length: ABSENCE_WRITER_CHUNK + 1 }, (_, i) => `recheck-${i}`);
    upsertDocuments(db, extras.map(makeDoc));
    const presentBase = ["note-1", "note-2", "note-3"];
    const policy = { ...POLICY, maxMarksPerSnapshot: 100_000 };
    snapshot(db, presentBase, Date.now(), policy);
    snapshot(db, presentBase, Date.now() + 1, policy);
    snapshot(db, [...presentBase, ...extras], Date.now() + DAY, policy);
    const candidate = listStaleAbsences(db, 1)[0]!;
    db.prepare(
      `UPDATE document_absences SET generation =
         (SELECT generation FROM document_absence_scopes LIMIT 1)
       WHERE document_id = ?`,
    ).run(candidate.documentId);

    expect(reclaimStaleAbsences(db, [candidate])).toBe(0);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_absences WHERE document_id = ?")
        .get(candidate.documentId)!.n,
    ).toBe(1);
  });

  test("the page's own arriving documents are not counted as missing", () => {
    // A bootstrap page carries documents the plan is computed before writing.
    // Without accounting for them, every source's first sync would read as the
    // corpus having lost exactly what the source just delivered.
    const plan = computeSnapshotAbsencePlan(
      db,
      PROVIDER,
      SOURCE,
      ["note-1", "note-2", "note-3", "note-4"],
      POLICY,
      { arrivingExternalIds: ["note-4"] },
    );
    expect(plan.missingCount).toBe(0);
  });

  test("the snapshot's ids that the corpus does not hold are counted", () => {
    // 26 live ids, nothing stored: the reading a healthy no-op cannot produce.
    const empty = createDatabase(testDbPath());
    try {
      const plan = computeSnapshotAbsencePlan(
        empty,
        PROVIDER,
        SOURCE,
        Array.from({ length: 26 }, (_, i) => `note-${i}`),
        POLICY,
      );
      expect(plan.missingCount).toBe(26);
      expect(plan.storedCount).toBe(0);
      expect(plan.absentCount).toBe(0);
    } finally {
      empty.close();
    }
  });

  test("a document deleted through any other path takes its pending absence with it", () => {
    snapshot(db, ["note-1"], Date.now());
    expect(countPendingAbsences(db)).toBe(2);

    // The tombstone channel — the source asserting a deletion — still applies
    // at once, and the foreign key cleans up behind it.
    deleteDocuments(db, PROVIDER, SOURCE, ["note-2"]);
    expect(storedIds(db)).toEqual(["note-1", "note-3"]);
    expect(countPendingAbsences(db)).toBe(1);
  });

  test("the due query drives live generations through the scope index", () => {
    const plan = db
      .prepare<[number, number, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT a.document_id
           FROM document_absence_scopes AS s
           CROSS JOIN document_absences AS a INDEXED BY idx_document_absences_scope
          WHERE a.provider_id = s.provider_id
            AND a.source_id = s.source_id
            AND a.stream_id = s.stream_id
            AND a.generation = s.generation
            AND a.observations >= ? AND a.first_absent_at <= ?
          ORDER BY a.first_absent_at LIMIT ?`,
      )
      .all(0, 0, 1)
      .map((r) => r.detail)
      .join(" ");
    expect(plan).toContain("idx_document_absences_scope");
    expect(plan).not.toContain("SCAN a");
  });

  test("stale-generation cleanup seeks the scope-generation index", () => {
    const plan = db
      .prepare<[number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT a.document_id
           FROM document_absence_scopes AS s
           CROSS JOIN document_absences AS a INDEXED BY idx_document_absences_scope
          WHERE a.provider_id = s.provider_id AND a.source_id = s.source_id
            AND a.stream_id = s.stream_id AND a.generation < s.generation
          LIMIT ?`,
      )
      .all(ABSENCE_WRITER_CHUNK)
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("idx_document_absences_scope");
    expect(plan).not.toContain("SCAN a");
  });

  test("the snapshot scan seeks the exact provider/source/stream index", () => {
    const plan = db
      .prepare<[string, string, string], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id, external_id FROM documents INDEXED BY idx_documents_provider_source_stream
          WHERE provider_id = ? AND source_id = ? AND stream_id = ?`,
      )
      .all(PROVIDER, SOURCE, "")
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("idx_documents_provider_source_stream");
  });

  /** The sweep's writer half, with the deadline already spent. */
  function sweep(documentIds: string[], now = Date.now()) {
    return sweepDueAbsences(db, documentIds, {
      minObservations: 1,
      dueBefore: now,
      now,
      deleteDocumentsByIds,
    });
  }

  function pendingDocumentIds(): string[] {
    return db
      .prepare<[], { document_id: string }>(
        "SELECT document_id FROM document_absences ORDER BY external_id",
      )
      .all()
      .map((r) => r.document_id);
  }

  test("the sweep deletes a due absence and records its ids", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0 - DAY);

    const batch = sweep(pendingDocumentIds(), t0);

    expect(batch.deletedDocumentIds).toHaveLength(2);
    expect(batch.revoked).toBe(0);
    expect(storedIds(db)).toEqual(["note-1"]);
    // The absences went with their documents through the foreign key.
    expect(countPendingAbsences(db)).toBe(0);
    const row = db
      .prepare<
        [],
        { external_ids: string; document_count: number }
      >("SELECT external_ids, document_count FROM snapshot_absence_deletions")
      .get();
    expect((JSON.parse(row!.external_ids) as string[]).sort()).toEqual(["note-2", "note-3"]);
    expect(row!.document_count).toBe(2);
    expect(listPendingAbsenceCascades(db, 10)).toEqual([
      expect.objectContaining({ documentIds: expect.arrayContaining(batch.deletedDocumentIds) }),
    ]);
  });

  test("the sweep leaves a disputed replicated item alone and drops its absence instead", () => {
    const host = createDevice(db, {
      name: "mac-a",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [SourceType("apple-notes")],
        multiDeviceModes: { "apple-notes": "replicated" },
        syncLease: true,
      },
    });
    // The sweep reads the source's mode through `sources`; this suite's
    // fixtures are keyed on the bare source id, so register that row directly.
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, multi_device_mode, created_at, updated_at)
       VALUES (?, 'apple-notes', 'local', ?, 'replicated', 1, 1)`,
    ).run(SOURCE, host.id);
    // note-2 was deleted by one member and restored by another; note-3 was
    // merely omitted by the snapshot and is due like any other absence.
    recordDeletionClaims(db, PROVIDER, SOURCE, "mac-a", ["note-2"], Date.now() - DAY);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["note-2"], Date.now() - DAY + 1);
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0 - DAY, POLICY, host.id);
    expect(countPendingAbsences(db)).toBe(2);

    const batch = sweep(pendingDocumentIds(), t0);

    expect(batch.deletedDocumentIds).toHaveLength(1);
    expect(batch.disputed).toBe(1);
    expect(batch.revoked).toBe(0);
    expect(storedIds(db)).toEqual(["note-1", "note-2"]);
    expect(countPendingAbsences(db)).toBe(0);

    // The deletion of note-3 is the verdict of the member whose snapshots
    // earned it, so a member that brings note-3 back after the reset disputes
    // it rather than restarting the cycle.
    expect(
      db
        .prepare<
          [string],
          { device_id: string; role: string }
        >("SELECT device_id, role FROM replica_deletion_claims WHERE external_id = ?")
        .all("note-3"),
    ).toEqual([{ device_id: host.id, role: "deleted" }]);
    recordPresenceClaims(db, PROVIDER, SOURCE, "mac-b", ["note-3"], t0 + 1);
    expect(listDisputedExternalIds(db, PROVIDER, SOURCE, ["note-3"])).toEqual(["note-3"]);
  });

  test("an absence remembers its last observer, and an anonymous corroboration keeps it", () => {
    const t0 = Date.now();
    const observer = (externalId: string) =>
      db
        .prepare<
          [string],
          { observed_by: string }
        >("SELECT observed_by FROM document_absences WHERE external_id = ?")
        .get(externalId)?.observed_by;
    snapshot(db, ["note-1"], t0, POLICY, "mac-a");
    expect(observer("note-2")).toBe("mac-a");
    // A later holder's corroboration takes the verdict over.
    snapshot(db, ["note-1"], t0 + observationSpacingMs(POLICY), POLICY, "mac-b");
    expect(observer("note-2")).toBe("mac-b");
    // A snapshot with no observer (the shared row) corroborates without
    // erasing who observed it.
    snapshot(db, ["note-1"], t0 + 2 * observationSpacingMs(POLICY), POLICY);
    expect(observer("note-2")).toBe("mac-b");
    expect(
      db
        .prepare<
          [string],
          { observations: number }
        >("SELECT observations FROM document_absences WHERE external_id = ?")
        .get("note-2")?.observations,
    ).toBe(3);
  });

  test("forgetting an observer leaves the absence and its deadline in place", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0, POLICY, "mac-a");
    forgetAbsenceObserver(db, SOURCE, "mac-a");
    expect(
      db
        .prepare<
          [],
          { observed_by: string; observations: number }[]
        >("SELECT observed_by, observations FROM document_absences")
        .all(),
    ).toEqual([
      { observed_by: "", observations: 1 },
      { observed_by: "", observations: 1 },
    ]);
  });

  test("an absence with no observer on record carries no verdict", () => {
    const host = createDevice(db, {
      name: "mac-a",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [SourceType("apple-notes")],
        multiDeviceModes: { "apple-notes": "replicated" },
        syncLease: true,
      },
    });
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, multi_device_mode, created_at, updated_at)
       VALUES (?, 'apple-notes', 'local', ?, 'replicated', 1, 1)`,
    ).run(SOURCE, host.id);
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0 - DAY);

    const batch = sweep(pendingDocumentIds(), t0);

    expect(batch.deletedDocumentIds).toHaveLength(2);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM replica_deletion_claims").get()?.n,
    ).toBe(0);
  });

  test("the durable cascade survives partial acknowledgement and clears only after both", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0 - DAY);
    const batch = sweep(pendingDocumentIds(), t0);
    const id = batch.cascade!.id;

    acknowledgeAbsenceCascade(db, id, "index");
    expect(listPendingAbsenceCascades(db, 10)).toEqual([
      expect.objectContaining({ id, indexDone: true, cognitionDone: false }),
    ]);

    acknowledgeAbsenceCascade(db, id, "cognition");
    expect(listPendingAbsenceCascades(db, 10)).toEqual([]);
  });

  test("the sweep re-decides due-ness, so an absence revoked since the read survives", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0 - DAY);
    const candidates = pendingDocumentIds();
    // The source recovers between the sweep's read and its write.
    snapshot(db, ["note-1", "note-2", "note-3"], t0);

    const batch = sweep(candidates, t0);

    expect(batch.deletedDocumentIds).toEqual([]);
    expect(batch.revoked).toBe(2);
    expect(storedIds(db)).toEqual(["note-1", "note-2", "note-3"]);
  });

  test("the sweep refuses a candidate that has not spent its corroboration", () => {
    const t0 = Date.now();
    snapshot(db, ["note-1"], t0 - DAY);

    const batch = sweepDueAbsences(db, pendingDocumentIds(), {
      minObservations: 3,
      dueBefore: t0,
      now: t0,
      deleteDocumentsByIds,
    });

    expect(batch.deletedDocumentIds).toEqual([]);
    expect(storedIds(db)).toEqual(["note-1", "note-2", "note-3"]);
    // Nothing was deleted, so nothing was claimed to have been.
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM snapshot_absence_deletions").get()!
        .n,
    ).toBe(0);
  });

  test("the audit trail stays bounded", () => {
    for (let i = 0; i < SNAPSHOT_ABSENCE_AUDIT_KEEP + 5; i++) {
      upsertDocuments(db, [makeDoc(`filler-${i}`)]);
      const t = Date.now() + i;
      snapshot(db, ["note-1", "note-2", "note-3"], t - DAY);
      sweep(pendingDocumentIds(), t);
    }
    const kept = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM snapshot_absence_deletions")
      .get();
    expect(kept!.n).toBe(SNAPSHOT_ABSENCE_AUDIT_KEEP);
  });

  test("absences stay inside their own stream", () => {
    upsertDocuments(db, [makeDoc("note-1")], { streams: { [SOURCE]: "phone-b" } });
    const plan = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, [], POLICY, {
      streamId: "phone-b",
    });
    applySnapshotAbsencePlan(db, plan);

    expect(plan.absentCount).toBe(1);
    const marked = db
      .prepare<[], { stream_id: string }>("SELECT stream_id FROM document_absences")
      .all()
      .map((r) => r.stream_id);
    expect(marked).toEqual(["phone-b"]);
  });

  test("source, stream, and provider wipes remove their reconcile scope state", () => {
    db.prepare("DELETE FROM document_absence_scopes").run();
    db.prepare("DELETE FROM document_absence_observations").run();
    const insert = db.prepare(
      `INSERT INTO document_absence_scopes
         (provider_id, source_id, stream_id, generation, revision)
       VALUES (?, ?, ?, 0, 1)`,
    );
    insert.run("google", "gmail", "phone-a");
    insert.run("google", "gmail", "phone-b");
    insert.run("apple", "notes", "phone-c");
    const insertObservation = db.prepare(
      `INSERT INTO document_absence_observations
         (provider_id, source_id, stream_id, observation_id, created_at)
       VALUES (?, ?, ?, ?, 1)`,
    );
    insertObservation.run("google", "gmail", "phone-a", "attempt-a");
    insertObservation.run("google", "gmail", "phone-b", "attempt-b");
    insertObservation.run("apple", "notes", "phone-c", "attempt-c");

    deleteAllByStream(db, "gmail", "phone-a");
    expect(
      db
        .prepare<
          [],
          { stream_id: string }
        >("SELECT stream_id FROM document_absence_scopes ORDER BY stream_id")
        .all(),
    ).toEqual([{ stream_id: "phone-b" }, { stream_id: "phone-c" }]);
    expect(
      db
        .prepare<
          [],
          { stream_id: string }
        >("SELECT stream_id FROM document_absence_observations ORDER BY stream_id")
        .all(),
    ).toEqual([{ stream_id: "phone-b" }, { stream_id: "phone-c" }]);

    deleteAllByProvider(db, "google");
    expect(
      db.prepare<[], { source_id: string }>("SELECT source_id FROM document_absence_scopes").all(),
    ).toEqual([{ source_id: "notes" }]);
    expect(
      db
        .prepare<[], { source_id: string }>("SELECT source_id FROM document_absence_observations")
        .all(),
    ).toEqual([{ source_id: "notes" }]);

    deleteAllBySource(db, "notes");
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absence_scopes").get()!.n,
    ).toBe(0);
    expect(
      db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absence_observations")
        .get()!.n,
    ).toBe(0);
  });
});

/**
 * A snapshot that vouches for some of the source's stores and not others.
 *
 * The whole-source form is all-or-nothing: one unreadable address book out of
 * three withholds deletion detection for the two that were read, indefinitely.
 * A claim narrows the assertion to the stores it names, so the two keep
 * reconciling while the third is left exactly alone.
 */
describe("per-partition snapshot claims", () => {
  let db: Db;
  let dbPath: string;

  function inPartition(externalId: string, partitionKey: string): DocumentInput {
    return { ...makeDoc(externalId), partitionKey } as DocumentInput;
  }

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      inPartition("home-1", "books/home"),
      inPartition("home-2", "books/home"),
      inPartition("work-1", "books/work"),
      inPartition("locked-1", "books/locked"),
    ]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function claim(partitions: string[], present: string[], now: number) {
    const plan = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, present, POLICY, {
      now,
      claimedPartitions: partitions,
    });
    return { plan, applied: applySnapshotAbsencePlan(db, plan) };
  }

  test("a claimed partition's omission is marked", () => {
    const { plan } = claim(["books/home"], ["home-1"], Date.now());
    expect(plan.absentCount).toBe(1);
    expect(plan.mark.map((m) => m.externalId)).toEqual(["home-2"]);
  });

  test("an unclaimed partition's documents are untouched", () => {
    // The point of the whole exercise: `books/locked` could not be read, so
    // nothing in it is evidence of anything.
    const { plan } = claim(
      ["books/home", "books/work"],
      ["home-1", "home-2", "work-1"],
      Date.now(),
    );
    expect(plan.absentCount).toBe(0);
    expect(plan.mark).toEqual([]);
  });

  test("a claim never marks a sibling partition, even when it names nothing", () => {
    const { plan } = claim(["books/home"], [], Date.now());
    expect(plan.mark.map((m) => m.externalId).sort()).toEqual(["home-1", "home-2"]);
  });

  test("claiming nothing asserts nothing about anything", () => {
    const { plan } = claim([], [], Date.now());
    expect(plan.absentCount).toBe(0);
    expect(plan.mark).toEqual([]);
  });

  test("the unnamed partition is a partition, and can be claimed by name", () => {
    upsertDocuments(db, [makeDoc("unfiled-1")]);
    const { plan } = claim([""], [], Date.now());
    expect(plan.mark.map((m) => m.externalId)).toEqual(["unfiled-1"]);
  });

  test("a document that moved out of a claimed partition stops being swept", () => {
    // It left `books/home` for the store that would not open. A claim on
    // `books/home` that omits it is then correct rather than a deletion: the
    // document is not in the partition being vouched for.
    upsertDocuments(db, [inPartition("home-2", "books/locked")]);
    const { plan } = claim(["books/home"], ["home-1"], Date.now());
    expect(plan.mark).toEqual([]);
  });

  test("a whole-source snapshot still judges every partition", () => {
    // The unscoped form is unchanged, which is what every source that has not
    // adopted claims keeps doing.
    const plan = computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["home-1"], POLICY, {
      now: Date.now(),
    });
    expect(plan.mark.map((m) => m.externalId).sort()).toEqual(["home-2", "locked-1", "work-1"]);
  });

  test("a reappearance in a claimed partition revokes its deadline", () => {
    const t0 = Date.now();
    claim(["books/home"], ["home-1"], t0);
    const { applied } = claim(["books/home"], ["home-1", "home-2"], t0 + DAY);
    expect(applied.cleared).toBe(1);
  });

  test("a mass recovery in one partition resets an unclaimed partition's clock", () => {
    // The scope generation is stream-wide, so the O(1) revocation a mass
    // recovery uses reaches partitions this snapshot never read. Their marks
    // are dropped and their clocks restart — which delays a deletion and can
    // never cause one. The alternative, leaving revoked deadlines standing
    // because the id list was full, deletes documents the source just
    // re-vouched for.
    const t0 = Date.now();
    const bulk = Array.from({ length: ABSENCE_WRITER_CHUNK + 5 }, (_, i) => `home-bulk-${i}`);
    upsertDocuments(
      db,
      bulk.map((id) => inPartition(id, "books/home")),
    );
    const generous = { ...POLICY, maxMarksPerSnapshot: 100_000 };

    // `locked-1` earns a mark from a whole-source read, and the home
    // partition's bulk goes absent alongside it.
    applySnapshotAbsencePlan(
      db,
      computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["home-1", "home-2", "work-1"], generous, {
        now: t0,
      }),
    );
    applySnapshotAbsencePlan(
      db,
      computeSnapshotAbsencePlan(db, PROVIDER, SOURCE, ["home-1", "home-2", "work-1"], generous, {
        now: t0 + 1,
      }),
    );
    expect(countPendingAbsences(db)).toBe(bulk.length + 1);

    // The home store comes back in full; the locked one is still unread.
    const plan = computeSnapshotAbsencePlan(
      db,
      PROVIDER,
      SOURCE,
      ["home-1", "home-2", ...bulk],
      generous,
      { now: t0 + DAY, claimedPartitions: ["books/home"] },
    );
    expect(plan.invalidateGeneration).toBe(true);
    applySnapshotAbsencePlan(db, plan);

    expect(countPendingAbsences(db)).toBe(0);
  });

  test("an unclaimed partition's pending absence is neither corroborated nor cleared", () => {
    const t0 = Date.now();
    // Mark `locked-1` through a whole-source snapshot, then stop claiming its
    // partition. Its clock must simply stop rather than keep running on
    // evidence nobody gave.
    const first = computeSnapshotAbsencePlan(
      db,
      PROVIDER,
      SOURCE,
      ["home-1", "home-2", "work-1"],
      POLICY,
      {
        now: t0,
      },
    );
    applySnapshotAbsencePlan(db, first);

    const { plan, applied } = claim(
      ["books/home", "books/work"],
      ["home-1", "home-2", "work-1"],
      t0 + DAY,
    );
    expect(plan.absentCount).toBe(0);
    expect(applied.cleared).toBe(0);
  });
});
