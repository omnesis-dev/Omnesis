// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLabTable, setLabFlag } from "../lab/store.js";
import { taskDocumentHidden } from "../lab/document-policy.js";

let db: Database.Database;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  createLabTable(db);
  db.exec(`
    CREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT, external_id TEXT);
    CREATE TABLE knowledge_nodes(id TEXT PRIMARY KEY, kind TEXT);
    INSERT INTO documents VALUES ('task-document','open-loops','task'), ('mirror','brain-knowledge','loop-node'), ('page','brain-knowledge','wiki-node'), ('source','files:test','source');
    INSERT INTO knowledge_nodes VALUES ('loop-node','loop'), ('wiki-node','wiki');
  `);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

it("withholds both task projection forms without hiding ordinary knowledge or source documents", () => {
  expect(taskDocumentHidden(db, "task-document")).toBe(true);
  expect(taskDocumentHidden(db, "mirror")).toBe(true);
  expect(taskDocumentHidden(db, "page")).toBe(false);
  expect(taskDocumentHidden(db, "source")).toBe(false);
  setLabFlag(db, "tasks", true);
  expect(taskDocumentHidden(db, "task-document")).toBe(false);
  expect(taskDocumentHidden(db, "mirror")).toBe(false);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_SYNTHETIC", "0");
  expect(taskDocumentHidden(db, "mirror")).toBe(true);
});
