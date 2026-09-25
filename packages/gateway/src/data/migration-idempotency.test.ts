// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Standing migration-idempotency fixture.
 *
 * A deterministic near-head sentinel database is opened twice through the
 * production DB path. The first boot must record the current migration tail
 * while preserving representative seeded activity; the second boot must be a
 * complete no-op. Per-migration tests cover historical table shapes.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  buildSeedDatabase,
  SEEDED_SCHEMA_VERSION,
  SEED_READ_BRIEF_ID,
  SEED_UNREAD_BRIEF_ID,
} from "./migration-idempotency-seed.js";
import type { Db } from "./types.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mig-idem-"));
  dbPath = join(dir, `omnesis-test-${randomUUID()}.db`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function materialiseSeed(): void {
  const seed = new Database(dbPath) as unknown as Db;
  try {
    buildSeedDatabase(seed);
  } finally {
    seed.close();
  }
}

function userVersion(db: Db): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function indexNames(db: Db): Set<string> {
  return new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IS NOT NULL",
      )
      .all()
      .map((row) => row.name),
  );
}

describe("migration-idempotency standing fixture", () => {
  test("the seed remains several versions behind head", () => {
    expect(SEEDED_SCHEMA_VERSION).toBeLessThan(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION - SEEDED_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });

  test("first boot upgrades seeded data and installs the current migration tail", () => {
    materialiseSeed();

    const db = createDatabase(dbPath) as unknown as Db;
    try {
      expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      const recorded = new Set(
        db
          .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
          .all()
          .map((row) => row.version),
      );
      // The seed's own baseline row, then every migration past it and nothing
      // else — derived rather than listed, so the assertion is about the tail
      // being complete rather than about which version happens to be head.
      const tail = new Set<number>();
      for (let v = SEEDED_SCHEMA_VERSION; v <= LATEST_SCHEMA_VERSION; v += 1) tail.add(v);
      expect(recorded).toEqual(tail);

      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('temporal_annotations')",
          )
          .all()
          .map((row) => row.name),
      ).not.toContain("thread_conversation_id");

      const briefColumns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('briefs')")
        .all()
        .map((row) => row.name);
      expect(briefColumns).toContain("read_at");

      expect(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
          .all()
          .map((row) => row.name),
      ).toEqual(
        expect.arrayContaining([
          "push_transport",
          "relay_url",
          "relay_credential",
          "relay_consent_app_id",
          "relay_consented_at",
        ]),
      );
      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notifications', 'notification_deliveries') ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["notification_deliveries", "notifications"]);

      const briefs = db
        .prepare<
          [],
          { id: string; state: string; read_at: number | null }
        >("SELECT id, state, read_at FROM briefs ORDER BY id")
        .all();
      expect(briefs).toEqual([
        { id: SEED_READ_BRIEF_ID, state: "read", read_at: null },
        { id: SEED_UNREAD_BRIEF_ID, state: "unread", read_at: null },
      ]);

      const indexes = indexNames(db);
      expect(indexes).toContain("idx_cognition_runs_retention");
      expect(indexes).toContain("idx_merge_candidates_history");
      expect(indexes).toContain("idx_briefs_read_snapshot");
      expect(
        db
          .prepare<
            [],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'answer_completion_deliveries'")
          .get()?.name,
      ).toBe("answer_completion_deliveries");
      expect(
        db
          .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('answer_tasks')")
          .all()
          .map((row) => row.name),
      ).toEqual(
        expect.arrayContaining(["completion_device_id", "completion_native_conversation_id"]),
      );
      expect(indexes).toContain("idx_open_loops_active_importance_page");
      expect(indexes).toContain("idx_cognition_runs_status_kind_scheduled_page");
      expect(indexes).toContain("idx_answer_approvals_page");
      expect(indexes).toContain("idx_subscription_approvals_page");
      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('subscription_approvals')",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(expect.arrayContaining(["privacy_review_json", "disclosure_categories_json"]));
      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('subscription_grants')",
          )
          .all()
          .map((row) => row.name),
      ).toContain("disclosure_categories_json");

      const removedDocumentColumns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('removed_documents')")
        .all()
        .map((row) => row.name);
      expect(removedDocumentColumns).toContain("original_document_id");

      const cognitionRunColumns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
        .all()
        .map((row) => row.name);
      expect(cognitionRunColumns).toContain("failure_code");

      expect(
        db
          .prepare<
            [],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_watermarks'")
          .all(),
      ).toHaveLength(1);

      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('temporal_annotation_evidence')",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["annotation_id", "position", "document_id", "quote", "broken_at"]);

      expect(
        db
          .prepare<[], { scope: string }>("SELECT scope FROM mutable_list_revisions ORDER BY scope")
          .all()
          .map((row) => row.scope),
      ).toEqual(["cognition-coverage", "cognition-runs", "link-declarations", "product-loops"]);
    } finally {
      db.close();
    }
  });

  test("second boot is a no-op with no row or migration-history churn", () => {
    materialiseSeed();

    const first = createDatabase(dbPath) as unknown as Db;
    let firstBriefs: Array<Record<string, unknown>>;
    let firstMigrationCount: number;
    try {
      firstBriefs = first
        .prepare<
          [],
          Record<string, unknown>
        >("SELECT id, state, read_at, created_at, updated_at FROM briefs ORDER BY id")
        .all();
      firstMigrationCount = first
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()!.count;
    } finally {
      first.close();
    }

    const second = createDatabase(dbPath) as unknown as Db;
    try {
      expect(userVersion(second)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        second
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM schema_migrations")
          .get()!.count,
      ).toBe(firstMigrationCount);
      expect(
        second
          .prepare<
            [],
            Record<string, unknown>
          >("SELECT id, state, read_at, created_at, updated_at FROM briefs ORDER BY id")
          .all(),
      ).toEqual(firstBriefs);
    } finally {
      second.close();
    }
  });

  test("the seed materialises a readable on-disk near-head database", () => {
    materialiseSeed();
    expect(statSync(dbPath).size).toBeGreaterThan(0);

    const raw = new Database(dbPath, { readonly: true }) as unknown as Db;
    try {
      expect(userVersion(raw)).toBe(SEEDED_SCHEMA_VERSION);
      const columns = raw
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('briefs')")
        .all()
        .map((row) => row.name);
      expect(columns).toContain("read_at");
    } finally {
      raw.close();
    }
  });
});
