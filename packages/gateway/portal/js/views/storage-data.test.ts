// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { bytesBeforeMonthCutoff, storageSources, storageReconciliation, scheduledStorageCutoff, storageTrimStatus, visibleStorageTrimJobs } from "./storage-data.js";

test("joins accounting by source and month and distributes only measured lexical allocation", () => {
  const rows = storageSources({
    logical: { sources: [
      { sourceId: "archive:one", payloadBytes: 60, months: [
        { month: "2020-01", payloadBytes: 30 }, { month: "unknown", payloadBytes: 30 },
      ] },
    ] },
    index: { lexicalBytes: 100, sources: [
      { sourceId: "archive:one", month: "2020-01", textBytes: 10, embeddingBytes: 20 },
      { sourceId: "archive:two", month: "2020-02", textBytes: 30, embeddingBytes: 40 },
    ] },
  });
  expect(rows).toEqual([
    { sourceId: "archive:two", documentBytes: 0, vectorBytes: 40, lexicalBytes: 105, lexicalPartial: false, bytes: 145,
      months: [{ month: "2020-02", bytes: 145, trimmableDocuments: 0 }] },
    { sourceId: "archive:one", documentBytes: 60, vectorBytes: 20, lexicalBytes: 35, lexicalPartial: false, bytes: 115,
      months: [{ month: "2020-01", bytes: 85 }, { month: "unknown", bytes: 30 }] },
  ]);
  expect(bytesBeforeMonthCutoff(rows[1].months, "2020-01-20")).toBe(0);
  expect(bytesBeforeMonthCutoff(rows[1].months, "2020-02-01")).toBe(85);
});

test("keeps unavailable measurements distinct from zero and retains sources with a policy", () => {
  expect(storageSources({
    retention: [{ sourceId: "archive:one" }],
  })).toEqual([
    { sourceId: "archive:one", documentBytes: null, vectorBytes: null, lexicalBytes: null, lexicalPartial: false, bytes: 0, months: [] },
  ]);
});

test("includes measured indexed text when lexical allocation is unavailable", () => {
  const [row] = storageSources({index: {lexicalBytes: null, sources: [
    {sourceId: "archive:one", month: "2020-01", textBytes: 15, embeddingBytes: 20},
  ]}});
  expect(row).toMatchObject({documentBytes: null, lexicalBytes: 15, lexicalPartial: true, bytes: 35});
});

test("scheduled shading unions pending cutoffs with rolling retention and ignores completed, failed and cancelled jobs", () => {
  const jobs = [
    { sourceId: "archive:one", before: "2024-02-01T00:00:00.000Z", state: "queued" },
    { sourceId: "archive:one", before: "2024-03-01T00:00:00.000Z", state: "running" },
    ...["completed", "failed", "cancelled"].map((state) => ({sourceId: "archive:one", before: "2025-01-01T00:00:00.000Z", state})),
    {sourceId: "archive:two", before: "2025-01-01T00:00:00.000Z", state: "queued"},
  ];
  expect(scheduledStorageCutoff("archive:one", null, jobs)).toBe("2024-03-01T00:00:00.000Z");
  expect(scheduledStorageCutoff("archive:one", 2, jobs, Date.parse("2024-04-10T12:30:00Z"))).toBe("2024-04-08T12:30:00.000Z");
  expect(scheduledStorageCutoff("absent", null, jobs)).toBeNull();
  expect(storageTrimStatus({ state: "failed", deleted: 12, error: "Disk unavailable" })).toBe("Trim stopped · 12 documents removed · Disk unavailable");
});

test("retains measured trimmability while including derived index bytes", () => {
  const [row] = storageSources({logical: {sources: [{sourceId: "notes:example", payloadBytes: 50, months: [{month: "2020-01", payloadBytes: 50, trimmableDocuments: 0}]}]}, index: {lexicalBytes: 0, sources: [{sourceId: "notes:example", month: "2020-01", textBytes: 20, embeddingBytes: 40}]}});
  expect(row.months).toEqual([{month: "2020-01", bytes: 110, trimmableDocuments: 0}]);
});

test("shows every active trim and only the latest terminal status per source", () => {
  const jobs = [
    {id: "old", state: "completed", updatedAt: 1},
    {id: "active", state: "running", updatedAt: 2},
    {id: "last", state: "completed", updatedAt: 3},
    {id: "queued", state: "queued", updatedAt: 4},
  ];
  expect(visibleStorageTrimJobs(jobs).map((job: {id: string}) => job.id)).toEqual(["active", "queued", "last"]);
  expect(storageTrimStatus({state: "completed", deleted: 100, cleanupPending: true})).toContain("Search cleanup continuing");
  expect(storageTrimStatus({state: "completed", deleted: 100, cleanupPending: true})).not.toContain("Trim completed");
});

