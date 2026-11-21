// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { PrivacyDb } from "./store-types.js";

export function createAnswerScopeSchema(db: PrivacyDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS answer_task_scope (
    task_id TEXT PRIMARY KEY REFERENCES answer_tasks(id) ON DELETE CASCADE,
    authorization TEXT NOT NULL,
    -- NULL until the run's read set is saved; then whether it is complete.
    complete INTEGER CHECK(complete IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS answer_task_scope_documents (
    task_id TEXT NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    PRIMARY KEY(task_id,document_id)
  ) WITHOUT ROWID;
`);
}
