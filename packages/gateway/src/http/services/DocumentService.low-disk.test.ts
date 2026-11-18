// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Low-disk ingestion guard. Drives the full route → DocumentService →
 * writeGate → DB path via a real `createServer`, asserting:
 *   - an absurdly-high `minFreeDiskMb` (no real volume satisfies it) makes
 *     `POST /documents` return 507 INSUFFICIENT_STORAGE and write nothing,
 *   - the same call without the guard (default threshold) still ingests, and
 *   - `POST /documents/with-cursor` is gated the same way.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { StoragePressureManager, resolveStoragePolicy } from "../../storage/pressure.js";
import {
  captureStorageRetentionBindingInputs,
  reconcileStorageRetentionBindings,
} from "../../storage/retention-bindings.js";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

// No real /tmp volume has this much free, so the guard always trips.
const ABSURD_MIN_FREE_MB = Math.ceil(Number.MAX_SAFE_INTEGER / (1024 * 1024));

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let token: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

function ingestBody(externalId: string) {
  return JSON.stringify({
    documents: [
      {
        providerId: "google",
        sourceId: "gmail",
        externalId,
        title: `Doc ${externalId}`,
        content: `# ${externalId}\nbody`,
        contentHash: `ch-${externalId}`,
        metadata: { documentType: "email" },
        sourceCreatedAt: "2024-01-15T10:00:00Z",
        sourceUpdatedAt: "2024-01-15T10:00:00Z",
      },
    ],
  });
}

function bindRollingSource() {
  const device = createDevice(db, { name: "Invented retention collector", kind: "collector" });
  db.prepare(
    `INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at)
    VALUES ('gmail','gmail','fixture',?,1,1)`,
  ).run(device.id);
  reconcileStorageRetentionBindings(db, {
    policies: captureStorageRetentionBindingInputs(db, [{ sourceId: "gmail", maxAgeDays: 30 }]),
  });
}

function docCount(): number {
  return (
    db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM documents").get() as { c: number }
  ).c;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-low-disk-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("DocumentService low-disk guard", () => {
  test("POST /documents returns 507 under low disk and writes nothing", async () => {
    app = createServer(db, dbPath, { minFreeDiskMb: ABSURD_MIN_FREE_MB });
    const res = await req("/documents", { method: "POST", body: ingestBody("low-1") });
    expect(res.status).toBe(507);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("INSUFFICIENT_STORAGE");
    expect(body.error).toMatch(/disk space/i);
    expect(docCount()).toBe(0);
  });

  test("POST /documents/with-cursor returns 507 under low disk and writes nothing", async () => {
    app = createServer(db, dbPath, { minFreeDiskMb: ABSURD_MIN_FREE_MB });
    const res = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: "google",
        sourceId: "gmail",
        documents: [
          {
            providerId: "google",
            sourceId: "gmail",
            externalId: "lc-1",
            title: "Doc lc-1",
            content: "body",
            contentHash: "ch-lc-1",
            metadata: { documentType: "email" },
            sourceCreatedAt: "2024-01-15T10:00:00Z",
            sourceUpdatedAt: "2024-01-15T10:00:00Z",
          },
        ],
        hasMore: false,
        cursor: { page: 1 },
      }),
    });
    expect(res.status).toBe(507);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("INSUFFICIENT_STORAGE");
    expect(docCount()).toBe(0);
  });

  test("POST /documents still ingests when disk is fine (default threshold)", async () => {
    // No minFreeDiskMb wired → guard inert; ample free disk would pass anyway.
    app = createServer(db, dbPath, {});
    const res = await req("/documents", { method: "POST", body: ingestBody("ok-1") });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ingested: number };
    expect(json.ingested).toBe(1);
    expect(docCount()).toBe(1);
  });

  test("a modest threshold the volume satisfies still ingests", async () => {
    // 1 MB minimum — any real /tmp has far more, so the guard passes.
    app = createServer(db, dbPath, { minFreeDiskMb: 1 });
    const res = await req("/documents", { method: "POST", body: ingestBody("ok-2") });
    expect(res.status).toBe(200);
    expect(docCount()).toBe(1);
  });
});

