// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { boundSyncIssues, syncIssueIdentity } from "@omnesis/core";
import { sourceSyncIssuesCodec } from "../json-columns.js";
import type { SyncIssue, SyncIssueAssessment, SyncIssueStatus } from "@omnesis/types";
import type { Db } from "../types.js";

export function listSourceSyncIssues(db: Db, sourceId: string): Map<string, SyncIssueStatus[]> {
  return new Map(
    db
      .prepare<[string], { device_id: string; issues_json: string }>(
        "SELECT device_id, issues_json FROM source_sync_issues WHERE source_id = ?",
      )
      .all(sourceId)
      .map((row) => [row.device_id, sourceSyncIssuesCodec.parse(row.issues_json)]),
  );
}

const identity = syncIssueIdentity;

/** Only explicit, completed-run reports replace warnings; omission is not recovery. */
export function replaceSourceSyncIssues(
  db: Db,
  sourceId: string,
  deviceId: string,
  issues: readonly SyncIssue[],
  now = Date.now(),
  assessments?: readonly SyncIssueAssessment[],
): void {
  db.transaction(() => {
    // A queued report must not resurrect diagnostics after removal/detach.
    const host = db
      .prepare(
        `SELECT 1 FROM sources WHERE id = ? AND
      (device_id = ? OR EXISTS (SELECT 1 FROM source_devices WHERE source_id = ? AND device_id = ?))`,
      )
      .get(sourceId, deviceId, sourceId, deviceId);
    if (!host) return;
    const priorIssues = listSourceSyncIssues(db, sourceId).get(deviceId) ?? [];
    const previous = new Map(priorIssues.map((issue) => [identity(issue), issue.since]));
    const assessed = assessments === undefined ? undefined : new Set(assessments.map(identity));
    const retained =
      assessed === undefined ? [] : priorIssues.filter((issue) => !assessed.has(identity(issue)));
    const incoming =
      assessed === undefined ? issues : issues.filter((issue) => assessed.has(identity(issue)));
    const next = boundSyncIssues([...retained, ...incoming]).map((issue) => ({
      ...issue,
      since: previous.get(identity(issue)) ?? now,
    }));
    if (next.length === 0) {
      db.prepare("DELETE FROM source_sync_issues WHERE source_id = ? AND device_id = ?").run(
        sourceId,
        deviceId,
      );
    } else {
      db.prepare(
        `INSERT INTO source_sync_issues (source_id, device_id, issues_json) VALUES (?, ?, ?)
        ON CONFLICT(source_id, device_id) DO UPDATE SET issues_json = excluded.issues_json`,
      ).run(sourceId, deviceId, sourceSyncIssuesCodec.serialize(next));
    }
  })();
}
