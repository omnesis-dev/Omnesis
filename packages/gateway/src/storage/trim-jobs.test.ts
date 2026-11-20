// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createSource } from "../data/repositories/SourceRepository.js";
import {
  acknowledgeAbsenceCascade,
  type AbsenceCascade,
} from "../data/repositories/AbsenceRepository.js";
import { finishDocumentCascade } from "../absence/document-cascade.js";
import { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import { StorageRetentionService } from "./retention.js";
import {
  startStorageTrimJob,
  applyStorageTrimPage,
  failStorageTrimJob,
  readStorageTrimPage,
  readStorageTrimJob,
  readNextStorageTrimCleanup,
  STORAGE_TRIM_PAGE_SQL,
} from "./trim-job-store.js";
import {
  readStorageSourceIncarnation,
  bindStorageRetentionPolicy,
  readBoundStorageRetentionPolicies,
} from "./retention-bindings.js";

const sourceId = "fictional-notes:archive";
const before = "2023-01-01T00:00:00.000Z";
const old = "2020-01-01T00:00:00.000Z";
let db: ReturnType<typeof createDatabase>;
let now: number;
function seedSources() {
  const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
  for (const account of ["archive", "other"])
    createSource(db, {
      type: SourceType("fictional-notes"),
      accountId: AccountId(account),
      deviceId: device.id,
    });
}
function add(
  externalId: string,
  date = old,
  metadata: Record<string, unknown> = {},
  source = sourceId,
) {
  return upsertDocuments(db, [
    {
      providerId: ProviderId("fictional-provider"),
      sourceId: SourceId(source),
      externalId,
      title: externalId,
      content: "Invented reference.",
      contentHash: externalId,
      metadata,
      sourceCreatedAt: date,
      sourceUpdatedAt: date,
    },
  ]);
}
function engine(
  readPage?: typeof readStorageTrimPage,
  finish?: (cascade: AbsenceCascade) => Promise<void>,
) {
  return new StorageRetentionService({
    db,
    clock: () => now,
    sourceWriteEpochFence: new SourceWriteEpochFence(),
    writeGate: {
      startStorageTrimJob: async (input) => startStorageTrimJob(db, input),
      applyStorageTrimPage: async (input) => applyStorageTrimPage(db, input),
      failStorageTrimJob: async (input) => failStorageTrimJob(db, input),
    },
    reads: {
      storageTrimPage: async (job) => (readPage ?? readStorageTrimPage)(db, job),
    },
    finishCascade: async (cascade) => {
      if (finish) await finish(cascade);
      acknowledgeAbsenceCascade(db, cascade.id, "index");
      acknowledgeAbsenceCascade(db, cascade.id, "cognition");
    },
  });
}
function policies(days = 365) {
  bindStorageRetentionPolicy(db, {
    sourceId,
    maxAgeDays: days,
    sourceIncarnation: readStorageSourceIncarnation(db, sourceId)!,
  });
  return readBoundStorageRetentionPolicies(db, [{ sourceId, maxAgeDays: days }]);
}
beforeEach(() => {
  db = createDatabase(":memory:");
  now = Date.parse("2026-11-18T12:00:00.000Z");
  seedSources();
});
afterEach(() => db.close());

test("a terminal trim remains readable by id after it leaves the bounded recent list", async () => {
  const service = engine();
  const oldest = await service.startTrim(sourceId, before);
  expect(oldest.state).toBe("completed");
  for (let i = 0; i < 25; i++) {
    now++;
    await service.startTrim(sourceId, before);
  }
  expect(service.jobs()).toHaveLength(20);
  expect(service.jobs().some((job) => job.id === oldest.id)).toBe(false);
  expect(service.job(oldest.id)).toEqual(oldest);
  expect(service.job("00000000-0000-4000-8000-000000000001")).toBeNull();
  for (const field of [
    "revision",
    "sourceIncarnation",
    "bindingId",
    "cursorId",
    "cursorDate",
    "upperId",
    "upperDate",
  ])
    expect(service.job(oldest.id)).not.toHaveProperty(field);
});

test("one durable command finishes multiple pages across engine restart and protects all excluded data", async () => {
  for (let i = 0; i < 253; i++) add(`old-${i}`);
  add("contact", old, { documentType: "contact" });
  add("unknown");
  db.prepare(
    "UPDATE documents SET source_created_at='0000-unknown' WHERE external_id='unknown'",
  ).run();
  add("young", "2026-01-01T00:00:00.000Z");
  add("sibling", old, {}, "fictional-notes:other");
  let service = engine();
  const job = await service.startTrim(sourceId, before);
  expect(job).toMatchObject({ state: "queued", deleted: 0, sourceId, before });
  expect((await service.sweep([])).deleted).toBeLessThanOrEqual(100);
  service = engine();
  for (
    let i = 0;
    i < 5 && service.jobs().find((row) => row.id === job.id)?.state !== "completed";
    i++
  ) {
    now++;
    await service.sweep([]);
  }
  expect(service.jobs().find((row) => row.id === job.id)).toMatchObject({
    state: "completed",
    deleted: 253,
    examinedDocuments: 255,
    skippedDocuments: 2,
    cleanupPending: false,
  });
  expect(
    db.prepare<[], string>("SELECT external_id FROM documents ORDER BY external_id").pluck().all(),
  ).toEqual(["contact", "sibling", "unknown", "young"]);
  expect(
    db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM storage_trim_jobs").get()!.n,
  ).toBe(1);
  expect(
    db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM removed_documents").get()!.n,
  ).toBe(253);
});

test("start is idempotent for the same cutoff and refuses changing an active command", async () => {
  add("old");
  const service = engine();
  const first = await service.startTrim(sourceId, before);
  expect((await service.startTrim(sourceId, before)).id).toBe(first.id);
  await expect(service.startTrim(sourceId, "2022-01-01T00:00:00.000Z")).rejects.toMatchObject({
    status: 409,
  });
  expect(
    db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM storage_trim_jobs").get()!.n,
  ).toBe(1);
});

test("an old page cannot delete from a replacement source even when its timestamp is reused", async () => {
  add("old");
  const service = engine();
  const job = await service.startTrim(sourceId, before);
  const stored = readStorageTrimJob(db, job.id)!;
  const page = readStorageTrimPage(db, stored);
  const source = db
    .prepare<[string], { device_id: string; created_at: number }>(
      "SELECT device_id,created_at FROM sources WHERE id=?",
    )
    .get(sourceId)!;
  db.prepare("DELETE FROM sources WHERE id=?").run(sourceId);
  createSource(db, {
    type: SourceType("fictional-notes"),
    accountId: AccountId("archive"),
    deviceId: source.device_id as never,
  });
  db.prepare("UPDATE sources SET created_at=? WHERE id=?").run(source.created_at, sourceId);
  expect(
    applyStorageTrimPage(db, { jobId: job.id, revision: stored.revision, page, now }).job?.state,
  ).toBe("cancelled");
  expect(db.prepare("SELECT 1 FROM documents WHERE external_id='old'").get()).toBeDefined();
  expect(service.jobs()).toEqual([]);
});

test("protected rows advance once and rolling passes resume beyond their completed frontier", async () => {
  for (let i = 0; i < 250; i++) add(`contact-${i}`, old, { documentType: "contact" });
  const policy = policies();
  const read = vi.fn(readStorageTrimPage);
  const service = engine(read);
  for (let i = 0; i < 3; i++) {
    now++;
    await service.sweep(policy);
  }
  expect(read.mock.calls.reduce((n, [, job]) => n + (job ? 1 : 0), 0)).toBe(3);
  const jobId = db
    .prepare<[], { id: string }>("SELECT id FROM storage_trim_jobs WHERE kind='rolling'")
    .get()!.id;
  expect(readStorageTrimJob(db, jobId)).toMatchObject({
    state: "completed",
    deleted: 0,
    examinedDocuments: 250,
  });
  for (let i = 0; i < 4; i++) {
    now += 60_000;
    await service.sweep(policy);
  }
  expect(read).toHaveBeenCalledTimes(3);
  expect(readStorageTrimJob(db, jobId)).toMatchObject({ examinedDocuments: 250 });
});

test("manual and rolling cleanup use the same bounded reader and preserve fair progress", async () => {
  for (let i = 0; i < 102; i++) add(`old-${i}`);
  add("other-old", old, {}, "fictional-notes:other");
  const policy = policies();
  const service = engine();
  await service.startTrim("fictional-notes:other", before);
  expect((await service.sweep(policy)).deleted).toBe(1);
  expect((await service.sweep(policy)).deleted).toBe(100);
  expect((await service.sweep(policy)).deleted).toBe(2);
  expect(
    db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM removed_documents").get()!.n,
  ).toBe(1);
});

test("failed cross-store cleanup remains associated with the job and is not mistaken for no deletion", async () => {
  add("old");
  const service = engine(undefined, async () => {
    throw new Error("index unavailable");
  });
  const job = await service.startTrim(sourceId, before);
  expect((await service.sweep([])).deleted).toBe(1);
  expect(service.jobs().find((row) => row.id === job.id)).toMatchObject({
    state: "completed",
    deleted: 1,
    cleanupPending: true,
  });
  expect(service.job(job.id)).toMatchObject({
    state: "completed",
    deleted: 1,
    cleanupPending: true,
  });
  expect(service.job(job.id)).not.toHaveProperty("revision");
  expect(service.job(job.id)).not.toHaveProperty("sourceIncarnation");
  expect(db.prepare("SELECT 1 FROM storage_trim_job_cascades").get()).toBeDefined();
});

test("index cleanup backpressure bounds pending obligations to one page instead of a document queue", async () => {
  for (let i = 0; i < 253; i++) add(`old-${i}`);
  const service = engine(undefined, async () => {
    throw new Error("index unavailable");
  });
  const job = await service.startTrim(sourceId, before);
  expect((await service.sweep([])).deleted).toBe(100);
  for (let i = 0; i < 5; i++) {
    now++;
    expect((await service.sweep([])).deleted).toBe(0);
  }
  expect(service.jobs().find((row) => row.id === job.id)).toMatchObject({
    state: "running",
    deleted: 100,
    examinedDocuments: 100,
    cleanupPending: true,
  });
  const obligations = db
    .prepare<[], { n: number; documents: number }>(
      "SELECT COUNT(*) AS n,SUM(json_array_length(document_ids)) AS documents FROM snapshot_absence_cascade_outbox",
    )
    .get()!;
  expect(obligations).toEqual({ n: 1, documents: 100 });
});

test("two manual jobs both advance with a frozen clock", async () => {
  for (let i = 0; i < 203; i++) add(`archive-${i}`);
  for (let i = 0; i < 203; i++) add(`other-${i}`, old, {}, "fictional-notes:other");
  const service = engine();
  await service.startTrim(sourceId, before);
  await service.startTrim("fictional-notes:other", before);
  await service.sweep([]);
  await service.sweep([]);
  expect(
    service
      .jobs()
      .map((row) => row.deleted)
      .sort(),
  ).toEqual([100, 100]);
});

test("frequently updated rolling history cannot evict a completed manual result", async () => {
  add("old");
  const service = engine();
  const manual = await service.startTrim(sourceId, before);
  await service.sweep([]);
  const incarnation = readStorageSourceIncarnation(db, sourceId)!;
  const insert = db.prepare(
    "INSERT INTO storage_trim_jobs(id,kind,source_id,source_incarnation,before_date,state,upper_date,upper_id,created_at,updated_at) VALUES(?,'rolling',?,?,?,'completed','','',?,?)",
  );
  for (let i = 0; i < 25; i++)
    insert.run(`rolling-${i}`, sourceId, incarnation, before, now + i + 1, now + i + 1);
  expect(
    service
      .jobs()
      .some((job) => job.id === manual.id && job.state === "completed" && job.deleted === 1),
  ).toBe(true);
});

test("a read failure is durable, content-free and retryable by a new command", async () => {
  add("old");
  const service = engine(() => {
    throw new Error("private filesystem context");
  });
  const job = await service.startTrim(sourceId, before);
  await service.sweep([]);
  expect(service.jobs().find((row) => row.id === job.id)).toMatchObject({
    state: "failed",
    deleted: 0,
    error: "Storage cleanup could not continue. Retry this trim.",
  });
  const retry = engine();
  expect((await retry.startTrim(sourceId, before)).id).not.toBe(job.id);
  await retry.sweep([]);
  expect(retry.jobs().some((row) => row.state === "completed" && row.deleted === 1)).toBe(true);
});

test("writer admission suppresses old late arrivals while a job runs, but keeps young and contact data", async () => {
  add("original");
  const service = engine();
  await service.startTrim(sourceId, before);
  add("late-old");
  add("late-young", "2026-01-01T00:00:00.000Z");
  add("late-contact", old, { documentType: "contact" });
  expect(db.prepare("SELECT 1 FROM documents WHERE external_id='late-old'").get()).toBeUndefined();
  await service.sweep([]);
  expect(
    db.prepare<[], string>("SELECT external_id FROM documents ORDER BY external_id").pluck().all(),
  ).toEqual(["late-contact", "late-young"]);
  add("new-old-after-completion");
  expect(
    db.prepare("SELECT 1 FROM documents WHERE external_id='new-old-after-completion'").get(),
  ).toBeDefined();
});

test("candidate pages use a covering indexed seek with no document payload or temporary sort", () => {
  const details = db
    .prepare<[string, string, string, string, string, number], { detail: string }>(
      `EXPLAIN QUERY PLAN ${STORAGE_TRIM_PAGE_SQL}`,
    )
    .all(sourceId, "2020-01-01T00:00:00.000Z", "middle", "2022-01-01T00:00:00.000Z", "upper", 101)
    .map((row) => row.detail)
    .join("\n");
  expect(details).toContain(
    "SEARCH documents USING COVERING INDEX idx_documents_source_created_revision",
  );
  expect(details).not.toMatch(/SCAN|TEMP B-TREE/);
});

test("read worker pages contain only cursor keys even for large content and metadata", async () => {
  add("large-entry", old, { inventedPayload: "m".repeat(100_000) });
  db.prepare("UPDATE documents SET content=?,title=? WHERE external_id='large-entry'").run(
    "c".repeat(1_000_000),
    "t".repeat(100_000),
  );
  const job = await engine().startTrim(sourceId, before);
  const page = readStorageTrimPage(db, readStorageTrimJob(db, job.id)!);
  expect(page.rows).toHaveLength(1);
  expect(Object.keys(page.rows[0]!).sort()).toEqual(["id", "source_created_at"]);
  expect(page.rows[0]!.source_created_at).toBe(old);
  expect(JSON.stringify(page).length).toBeLessThan(200);
});

test("a persisted manual command continues after closing and reopening the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-trim-restart-"));
  const path = join(dir, "gateway.db");
  db.close();
  db = createDatabase(path);
  seedSources();
  try {
    for (let i = 0; i < 125; i++) add(`old-${i}`);
    const first = engine();
    const job = await first.startTrim(sourceId, before);
    await first.sweep([]);
    db.close();
    db = createDatabase(path);
    const resumed = engine();
    await resumed.sweep([]);
    expect(resumed.jobs().find((row) => row.id === job.id)).toMatchObject({
      state: "completed",
      deleted: 125,
    });
  } finally {
    db.close();
    db = createDatabase(":memory:");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer independently preserves an accepted manual command against a competing cutoff", async () => {
  add("old");
  const command = await engine().startTrim(sourceId, before);
  expect(
    startStorageTrimJob(db, {
      kind: "manual",
      sourceId,
      before: "2024-01-01T00:00:00.000Z",
      sourceIncarnation: readStorageSourceIncarnation(db, sourceId)!,
      now,
    }),
  ).toBeNull();
  expect(readStorageTrimJob(db, command.id)).toMatchObject({ state: "queued", before });
});