describe("shared storage capacity admission", () => {
  test("quota pressure rejects direct and cursor writes, preserves existing data and cursor, then retries", async () => {
    let usageBytes = 0;
    const pressure = new StoragePressureManager({
      getPolicy: () => ({ ...resolveStoragePolicy(undefined, 0), maxBytes: 1000 }),
      measure: async () => ({
        usageBytes,
        measuredAt: Date.now(),
        volumes: [{ id: "test", totalBytes: 10000, availableBytes: 5000 }],
      }),
    });
    await pressure.refresh();
    app = createServer(db, dbPath, { assertStorageCanGrow: () => pressure.assertCanGrow() });
    const first = await req("/documents", { method: "POST", body: ingestBody("preserved") });
    expect(first.status).toBe(200);
    const page = {
      ...JSON.parse(ingestBody("page-two")),
      providerId: "google",
      sourceId: "gmail",
      hasMore: false,
      cursor: { page: 2 },
    };
    const before = db.prepare("SELECT * FROM sync_state WHERE source_id = ?").all("gmail");
    usageBytes = 1000;
    await pressure.refresh();
    const rejected = await req("/documents", {
      method: "POST",
      body: ingestBody("quota-rejected"),
    });
    expect(rejected.status).toBe(507);
    const blockedPage = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify(page),
    });
    expect(blockedPage.status).toBe(507);
    expect(docCount()).toBe(1);
    expect(db.prepare("SELECT * FROM sync_state WHERE source_id = ?").all("gmail")).toEqual(before);
    usageBytes = 900;
    await pressure.refresh();
    const retried = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify(page),
    });
    expect(retried.status).toBe(200);
    expect(docCount()).toBe(2);
    expect(
      db.prepare("SELECT cursor FROM sync_state WHERE source_id = ?").get("gmail"),
    ).toMatchObject({ cursor: JSON.stringify({ page: 2 }) });
  });

  test("rolling retention filters only its source and preserves contacts", async () => {
    bindRollingSource();
    app = createServer(db, dbPath, {
      config: { gateway: { storage: { retention: [{ sourceId: "gmail", maxAgeDays: 30 }] } } },
    });
    const old = JSON.parse(ingestBody("old")).documents[0];
    const recent = { ...old, externalId: "recent", sourceCreatedAt: new Date().toISOString() };
    const sibling = { ...old, sourceId: "gmail:other", externalId: "sibling" };
    const contact = { ...old, externalId: "contact", metadata: { documentType: "contact" } };
    const response = await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [old, recent, sibling, contact] }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ingested: number }).ingested).toBe(3);
    expect(db.prepare("SELECT external_id FROM documents ORDER BY external_id").all()).toEqual([
      { external_id: "contact" },
      { external_id: "recent" },
      { external_id: "sibling" },
    ]);
  });
});

test("an incarnation-bound retention policy never filters a replacement or absent source", async () => {
  app = createServer(db, dbPath, {
    config: {
      gateway: {
        storage: { retention: [{ sourceId: "gmail", maxAgeDays: 30 }] },
      },
    },
  });
  const response = await req("/documents", {
    method: "POST",
    body: ingestBody("different-incarnation"),
  });
  expect(response.status).toBe(200);
  expect(docCount()).toBe(1);
});

test.each(["/documents", "/documents/with-cursor"])(
  "rolling retention at %s preserves unknown and offset dates",
  async (path) => {
    bindRollingSource();
    app = createServer(db, dbPath, {
      config: { gateway: { storage: { retention: [{ sourceId: "gmail", maxAgeDays: 30 }] } } },
    });
    const old = JSON.parse(ingestBody("canonical-old")).documents[0];
    const documents = [
      { ...old, sourceCreatedAt: "2000-01-01T00:00:00Z" },
      { ...old, externalId: "invalid-old", sourceCreatedAt: "2000-unknown" },
      { ...old, externalId: "offset-old", sourceCreatedAt: "2000-01-01T00:00:00+02:00" },
      { ...old, externalId: "recent", sourceCreatedAt: new Date().toISOString() },
    ];
    const page = path.endsWith("with-cursor")
      ? { providerId: "google", sourceId: "gmail", documents, cursor: { page: 1 }, hasMore: false }
      : { documents };
    const response = await req(path, { method: "POST", body: JSON.stringify(page) });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT external_id FROM documents ORDER BY external_id").all()).toEqual([
      { external_id: "invalid-old" },
      { external_id: "offset-old" },
      { external_id: "recent" },
    ]);
  },
);

test("legacy import maxAge retains its existing comparison for ambiguous dates", async () => {
  app = createServer(db, dbPath, { config: { dataRetention: { maxAge: "1y" } } });
  const old = JSON.parse(ingestBody("legacy-ambiguous")).documents[0];
  const response = await req("/documents", {
    method: "POST",
    body: JSON.stringify({ documents: [{ ...old, sourceCreatedAt: "2000-unknown" }] }),
  });
  expect(response.status).toBe(200);
  expect(docCount()).toBe(0);
});
