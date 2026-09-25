// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";
export function addSourceSyncIssues(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_sync_issues (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    issues_json TEXT NOT NULL,
    PRIMARY KEY (source_id, device_id)
  )`);
}
