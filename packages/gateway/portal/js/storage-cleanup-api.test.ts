// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { getStorageCleanupJobs, startStorageCleanup, cancelStorageCleanup } from "./api.js";
afterEach(() => vi.unstubAllGlobals());

test("reads durable jobs without caching and schedules or cancels through the admin API", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({job: {id: "job-one"}, jobs: []}), {headers: {"Content-Type": "application/json"}}));
  vi.stubGlobal("fetch", fetchMock);
  await expect(getStorageCleanupJobs()).resolves.toMatchObject({jobs: []});
  expect(fetchMock).toHaveBeenLastCalledWith("/admin/storage/cleanup/jobs", expect.objectContaining({method: "GET", cache: "no-store"}));
  const body = {target: "backups", before: "2024-01-01T00:00:00.000Z", keepNewest: false};
  await expect(startStorageCleanup(body)).resolves.toMatchObject({job: {id: "job-one"}});
  expect(fetchMock).toHaveBeenLastCalledWith("/admin/storage/cleanup/jobs", expect.objectContaining({method: "POST", body: JSON.stringify(body)}));
  await cancelStorageCleanup("job/one");
  expect(fetchMock).toHaveBeenLastCalledWith("/admin/storage/cleanup/jobs/job%2Fone/cancel", expect.objectContaining({method: "POST"}));
});
