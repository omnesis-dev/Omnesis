// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { storageCleanupTarget, storageCleanupTargetForStore, storageCleanupCutoff, visibleStorageCleanupJobs, storageCleanupStatus, storageCleanupProtectedReasons, storageCleanupActive, storageCleanupRows } from "./storage-cleanup-data.js";

test("maps only the three supported physical stores to cleanup targets", () => {
  expect(storageCleanupTargetForStore("transcripts")).toBe("brain-transcripts");
  expect(storageCleanupTargetForStore("conversations")).toBe("conversations");
  expect(storageCleanupTargetForStore("backups")).toBe("backups");
  for (const key of ["documents", "index", "models", "__proto__", "constructor"]) {
    expect(storageCleanupTargetForStore(key)).toBeNull();
    expect(storageCleanupTarget(key)).toBeNull();
  }
});

test("uses an exclusive UTC boundary and refuses normalized invalid dates", () => {
  expect(storageCleanupCutoff("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
  for (const date of ["", "2025-02-29", "2024-02-30", "2024-13-01", "2024-01-00", "2024-1-1", "2024-01-01T00:00:00Z"]) {
    expect(storageCleanupCutoff(date)).toBeNull();
  }
});

test("shows active jobs alone, then the newest terminal result for the requested category", () => {
  const jobs = [
    {id: "old", target: "backups", state: "completed", updatedAt: 1},
    {id: "active", target: "backups", state: "running", updatedAt: 2},
    {id: "last", target: "backups", state: "cancelled", updatedAt: 3},
    {id: "queued", target: "backups", state: "queued", updatedAt: 4},
    {id: "other", target: "conversations", state: "running", updatedAt: 5},
  ];
  expect(visibleStorageCleanupJobs(jobs, "backups").map((job: {id: string}) => job.id)).toEqual(["active", "queued"]);
  expect(visibleStorageCleanupJobs(jobs.filter((job) => !["queued", "running"].includes(job.state)), "backups").map((job: {id: string}) => job.id)).toEqual(["last"]);
  expect(visibleStorageCleanupJobs(jobs, "brain-transcripts")).toEqual([]);
});

test.each([
  ["queued", "Cleanup queued"], ["running", "Cleaning up"], ["completed", "Cleanup completed"],
  ["failed", "Cleanup stopped"], ["cancelled", "Cleanup cancelled"],
])("reports %s progress without claiming measured free disk space", (state, label) => {
  const status = storageCleanupStatus({state, removed: 3, protected: 2, removedBytesEstimate: 1024, error: state === "failed" ? "Cleanup could not finish" : null});
  expect(status).toContain(`${label} · 3 removed · 2 protected`);
  expect(status).toContain("1 KiB estimated file data removed");
  expect(status).not.toContain("free disk space");
  if (state === "failed") expect(status).toContain("Cleanup could not finish");
});

test("reports stopping safely and labels actual protection reasons", () => {
  expect(storageCleanupStatus({state: "running", cancelRequested: true, removed: 1})).toContain("Stopping after current cleanup");
  expect(storageCleanupProtectedReasons({protectedReasons: {active: 2, newest: 1, constructor: 3, unsafe: 0, invalid: -1}})).toEqual([
    {label: "Active", count: 2}, {label: "Newest backup", count: 1}, {label: "Other protected", count: 3},
  ]);
});

test("failed jobs with durable pending removal remain active and keep their category visible", () => {
  const job = {id: "pending-one", target: "backups", state: "failed", hasPendingRemoval: true};
  expect(storageCleanupActive(job)).toBe(true);
  expect(storageCleanupActive({...job, hasPendingRemoval: false})).toBe(false);
  expect(storageCleanupStatus(job)).toContain("retrying automatically");
  expect(storageCleanupRows([], [job])).toEqual([expect.objectContaining({id: "backups", label: "Backups", bytes: 0})]);
  expect(visibleStorageCleanupJobs([job, {...job, id: "completed", state: "completed", updatedAt: 2}], "backups")).toEqual([job]);
});
