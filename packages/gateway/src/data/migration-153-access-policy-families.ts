// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";

import type { Db } from "./types.js";

function columns(db: Db, table: string): Set<string> {
  return new Set(
    db
      .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((row) => row.name),
  );
}

export function createV153PolicyFamilyTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS privacy_policy_families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO privacy_policy_families
       (id, name, name_key, created_at, updated_at)
     VALUES (?, 'Default policy', 'default policy', 0, 0)`,
  ).run(DEFAULT_PRIVACY_POLICY_FAMILY_ID);
}

function migratePolicyHistory(db: Db): void {
  createV153PolicyFamilyTables(db);
  const versionColumns = columns(db, "privacy_policy_versions");
  if (versionColumns.size === 0 || versionColumns.has("family_id")) return;

  db.exec(`
    CREATE TABLE privacy_policy_versions_v153 (
      generation INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id TEXT NOT NULL REFERENCES privacy_policy_families(id),
      family_version INTEGER NOT NULL CHECK(family_version > 0),
      revision TEXT NOT NULL UNIQUE CHECK(length(revision) = 64),
      digest TEXT NOT NULL CHECK(length(digest) = 64),
      policy TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('bootstrap', 'edit', 'restore', 'fork', 'template')),
      origin_revision TEXT REFERENCES privacy_policy_versions_v153(revision),
      origin_template_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(family_id, family_version),
      UNIQUE(family_id, generation)
    );
    INSERT INTO privacy_policy_versions_v153
      (generation, family_id, family_version, revision, digest, policy, action,
       origin_revision, origin_template_id, created_at)
    SELECT v.generation, '${DEFAULT_PRIVACY_POLICY_FAMILY_ID}', v.generation,
           v.revision, v.digest, v.policy,
           CASE v.action WHEN 'revert' THEN 'restore' ELSE v.action END,
           origin.revision, NULL, v.created_at
      FROM privacy_policy_versions v
      LEFT JOIN privacy_policy_versions origin
        ON origin.generation = v.reverted_from_generation
     ORDER BY v.generation;

    CREATE TABLE privacy_policy_state_v153 (
      family_id TEXT PRIMARY KEY REFERENCES privacy_policy_families(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL UNIQUE,
      revision TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      previous_digest TEXT,
      mirror_synced INTEGER NOT NULL DEFAULT 0 CHECK(mirror_synced IN (0, 1)),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(family_id, generation)
        REFERENCES privacy_policy_versions_v153(family_id, generation)
    );
    INSERT INTO privacy_policy_state_v153
      (family_id, generation, revision, digest, previous_digest, mirror_synced, updated_at)
    SELECT '${DEFAULT_PRIVACY_POLICY_FAMILY_ID}', generation, revision, digest,
           previous_digest, mirror_synced, updated_at
      FROM privacy_policy_state WHERE singleton = 1;

    DROP TABLE privacy_policy_state;
    DROP TABLE privacy_policy_versions;
    ALTER TABLE privacy_policy_versions_v153 RENAME TO privacy_policy_versions;
    ALTER TABLE privacy_policy_state_v153 RENAME TO privacy_policy_state;
  `);
  db.prepare(
    `UPDATE privacy_policy_families
        SET created_at = COALESCE((SELECT MIN(created_at) FROM privacy_policy_versions), 0),
            updated_at = COALESCE((SELECT MAX(created_at) FROM privacy_policy_versions), 0)
      WHERE id = ?`,
  ).run(DEFAULT_PRIVACY_POLICY_FAMILY_ID);
}

function migrateAccessRules(db: Db): void {
  const capabilityColumns = columns(db, "access_grant_capabilities");
  if (capabilityColumns.size === 0 || capabilityColumns.has("release_mode")) return;
  db.exec(`
    CREATE TABLE access_grant_capabilities_v153 (
      grant_id TEXT NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
      capability TEXT NOT NULL CHECK(capability IN ('direct', 'answer')),
      source_mode TEXT NOT NULL CHECK(source_mode IN ('all', 'allowlist', 'denylist')),
      source_ids TEXT NOT NULL,
      release_mode TEXT CHECK(release_mode IN ('reviewed', 'unreviewed')),
      policy_family_id TEXT REFERENCES privacy_policy_families(id),
      PRIMARY KEY(grant_id, capability),
      CHECK(json_valid(source_ids) AND json_type(source_ids) = 'array'),
      CHECK((source_mode = 'all' AND source_ids = '[]') OR source_mode <> 'all'),
      CHECK(
        (capability = 'direct' AND release_mode IS NULL AND policy_family_id IS NULL) OR
        (capability = 'answer' AND release_mode = 'reviewed' AND policy_family_id IS NOT NULL) OR
        (capability = 'answer' AND release_mode = 'unreviewed' AND policy_family_id IS NULL)
      )
    );
    INSERT INTO access_grant_capabilities_v153
      (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
    SELECT grant_id, capability, source_mode, source_ids,
           CASE capability WHEN 'answer' THEN 'reviewed' ELSE NULL END,
           CASE capability WHEN 'answer' THEN '${DEFAULT_PRIVACY_POLICY_FAMILY_ID}' ELSE NULL END
      FROM access_grant_capabilities;
    DROP TABLE access_grant_capabilities;
    ALTER TABLE access_grant_capabilities_v153 RENAME TO access_grant_capabilities;
  `);
}

function addAuthorizationNotificationMarkers(db: Db): void {
  const requestColumns = columns(db, "oauth_authorization_requests");
  if (requestColumns.size === 0) return;
  if (!requestColumns.has("access_notification_reserved_at")) {
    db.exec(
      "ALTER TABLE oauth_authorization_requests ADD COLUMN access_notification_reserved_at INTEGER",
    );
  }
  if (!requestColumns.has("access_notification_sent_at")) {
    db.exec(
      "ALTER TABLE oauth_authorization_requests ADD COLUMN access_notification_sent_at INTEGER",
    );
  }
}

/** Enrich the V1 access spine without changing any identity or token revision. */
export function migrateV153AccessPolicyFamilies(db: Db): void {
  migratePolicyHistory(db);
  migrateAccessRules(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_grant_capabilities_policy
      ON access_grant_capabilities(policy_family_id, capability, release_mode, grant_id);
  `);
  addAuthorizationNotificationMarkers(db);
}
