// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../../db.js";
import { directReadPort } from "../../scheduler/read-port.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { StatusCache } from "./StatusCache.js";
import {
  STATUS_CACHE_READS,
  type StatusCacheReads,
  type StatusCacheSnapshot,
} from "./status-cache-reads.js";
import type { AnalyticsDb } from "../../analytics-db.js";

const paths: string[] = [];
const handles: Array<{ open: boolean; close(): void }> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const handle of handles.splice(0)) if (handle.open) handle.close();
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  }
});

describe("StatusCache lifetime", () => {
  test("retires its refresh timer when its owning database closes", async () => {
    vi.useFakeTimers();
    const path = `/tmp/omnesis-status-cache-${randomUUID()}.db`;
    paths.push(path);
    const db = createDatabase(path);
    const cache = new StatusCache(db);
    const stop = vi.spyOn(cache, "stop");

    cache.start();
    db.close();
    await vi.advanceTimersByTimeAsync(StatusCache.REFRESH_INTERVAL_MS);

    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("StatusCache refresh through a read port", () => {
  function setup() {
    const path = `/tmp/omnesis-status-cache-${randomUUID()}.db`;
    paths.push(path);
    const db = createDatabase(path);
    const portDb = createDatabase(path);
    handles.push(db, portDb);
    const direct = directReadPort(STATUS_CACHE_READS, portDb);
    let release: (() => void) | null = null;
    let deferNext = false;
    const reads: StatusCacheReads = {
      statusCacheSnapshot: vi.fn(async () => {
        const snapshot = await direct.statusCacheSnapshot();
        if (!deferNext) return snapshot;
        deferNext = false;
        return new Promise<StatusCacheSnapshot>((resolve) => {
          release = () => resolve(snapshot);
        });
      }),
    };
    return {
      db,
      reads,
      cache: new StatusCache(db, undefined, reads),
      deferNextRead: () => (deferNext = true),
      releaseDeferredRead: () => release?.(),
    };
  }

  test("the periodic refresh reads through the port, not on the main handle", async () => {
    const { db, reads, cache } = setup();
    cache.refreshDb();
    createDevice(db, { name: "Example laptop", kind: "collector" });
    const prepare = vi.spyOn(db, "prepare");

    await cache.refreshAll();

    expect(prepare).not.toHaveBeenCalled();
    expect(reads.statusCacheSnapshot).toHaveBeenCalledOnce();
    expect(cache.listDevices.map((d) => d.name)).toEqual(["Example laptop"]);
  });

  test("a bump that lands while a port read is in flight keeps its newer data", async () => {
    const { db, cache, deferNextRead, releaseDeferredRead } = setup();
    deferNextRead();
    const refresh = cache.refreshAll();
    // Let the port read take its snapshot before the mutation lands.
    await new Promise((resolve) => setImmediate(resolve));
    createDevice(db, { name: "Example phone", kind: "ios" });
    cache.bump();
    expect(cache.listDevices.map((d) => d.name)).toEqual(["Example phone"]);

    releaseDeferredRead();
    await refresh;

    expect(cache.listDevices.map((d) => d.name)).toEqual(["Example phone"]);
    await cache.refreshAll();
    expect(cache.listDevices.map((d) => d.name)).toEqual(["Example phone"]);
  });

  test("a failed port read is reported, unless it met a lock or the cache had stopped", async () => {
    const path = `/tmp/omnesis-status-cache-${randomUUID()}.db`;
    paths.push(path);
    const db = createDatabase(path);
    handles.push(db);
    let fail: (err: Error) => void = () => {};
    const reads: StatusCacheReads = {
      statusCacheSnapshot: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    };
    const cache = new StatusCache(db, undefined, reads);
    const failing = cache.refreshAll();
    fail(new Error("io worker unavailable"));
    await expect(failing).rejects.toThrow("io worker unavailable");

    // A worker that met the writer's lock keeps the previous cache, as on main.
    const locked = cache.refreshAll();
    fail(new Error("SqliteError: database is locked"));
    await expect(locked).resolves.toBeUndefined();

    const stopping = cache.refreshAll();
    cache.stop();
    fail(new Error("scheduler disposed"));
    await expect(stopping).resolves.toBeUndefined();
  });

  test("the analytics refresh reads only each table's activity", async () => {
    const path = `/tmp/omnesis-status-cache-${randomUUID()}.db`;
    paths.push(path);
    const db = createDatabase(path);
    const getCatalog = vi.fn();
    const analyticsDb = {
      getCatalog,
      getCatalogActivity: vi.fn(async () => [
        {
          tableName: "example_steps",
          displayName: "Steps",
          sourceId: "example-health",
          recordCount: 4,
          latestDate: "2027-02-01 09:00:00",
        },
        {
          tableName: "example_heart_rate",
          displayName: "Heart rate",
          sourceId: "example-health",
          recordCount: 3,
          latestDate: "2027-02-02 09:00:00+00",
        },
      ]),
    } as unknown as AnalyticsDb;
    handles.push(db);
    const cache = new StatusCache(db, analyticsDb);

    await cache.refreshAnalytics();

    expect(getCatalog).not.toHaveBeenCalled();
    expect(cache.analyticsByType).toEqual({ "example-health": 7 });
    expect(cache.latestAnalyticsActivity).toEqual({
      "example-health": {
        latestActivityAt: "2027-02-02T09:00:00.000Z",
        tableName: "example_heart_rate",
        tableDisplayName: "Heart rate",
      },
    });
  });
});
