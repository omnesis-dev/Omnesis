// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Secure live-storage E2E.
 *
 * Boots the real gateway with a file-backed install root key, lets gateway boot
 * create wrapped per-store keys and migrate live stores, then verifies:
 *   - real HTTP document + analytics writes still work
 *   - `omnesis.db` and `index.db` are not plaintext SQLite files
 *   - `analytics.db` cannot be opened by DuckDB without its encryption key
 */

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureInstallRootKey } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

describe("secure live storage", () => {
  let harness: SyntheticE2EHarness;
  let priorSecretStore: string | undefined;

  beforeAll(async () => {
    priorSecretStore = process.env.OMNESIS_SECRET_STORE;
    process.env.OMNESIS_SECRET_STORE = "file";
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await ensureInstallRootKey({ backend: "file", configDir: harness.getConfigDir() });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
    if (priorSecretStore === undefined) {
      delete process.env.OMNESIS_SECRET_STORE;
    } else {
      process.env.OMNESIS_SECRET_STORE = priorSecretStore;
    }
  }, 30_000);

  test("serves document and analytics writes while live stores are encrypted on disk", async () => {
    await harness.pushDocument({
      sourceId: "synthetic:test@example.com",
      providerId: "synthetic:test@example.com",
      externalId: "secure-storage-doc-1",
      title: "storage encryption e2e",
      content: "secure storage e2e document content",
    });
    const docs = await harness.gatewayJson<{
      documents: Array<{ title: string; contentPreview: string }>;
    }>(`/documents/recent/${encodeURIComponent("synthetic:test@example.com")}?limit=1`);
    expect(docs.documents[0]).toMatchObject({
      title: "storage encryption e2e",
      contentPreview: "secure storage e2e document content",
    });

    await harness.pushAnalyticsRow("secure_e2e_metrics", {
      id: "metric-1",
      label: "secure-storage-e2e",
      value: 42,
    });
    const analytics = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT label, value FROM secure_e2e_metrics WHERE id = 'metric-1'",
      }),
    });
    expect(analytics.rows).toEqual([["secure-storage-e2e", 42]]);

    expectSqliteStoreEncrypted(harness.getDbPath());
    expectSqliteStoreEncrypted(join(harness.getConfigDir(), "index.db"));
    await expect(
      DuckDBInstance.create(join(harness.getConfigDir(), "analytics.db"), {
        access_mode: "READ_ONLY",
      }),
    ).rejects.toThrow();
  });
});

function expectSqliteStoreEncrypted(path: string): void {
  expect(readFileSync(path).subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)).toBe(false);
  expect(() => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    } finally {
      db.close();
    }
  }).toThrow();
}
