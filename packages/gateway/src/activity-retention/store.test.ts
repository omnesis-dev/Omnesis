// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createDatabase } from "../db.js";
import { pruneActivityRetentionBatch, reclaimActivityRetentionPages } from "./store.js";
import type { Db } from "../data/types.js";

describe("activity retention storage", () => {
  let dir: string;
  let db: Db;

  function seedSubscription(): void {
    db.prepare(
      `INSERT INTO devices (id, name, kind, paired_at)
       VALUES ('device_1', 'Example integration', 'agent-integration', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_workflows
         (id, owner_id, name, status, created_at, expires_at)
       VALUES ('workflow_1', 'owner_1', 'Example workflow', 'active', 0, 999999)`,
    ).run();
    db.prepare(
      `INSERT INTO subscriptions
         (id, integration_device_id, owner_id, workflow_id, client_request_id,
          request_fingerprint, status, created_at, updated_at)
       VALUES ('subscription_1', 'device_1', 'owner_1', 'workflow_1', 'request_1',
               'fingerprint_1', 'active', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO subscription_revisions
         (subscription_id, revision, workflow_id, condition_json, reaction_json,
          interpretation_json, compiled_plan_json, compiler_version, policy_revision, created_at)
       VALUES ('subscription_1', 1, 'workflow_1', '{}', '{}', '{}', '{}', 'test', 'policy_1', 0)`,
    ).run();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-activity-retention-"));
    db = createDatabase(join(dir, "omnesis.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("terminal cognition runs are pruned in bounded batches", () => {
    const insert = db.prepare(
      `INSERT INTO cognition_runs
         (id, kind, status, next_attempt_at, enqueued_at, cycle_anchor_at, completed_at)
       VALUES (?, 'data', ?, 0, 0, 0, ?)`,
    );
    insert.run("old_1", "completed", 100);
    insert.run("old_2", "failed", 101);
    insert.run("old_3", "completed", 102);
    insert.run("fresh", "completed", 10_000);
    insert.run("pending", "pending", null);

    expect(pruneActivityRetentionBatch(db, "cognitionRuns", 1_000, 2)).toMatchObject({
      deleted: 2,
      hasMore: true,
    });
    expect(pruneActivityRetentionBatch(db, "cognitionRuns", 1_000, 2)).toMatchObject({
      deleted: 1,
      hasMore: false,
    });
    expect(
      db.prepare<[], { id: string }>("SELECT id FROM cognition_runs ORDER BY id").all(),
    ).toEqual([{ id: "fresh" }, { id: "pending" }]);
  });

  test("only resolved developer annotations expire", () => {
    db.prepare(
      `INSERT INTO dev_annotations
         (id, target_type, note, status, created_at, resolved_at)
       VALUES (?, 'route', 'Invented test note', ?, 0, ?)`,
    ).run("resolved_old", "resolved", 100);
    db.prepare(
      `INSERT INTO dev_annotations
         (id, target_type, note, status, created_at, resolved_at)
       VALUES (?, 'route', 'Invented open note', 'open', 0, NULL)`,
    ).run("open_old");

    expect(pruneActivityRetentionBatch(db, "resolvedDevAnnotations", 1_000, 100).deleted).toBe(1);
    // An open note is a question the operator has not answered yet, so it
    // survives its own age.
    expect(db.prepare<[], { id: string }>("SELECT id FROM dev_annotations").all()).toEqual([
      { id: "open_old" },
    ]);
  });

  test("terminal subscription firing deletion revokes its bearer token atomically", () => {
    seedSubscription();
    const firing = db.prepare(
      `INSERT INTO subscription_firings
         (id, subscription_id, revision, workflow_id, index_event_key, status, fired_at)
       VALUES (?, 'subscription_1', 1, 'workflow_1', ?, ?, ?)`,
    );
    firing.run("firing_old", "event_old", "delivered", 100);
    firing.run("firing_pending", "event_pending", "pending", 100);
    firing.run("firing_review", "event_review", "delivered", 100);
    db.prepare(
      `INSERT INTO subscription_deliveries
         (id, firing_id, subscription_id, revision, integration_device_id, workflow_id,
          status, created_at, updated_at)
       VALUES ('delivery_old', 'firing_old', 'subscription_1', 1, 'device_1',
               'workflow_1', 'delivered', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO subscription_deliveries
         (id, firing_id, subscription_id, revision, integration_device_id, workflow_id,
          status, created_at, updated_at)
       VALUES ('delivery_review', 'firing_review', 'subscription_1', 1, 'device_1',
               'workflow_1', 'manual_review', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tokens (id, device_id, token_hash, created_at)
       VALUES ('token_old', 'device_1', 'hash_old', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO subscription_firing_answer_authorities
         (id, token_id, delivery_id, firing_id, subscription_id, revision, workflow_id,
          owner_id, policy_revision, created_at, expires_at)
       VALUES ('authority_old', 'token_old', 'delivery_old', 'firing_old',
               'subscription_1', 1, 'workflow_1', 'owner_1', 'policy_1', 0, 999999)`,
    ).run();

    expect(pruneActivityRetentionBatch(db, "subscriptionFirings", 1_000, 25).deleted).toBe(1);
    expect(db.prepare("SELECT id FROM tokens WHERE id = 'token_old'").get()).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM subscription_firings WHERE id = 'firing_old'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM subscription_firings WHERE id = 'firing_pending'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT id FROM subscription_firings WHERE id = 'firing_review'").get(),
    ).toBeTruthy();
  });

  test("old audit events expire", () => {
    seedSubscription();
    const audit = db.prepare(
      `INSERT INTO subscription_audit_events
         (id, subscription_id, revision, event_type, display_json, created_at)
       VALUES (?, 'subscription_1', 1, 'test_event', '{}', ?)`,
    );
    audit.run("audit_old", 100);
    audit.run("audit_fresh", 10_000);

    expect(pruneActivityRetentionBatch(db, "subscriptionAudit", 1_000, 100).deleted).toBe(1);
    expect(
      db.prepare<[], { id: string }>("SELECT id FROM subscription_audit_events").all(),
    ).toEqual([{ id: "audit_fresh" }]);
  });

  test("fresh databases support bounded incremental page reclamation", () => {
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(2);
    db.exec("CREATE TABLE retention_reclaim_test (payload TEXT)");
    const insert = db.prepare("INSERT INTO retention_reclaim_test (payload) VALUES (?)");
    db.transaction(() => {
      for (let i = 0; i < 2_000; i += 1) insert.run("x".repeat(2_000));
    })();
    db.exec("DELETE FROM retention_reclaim_test");
    const before = db.pragma("freelist_count", { simple: true }) as number;
    expect(before).toBeGreaterThan(0);
    expect(reclaimActivityRetentionPages(db, 8)).toBeGreaterThan(0);
    expect(db.pragma("freelist_count", { simple: true }) as number).toBeLessThan(before);
  });

  test("opening an existing mode-NONE database never triggers an online conversion", () => {
    const path = join(dir, "existing.db");
    const existing = new Database(path);
    existing.exec("CREATE TABLE existing_data (id INTEGER PRIMARY KEY)");
    existing.close();

    const reopened = createDatabase(path);
    try {
      expect(reopened.pragma("auto_vacuum", { simple: true })).toBe(0);
      expect(reclaimActivityRetentionPages(reopened, 8)).toBe(0);
    } finally {
      reopened.close();
    }
  });

  test("an existing empty file is still initialized for incremental reclamation", () => {
    const path = join(dir, "empty.db");
    const empty = new Database(path);
    empty.close();

    const initialized = createDatabase(path);
    try {
      expect(initialized.pragma("auto_vacuum", { simple: true })).toBe(2);
    } finally {
      initialized.close();
    }
  });
});
