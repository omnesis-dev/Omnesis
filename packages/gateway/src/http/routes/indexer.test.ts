// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for POST /admin/index/rebuild — the swap-mode contract.
 *The route carries the operator's graceful/hard choice from the
 * portal/CLI swap-confirm flow through to `indexerControl.rebuild(mode)`;
 * `applyEmbedSwap` itself is unit-tested in indexer-lifecycle.test.ts. Uses a
 * stub indexerControl that records the mode it was called with.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;
let rebuiltWith: Array<string | undefined>;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function rebuild(body: unknown, opts: { token?: string } = {}) {
  return app.request("/admin/index/rebuild", {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token ?? ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : (JSON.stringify(body) as unknown as BodyInit),
  });
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-indexer-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  rebuiltWith = [];
  app = createServer(db, dbPath, {
    indexerControl: {
      reindexMissing: async () => ({ indexed: 0, errors: 0 }),
      rebuild: async (mode) => {
        rebuiltWith.push(mode);
      },
    },
  });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("POST /admin/index/rebuild", () => {
  test("defaults to graceful when no mode is given", async () => {
    const res = await rebuild({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body).toEqual({ ok: true, mode: "graceful" });
    expect(rebuiltWith).toEqual(["graceful"]);
  });

  test("forwards an explicit graceful mode", async () => {
    const res = await rebuild({ mode: "graceful" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ mode: "graceful" });
    expect(rebuiltWith).toEqual(["graceful"]);
  });

  test("forwards a hard cutover to indexerControl.rebuild", async () => {
    const res = await rebuild({ mode: "hard" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ ok: true, mode: "hard" });
    expect(rebuiltWith).toEqual(["hard"]);
  });

  test("rejects an unknown mode with 400 and never kicks a swap", async () => {
    const res = await rebuild({ mode: "obliterate" });
    expect(res.status).toBe(400);
    expect(rebuiltWith).toEqual([]);
  });

  test("tolerates a missing/empty body (defaults graceful)", async () => {
    const res = await rebuild(undefined);
    expect(res.status).toBe(200);
    expect(rebuiltWith).toEqual(["graceful"]);
  });

  test("requires the admin scope (a read-only token is rejected)", async () => {
    const res = await rebuild({ mode: "hard" }, { token: READ_TOKEN });
    expect(res.status).toBe(403);
    expect(rebuiltWith).toEqual([]);
  });
});
