// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the backup routes: POST /admin/backup,
 * GET /admin/backup/status, GET /admin/backups — scope guard, body
 * validation, the 202 start + poll contract, and the 409 single-flight.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { BackupService } from "../services/BackupService.js";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let configDir: string;
let service: BackupService;
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

// When set, the analytics stub parks on this promise — used by the 409
// test to hold a backup in flight deterministically.
let analyticsGate: Promise<void> | null = null;
let releaseAnalytics: () => void = () => {};

beforeEach(() => {
  dbPath = `/tmp/omnesis-backup-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  configDir = mkdtempSync(join(tmpdir(), "omnesis-backup-http-"));
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  READ_TOKEN = mintToken([SCOPE_READ]);

  // Small index.db so includeIndex has something to vacuum; the gateway DB
  // under test doubles as the backup source.
  const indexDbPath = join(configDir, "index.db");
  const idx = new Database(indexDbPath);
  idx.exec("CREATE TABLE chunks (id TEXT)");
  idx.prepare("INSERT INTO chunks (id) VALUES (?)").run("c1");
  idx.close();
  const analyticsDbPath = join(configDir, "analytics.db");
  writeFileSync(analyticsDbPath, "duckdb-placeholder");
  writeFileSync(join(configDir, "omnesis.json"), JSON.stringify({ sources: [] }));

  analyticsGate = null;
  releaseAnalytics = () => {};
  service = new BackupService({
    configDir,
    gatewayDbPath: dbPath,
    indexDbPath,
    analyticsDbPath,
    analyticsBackup: async (dest) => {
      writeFileSync(dest, "analytics-copy");
      if (analyticsGate) await analyticsGate;
    },
    statfs: () => ({ bavail: 1_000_000_000, bsize: 4096 }),
  });

  app = createServer(db, dbPath, {
    writeGate: directWriteGate(db),
    backupService: service,
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

describe("backup routes", () => {
  test("admin scope is required", async () => {
    expect((await req("/admin/backup/status", {}, READ_TOKEN)).status).toBe(403);
    expect((await req("/admin/backups", {}, READ_TOKEN)).status).toBe(403);
    expect((await req("/admin/backup", { method: "POST", body: "{}" }, READ_TOKEN)).status).toBe(
      403,
    );
  });

  test("POST starts a backup; status and list reflect it once complete", async () => {
    const res = await req("/admin/backup", {
      method: "POST",
      body: JSON.stringify({ note: "from-test" }),
    });
    expect(res.status).toBe(202);
    const { backupId, estimatedTotalBytes } = (await res.json()) as {
      backupId: string;
      estimatedTotalBytes?: number;
    };
    expect(backupId).toBeTruthy();
    expect(estimatedTotalBytes).toBeGreaterThan(0);

    await service.whenIdle();

    const status = (await (await req("/admin/backup/status")).json()) as {
      running: boolean;
      lastResult?: { backupId: string; ok: boolean; files: Array<{ name: string }> };
    };
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(true);
    expect(status.lastResult?.backupId).toBe(backupId);
    const names = status.lastResult?.files.map((f) => f.name) ?? [];
    expect(names).toContain("omnesis.db");
    expect(names).toContain("index.db");
    expect(names).toContain("analytics.db");
    expect(names).toContain("omnesis.json");

    const list = (await (await req("/admin/backups")).json()) as {
      backups: Array<{
        path: string;
        note?: string;
        includeIndex: boolean;
        purpose: "operator" | "pre-update";
      }>;
    };
    expect(list.backups.length).toBe(1);
    expect(list.backups[0].note).toBe("from-test");
    expect(list.backups[0].includeIndex).toBe(true);
    expect(list.backups[0].purpose).toBe("operator");
    expect(existsSync(join(list.backups[0].path, "backup-manifest.json"))).toBe(true);
  });

  test("accepts a structured pre-update purpose", async () => {
    const res = await req("/admin/backup", {
      method: "POST",
      body: JSON.stringify({ purpose: "pre-update", note: "version transition" }),
    });
    expect(res.status).toBe(202);
    await service.whenIdle();

    const list = (await (await req("/admin/backups")).json()) as {
      backups: Array<{ purpose: string; note?: string }>;
    };
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]).toMatchObject({
      purpose: "pre-update",
      note: "version transition",
    });
  });

  test("includeIndex: false skips index.db", async () => {
    const res = await req("/admin/backup", {
      method: "POST",
      body: JSON.stringify({ includeIndex: false }),
    });
    expect(res.status).toBe(202);
    await service.whenIdle();
    const status = (await (await req("/admin/backup/status")).json()) as {
      lastResult?: { ok: boolean; files: Array<{ name: string }> };
    };
    expect(status.lastResult?.ok).toBe(true);
    expect(status.lastResult?.files.map((f) => f.name)).not.toContain("index.db");
  });

  test("invalid body is rejected with the canonical 400 envelope", async () => {
    const res = await req("/admin/backup", {
      method: "POST",
      body: JSON.stringify({ note: 123 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("rejects an unknown backup purpose", async () => {
    const res = await req("/admin/backup", {
      method: "POST",
      body: JSON.stringify({ purpose: "scheduled" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("a second POST while one runs returns 409", async () => {
    // Park the in-flight backup at the analytics stage so it can't finish
    // between the two requests.
    analyticsGate = new Promise<void>((resolve) => (releaseAnalytics = resolve));
    const first = await req("/admin/backup", { method: "POST", body: "{}" });
    expect(first.status).toBe(202);

    const second = await req("/admin/backup", { method: "POST", body: "{}" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");

    releaseAnalytics();
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);
  });
});
