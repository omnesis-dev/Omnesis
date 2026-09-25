// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../../db.js";
import { StatusCache } from "./StatusCache.js";

const paths: string[] = [];

afterEach(() => {
  vi.useRealTimers();
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
