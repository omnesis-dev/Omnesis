// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { upsertSourceWatermark } from "../../../data/repositories/WatermarkRepository.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let app: ReturnType<typeof createServer>;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-watermarks-route-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  app = createServer(db, dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("GET /admin/watermarks", () => {
  test("uses the API's camelCase response contract and filters by sourceId", async () => {
    const sourceId = "mail:example";
    upsertSourceWatermark(db, sourceId, {
      guarantee: "observation",
      observedAt: "2026-08-01T10:00:00.000Z",
    });
    const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
    const token = createToken(db, device.id, [SCOPE_ADMIN]).token;

    const res = await app.request(`/admin/watermarks?sourceId=${encodeURIComponent(sourceId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body).toEqual({
      items: [
        expect.objectContaining({
          sourceId,
          streamId: "default",
          guarantee: "observation",
          observedAt: "2026-08-01T10:00:00.000Z",
        }),
      ],
    });
    expect(body.items[0]).not.toHaveProperty("source_id");
    expect(body.items[0]).not.toHaveProperty("observed_at");
  });
});
