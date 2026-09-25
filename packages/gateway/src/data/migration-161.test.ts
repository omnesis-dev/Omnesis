// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCorpusAuthorization,
  externalAnswerOwnerId,
} from "../access/corpus-authorization.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import { migrateAnswerOwnersToStableScope } from "./migration-161-answer-owner-scope.js";
import type { Db } from "./types.js";

const POLICY_FAMILY = "00000000-0000-4000-8000-000000000099";
const POLICY_ONE = "1".repeat(64);
const POLICY_TWO = "2".repeat(64);

describe("migration 161", () => {
  const databases: Db[] = [];
  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  function fixture(currentSource = "fictional-mail:primary") {
    const db = new Database(":memory:") as unknown as Db;
    databases.push(db);
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    db.exec(`
      INSERT INTO privacy_policy_families
        (id, name, name_key, created_at, updated_at)
      VALUES ('${POLICY_FAMILY}', 'Fictional policy', 'fictional policy', 1, 2);
      INSERT INTO privacy_policy_versions
        (family_id, family_version, revision, digest, policy, action, created_at)
      VALUES
        ('${POLICY_FAMILY}', 1, '${POLICY_ONE}', '${"a".repeat(64)}', 'First fictional policy.', 'bootstrap', 1),
        ('${POLICY_FAMILY}', 2, '${POLICY_TWO}', '${"b".repeat(64)}', 'Second fictional policy.', 'edit', 2);
      INSERT INTO privacy_policy_state
        (family_id, generation, revision, digest, previous_digest, mirror_synced, updated_at)
      SELECT '${POLICY_FAMILY}', generation, revision, digest, '${"a".repeat(64)}', 0, 2
        FROM privacy_policy_versions WHERE revision = '${POLICY_TWO}';
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-example', 'Fictional assistant', 'interactive', 1, 2);
      INSERT INTO access_grants
        (id, principal_id, name, revision, created_at, updated_at)
      VALUES ('grant-example', 'principal-example', 'Fictional access', 2, 1, 2);
      INSERT INTO access_grant_capabilities
        (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
      VALUES (
        'grant-example', 'answer', 'allowlist', '["${currentSource}"]',
        'reviewed', '${POLICY_FAMILY}'
      );
      INSERT INTO principal_credentials
        (id, grant_id, oauth_client_id, kind, status, label, created_at)
      VALUES (
        'credential-example', 'grant-example', 'client-example',
        'interactive', 'active', 'Fictional credential', 1
      );
    `);
    const oldAuthorization = createCorpusAuthorization(
      {
        principalId: "principal-example",
        grantId: "grant-example",
        grantRevision: 1,
        credentialId: "credential-example",
        accessTokenId: "old-token",
      },
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["fictional-mail:primary"],
          releaseMode: "reviewed",
          policyFamilyId: POLICY_FAMILY,
          policyRevision: POLICY_ONE,
          privacyPolicy: "First fictional policy.",
        },
      ],
      "answer",
    )!;
    const oldOwner = [
      "principal",
      oldAuthorization.principalId,
      "grant",
      oldAuthorization.grantId,
      "revision",
      oldAuthorization.grantRevision,
      "credential",
      oldAuthorization.credentialId,
      "scope",
      oldAuthorization.digest,
    ].join(":");
    db.prepare(
      `INSERT INTO answer_workflows
        (id, owner_id, name, purpose, status, created_at, expires_at)
       VALUES ('workflow-example', ?, 'Fictional workflow', '', 'active', 1, 999999)`,
    ).run(oldOwner);
    db.prepare(
      `INSERT INTO answer_conversations
        (id, workflow_id, owner_id, active_task_id, created_at, updated_at)
       VALUES ('conversation-example', 'workflow-example', ?, 'task-example', 1, 1)`,
    ).run(oldOwner);
    db.prepare(
      `INSERT INTO answer_tasks
        (id, workflow_id, conversation_id, owner_id, client_request_id,
         request_fingerprint, question, status, policy_revision, created_at)
       VALUES (
         'task-example', 'workflow-example', 'conversation-example', ?,
         'request-example', 'fingerprint-example', 'A fictional question?',
         'approval_required', ?, 1
       )`,
    ).run(oldOwner, POLICY_ONE);
    return { db, oldOwner };
  }

  it("preserves a held task when only its named policy revision changed", () => {
    const { db, oldOwner } = fixture();
    migrateAnswerOwnersToStableScope(db);

    const currentAuthorization = createCorpusAuthorization(
      {
        principalId: "principal-example",
        grantId: "grant-example",
        grantRevision: 2,
        credentialId: "credential-example",
        accessTokenId: "new-token",
      },
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["fictional-mail:primary"],
          releaseMode: "reviewed",
          policyFamilyId: POLICY_FAMILY,
          policyRevision: POLICY_TWO,
          privacyPolicy: "Second fictional policy.",
        },
      ],
      "answer",
    )!;
    const expected = externalAnswerOwnerId(currentAuthorization);
    expect(expected).not.toBe(oldOwner);
    for (const table of ["answer_workflows", "answer_conversations", "answer_tasks"]) {
      expect(db.prepare(`SELECT owner_id FROM ${table}`).get()).toEqual({ owner_id: expected });
    }

    migrateAnswerOwnersToStableScope(db);
    expect(db.prepare("SELECT owner_id FROM answer_tasks").get()).toEqual({ owner_id: expected });
  });

  it("leaves legacy work isolated when the current source boundary cannot reproduce it", () => {
    const { db, oldOwner } = fixture("fictional-mail:secondary");
    migrateAnswerOwnersToStableScope(db);
    expect(db.prepare("SELECT owner_id FROM answer_tasks").get()).toEqual({ owner_id: oldOwner });
  });

  it("moves owners retained only by deletion tombstones", () => {
    const { db, oldOwner } = fixture();
    db.prepare(
      `INSERT INTO answer_request_tombstones
        (owner_id, client_request_id, request_fingerprint, deleted_at)
       VALUES (?, 'deleted-request', 'deleted-fingerprint', 3)`,
    ).run(oldOwner);
    db.prepare(
      `INSERT INTO answer_conversation_tombstones
        (id, owner_id, deleted_at, egress_count, release_digests_json)
       VALUES ('deleted-conversation', ?, 3, 0, '[]')`,
    ).run(oldOwner);
    db.prepare("DELETE FROM answer_conversations").run();
    db.prepare("DELETE FROM answer_workflows").run();
    expect(db.prepare("SELECT owner_id FROM answer_tasks").get()).toBeUndefined();

    migrateAnswerOwnersToStableScope(db);

    const requestOwner = db.prepare("SELECT owner_id FROM answer_request_tombstones").get();
    const conversationOwner = db
      .prepare("SELECT owner_id FROM answer_conversation_tombstones")
      .get();
    expect(requestOwner).toEqual(conversationOwner);
    expect(requestOwner).not.toEqual({ owner_id: oldOwner });
  });

  it("upgrades the production v157 tail through the current head and is idempotent", () => {
    const { db, oldOwner } = fixture();
    for (const column of [
      "version",
      "version_seen_at",
      "protocol_version",
      "desired_version",
      "update_state",
      "update_detail",
      "update_state_at",
    ]) {
      db.exec(`ALTER TABLE devices DROP COLUMN ${column}`);
    }
    for (const column of ["replacement_ciphertext", "retry_until"]) {
      db.exec(`ALTER TABLE oauth_refresh_tokens DROP COLUMN ${column}`);
    }
    db.exec("DELETE FROM schema_migrations WHERE version > 157; PRAGMA user_version = 157");

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare<[], { version: number }>(
          "SELECT version FROM schema_migrations WHERE version >= 158 ORDER BY version",
        )
        .all()
        .map((row) => row.version),
    ).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION - 157 }, (_, index) => 158 + index));
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
        .all()
        .map((row) => row.name),
    ).toEqual(
      expect.arrayContaining([
        "version",
        "version_seen_at",
        "protocol_version",
        "desired_version",
        "update_state",
        "update_detail",
        "update_state_at",
      ]),
    );
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('oauth_refresh_tokens')")
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(["replacement_ciphertext", "retry_until"]));
    expect(db.prepare("SELECT owner_id FROM answer_tasks").get()).not.toEqual({
      owner_id: oldOwner,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const recordedBefore = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
    runMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(
      recordedBefore,
    );
  });
});
