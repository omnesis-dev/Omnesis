// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { createSource } from "../data/repositories/SourceRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createDatabase, upsertDocuments } from "../db.js";
import { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import { acknowledgeAbsenceCascade } from "../data/repositories/AbsenceRepository.js";
import { startStorageTrimJob, applyStorageTrimPage, failStorageTrimJob } from "./trim-job-store.js";
import {
  bindStorageRetentionPolicy,
  readBoundStorageRetentionPolicies,
  readStorageSourceIncarnation,
} from "./retention-bindings.js";
import { StorageRetentionService } from "./retention.js";
import { STORAGE_READS } from "./reads.js";

const sourceId = "fictional-notes:archive";
const old = "2020-01-01T00:00:00.000Z";
const cutoff = "2023-01-01T00:00:00.000Z";
const recent = "2026-01-01T00:00:00.000Z";

describe("storage retention command facade", () => {
  let db: ReturnType<typeof createDatabase>;
  let service: StorageRetentionService;
  let now: number;
  const finishCascade = vi.fn(
    async (cascade: import("../data/repositories/AbsenceRepository.js").AbsenceCascade) => {
      acknowledgeAbsenceCascade(db, cascade.id, "index");
      acknowledgeAbsenceCascade(db, cascade.id, "cognition");
    },
  );
  function gate() {
    return {
      startStorageTrimJob: async (input: Parameters<typeof startStorageTrimJob>[1]) =>
        startStorageTrimJob(db, input),
      applyStorageTrimPage: async (input: Parameters<typeof applyStorageTrimPage>[1]) =>
        applyStorageTrimPage(db, input),
      failStorageTrimJob: async (input: Parameters<typeof failStorageTrimJob>[1]) =>
        failStorageTrimJob(db, input),
    };
  }
  function boundPolicies(desired: { sourceId: string; maxAgeDays: number }[]) {
    for (const policy of desired)
      bindStorageRetentionPolicy(db, {
        ...policy,
        sourceIncarnation: readStorageSourceIncarnation(db, policy.sourceId)!,
      });
    return readBoundStorageRetentionPolicies(db, desired);
  }

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
    const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
    for (const account of ["archive", "other"])
      createSource(db, {
        type: SourceType("fictional-notes"),
        accountId: AccountId(account),
        deviceId: device.id,
      });
    now = Date.parse("2026-11-17T00:00:00.000Z");
    finishCascade.mockClear();
    service = new StorageRetentionService({
      db,
      writeGate: gate(),
      sourceWriteEpochFence: new SourceWriteEpochFence(),
      finishCascade,
      clock: () => now,
    });
  });
  afterEach(() => db.close());

  test("whole-cutoff cleanup protects exact boundaries, sibling sources and newer attachments", async () => {
    add("parent");
    add("parent/att/kept", recent, sourceId, { documentType: "attachment" });
    add("boundary", cutoff);
    add("contact", old, sourceId, { documentType: "contact" });
    add("sibling", old, "fictional-notes:other");
    await service.startTrim(sourceId, cutoff);
    expect(keys()).toHaveLength(5);
    expect(await service.sweep([])).toEqual({ deleted: 1, hasMore: false });
    expect(keys()).toEqual(["boundary", "contact", "parent/att/kept", "sibling"]);
    expect(finishCascade).toHaveBeenCalledOnce();
  });

  test("unknown, partial, offset and invalid calendar dates fail closed", async () => {
    const dates = ["0000-unknown", "2020", "2022-12-31T23:30:00-02:00", "2020-02-30T00:00:00.000Z"];
    for (const [index, date] of dates.entries()) {
      add(`protected-${index}`);
      db.prepare("UPDATE documents SET source_created_at=? WHERE external_id=?").run(
        date,
        `protected-${index}`,
      );
    }
    add("old");
    await service.startTrim(sourceId, cutoff);
    expect((await service.sweep([])).deleted).toBe(1);
    expect(keys()).toEqual(dates.map((_, index) => `protected-${index}`));
  });

  test("rolling retention visits sources fairly and creates no permanent tombstones", async () => {
    for (let i = 0; i < 102; i++) add(`old-${i}`);
    add("other", old, "fictional-notes:other");
    const policies = boundPolicies([
      { sourceId, maxAgeDays: 365 },
      { sourceId: "fictional-notes:other", maxAgeDays: 365 },
    ]);
    expect(await service.sweep(policies)).toEqual({ deleted: 100, hasMore: true });
    expect(await service.sweep(policies)).toEqual({ deleted: 1, hasMore: false });
    expect(keys()).toHaveLength(2);
    expect(db.prepare("SELECT 1 FROM removed_documents").get()).toBeUndefined();
  });

  test("disabling a rolling policy during its read prevents the pending deletion", async () => {
    add("old");
    let policies = boundPolicies([{ sourceId, maxAgeDays: 365 }]);
    service = new StorageRetentionService({
      db,
      writeGate: gate(),
      sourceWriteEpochFence: new SourceWriteEpochFence(),
      finishCascade,
      clock: () => now,
      reads: {
        storageTrimPage: async (job) => {
          const page = STORAGE_READS.storageTrimPage(db, job);
          policies = [];
          return page;
        },
      },
    });
    expect((await service.sweep(() => policies)).deleted).toBe(0);
    expect(keys()).toEqual(["old"]);
  });

  test("a source incarnation binding prevents a replacement source inheriting destructive retention", async () => {
    const policies = boundPolicies([{ sourceId, maxAgeDays: 365 }]);
    add("old");
    const original = db
      .prepare<[string], { device_id: string; created_at: number }>(
        "SELECT device_id,created_at FROM sources WHERE id=?",
      )
      .get(sourceId)!;
    db.prepare("DELETE FROM sources WHERE id=?").run(sourceId);
    createSource(db, {
      type: SourceType("fictional-notes"),
      accountId: AccountId("archive"),
      deviceId: original.device_id as never,
    });
    db.prepare("UPDATE sources SET created_at=? WHERE id=?").run(original.created_at, sourceId);
    expect((await service.sweep(policies)).deleted).toBe(0);
    expect(keys()).toEqual(["old"]);
  });

  test("invalid and future cutoffs never start a job", async () => {
    add("old");
    for (const date of ["invalid", "2020-01-01", "2030-01-01T00:00:00.000Z"]) {
      await expect(service.startTrim(sourceId, date)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(keys()).toEqual(["old"]);
  });
});
