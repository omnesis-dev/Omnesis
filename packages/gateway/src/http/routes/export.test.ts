// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the export routes: POST /admin/export,
 * GET /admin/export/status, GET /admin/exports — scope guard, body
 * validation, the 202 start + poll contract, and the 409 single-flight.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { ExportService } from "../services/ExportService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let configDir: string;
let service: ExportService;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(path: string, init: RequestInit = {}, token = ADMIN_TOKEN): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function insertDoc(sourceId: string, externalId: string): void {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    sourceId.split(":")[0],
    sourceId,
    externalId,
    `Title ${externalId}`,
    "body",
    `hash-${externalId}`,
    "{}",
    "2026-01-10T09:00:00.000Z",
    "2026-01-10T09:00:00.000Z",
    "2026-01-10T09:00:00.000Z",
    "2026-01-10T09:00:00.000Z",
    null,
  );
}

// When set, the analytics stub parks on this promise — used by the 409
// test to hold an export in flight deterministically.
let analyticsGate: Promise<void> | null = null;
let releaseAnalytics: () => void = () => {};

beforeEach(() => {
  dbPath = `/tmp/omnesis-export-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  configDir = mkdtempSync(join(tmpdir(), "omnesis-export-http-"));
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  READ_TOKEN = mintToken([SCOPE_READ]);

  insertDoc("gmail:maya@example.com", "msg-1");
  insertDoc("notion:workspace-7", "page-9");

  analyticsGate = null;
  releaseAnalytics = () => {};
  service = new ExportService({
    configDir,
    gatewayDbPath: dbPath,
    analyticsExport: async () => {
      if (analyticsGate) await analyticsGate;
      return [];
    },
  });

  app = createServer(db, dbPath, {
    writeGate: directWriteGate(db),
    exportService: service,
    configDir,
  });
});

afterEach(async () => {
  releaseAnalytics();
  analyticsGate = null;
  await service.whenIdle();
  db.close();
  cleanupDb(dbPath);
  rmSync(configDir, { recursive: true, force: true });
});

describe("export routes", () => {
  test("admin scope is required", async () => {
    expect((await req("/admin/export/status", {}, READ_TOKEN)).status).toBe(403);
    expect((await req("/admin/exports", {}, READ_TOKEN)).status).toBe(403);
    expect((await req("/admin/export", { method: "POST", body: "{}" }, READ_TOKEN)).status).toBe(
      403,
    );
  });

  test("POST starts an export; status and list reflect it once complete", async () => {
    const res = await req("/admin/export", {
      method: "POST",
      body: JSON.stringify({ format: "json" }),
    });
    expect(res.status).toBe(202);
    const { exportId } = (await res.json()) as { exportId: string };
    expect(exportId).toBeTruthy();

    await service.whenIdle();

    const status = (await (await req("/admin/export/status")).json()) as {
      running: boolean;
      lastResult?: { exportId: string; ok: boolean; documentCount: number; files: string[] };
    };
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(true);
    expect(status.lastResult?.exportId).toBe(exportId);
    expect(status.lastResult?.documentCount).toBe(2);
    expect(status.lastResult?.files).toContain("documents.jsonl");

    const list = (await (await req("/admin/exports")).json()) as {
      exports: Array<{ path: string; format: string; documentCount: number }>;
    };
    expect(list.exports.length).toBe(1);
    expect(list.exports[0].format).toBe("json");
    expect(list.exports[0].documentCount).toBe(2);
    expect(existsSync(join(list.exports[0].path, "manifest.json"))).toBe(true);
  });

  test("invalid body is rejected with the canonical 400 envelope", async () => {
    const res = await req("/admin/export", {
      method: "POST",
      body: JSON.stringify({ format: "xml" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("a second POST while one runs returns 409", async () => {
    // Park the in-flight export at the analytics stage so it can't finish
    // between the two requests.
    analyticsGate = new Promise<void>((resolve) => (releaseAnalytics = resolve));
    const first = await req("/admin/export", {
      method: "POST",
      body: JSON.stringify({ format: "csv" }),
    });
    expect(first.status).toBe(202);

    const second = await req("/admin/export", { method: "POST", body: "{}" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");

    releaseAnalytics();
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);
  });
});
