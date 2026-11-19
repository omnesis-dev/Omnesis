// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, type MigrationProgress } from "../data/migrations.js";
import { createDatabase, closeDrainingWal, openReadOnlyDatabase } from "../db.js";
import { createIndexDatabase, enqueueSourceIndexPurge } from "../indexer/db.js";
import { resolveActiveUsearchTarget } from "../indexer/usearch-read-registry.js";
import {
  initializeGatewayDatabase,
  initializeGatewayIndex,
  type GatewayIndexBoot,
} from "./storage.js";

async function prepareGatewayGraph(
  options: Omit<GatewayIndexBoot, "gatewayDbPath" | "gatewayDbKeyHex">,
) {
  const gatewayDbPath = join(dir, "graph-main.db");
  const mainDb = createDatabase(gatewayDbPath);
  closeDrainingWal(mainDb, () => {});
  return (await initializeGatewayIndex({ ...options, gatewayDbPath })).graph;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-startup-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("startup storage worker", () => {
  it("creates the real current schema and releases it before resolving, then restarts idempotently", async () => {
    const path = join(dir, "gateway.db");
    const events: MigrationProgress[] = [];
    const result = await initializeGatewayDatabase(
      { path },
      { onMigration: (event) => events.push(event) },
    );
    expect(result.frames).toBeGreaterThanOrEqual(0);
    const db = new Database(path);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      db.exec("BEGIN EXCLUSIVE; COMMIT");
    } finally {
      db.close();
    }
    expect(events[0]).toMatchObject({ phase: "planned", completed: 0 });
    expect(events.at(-1)).toMatchObject({ phase: "committed", version: LATEST_SCHEMA_VERSION });
    const restart: MigrationProgress[] = [];
    await initializeGatewayDatabase({ path }, { onMigration: (event) => restart.push(event) });
    expect(restart).toEqual([{ phase: "planned", current: 0, total: 0, completed: 0 }]);
  }, 30_000);

  it("initializes the encrypted schema using the same driver as normal readers", async () => {
    const path = join(dir, "encrypted.db");
    const key = randomBytes(32);
    await initializeGatewayDatabase({ path, encryptionKeyHex: key.toString("hex") });
    const db = openReadOnlyDatabase(path, { encryptionKey: key });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
    const plaintext = new Database(path, { readonly: true });
    try {
      expect(() => plaintext.prepare("SELECT name FROM sqlite_master").all()).toThrow();
    } finally {
      plaintext.close();
    }
  }, 30_000);

  it("propagates worker failures without leaving a writable handle", async () => {
    await expect(initializeGatewayDatabase({ path: dir })).rejects.toThrow();
    const path = join(dir, "recovered.db");
    await initializeGatewayDatabase({ path });
    expect(existsSync(path)).toBe(true);
  }, 30_000);

  it("does not create storage when cancelled before startup", async () => {
    const controller = new AbortController();
    controller.abort();
    const path = join(dir, "cancelled.db");
    await expect(
      initializeGatewayDatabase({ path }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(path)).toBe(false);
  });

  it("waits for worker exit on cancellation before a subsequent boot opens the same file", async () => {
    const controller = new AbortController();
    const path = join(dir, "interrupted.db");
    await expect(
      initializeGatewayDatabase(
        { path },
        {
          signal: controller.signal,
          onMigration: (event) => {
            if (event.phase === "planned") controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await initializeGatewayDatabase({ path });
    const db = new Database(path);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  }, 30_000);

  it("prepares an absent graph without requiring an embedder or deleting index data", async () => {
    const path = join(dir, "index.db");
    const db = createIndexDatabase(path);
    db.close();
    const result = await prepareGatewayGraph({
      indexDbPath: path,
      configDir: dir,
      storageEncryptionEnabled: false,
    });
    expect(result).toEqual({ validated: "absent" });
    const after = new Database(path);
    try {
      expect(
        after
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")
          .get(),
      ).toBeDefined();
    } finally {
      after.close();
    }
  }, 30_000);

  it("retains an encrypted index when no durable encrypted graph exists", async () => {
    const path = join(dir, "encrypted-index.db");
    const key = randomBytes(32);
    const db = createIndexDatabase(path, { encryptionKey: key });
    db.close();
    const result = await prepareGatewayGraph({
      indexDbPath: path,
      configDir: dir,
      indexDbKeyHex: key.toString("hex"),
      storageEncryptionEnabled: true,
    });
    expect(result).toEqual({
      restore: { restored: false, reason: "no encrypted sidecar" },
      validated: "absent",
    });
    const after = createIndexDatabase(path, { encryptionKey: key });
    try {
      expect(after.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    } finally {
      after.close();
    }
  }, 30_000);

  it("quarantines a corrupt graph in the validation subprocess before normal readers open", async () => {
    const path = join(dir, "index.db");
    const db = createIndexDatabase(path);
    const target = resolveActiveUsearchTarget(db, dir);
    db.close();
    writeFileSync(target.path, "invented corrupt index bytes");
    const result = await prepareGatewayGraph({
      indexDbPath: path,
      configDir: dir,
      storageEncryptionEnabled: false,
    });
    expect(result.validated).toBe("quarantined");
    expect(existsSync(target.path)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
  }, 30_000);

  it("reconciles the index against the keyed main database and reapplies persisted source purges before returning", async () => {
    const mainKey = randomBytes(32);
    const indexKey = randomBytes(32);
    const gatewayDbPath = join(dir, "gateway.db");
    const indexDbPath = join(dir, "index.db");
    const main = createDatabase(gatewayDbPath, { encryptionKey: mainKey });
    closeDrainingWal(main, () => {});
    const index = createIndexDatabase(indexDbPath, { encryptionKey: indexKey });
    index
      .prepare(
        "INSERT INTO indexed_documents (document_id, content_hash, chunk_count, indexed_at) VALUES (?, ?, ?, ?)",
      )
      .run("fixture-missing-document", "example-hash", 0, "2026-01-01T00:00:00Z");
    enqueueSourceIndexPurge(index, "example-source");
    index.close();
    const result = await initializeGatewayIndex({
      gatewayDbPath,
      gatewayDbKeyHex: mainKey.toString("hex"),
      indexDbPath,
      indexDbKeyHex: indexKey.toString("hex"),
      configDir: dir,
      storageEncryptionEnabled: true,
    });
    expect(result.reconciled).toMatchObject({ ran: true, removedDocuments: 1 });
    expect(result.scrubbed).toEqual({ sourceIds: ["example-source"], deletedDocuments: 0 });
    const after = createIndexDatabase(indexDbPath, { encryptionKey: indexKey });
    try {
      expect(after.prepare("SELECT * FROM indexed_documents").all()).toEqual([]);
    } finally {
      after.close();
    }
  }, 30_000);
});
