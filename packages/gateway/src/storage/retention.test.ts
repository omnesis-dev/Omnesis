// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { createSource } from "../data/repositories/SourceRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createDatabase, upsertDocuments } from "../db.js";
import { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import { listPendingAbsenceCascades } from "../data/repositories/AbsenceRepository.js";
import { deleteStorageRetentionBatch } from "./retention-store.js";
import { StorageRetentionService } from "./retention.js";
import { STORAGE_READS } from "./reads.js";

const sourceId = "fictional-notes:archive";
const old = "2020-01-01T00:00:00.000Z";
const cutoff = "2023-01-01T00:00:00.000Z";
const recent = "2026-01-01T00:00:00.000Z";

describe("storage retention exact approved batches", () => {
  let db: ReturnType<typeof createDatabase>;
  let service: StorageRetentionService;
  let now: number;
  const finishCascade = vi.fn(async () => {});

  function add(
    externalId: string,
    date = old,
    source = sourceId,
    metadata: Record<string, unknown> = {},
  ) {
    upsertDocuments(db, [
      {
        providerId: ProviderId("fictional-provider"),
        sourceId: SourceId(source),
        externalId,
        title: externalId,
        content: "Invented archive entry.",
        contentHash: externalId,
        metadata,
        sourceCreatedAt: date,
        sourceUpdatedAt: date,
      },
    ]);
  }
  function keys(): string[] {
    return db
      .prepare<[], string>("SELECT external_id FROM documents ORDER BY external_id")
      .pluck()
      .all();
  }
  beforeEach(() => {
    db = createDatabase(":memory:");
    now = Date.parse("2026-11-17T00:00:00.000Z");
    finishCascade.mockClear();
    service = new StorageRetentionService({
      db,
      writeGate: {
        deleteStorageRetentionBatch: async (batch) => deleteStorageRetentionBatch(db, batch),
      },
      sourceWriteEpochFence: new SourceWriteEpochFence(),
      finishCascade,
      clock: () => now,
    });
  });
  afterEach(() => db.close());

  test("preview changes nothing; exact source, date boundary and contacts are protected", async () => {
    add("old");
    add("new", recent);
    add("boundary", cutoff);
    add("contact", old, sourceId, { documentType: "contact" });
    add("sibling", old, "fictional-notes:other");
    const preview = await service.preview(sourceId, cutoff);
    expect(preview).toMatchObject({ documents: 1, hasMore: false, sourceId, before: cutoff });
    expect(preview.payloadBytes).toBeGreaterThan(0);
    expect(keys()).toHaveLength(5);
    expect(await service.execute(preview.token)).toEqual({ deleted: 1, hasMore: false });
    expect(keys()).toEqual(["boundary", "contact", "new", "sibling"]);
    expect(
      db.prepare("SELECT 1 FROM removed_documents WHERE external_id='old'").get(),
    ).toBeDefined();
    expect(finishCascade).toHaveBeenCalledOnce();
  });

  test("a parent deletion does not expand into a newer attachment", async () => {
    add("parent");
    add("parent/att/kept", recent, sourceId, { documentType: "attachment" });
    const preview = await service.preview(sourceId, cutoff);
    await service.execute(preview.token);
    expect(keys()).toEqual(["parent/att/kept"]);
  });

  test("unknown legacy dates are retained instead of guessed to be old", async () => {
    add("unknown");
    add("partial-date");
    add("old");
    db.prepare(
      "UPDATE documents SET source_created_at='0000-unknown' WHERE external_id='unknown'",
    ).run();
    db.prepare(
      "UPDATE documents SET source_created_at='2020' WHERE external_id='partial-date'",
    ).run();
    const preview = await service.preview(sourceId, cutoff);
    expect(preview.documents).toBe(1);
    await service.execute(preview.token);
    expect(keys()).toEqual(["partial-date", "unknown"]);
  });

  test("offset and invalid calendar dates are retained even when they sort before the cutoff", async () => {
    add("offset");
    add("invalid-calendar");
    add("old");
    db.prepare("UPDATE documents SET source_created_at=? WHERE external_id='offset'").run(
      "2022-12-31T23:30:00-02:00",
    );
    db.prepare("UPDATE documents SET source_created_at=? WHERE external_id='invalid-calendar'").run(
      "2020-02-30T00:00:00.000Z",
    );
    const preview = await service.preview(sourceId, cutoff);
    // SQLite may normalize invalid calendar days differently by version;
    // the atomic writer independently refuses a noncanonical calendar date.
    if (preview.documents > 1) {
      await expect(service.execute(preview.token)).rejects.toMatchObject({
        code: "RETENTION_PREVIEW_CHANGED",
      });
      expect(keys()).toEqual(["invalid-calendar", "offset", "old"]);
    } else {
      await service.execute(preview.token);
      expect(keys()).toEqual(["invalid-calendar", "offset"]);
    }
  });

  test("one changed revision rejects the entire preview without deleting unchanged peers", async () => {
    add("a");
    add("b");
    const preview = await service.preview(sourceId, cutoff);
    db.prepare("UPDATE documents SET content_hash='changed' WHERE external_id='b'").run();
    await expect(service.execute(preview.token)).rejects.toMatchObject({
      code: "RETENTION_PREVIEW_CHANGED",
    });
    expect(keys()).toEqual(["a", "b"]);
    expect(listPendingAbsenceCascades(db, 10)).toEqual([]);
  });

  test("removed and recreated source rows cannot spend a prior preview", async () => {
    add("same-key");
    const preview = await service.preview(sourceId, cutoff);
    db.prepare("DELETE FROM documents").run();
    add("same-key");
    await expect(service.execute(preview.token)).rejects.toMatchObject({
      code: "RETENTION_PREVIEW_CHANGED",
    });
    expect(keys()).toEqual(["same-key"]);
  });

  test("a row changed to contact after preview cannot be removed", async () => {
    add("protected");
    const preview = await service.preview(sourceId, cutoff);
    db.prepare("UPDATE documents SET metadata=?").run(JSON.stringify({ documentType: "contact" }));
    await expect(service.execute(preview.token)).rejects.toMatchObject({
      code: "RETENTION_PREVIEW_CHANGED",
    });
    expect(keys()).toEqual(["protected"]);
  });

  test("metadata edits are stale even when a same-millisecond update preserves the timestamp", async () => {
    add("edited");
    const preview = await service.preview(sourceId, cutoff);
    db.prepare("UPDATE documents SET metadata=?").run(JSON.stringify({ label: "new revision" }));
    await expect(service.execute(preview.token)).rejects.toMatchObject({
      code: "RETENTION_PREVIEW_CHANGED",
    });
    expect(keys()).toEqual(["edited"]);
  });

  test("approval expires and is consumed once under concurrent requests", async () => {
    add("old");
    const expired = await service.preview(sourceId, cutoff);
    now += 10 * 60_000;
    await expect(service.execute(expired.token)).rejects.toMatchObject({
      code: "RETENTION_PREVIEW_EXPIRED",
    });
    const active = await service.preview(sourceId, cutoff);
    const results = await Promise.allSettled([
      service.execute(active.token),
      service.execute(active.token),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(keys()).toEqual([]);
  });

  test("a cleanup failure retains durable cross-store work", async () => {
    add("old");
    finishCascade.mockRejectedValueOnce(new Error("index unavailable"));
    const preview = await service.preview(sourceId, cutoff);
    expect(await service.execute(preview.token)).toEqual({
      deleted: 1,
      hasMore: false,
      cleanupPending: true,
    });
    expect(keys()).toEqual([]);
    expect(listPendingAbsenceCascades(db, 10)).toEqual([
      expect.objectContaining({ indexDone: false, cognitionDone: false }),
    ]);
  });

  test("one operation never deletes beyond the approved batch", async () => {
    for (let i = 0; i < 103; i++) add(`old-${i}`);
    const preview = await service.preview(sourceId, cutoff);
    expect(preview).toMatchObject({ documents: 100, hasMore: true });
    expect(await service.execute(preview.token)).toEqual({ deleted: 100, hasMore: true });
    expect(keys()).toHaveLength(3);
  });

  test("rolling retention visits sources fairly and creates no permanent tombstones", async () => {
    for (let i = 0; i < 102; i++) add(`old-${i}`);
    add("other", old, "fictional-notes:other");
    const policies = [
      { sourceId, maxAgeDays: 365 },
      { sourceId: "fictional-notes:other", maxAgeDays: 365 },
    ];
    expect(await service.sweep(policies)).toEqual({ deleted: 100, hasMore: true });
    expect(await service.sweep(policies)).toEqual({ deleted: 1, hasMore: false });
    expect(keys()).toHaveLength(2);
    expect(db.prepare("SELECT 1 FROM removed_documents").get()).toBeUndefined();
  });

  test("disabling a rolling policy during its read prevents the pending deletion", async () => {
    add("old");
    let policies = [{ sourceId, maxAgeDays: 365 }];
    service = new StorageRetentionService({
      db,
      writeGate: {
        deleteStorageRetentionBatch: async (batch) => deleteStorageRetentionBatch(db, batch),
      },
      sourceWriteEpochFence: new SourceWriteEpochFence(),
      finishCascade,
      clock: () => now,
      reads: {
        storageRetentionCandidates: async (id, before) => {
          const rows = STORAGE_READS.storageRetentionCandidates(db, id, before);
          policies = [];
          return rows;
        },
      },
    });
    await expect(service.sweep(() => policies)).rejects.toMatchObject({
      code: "RETENTION_POLICY_CHANGED",
    });
    expect(keys()).toEqual(["old"]);
  });

  test("a source incarnation binding prevents a replacement source inheriting destructive retention", async () => {
    const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
    const source = createSource(db, {
      type: SourceType("fictional-notes"),
      accountId: AccountId("archive"),
      deviceId: device.id,
    });
    add("old");
    db.prepare("UPDATE sources SET created_at = created_at + 1 WHERE id = ?").run(source.id);
    await expect(
      service.sweep([{ sourceId, maxAgeDays: 365, sourceCreatedAt: source.createdAt }]),
    ).rejects.toMatchObject({ code: "RETENTION_SOURCE_CHANGED" });
    expect(keys()).toEqual(["old"]);
  });

  test("invalid and future cutoffs never create an approval", async () => {
    add("old");
    for (const date of ["invalid", "2020-01-01", "2030-01-01T00:00:00.000Z"]) {
      await expect(service.preview(sourceId, date)).rejects.toMatchObject({
        code: "INVALID_RETENTION_CUTOFF",
      });
    }
    expect(keys()).toEqual(["old"]);
  });
});
