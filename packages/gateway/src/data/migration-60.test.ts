// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";

import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
});

afterEach(() => db.close());

describe("migration 60 - trusted external-answer audit storage", () => {
  test("upgrades a v59 approval and snapshots its held candidate", () => {
    runSchemaSetup(db);
    db.exec("DROP TABLE answer_approvals");
    db.exec(`
      CREATE TABLE answer_approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT UNIQUE NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
        candidate_digest TEXT NOT NULL,
        policy_revision TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER
      )
    `);
    db.prepare(
      `INSERT INTO answer_workflows
         (id, owner_id, name, purpose, status, created_at, expires_at)
       VALUES ('wf-m60', 'token:synthetic', 'Planning assistant', '', 'active', 10, 9999)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_conversations
         (id, workflow_id, owner_id, active_task_id, created_at, updated_at)
       VALUES ('conv-m60', 'wf-m60', 'token:synthetic', 'task-m60', 10, 20)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_tasks
         (id, workflow_id, conversation_id, owner_id, client_request_id,
          request_fingerprint, question, status, candidate_answer, candidate_digest,
          policy_revision, review_json, reductions_json, approval_id, created_at)
       VALUES ('task-m60', 'wf-m60', 'conv-m60', 'token:synthetic', 'request-m60',
               'fingerprint', 'Summarize the fictional planning note.', 'approval_required',
               'The held synthetic candidate.', 'candidate-digest', 'policy-revision',
               '{}', '["Removed an exact date"]', 'approval-m60', 20)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_approvals
         (id, task_id, candidate_digest, policy_revision, status, created_at, expires_at)
       VALUES ('approval-m60', 'task-m60', 'candidate-digest', 'policy-revision',
               'pending', 20, 9999)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_tasks
         (id, workflow_id, conversation_id, owner_id, client_request_id,
          request_fingerprint, question, status, policy_revision, review_json,
          reductions_json, release_id, created_at, resolved_at)
       VALUES ('task-release-m60', 'wf-m60', 'conv-m60', 'token:synthetic',
               'request-release-m60', 'release-fingerprint', 'Give a synthetic summary.',
               'released', 'policy-revision',
               '{"recipeVersion":"privacy-reviewer-v2","provider":"synthetic","model":"reviewer","confidence":1,"policyRevision":"policy-revision","findings":[{"category":"schedule","detailLevel":"summary","subject":"user","disposition":"allow","description":"Synthetic schedule summary."}],"rationale":"Allowed."}',
               '[]', 'release-m60', 15, 16)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_releases
         (id, task_id, owner_id, answer, reductions_json, created_at)
       VALUES ('release-m60', 'task-release-m60', 'token:synthetic',
               'Synthetic released answer.', '[]', 16)`,
    ).run();
    db.pragma("user_version = 59");

    runMigrations(db, { log: createLogger("test") });

    const approval = db
      .prepare<[], { candidate_answer: string; release_status: string; reductions_json: string }>(
        `SELECT candidate_answer, release_status, reductions_json
           FROM answer_approvals WHERE id = 'approval-m60'`,
      )
      .get();
    expect(approval).toEqual({
      candidate_answer: "The held synthetic candidate.",
      release_status: "released_with_reductions",
      reductions_json: '["Removed an exact date"]',
    });
    expect(
      db
        .prepare<
          [],
          {
            revision: number;
            released_turns: number;
            released_characters: number;
            categories_json: string;
          }
        >(
          `SELECT revision, released_turns, released_characters, categories_json
             FROM answer_workflow_disclosure WHERE workflow_id = 'wf-m60'`,
        )
        .get(),
    ).toEqual({
      revision: 1,
      released_turns: 1,
      released_characters: "Synthetic released answer.".length,
      categories_json: JSON.stringify([
        { category: "schedule", detailLevel: "summary", subject: "user", count: 1 },
      ]),
    });
    expect(
      db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'answer_audit_events'")
        .get()?.name,
    ).toBe("answer_audit_events");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("replaying migration 60 is idempotent", () => {
    runSchemaSetup(db);
    const migration = MIGRATIONS.find((entry) => entry.version === 60);
    if (!migration) throw new Error("migration 60 not found");
    expect(() => {
      migration.up(db);
      migration.up(db);
    }).not.toThrow();
  });
});
