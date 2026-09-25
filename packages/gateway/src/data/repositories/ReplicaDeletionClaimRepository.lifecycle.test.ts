// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the rest of the gateway touches the replica deletion ledger: the
 * member lifecycle that voids verdicts, the cursor resets that withdraw a
 * member's restores, the source wipe, and the writer's refusal of a fresh
 * deletion a member without authority tried to lead.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import {
  AccountId,
  SourceType,
  type DeviceId,
  type DocumentInput,
  type SourceId,
} from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDatabase,
  deleteAllBySource,
  upsertWithCursor,
  upsertWithCursorYieldable,
} from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  removeSourceMember,
  updateSource,
} from "./SourceRepository.js";
import { getWipeEpoch, resetMemberCursor } from "./SyncStateRepository.js";
import { recordDeletionClaims, recordPresenceClaims } from "./ReplicaDeletionClaimRepository.js";
import type { Db } from "../types.js";

const TYPE = SourceType("apple-notes");
const PROVIDER = "apple";

function doc(sourceId: string, externalId: string): DocumentInput {
  return {
    providerId: PROVIDER,
    sourceId,
    externalId,
    title: `Note ${externalId}`,
    content: `Body of ${externalId}`,
    contentHash: `hash-${externalId}`,
    sourceCreatedAt: "2026-01-05T09:00:00.000Z",
    sourceUpdatedAt: "2026-01-05T09:00:00.000Z",
    metadata: { documentType: "note" },
  } as DocumentInput;
}

describe("replica deletion claims across the member lifecycle", () => {
  let db: Db;
  let dbPath: string;
  let sourceId: SourceId;
  let macA: DeviceId;
  let macB: DeviceId;

  const rows = () =>
    db
      .prepare<[string], { external_id: string; device_id: string; role: string }>(
        "SELECT external_id, device_id, role FROM replica_deletion_claims WHERE source_id = ? ORDER BY external_id, device_id",
      )
      .all(sourceId)
      .map((r) => `${r.external_id}/${r.device_id}/${r.role}`)
      .sort();
  const host = (name: string) =>
    createDevice(db, {
      name: `${name}-${randomUUID()}`,
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [TYPE],
        multiDeviceModes: { [TYPE]: "replicated" },
        syncLease: true,
      },
    }).id;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    macA = host("mac-a");
    macB = host("mac-b");
    sourceId = createSource(db, {
      type: TYPE,
      accountId: AccountId("local"),
      deviceId: macA,
      multiDeviceMode: "replicated",
    }).id;
    addSourceMember(db, sourceId, macB);
    recordDeletionClaims(db, PROVIDER, sourceId, macA, ["n-1", "n-2"], 1);
    recordPresenceClaims(db, PROVIDER, sourceId, macB, ["n-1"], 2);
    expect(rows()).toEqual(
      [`n-1/${macA}/deleted`, `n-1/${macB}/restored`, `n-2/${macA}/deleted`].sort(),
    );
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  test("a detached member's verdicts are void", () => {
    expect(removeSourceMember(db, sourceId, macB)).toMatchObject({ removed: true });
    expect(rows()).toEqual([`n-1/${macA}/deleted`, `n-2/${macA}/deleted`].sort());
  });

  test("a re-home leaves one host and no history", () => {
    updateSource(db, sourceId, { deviceId: macB });
    expect(rows()).toEqual([]);
  });

  test("a source wipe clears the history", () => {
    deleteAllBySource(db, sourceId);
    expect(rows()).toEqual([]);
  });

  test("a per-member reset withdraws that member's restores and keeps every deletion", () => {
    resetMemberCursor(db, sourceId, macB);
    expect(rows()).toEqual([`n-1/${macA}/deleted`, `n-2/${macA}/deleted`].sort());
  });

  test("a member without authority naming a fresh, existing item is refused before anything is written", () => {
    upsertWithCursor(db, {
      providerId: PROVIDER,
      sourceId,
      documents: [doc(sourceId, "n-3")],
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: macA,
      replicaClaimDeviceId: macA,
    });
    const result = upsertWithCursor(db, {
      providerId: PROVIDER,
      sourceId,
      documents: [doc(sourceId, "n-4")],
      deletedExternalIds: ["n-3"],
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: macB,
      replicaClaimDeviceId: macB,
      deletionAuthority: false,
      wipeEpoch: getWipeEpoch(db, sourceId, macB),
    });
    expect(result).toMatchObject({ rejected: true, deletionDeferred: true });
    const stored = db
      .prepare<[string], { external_id: string }>(
        "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
      )
      .all(sourceId)
      .map((r) => r.external_id);
    expect(stored).toEqual(["n-3"]);
    expect(rows()).toEqual(
      [`n-1/${macA}/deleted`, `n-1/${macB}/restored`, `n-2/${macA}/deleted`].sort(),
    );
  });

  test("a detached member is nobody's observer any more", () => {
    upsertWithCursor(db, {
      providerId: PROVIDER,
      sourceId,
      documents: [doc(sourceId, "n-3")],
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: macA,
      replicaClaimDeviceId: macA,
    });
    const docId = db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = ? AND external_id = 'n-3'")
      .get(sourceId)!.id;
    db.prepare(
      `INSERT INTO document_absences
         (document_id, provider_id, source_id, stream_id, external_id, first_absent_at, last_absent_at, observations, observed_by)
       VALUES (?, ?, ?, '', 'n-3', 1, 1, 1, ?)`,
    ).run(docId, PROVIDER, sourceId, macB);
    removeSourceMember(db, sourceId, macB);
    expect(
      db
        .prepare<
          [string],
          { observed_by: string }
        >("SELECT observed_by FROM document_absences WHERE document_id = ?")
        .get(docId)?.observed_by,
    ).toBe("");
  });

  test("a page that yields between chunks counts a restorer's omission exactly once", () => {
    // mac-b keeps n-1 alive; its bootstrap arrives as three chunks with a
    // yield after the first, and its snapshot omits n-1.
    const policy = { minObservations: 3, minAgeMs: 24 * 60 * 60_000, maxMarksPerSnapshot: 200 };
    const args = {
      providerId: PROVIDER,
      sourceId,
      documents: [doc(sourceId, "n-4"), doc(sourceId, "n-5"), doc(sourceId, "n-6")],
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: macB,
      streamId: "",
      replicaClaimDeviceId: macB,
      deletionAuthority: false,
      restorerSnapshot: { omitted: ["n-1"], named: [] },
      absencePolicy: policy,
      wipeEpoch: getWipeEpoch(db, sourceId, macB),
    };
    let requests = 0;
    const token = {
      requested: () => {
        requests += 1;
        return requests === 1;
      },
    };
    const first = upsertWithCursorYieldable(db, args, { token, chunkSize: 1 });
    expect(first.kind).toBe("yield");
    if (first.kind !== "yield") throw new Error("unreachable");
    const second = upsertWithCursorYieldable(db, first.resume, { token, chunkSize: 1 });
    expect(second.kind).toBe("done");
    expect(
      db
        .prepare<
          [string, string],
          { omissions: number }
        >("SELECT omissions FROM replica_deletion_claims WHERE source_id = ? AND external_id = 'n-1' AND device_id = ?")
        .get(sourceId, macB)?.omissions,
    ).toBe(1);
  });
});
