// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import type Database from "better-sqlite3";
import type {
  PrivacyPolicyFamilySummary,
  PrivacyPolicyVersion,
  PrivacyPolicyVersionAction,
  PrivacyPolicyVersionSummary,
} from "@omnesis/types/privacy";

export interface CommitPrivacyPolicyInput {
  familyId?: string;
  familyName?: string;
  policy: string;
  digest: string;
  revision: string;
  expectedRevision: string | null;
  action: PrivacyPolicyVersionAction;
  revertedFromGeneration: number | null;
  originRevision?: string | null;
  originTemplateId?: string | null;
  createdAt: number;
}

export interface PrivacyPolicyState {
  familyId: string;
  generation: number;
  revision: string;
  digest: string;
  previousDigest: string | null;
  mirrorSynced: boolean;
  updatedAt: number;
}

export type CommitPrivacyPolicyResult =
  | { outcome: "written"; version: PrivacyPolicyVersion }
  | { outcome: "unchanged"; version: PrivacyPolicyVersion }
  | { outcome: "conflict"; version: PrivacyPolicyVersion };

interface VersionRow {
  generation: number;
  revision: string;
  digest: string;
  policy: string;
  action: PrivacyPolicyVersionAction;
  reverted_from_generation: number | null;
  created_at: number;
  family_id: string;
  family_version: number;
  origin_revision: string | null;
  origin_template_id: string | null;
  origin_generation?: number | null;
}

export function createPrivacyPolicyHistoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS privacy_policy_families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS privacy_policy_versions (
      generation INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id TEXT NOT NULL REFERENCES privacy_policy_families(id),
      family_version INTEGER NOT NULL CHECK(family_version > 0),
      revision TEXT NOT NULL UNIQUE CHECK(length(revision) = 64),
      digest TEXT NOT NULL CHECK(length(digest) = 64),
      policy TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('bootstrap', 'edit', 'restore', 'fork', 'template')),
      origin_revision TEXT REFERENCES privacy_policy_versions(revision),
      origin_template_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(family_id, family_version),
      UNIQUE(family_id, generation)
    );
    CREATE TABLE IF NOT EXISTS privacy_policy_state (
      family_id TEXT PRIMARY KEY REFERENCES privacy_policy_families(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL UNIQUE,
      revision TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      previous_digest TEXT,
      mirror_synced INTEGER NOT NULL DEFAULT 0 CHECK(mirror_synced IN (0, 1)),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(family_id, generation) REFERENCES privacy_policy_versions(family_id, generation)
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO privacy_policy_families
       (id, name, name_key, created_at, updated_at)
     VALUES (?, 'Default policy', 'default policy', 0, 0)`,
  ).run(DEFAULT_PRIVACY_POLICY_FAMILY_ID);
}

export function commitPrivacyPolicy(
  db: Database.Database,
  input: CommitPrivacyPolicyInput,
): CommitPrivacyPolicyResult {
  return db.transaction((): CommitPrivacyPolicyResult => {
    const familyId = input.familyId ?? DEFAULT_PRIVACY_POLICY_FAMILY_ID;
    if (input.familyName) {
      db.prepare(
        `INSERT OR IGNORE INTO privacy_policy_families
           (id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        familyId,
        input.familyName.trim(),
        input.familyName.trim().toLowerCase(),
        input.createdAt,
        input.createdAt,
      );
    }
    const family = db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL")
      .get(familyId);
    if (!family) throw new Error("Privacy policy family is not available.");
    const current = currentPrivacyPolicyVersion(db, familyId);
    if (input.expectedRevision !== null && current?.revision !== input.expectedRevision) {
      if (!current) throw new Error("Privacy policy history is not initialized.");
      return { outcome: "conflict", version: current };
    }
    if (
      current?.digest === input.digest &&
      input.action !== "revert" &&
      input.action !== "restore"
    ) {
      return { outcome: "unchanged", version: current };
    }
    db.prepare(
      `INSERT INTO privacy_policy_versions
         (family_id, family_version, revision, digest, policy, action,
          origin_revision, origin_template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      familyId,
      (current?.familyVersion ?? 0) + 1,
      input.revision,
      input.digest,
      input.policy,
      input.action === "revert" ? "restore" : input.action,
      input.originRevision ??
        (input.revertedFromGeneration === null
          ? null
          : (privacyPolicyVersion(db, input.revertedFromGeneration)?.revision ?? null)),
      input.originTemplateId ?? null,
      input.createdAt,
    );
    const generation = Number(
      db.prepare<[], { id: number }>("SELECT last_insert_rowid() AS id").get()!.id,
    );
    db.prepare(
      `INSERT INTO privacy_policy_state
         (family_id, generation, revision, digest, previous_digest, mirror_synced, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(family_id) DO UPDATE SET
         generation = excluded.generation,
         revision = excluded.revision,
         digest = excluded.digest,
         previous_digest = excluded.previous_digest,
         mirror_synced = 0,
         updated_at = excluded.updated_at`,
    ).run(
      familyId,
      generation,
      input.revision,
      input.digest,
      current?.digest ?? null,
      input.createdAt,
    );
    db.prepare("UPDATE privacy_policy_families SET updated_at = ? WHERE id = ?").run(
      input.createdAt,
      familyId,
    );
    const accessTables = new Set(
      db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('access_grants', 'access_grant_capabilities', 'access_level_capabilities')`,
        )
        .all()
        .map((table) => table.name),
    );
    const hasAccessTables =
      accessTables.has("access_grants") && accessTables.has("access_grant_capabilities");
    if (current && hasAccessTables) {
      db.prepare(
        `UPDATE access_grants SET revision = revision + 1, updated_at = ?
         WHERE revoked_at IS NULL AND id IN (
           SELECT grant_id FROM access_grant_capabilities
           WHERE capability = 'answer' AND release_mode = 'reviewed' AND policy_family_id = ?
         )`,
      ).run(input.createdAt, familyId);
      db.prepare(
        `INSERT INTO access_audit_events (
           id, occurred_at, event_type, principal_id, grant_id, grant_revision, detail
         )
         SELECT lower(hex(randomblob(16))), ?, 'grant-policy-updated',
                g.principal_id, g.id, g.revision,
                json_object('policyFamilyId', ?, 'policyRevision', ?)
           FROM access_grants g
           JOIN access_grant_capabilities c ON c.grant_id = g.id
          WHERE g.revoked_at IS NULL
            AND c.capability = 'answer' AND c.release_mode = 'reviewed'
            AND c.policy_family_id = ?`,
      ).run(input.createdAt, familyId, input.revision, familyId);
      // A level carries the same rules as its member grants, so its revision
      // advances with theirs: a decision against the older level revision is
      // refused as stale instead of joining rules reviewed under another policy.
      if (accessTables.has("access_level_capabilities")) {
        const reviewedLevels = `SELECT level_id FROM access_level_capabilities
          WHERE capability = 'answer' AND release_mode = 'reviewed' AND policy_family_id = ?`;
        db.prepare(
          `UPDATE access_levels SET revision = revision + 1, updated_at = ?
           WHERE revoked_at IS NULL AND id IN (${reviewedLevels})`,
        ).run(input.createdAt, familyId);
        db.prepare(
          `INSERT INTO access_audit_events (id, occurred_at, event_type, detail)
           SELECT lower(hex(randomblob(16))), ?, 'level-updated',
                  json_object('levelId', l.id, 'revision', l.revision, 'policyFamilyId', ?)
             FROM access_levels l
            WHERE l.revoked_at IS NULL AND l.id IN (${reviewedLevels})`,
        ).run(input.createdAt, familyId, familyId);
      }
    }
    return {
      outcome: "written",
      version: privacyPolicyVersion(db, generation)!,
    } as const;
  })();
}

export type DeletePrivacyPolicyFamilyResult =
  | { outcome: "deleted" }
  | { outcome: "not-found" }
  | { outcome: "in-use"; message: string };

/** All stored rules count, including expired and revoked access. */
export function privacyPolicyDeletionBlockedReason(
  db: Database.Database,
  familyId: string,
): string | null {
  if (familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) {
    return "The default policy cannot be deleted.";
  }
  for (const [table, label] of [
    ["access_grant_capabilities", "an access grant"],
    ["access_level_capabilities", "an access level"],
  ] as const) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (
      exists &&
      db.prepare(`SELECT 1 FROM ${table} WHERE policy_family_id = ? LIMIT 1`).get(familyId)
    ) {
      return `This policy is used by ${label}. Remove its policy reference before deleting it.`;
    }
  }
  return null;
}