function cleanupEngine(
  deleteIndex: (ids: readonly string[]) => Promise<number>,
  readPage?: typeof readStorageTrimPage,
) {
  return engine(readPage, (cascade) =>
    finishDocumentCascade(cascade, {
      deleteIndex,
      cascadeCognition: async () => {},
      acknowledge: async (id, part) => acknowledgeAbsenceCascade(db, id, part),
    }).then(() => {}),
  );
}

test.each([
  ["manual", "completed"],
  ["manual", "failed"],
  ["manual", "cancelled"],
  ["rolling", "completed"],
  ["rolling", "failed"],
  ["rolling", "cancelled"],
] as const)(
  "%s %s cleanup survives restart, lost authority and hidden history",
  async (kind, state) => {
    add("old");
    const deleteIndex = vi
      .fn<(ids: readonly string[]) => Promise<number>>()
      .mockRejectedValueOnce(new Error("Search cleanup is continuing in the background."))
      .mockResolvedValue(0);
    const first = cleanupEngine(deleteIndex);
    const policy = kind === "rolling" ? policies() : [];
    if (kind === "manual") await first.startTrim(sourceId, before);
    expect((await first.sweep(policy)).deleted).toBe(1);
    const id = db.prepare<[], { id: string }>("SELECT id FROM storage_trim_jobs").get()!.id;
    expect(readStorageTrimJob(db, id)).toMatchObject({
      state: "completed",
      deleted: 1,
      cleanupPending: true,
    });
    expect(
      db.prepare("SELECT index_done,cognition_done FROM snapshot_absence_cascade_outbox").get(),
    ).toEqual({ index_done: 0, cognition_done: 1 });
    db.prepare("UPDATE storage_trim_jobs SET state=? WHERE id=?").run(state, id);
    // Neither public history nor a current source/policy is needed to finish an
    // already committed deletion. The old command deliberately disappears there.
    const incarnation = readStorageSourceIncarnation(db, sourceId)!;
    const insert = db.prepare(
      "INSERT INTO storage_trim_jobs(id,kind,source_id,source_incarnation,before_date,state,upper_date,upper_id,created_at,updated_at) VALUES(?,'manual',?,?,?,'completed','','',?,?)",
    );
    for (let i = 0; i < 25; i++)
      insert.run(`later-${i}`, sourceId, incarnation, before, now + i + 1, now + i + 1);
    db.prepare("DELETE FROM sources WHERE id=?").run(sourceId);
    const stored = readStorageTrimJob(db, id)!;
    const read = vi.fn(readStorageTrimPage);
    const restarted = cleanupEngine(deleteIndex, read);
    expect(restarted.jobs()).toEqual([]);
    expect(await restarted.sweep([])).toEqual({ deleted: 0, hasMore: false });
    expect(read).not.toHaveBeenCalled();
    expect(deleteIndex).toHaveBeenCalledTimes(2);
    expect(readStorageTrimJob(db, id)).toEqual({ ...stored, cleanupPending: false });
    expect(db.prepare("SELECT 1 FROM storage_trim_job_cascades").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM snapshot_absence_cascade_outbox").get()).toBeUndefined();
    await restarted.sweep([]);
    expect(deleteIndex).toHaveBeenCalledTimes(2);
  },
);

test("cleanup retry rotates failed obligations and leaves a turn for new document work", async () => {
  const pendingIds: string[] = [];
  for (const source of [sourceId, "fictional-notes:other"]) {
    add(`old-${source}`, old, {}, source);
    const job = startStorageTrimJob(db, {
      kind: "manual",
      sourceId: source,
      before,
      sourceIncarnation: readStorageSourceIncarnation(db, source)!,
      now,
    })!;
    applyStorageTrimPage(db, {
      jobId: job.id,
      revision: job.revision,
      page: readStorageTrimPage(db, job),
      now,
    });
    pendingIds.push(job.id);
  }
  const ordered = [...pendingIds].sort();
  expect(readNextStorageTrimCleanup(db, "")!.id).toBe(ordered[0]);
  expect(readNextStorageTrimCleanup(db, ordered[0]!)!.id).toBe(ordered[1]);
  expect(readNextStorageTrimCleanup(db, ordered[1]!)!.id).toBe(ordered[0]);
  // New retained documents arrive after the completed one-off commands.
  add("new-old");
  const retries: string[] = [];
  const service = engine(undefined, async (cascade) => {
    const link = db
      .prepare<[number], { job_id: string }>(
        "SELECT job_id FROM storage_trim_job_cascades WHERE cascade_id=?",
      )
      .get(cascade.id)!;
    retries.push(link.job_id);
    throw new Error("index unavailable");
  });
  const next = await service.startTrim(sourceId, before);
  expect(await service.sweep([])).toEqual({ deleted: 0, hasMore: false });
  expect(retries).toHaveLength(1);
  expect((await service.sweep([])).deleted).toBe(1);
  expect(readStorageTrimJob(db, next.id)).toMatchObject({ state: "completed", deleted: 1 });
  // Round robin advances even when a cleanup attempt fails; no oldest job monopolizes it.
  const afterNewPage = retries.length;
  for (let i = 0; i < 3; i++) {
    const previous = retries.length;
    expect(await service.sweep([])).toEqual({ deleted: 0, hasMore: false });
    expect(retries.length - previous).toBe(1);
  }
  expect(new Set(retries.slice(afterNewPage))).toEqual(new Set([...pendingIds, next.id]));
  expect(
    db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM snapshot_absence_cascade_outbox")
      .get()!.n,
  ).toBe(3);
});

test("pending cleanup candidate lookup uses a covering seek independent of terminal history", () => {
  const plan = db
    .prepare<[string], { detail: string }>(
      "EXPLAIN QUERY PLAN SELECT job_id FROM storage_trim_job_cascades WHERE job_id > ? ORDER BY job_id,cascade_id LIMIT 1",
    )
    .all("middle")
    .map((row) => row.detail)
    .join("\n");
  expect(plan).toContain("SEARCH storage_trim_job_cascades USING COVERING INDEX");
  expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
});