test("reconciles complete physical stores against unchanged source estimates without double-counting files", () => {
  const measuredAt = "2026-01-01T00:00:00.000Z";
  const data = storageReconciliation({
    physical: {measuredAt, totalBytes: 180, stores: [
      {id: "documents", label: "Main database", bytes: 80, components: [{id: "database", label: "Database", bytes: 70}, {id: "write-log", label: "Write log", bytes: 10}]},
      {id: "index", label: "Search index", bytes: 90, components: [{id: "database", label: "Database", bytes: 70}, {id: "graph", label: "Search graph", bytes: 20}]},
      {id: "models", label: "Models", bytes: 10},
    ]},
    logical: {measuredAt, database: {tables: []}, sources: [{payloadBytes: 20}]},
    index: {measuredAt, tables: [], lexicalBytes: 10, sources: [{embeddingBytes: 30, textBytes: 10}]},
  });
  expect(data.state).toBe("ready");
  expect(data.rows.map((row: {sourceBytes: number; remainderBytes: number}) => [row.sourceBytes, row.remainderBytes])).toEqual([[20, 60], [50, 40], [0, 10]]);
  expect(data).toMatchObject({physicalBytes: 180, sourceBytes: 70, remainderBytes: 110});
});

test("empty measured stores reconcile to zero rather than unknown", () => {
  const measuredAt = "2026-01-01T00:00:00.000Z";
  const result = storageReconciliation({physical: {measuredAt, totalBytes: 0, stores: []},
    logical: {measuredAt, database: {tables: []}, sources: []}, index: {measuredAt, tables: [], lexicalBytes: 0, sources: []}});
  expect(result).toMatchObject({state: "ready", physicalBytes: 0, sourceBytes: 0, remainderBytes: 0});
});

test("missing dbstat and missing accounting preserve partial knowledge without inventing overhead", () => {
  const measuredAt = "2026-01-01T00:00:00.000Z";
  const physical = {measuredAt, totalBytes: 200, stores: [{id: "documents", bytes: 100}, {id: "index", bytes: 100}]};
  const data = storageReconciliation({physical, logical: {measuredAt, database: {tables: null}, sources: [{payloadBytes: 20}]},
    index: {measuredAt, tables: null, lexicalBytes: null, sources: [{embeddingBytes: 30, textBytes: 10}]}});
  expect(data.rows.map((row: {sourceBytes: number; remainderBytes: number | null; partial: boolean}) => [row.sourceBytes, row.remainderBytes, row.partial])).toEqual([[20, 80, false], [40, null, true]]);
  expect(data).toMatchObject({state: "unavailable", sourceBytes: null, remainderBytes: null});
  expect(storageReconciliation({physical}).rows[0]).toMatchObject({sourceBytes: null, remainderBytes: null});
});

test("compares source estimates to the whole store including write logs and preserves separately measured estimates", () => {
  const measuredAt = "2026-01-01T00:00:00.000Z";
  const logical = {measuredAt, database: {tables: []}, sources: [{payloadBytes: 50}]};
  const index = {measuredAt, tables: [], lexicalBytes: 0, sources: []};
  const base = {physical: {measuredAt, totalBytes: 110, stores: [{id: "documents", bytes: 100, components: [{id: "database", bytes: 40}, {id: "write-log", bytes: 60}]}, {id: "index", bytes: 10}]}, logical, index};
  expect(storageReconciliation(base).rows[0]).toMatchObject({state: "ready", sourceBytes: 50, remainderBytes: 50});
  expect(storageReconciliation({...base, logical: {...logical, sources: [{payloadBytes: 120}]}})).toMatchObject({state: "updating", remainderBytes: null});
  expect(storageReconciliation({...base, physical: {...base.physical, stores: [{id: "documents", bytes: 100}, {id: "index", bytes: 10}]}, logical: {...logical, measuredAt: "2025-12-31T23:00:00.000Z"}}).rows[0]).toMatchObject({state: "ready", remainderBytes: 50});
});

test("invalid byte measurements never produce a known remainder or a fabricated zero", () => {
  const logical = {database: {tables: []}, sources: [{payloadBytes: NaN}]};
  const data = storageReconciliation({physical: {totalBytes: 10, stores: [{id: "documents", bytes: 10}]}, logical});
  expect(data.rows[0]).toMatchObject({sourceBytes: null, remainderBytes: null, state: "unavailable"});
  expect(data.remainderBytes).toBeNull();
});

test("empty full-text structures belong to other storage, while a fully trimmed source remains measured at zero", () => {
  const index = {tables: [{name: "chunks_fts_config", bytes: 16}], lexicalBytes: 16, sources: []};
  const logical = {database: {tables: null}, sources: [{sourceId: "notes:fictional", payloadBytes: 0, months: []}]};
  const snapshot = {logical, index, physical: {totalBytes: 64, stores: [{id: "documents", bytes: 32}, {id: "index", bytes: 32}]}};
  expect(storageReconciliation(snapshot)).toMatchObject({state: "ready", sourceBytes: 0, remainderBytes: 64});
  expect(storageSources(snapshot)[0]).toMatchObject({documentBytes: 0, vectorBytes: 0, lexicalBytes: 0, lexicalPartial: false, bytes: 0});
});

test("source data whose physical store is temporarily absent is updating rather than silently omitted", () => {
  const result = storageReconciliation({physical: {totalBytes: 0, stores: []},
    logical: {sources: [{payloadBytes: 20}]}, index: {tables: [], lexicalBytes: 0, sources: []}});
  expect(result).toMatchObject({state: "updating", sourceBytes: 20, remainderBytes: null});
});
