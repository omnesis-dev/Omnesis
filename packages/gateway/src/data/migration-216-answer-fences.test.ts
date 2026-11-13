// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { beginAnswerTask } from "../privacy/store.js";
import { assertAnswerTaskScopeCurrent } from "../privacy/answer-scope.js";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";

test("the source-filter migration installs durable scope fences without reinterpreting unfiltered tasks", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    runSchemaSetup(db);
    beginAnswerTask(db, {
      ownerId: "fictional-unfiltered-owner",
      clientRequestId: "legacy",
      question: "Fictional question",
      ids: { workflowId: "workflow", conversationId: "conversation", taskId: "task" },
      now: 100,
      workflowExpiresAt: 10000,
    });
    db.exec("DROP TABLE answer_task_scope_documents;DROP TABLE answer_task_scope");
    db.pragma("user_version = 215");
    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM answer_task_scope").all()).toEqual([]);
    expect(() => assertAnswerTaskScopeCurrent(db, "task")).not.toThrow();
    expect(db.prepare("SELECT status FROM answer_tasks WHERE id='task'").get()).toEqual({
      status: "running",
    });
    runMigrations(db);
  } finally {
    db.close();
  }
});
