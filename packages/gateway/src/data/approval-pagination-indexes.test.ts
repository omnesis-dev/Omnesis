// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createSubscriptionApprovalListIndexes } from "../subscriptions/store-schema.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

describe("approval pagination query plans", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  const plan = (sql: string, ...params: unknown[]): string =>
    db
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join("\n");

  test("ordinary approval history uses tuple-order indexes for filtered and all pages", () => {
    expect(
      plan(
        `SELECT id FROM answer_approvals
          WHERE status = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
        "approved",
        51,
      ),
    ).toContain("idx_answer_approvals_page");
    expect(
      plan("SELECT id FROM answer_approvals ORDER BY created_at DESC, id DESC LIMIT ?", 51),
    ).toContain("idx_answer_approvals_all_page");
    expect(
      plan("SELECT COUNT(*) FROM answer_approvals WHERE status = 'pending' AND expires_at > ?", 1),
    ).toContain("idx_answer_approvals_effective_status");
  });

  test("subscription pending approval pages start from an indexed bounded candidate set", () => {
    const detail = plan(
      `SELECT a.id
         FROM subscription_approvals a
         JOIN subscription_revisions r
           ON r.subscription_id = a.subscription_id AND r.revision = a.revision
        WHERE a.status = 'pending'
          AND a.expires_at > ?
          AND CASE WHEN json_valid(r.reaction_json)
                   THEN json_extract(r.reaction_json, '$.kind') END = 'agent-workflow'
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?`,
      1,
      51,
    );
    expect(detail).toMatch(/idx_subscription_approvals_(?:page|effective_status)/);
    expect(detail).not.toContain("SCAN a");

    expect(
      plan("SELECT id FROM subscription_approvals ORDER BY created_at DESC, id DESC LIMIT ?", 51),
    ).toContain("idx_subscription_approvals_all_page");
  });

  test("legacy subscription schemas without reaction payloads still install approval indexes", () => {
    const legacyDb = new Database(":memory:") as unknown as Db;
    try {
      legacyDb.exec(`
        CREATE TABLE subscription_approvals (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE subscription_revisions (
          subscription_id TEXT NOT NULL,
          revision INTEGER NOT NULL
        );
      `);

      expect(() => createSubscriptionApprovalListIndexes(legacyDb)).not.toThrow();
      const indexes = legacyDb
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("idx_subscription_approvals_page");
      expect(indexes).toContain("idx_subscription_approvals_all_page");
      expect(indexes).not.toContain("idx_subscription_revisions_reaction_kind");
    } finally {
      legacyDb.close();
    }
  });
});
