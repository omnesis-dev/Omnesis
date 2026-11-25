// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { desktopRestoreReviewedTables, desktopRestoreTablePolicy } from "./authority-policy.js";

test("every real current gateway table has an explicitly reviewed restore policy", () => {
  const db = new Database(":memory:");
  try {
    runSchemaSetup(db);
    runMigrations(db);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    expect(tables.length).toBeGreaterThan(200);
    expect(desktopRestoreReviewedTables()).toEqual(tables);
    for (const name of tables) expect(() => desktopRestoreTablePolicy(name)).not.toThrow();
  } finally {
    db.close();
  }
});
test("an unknown table, virtual table or injected name fails closed", () => {
  for (const name of [
    "future_device_credentials",
    "attacker_virtual_table",
    "documents; DROP TABLE tokens",
    "sqlite_master",
    "__proto__",
  ]) {
    expect(() => desktopRestoreTablePolicy(name)).toThrow("without a reviewed restore policy");
  }
});
test("authentication, account trust, consent and access authority always come from the target", () => {
  for (const name of [
    "tokens",
    "sessions",
    "pairing_redemption_receipts",
    "revoked_device_keys",
    "access_principals",
    "access_grants",
    "access_grant_capabilities",
    "principal_credentials",
    "oauth_clients",
    "oauth_access_tokens",
    "oauth_refresh_tokens",
    "oauth_execution_bindings",
    "privacy_policy_state",
    "privacy_policy_versions",
    "privacy_policy_families",
    "answer_approvals",
    "answer_workflow_grants",
    "subscription_grants",
    "lab_features",
  ]) {
    expect(desktopRestoreTablePolicy(name)).toBe("keep-target");
  }
});
test("no copied pending work can deliver private content or delete restored records", () => {
  for (const name of [
    "answer_tasks",
    "device_pairings",
    "answer_completion_deliveries",
    "subscription_deliveries",
    "subscription_firing_answer_authorities",
    "notification_deliveries",
    "oauth_authorization_requests",
    "storage_cleanup_jobs",
    "storage_trim_jobs",
    "storage_trim_job_cascades",
    "storage_source_incarnations",
    "storage_retention_bindings",
    "source_stream_cleanups",
    "source_mode_transitions",
    "snapshot_absence_cascade_outbox",
    "knowledge_work",
    "knowledge_cascade_jobs",
    "note_agent_handoffs",
  ]) {
    expect(desktopRestoreTablePolicy(name)).toBe("discard-work");
  }
  expect(desktopRestoreTablePolicy("note_agent_runs")).toBe("pause-data");
  expect(desktopRestoreTablePolicy("knowledge_candidates")).toBe("pause-data");
});
test("source identities and personal history have separate review and data policies", () => {
  expect(desktopRestoreTablePolicy("devices")).toBe("reconcile-devices");
  expect(desktopRestoreTablePolicy("sources")).toBe("pause-sources");
  expect(desktopRestoreTablePolicy("source_devices")).toBe("review-memberships");
  for (const name of [
    "documents",
    "people",
    "note_entries",
    "knowledge_nodes",
    "knowledge_revisions",
    "doc_annotations",
    "temporal_annotations",
    "sync_state",
  ])
    expect(desktopRestoreTablePolicy(name)).toBe("import-data");
  expect(desktopRestoreTablePolicy("near_dup_signatures")).toBe("rebuild-derived");
});
