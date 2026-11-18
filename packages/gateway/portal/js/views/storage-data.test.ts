// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { bytesBeforeMonthCutoff, storageSources, scheduledStorageCutoff, storageTrimStatus, visibleStorageTrimJobs } from "./storage-data.js";

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
