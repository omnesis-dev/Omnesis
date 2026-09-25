// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import type { Db } from "./types.js";

/**
 * The tables that key Answer work by an owner id beginning
 * `principal:<p>:grant:<g>:credential:<c>:`.
 */
const ANSWER_OWNER_TABLES = [
  "answer_workflows",
  "answer_conversations",
  "answer_tasks",
  "answer_releases",
  "answer_audit_events",
  "answer_egress_events",
  "answer_conversation_tombstones",
  "answer_request_tombstones",
  "answer_workflow_grants",
] as const;

const NAME_MAX = 120;
const GRANT_NAME_SUFFIX = " access";

/**
 * Access levels: named rule sets shared by several connections. A grant on a
 * level carries exactly the level's capabilities, and an authorization request
 * remembers a level its decision created so an abandoned approval can retire
 * it. Installed on fresh databases by `createAccessTables` and on upgrades by
 * migration 171; every statement is idempotent.
 */
export function createAccessLevelTables(db: Db): void {
  if (!tableExists(db, "access_grants")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_levels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_access_levels_live_name
      ON access_levels(lower(trim(name))) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS access_level_capabilities (
      level_id TEXT NOT NULL REFERENCES access_levels(id) ON DELETE CASCADE,
      capability TEXT NOT NULL CHECK(capability IN ('direct', 'answer', 'notes')),
      source_mode TEXT NOT NULL CHECK(source_mode IN ('all', 'allowlist', 'denylist')),
      source_ids TEXT NOT NULL,
      release_mode TEXT CHECK(release_mode IN ('reviewed', 'unreviewed')),
      policy_family_id TEXT REFERENCES privacy_policy_families(id),
      PRIMARY KEY(level_id, capability),
      CHECK(json_valid(source_ids) AND json_type(source_ids) = 'array'),
      CHECK((source_mode = 'all' AND source_ids = '[]') OR source_mode <> 'all'),
      CHECK(
        (capability = 'direct' AND release_mode IS NULL AND policy_family_id IS NULL) OR
        (capability = 'notes' AND source_mode = 'all' AND source_ids = '[]' AND release_mode IS NULL AND policy_family_id IS NULL) OR
        (capability = 'answer' AND release_mode = 'reviewed' AND policy_family_id IS NOT NULL) OR
        (capability = 'answer' AND release_mode = 'unreviewed' AND policy_family_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_access_level_capabilities_policy
      ON access_level_capabilities(policy_family_id, capability, release_mode, level_id);
  `);
  const grantColumns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('access_grants')")
    .all()
    .map((column) => column.name);
  if (!grantColumns.includes("level_id")) {
    db.exec(
      "ALTER TABLE access_grants ADD COLUMN level_id TEXT REFERENCES access_levels(id) ON DELETE SET NULL",
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_grants_level
      ON access_grants(level_id) WHERE level_id IS NOT NULL
  `);
  if (!tableExists(db, "oauth_authorization_requests")) return;
  const requestColumns = db
    .prepare<[], { name: string }>(
      "SELECT name FROM pragma_table_info('oauth_authorization_requests')",
    )
    .all()
    .map((column) => column.name);
  if (!requestColumns.includes("created_level_id")) {
    db.exec(
      "ALTER TABLE oauth_authorization_requests ADD COLUMN created_level_id TEXT REFERENCES access_levels(id) ON DELETE SET NULL",
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_created_level
      ON oauth_authorization_requests(created_level_id) WHERE created_level_id IS NOT NULL
  `);
}

interface GrantRow {
  id: string;
  revision: number;
  created_at: number;
  expires_at: number | null;
  level_id: string | null;
}

interface CredentialRow {
  id: string;
  label: string;
  created_at: number;
}

/**
 * Give every connection exactly one live grant and one active sign-in, and
 * every live grant an access level.
 *
 * A live interactive principal keeps its oldest live grant and, on it, its
 * oldest active credential. Each other live grant moves to a principal of its
 * own. Each further active credential moves to a principal and grant of its
 * own that copy the source grant's capabilities and revision — the revision
 * is what keeps already-issued access tokens valid. Each original live grant
 * gets one access level named after its original principal, holding its
 * capabilities, and every grant split out of it uses that level too, so no
 * sign-in gains or loses access.
 *
 * Answer owner ids and Direct transcript sessions follow a moved credential,
 * so its history stays readable under its new identity. Access audit events
 * and note capture contexts are historical records and keep the ids they were
 * written with. Pending credentials are never split out. A second run finds
 * nothing to split.
 */
export function migrateV171AccessLevels(db: Db, now = Date.now()): void {
  createAccessLevelTables(db);
  if (!tableExists(db, "access_principals") || !tableExists(db, "principal_credentials")) return;

  const principalNames = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM access_principals WHERE kind = 'interactive' AND revoked_at IS NULL",
      )
      .all()
      .map((row) => nameKey(row.name)),
  );
  const levelNames = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM access_levels WHERE revoked_at IS NULL")
      .all()
      .map((row) => nameKey(row.name)),
  );
  const principals = db
    .prepare<[], { id: string; name: string }>(
      `SELECT id, name FROM access_principals
        WHERE kind = 'interactive' AND revoked_at IS NULL
        ORDER BY created_at, id`,
    )
    .all();
  const liveGrants = db.prepare<[string, number], GrantRow>(
    `SELECT id, revision, created_at, expires_at, level_id FROM access_grants
      WHERE principal_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at, id`,
  );
  const activeCredentials = db.prepare<[string, number], CredentialRow>(
    `SELECT id, label, created_at FROM principal_credentials
      WHERE grant_id = ? AND kind = 'interactive' AND status = 'active' AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at, id`,
  );

  for (const principal of principals) {
    const grants = liveGrants.all(principal.id, now);
    grants.forEach((grant, index) => {
      let holder = principal;
      if (index > 0) {
        const oldest = activeCredentials.get(grant.id, now);
        const name = uniqueName(oldest?.label || principal.name, principalNames);
        const movedTo = insertPrincipal(db, name, grant.created_at, now);
        db.prepare("UPDATE access_grants SET principal_id = ?, updated_at = ? WHERE id = ?").run(
          movedTo,
          now,
          grant.id,
        );
        // An approval still waiting on this grant reaps the principal it
        // belongs to now, so an abandoned one leaves no grantless connection.
        db.prepare(
          "UPDATE oauth_authorization_requests SET created_principal_id = ? WHERE created_grant_id = ?",
        ).run(movedTo, grant.id);
        rekeyOwners(db, {
          fromPrefix: `principal:${principal.id}:grant:${grant.id}:credential:`,
          toPrefix: `principal:${movedTo}:grant:${grant.id}:credential:`,
          fromPrincipalId: principal.id,
          toPrincipalId: movedTo,
          sessionFilter: { column: "grant_id", value: grant.id },
          toGrantId: grant.id,
        });
        appendSplitAudit(db, {
          principalId: movedTo,
          grantId: grant.id,
          grantRevision: grant.revision,
          credentialId: null,
          detail: { sourcePrincipalId: principal.id, sourceGrantId: grant.id },
          now,
        });
        holder = { id: movedTo, name };
      }

      let levelId = grant.level_id;
      if (levelId === null) {
        levelId = randomUUID();
        db.prepare(
          `INSERT INTO access_levels (id, name, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(levelId, uniqueName(principal.name, levelNames), now, now);
        db.prepare(
          `INSERT INTO access_level_capabilities
             (level_id, capability, source_mode, source_ids, release_mode, policy_family_id)
           SELECT ?, capability, source_mode, source_ids, release_mode, policy_family_id
             FROM access_grant_capabilities WHERE grant_id = ?`,
        ).run(levelId, grant.id);
        db.prepare("UPDATE access_grants SET level_id = ? WHERE id = ?").run(levelId, grant.id);
      }

      const active = activeCredentials.all(grant.id, now);
      for (const credential of active.slice(1)) {
        const name = uniqueName(credential.label || holder.name, principalNames);
        const splitPrincipal = insertPrincipal(db, name, credential.created_at, now);
        const splitGrant = randomUUID();
        db.prepare(
          `INSERT INTO access_grants
             (id, principal_id, name, revision, created_at, updated_at, expires_at, level_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          splitGrant,
          splitPrincipal,
          grantName(name),
          grant.revision,
          credential.created_at,
          now,
          grant.expires_at,
          levelId,
        );
        db.prepare(
          `INSERT INTO access_grant_capabilities
             (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
           SELECT ?, capability, source_mode, source_ids, release_mode, policy_family_id
             FROM access_grant_capabilities WHERE grant_id = ?`,
        ).run(splitGrant, grant.id);
        db.prepare("UPDATE principal_credentials SET grant_id = ? WHERE id = ?").run(
          splitGrant,
          credential.id,
        );
        rekeyOwners(db, {
          fromPrefix: `principal:${holder.id}:grant:${grant.id}:credential:${credential.id}:`,
          toPrefix: `principal:${splitPrincipal}:grant:${splitGrant}:credential:${credential.id}:`,
          fromPrincipalId: holder.id,
          toPrincipalId: splitPrincipal,
          sessionFilter: { column: "credential_id", value: credential.id },
          toGrantId: splitGrant,
        });
        appendSplitAudit(db, {
          principalId: splitPrincipal,
          grantId: splitGrant,
          grantRevision: grant.revision,
          credentialId: credential.id,
          detail: { sourcePrincipalId: holder.id, sourceGrantId: grant.id, levelId },
          now,
        });
      }
    });
  }
}

function insertPrincipal(db: Db, name: string, createdAt: number, now: number): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO access_principals (id, name, kind, created_at, updated_at)
     VALUES (?, ?, 'interactive', ?, ?)`,
  ).run(id, name, createdAt, now);
  return id;
}

/**
 * Point Answer owner ids and Direct transcript sessions at the identity a
 * credential moved to. Owner ids are matched by an exact prefix through a
 * range, which an owner_id-leading index serves where the table has one;
 * `answer_conversations`, `answer_egress_events` and
 * `answer_conversation_tombstones` have none and are read whole. Moves are
 * few — one per extra grant or sign-in an install ever held — and the
 * migration runs once.
 */
function rekeyOwners(
  db: Db,
  input: {
    fromPrefix: string;
    toPrefix: string;
    fromPrincipalId: string;
    toPrincipalId: string;
    sessionFilter: { column: "grant_id" | "credential_id"; value: string };
    toGrantId: string;
  },
): void {
  const upperBound = `${input.fromPrefix.slice(0, -1)};`;
  for (const table of ANSWER_OWNER_TABLES) {
    if (!tableExists(db, table)) continue;
    db.prepare(
      `UPDATE ${table} SET owner_id = ? || substr(owner_id, ?)
        WHERE owner_id >= ? AND owner_id < ?`,
    ).run(input.toPrefix, input.fromPrefix.length + 1, input.fromPrefix, upperBound);
  }
  if (!tableExists(db, "direct_audit_sessions")) return;
  const sessions = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM direct_audit_sessions
        WHERE ${input.sessionFilter.column} = ? AND principal_id = ?`,
    )
    .all(input.sessionFilter.value, input.fromPrincipalId);
  const updateSession = db.prepare(
    `UPDATE direct_audit_sessions
        SET principal_id = ?, grant_id = ?,
            owner_id = CASE
              WHEN owner_id = ? THEN ?
              WHEN owner_id >= ? AND owner_id < ? THEN ? || substr(owner_id, ?)
              ELSE owner_id
            END
      WHERE id = ?`,
  );
  const events = tableExists(db, "direct_audit_events")
    ? db.prepare(
        `UPDATE direct_audit_events
            SET owner_id = (SELECT owner_id FROM direct_audit_sessions WHERE id = ?)
          WHERE session_id = ?`,
      )
    : null;
  for (const session of sessions) {
    updateSession.run(
      input.toPrincipalId,
      input.toGrantId,
      `principal:${input.fromPrincipalId}`,
      `principal:${input.toPrincipalId}`,
      input.fromPrefix,
      upperBound,
      input.toPrefix,
      input.fromPrefix.length + 1,
      session.id,
    );
    events?.run(session.id, session.id);
  }
}

function appendSplitAudit(
  db: Db,
  input: {
    principalId: string;
    grantId: string;
    grantRevision: number;
    credentialId: string | null;
    detail: Record<string, string>;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO access_audit_events (
       id, occurred_at, event_type, principal_id, grant_id, grant_revision, credential_id, detail
     ) VALUES (?, ?, 'connection-split', ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.now,
    input.principalId,
    input.grantId,
    input.grantRevision,
    input.credentialId,
    JSON.stringify(input.detail),
  );
}

/** `base`, or `base 2`, `base 3`… — the first spelling no live row in `taken` already uses. */
function uniqueName(base: string, taken: Set<string>): string {
  const trimmed = base.trim().slice(0, NAME_MAX).trim() || "Agent";
  let candidate = trimmed;
  for (let suffix = 2; taken.has(nameKey(candidate)); suffix += 1) {
    const tail = ` ${suffix}`;
    candidate = `${trimmed.slice(0, NAME_MAX - tail.length).trim()}${tail}`;
  }
  taken.add(nameKey(candidate));
  return candidate;
}

function grantName(name: string): string {
  return `${name.slice(0, NAME_MAX - GRANT_NAME_SUFFIX.length).trim()}${GRANT_NAME_SUFFIX}`;
}

/** The comparison key SQLite's `lower(trim(name))` produces for ASCII names. */
function nameKey(name: string): string {
  return name.trim().replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function tableExists(db: Db, name: string): boolean {
  return (
    db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}