/** Archive the library entry, retaining immutable versions and review provenance. */
export function deletePrivacyPolicyFamily(
  db: Database.Database,
  familyId: string,
  now: number,
): DeletePrivacyPolicyFamilyResult {
  return db.transaction((): DeletePrivacyPolicyFamilyResult => {
    if (
      !db
        .prepare("SELECT 1 FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL")
        .get(familyId)
    ) {
      return { outcome: "not-found" };
    }
    const message = privacyPolicyDeletionBlockedReason(db, familyId);
    if (message) return { outcome: "in-use", message };
    db.prepare(
      "UPDATE privacy_policy_families SET archived_at = ?, updated_at = ?, name_key = ? WHERE id = ?",
    ).run(now, now, `\0archived:${familyId}`, familyId);
    return { outcome: "deleted" };
  })();
}

export function listPrivacyPolicyFamilies(db: Database.Database): PrivacyPolicyFamilySummary[] {
  const hasAccessTables =
    db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN ('access_grants', 'access_grant_capabilities')`,
      )
      .get()!.count === 2;
  const rows = db
    .prepare<
      [],
      {
        id: string;
        name: string;
        revision: string;
        family_version: number;
        updated_at: number;
        archived_at: number | null;
      }
    >(
      `SELECT f.id, f.name, v.revision, v.family_version, f.updated_at, f.archived_at
         FROM privacy_policy_families f
         JOIN privacy_policy_state s ON s.family_id = f.id
         JOIN privacy_policy_versions v
           ON v.family_id = s.family_id AND v.generation = s.generation
        WHERE f.archived_at IS NULL
        ORDER BY f.created_at, f.id`,
    )
    .all();
  const grantsByFamily = new Map<string, string[]>();
  if (hasAccessTables) {
    for (const row of db
      .prepare<[number], { family_id: string; grant_id: string }>(
        `SELECT c.policy_family_id AS family_id, c.grant_id
           FROM access_grant_capabilities c
           JOIN access_grants g ON g.id = c.grant_id
           JOIN access_principals p ON p.id = g.principal_id
          WHERE c.capability = 'answer' AND c.release_mode = 'reviewed'
            AND c.policy_family_id IS NOT NULL
            AND p.revoked_at IS NULL
            AND g.revoked_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at > ?)
          ORDER BY c.policy_family_id, c.grant_id`,
      )
      .all(Date.now())) {
      const ids = grantsByFamily.get(row.family_id) ?? [];
      ids.push(row.grant_id);
      grantsByFamily.set(row.family_id, ids);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    currentRevision: row.revision,
    currentVersion: row.family_version,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    affectedGrantIds: grantsByFamily.get(row.id) ?? [],
    deletionBlockedReason: privacyPolicyDeletionBlockedReason(db, row.id),
  }));
}

export function currentPrivacyPolicyState(
  db: Database.Database,
  familyId = DEFAULT_PRIVACY_POLICY_FAMILY_ID,
): PrivacyPolicyState | null {
  const row = db
    .prepare<
      [string],
      {
        generation: number;
        revision: string;
        digest: string;
        previous_digest: string | null;
        mirror_synced: number;
        updated_at: number;
      }
    >(
      `SELECT generation, revision, digest, previous_digest, mirror_synced, updated_at
         FROM privacy_policy_state WHERE family_id = ?`,
    )
    .get(familyId);
  return row
    ? {
        familyId,
        generation: row.generation,
        revision: row.revision,
        digest: row.digest,
        previousDigest: row.previous_digest,
        mirrorSynced: row.mirror_synced === 1,
        updatedAt: row.updated_at,
      }
    : null;
}

/** Mark only the exact generation we mirrored; a newer commit remains unsynced. */
export function markPrivacyPolicyMirrorSynced(
  db: Database.Database,
  generation: number,
  digest: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE privacy_policy_state SET mirror_synced = 1
          WHERE family_id = ? AND generation = ? AND digest = ?`,
      )
      .run(DEFAULT_PRIVACY_POLICY_FAMILY_ID, generation, digest).changes === 1
  );
}

