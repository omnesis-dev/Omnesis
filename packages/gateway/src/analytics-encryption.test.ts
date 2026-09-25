// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { AnalyticsDb } from "./analytics-db.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const schema: AnalyticsTableSchema = {
  tableName: "secure_metrics",
  displayName: "storage metrics",
  description: "Synthetic secure-storage metrics",
  columns: [
    { name: "id", type: "VARCHAR", description: "Record ID" },
    { name: "label", type: "VARCHAR", description: "Synthetic label" },
    { name: "value", type: "DOUBLE", description: "Synthetic value" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["label"], keyColumns: ["id", "label"] },
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-analytics-encryption-"));
  dirs.push(dir);
  return dir;
}

describe("AnalyticsDb encryption", () => {
  test("migrates a plaintext analytics store, preserves rows, and keeps SQL sandboxing", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "analytics.db");
    const encryptionKeyHex = randomBytes(32).toString("hex");

    const plaintext = new AnalyticsDb(dbPath);
    await plaintext.open();
    await plaintext.ensureTable(schema, "secure-source:local");
    await plaintext.insertRecords(
      "secure_metrics",
      [{ id: "row-1", label: "encrypted-duckdb-row", value: 7 }],
      ["id"],
    );
    await plaintext.close();

    const encrypted = new AnalyticsDb(dbPath, { encryptionKeyHex });
    await encrypted.open();
    const result = await encrypted.executeQuery("SELECT label, value FROM secure_metrics");
    expect(result.rows).toEqual([["encrypted-duckdb-row", 7]]);
    await expect(
      encrypted.executeQuery("INSERT INTO secure_metrics VALUES ('row-x', 'smuggled', 1)"),
    ).rejects.toThrow();
    await expect(encrypted.executeQuery("SET memory_limit='64GiB'")).rejects.toThrow();
    await expect(
      encrypted.executeQuery(`SELECT * FROM read_csv_auto('${join(dir, "probe.csv")}')`),
    ).rejects.toThrow(/read_csv_auto/);
    const operationalPath = join(dir, "fictional-operational.sqlite");
    const operational = new Database(operationalPath);
    operational.exec("CREATE TABLE tokens (id TEXT PRIMARY KEY, fictional_secret TEXT NOT NULL)");
    operational
      .prepare("INSERT INTO tokens (id, fictional_secret) VALUES (?, ?)")
      .run("token-1", "synthetic-secret-never-readable");
    operational.close();
    await expect(
      encrypted.executeQuery(`SELECT * FROM sqlite_scan('${operationalPath}', 'tokens')`),
    ).rejects.toThrow();
    await expect(
      encrypted.executeQuery(`ATTACH '${operationalPath}' AS operational (TYPE SQLITE, READ_ONLY)`),
    ).rejects.toThrow();
    await expect(
      encrypted.executeQuery(`CALL sqlite_attach('${operationalPath}', overwrite = false)`),
    ).rejects.toThrow();
    await encrypted.close();

    await expect(DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" })).rejects.toThrow();

    const reopened = new AnalyticsDb(dbPath, { encryptionKeyHex });
    await reopened.open();
    const reopenedResult = await reopened.executeQuery("SELECT COUNT(*) FROM secure_metrics");
    expect(reopenedResult.rows).toEqual([[1]]);
    await reopened.close();
  });

  test("writes encrypted analytics backups when the live store is encrypted", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "analytics.db");
    const destPath = join(dir, "analytics-backup.db");
    const encryptionKeyHex = randomBytes(32).toString("hex");

    const db = new AnalyticsDb(dbPath, { encryptionKeyHex });
    await db.open();
    await db.ensureTable(schema, "secure-source:local");
    await db.insertRecords(
      "secure_metrics",
      [{ id: "row-2", label: "backup-row", value: 11 }],
      ["id"],
    );
    await db.backupTo(destPath);
    await db.close();

    await expect(DuckDBInstance.create(destPath, { access_mode: "READ_ONLY" })).rejects.toThrow();

    const backup = new AnalyticsDb(destPath, { encryptionKeyHex });
    await backup.open();
    const result = await backup.executeQuery("SELECT label FROM secure_metrics");
    expect(result.rows).toEqual([["backup-row"]]);
    await backup.close();
  });
});