export function currentPrivacyPolicyVersion(
  db: Database.Database,
  familyId = DEFAULT_PRIVACY_POLICY_FAMILY_ID,
): PrivacyPolicyVersion | null {
  const row = db
    .prepare<[string], VersionRow>(
      `SELECT v.generation, v.family_id, v.family_version, v.revision, v.digest,
              v.policy, v.action, v.origin_revision, v.origin_template_id, v.created_at
         FROM privacy_policy_state s
         JOIN privacy_policy_versions v
           ON v.family_id = s.family_id AND v.generation = s.generation
        WHERE s.family_id = ?`,
    )
    .get(familyId);
  return row ? mapVersion(row) : null;
}

export function privacyPolicyVersion(
  db: Database.Database,
  generation: number,
): PrivacyPolicyVersion | null {
  const row = db
    .prepare<[number], VersionRow>(
      `SELECT v.*, origin.generation AS origin_generation
         FROM privacy_policy_versions v
         LEFT JOIN privacy_policy_versions origin ON origin.revision = v.origin_revision
        WHERE v.generation = ?`,
    )
    .get(generation);
  return row ? mapVersion(row) : null;
}

export function privacyPolicyFamilyVersion(
  db: Database.Database,
  familyId: string,
  familyVersion: number,
): PrivacyPolicyVersion | null {
  const row = db
    .prepare<[string, number], VersionRow>(
      `SELECT v.*, origin.generation AS origin_generation
         FROM privacy_policy_versions v
         LEFT JOIN privacy_policy_versions origin ON origin.revision = v.origin_revision
        WHERE v.family_id = ? AND v.family_version = ?`,
    )
    .get(familyId, familyVersion);
  return row ? mapVersion(row) : null;
}

export function listPrivacyPolicyVersions(
  db: Database.Database,
  options: {
    limit: number;
    beforeGeneration?: number;
    beforeVersion?: number;
    familyId?: string;
  },
): PrivacyPolicyVersionSummary[] {
  const familyId = options.familyId ?? DEFAULT_PRIVACY_POLICY_FAMILY_ID;
  const before = options.beforeVersion ?? options.beforeGeneration;
  const beforeColumn = options.beforeVersion === undefined ? "v.generation" : "v.family_version";
  const rows = before
    ? db
        .prepare<[string, number, number], VersionRow>(
          `SELECT v.*, origin.generation AS origin_generation
             FROM privacy_policy_versions v
             LEFT JOIN privacy_policy_versions origin ON origin.revision = v.origin_revision
            WHERE v.family_id = ? AND ${beforeColumn} < ?
            ORDER BY v.generation DESC LIMIT ?`,
        )
        .all(familyId, before, options.limit)
    : db
        .prepare<[string, number], VersionRow>(
          `SELECT v.*, origin.generation AS origin_generation
             FROM privacy_policy_versions v
             LEFT JOIN privacy_policy_versions origin ON origin.revision = v.origin_revision
            WHERE v.family_id = ? ORDER BY v.generation DESC LIMIT ?`,
        )
        .all(familyId, options.limit);
  return rows.map(({ policy: _policy, digest: _digest, ...row }) => mapSummary(row));
}

function mapVersion(row: VersionRow): PrivacyPolicyVersion {
  return { ...mapSummary(row), policy: row.policy, digest: row.digest };
}

function mapSummary(row: Omit<VersionRow, "policy" | "digest">): PrivacyPolicyVersionSummary {
  return {
    generation: row.generation,
    revision: row.revision,
    action:
      row.family_id === DEFAULT_PRIVACY_POLICY_FAMILY_ID && row.action === "restore"
        ? "revert"
        : row.action,
    revertedFromGeneration: row.origin_generation ?? null,
    createdAt: row.created_at,
    familyId: row.family_id,
    familyVersion: row.family_version,
    originRevision: row.origin_revision,
    originTemplateId: row.origin_template_id as PrivacyPolicyVersionSummary["originTemplateId"],
  };
}
