// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import { appendAudit, isUniqueConstraint } from "./store-helpers.js";
import type { Db } from "../data/types.js";
import type { StoredGrantRules } from "./store-rules.js";

/**
 * The writes that give access levels and connections their rows: live-name
 * allocation, level creation, and a grant created on a level. Callers run
 * these inside their own writer transaction.
 */

const CONNECTION_NAME_MAX = 120;
const CONNECTION_NAME_FALLBACK = "Agent";
const GRANT_NAME_SUFFIX = " access";
const LEVEL_NAME_INDEX = "idx_access_levels_live_name";

/**
 * `base`, trimmed and cut to fit, or `base 2`, `base 3`… — the first spelling
 * no live row of `table` already uses, compared without regard to case. Both
 * tables hold one row per connection or level, so reading the live names
 * whole stays cheap.
 */
export function uniqueLiveName(
  db: Db,
  table: "access_principals" | "access_levels",
  base: string,
): string {
  const trimmed = base.trim().slice(0, CONNECTION_NAME_MAX).trim() || CONNECTION_NAME_FALLBACK;
  const taken = new Set(
    db
      .prepare<[], { name: string }>(
        table === "access_principals"
          ? "SELECT lower(trim(name)) AS name FROM access_principals WHERE kind = 'interactive' AND revoked_at IS NULL"
          : "SELECT lower(trim(name)) AS name FROM access_levels WHERE revoked_at IS NULL",
      )
      .all()
      .map((row) => row.name),
  );
  let candidate = trimmed;
  for (let suffix = 2; taken.has(asciiLower(candidate)); suffix += 1) {
    const tail = ` ${suffix}`;
    candidate = `${trimmed.slice(0, CONNECTION_NAME_MAX - tail.length).trim()}${tail}`;
  }
  return candidate;
}

/** Whether a live access level other than `exceptLevelId` already uses `name`. */
export function levelNameTaken(db: Db, name: string, exceptLevelId: string | null = null): boolean {
  return (
    db
      .prepare<[string, string], { present: number }>(
        `SELECT 1 AS present FROM access_levels
          WHERE revoked_at IS NULL AND lower(trim(name)) = lower(trim(?)) AND id <> ?`,
      )
      .get(name, exceptLevelId ?? "") !== undefined
  );
}

/**
 * Whether a write failed on the live level-name index: a concurrent writer
 * took the name between the caller's check and its insert or rename.
 */
export function isLevelNameConflict(error: unknown): boolean {
  return isUniqueConstraint(error) && (error as Error).message.includes(LEVEL_NAME_INDEX);
}

/** SQLite's `lower()` folds ASCII letters only; names compare the same way here. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/** The name of a connection's grant: the connection's name with " access", cut to fit. */
export function connectionGrantName(connectionName: string): string {
  return `${connectionName.slice(0, CONNECTION_NAME_MAX - GRANT_NAME_SUFFIX.length).trim()}${GRANT_NAME_SUFFIX}`;
}

/**
 * Insert a live access level carrying `rules`, which the caller has already
 * normalized and checked against what they refer to.
 */
export function insertLevel(
  db: Db,
  name: string,
  rules: StoredGrantRules,
  actorTokenId: string | null,
  now: number,
): { id: string; name: string; revision: number } {
  const id = randomUUID();
  const trimmed = name.trim();
  db.prepare(
    `INSERT INTO access_levels (id, name, revision, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(id, trimmed, now, now);
  writeLevelCapabilities(db, id, rules);
  appendAudit(db, {
    eventType: "level-created",
    actorTokenId,
    detail: { levelId: id, name: trimmed, rules },
    now,
  });
  return { id, name: trimmed, revision: 1 };
}

/** Replace a level's stored capabilities with `rules`. */
export function writeLevelCapabilities(db: Db, levelId: string, rules: StoredGrantRules): void {
  db.prepare("DELETE FROM access_level_capabilities WHERE level_id = ?").run(levelId);
  const insert = db.prepare(
    `INSERT INTO access_level_capabilities (
       level_id, capability, source_mode, source_ids, release_mode, policy_family_id
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const rule of rules) {
    insert.run(
      levelId,
      rule.capability,
      rule.sourceMode,
      JSON.stringify(rule.sourceIds),
      rule.releaseMode,
      rule.policyFamilyId,
    );
  }
}

/**
 * Someone chose or edited this level, so it is theirs: an approval that
 * created it and is later abandoned no longer retires it. Authorization
 * requests live for minutes, so the partial index over the column stays small.
 */
export function markLevelChosen(db: Db, levelId: string): void {
  db.prepare(
    "UPDATE oauth_authorization_requests SET created_level_id = NULL WHERE created_level_id = ?",
  ).run(levelId);
}

/** A new grant on `levelId`, carrying a copy of that level's capabilities. */
export function createGrantOnLevel(
  db: Db,
  principalId: string,
  name: string,
  levelId: string,
  expiresAt: number | null,
  now: number,
): { id: string; revision: number } {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO access_grants (
       id, principal_id, name, revision, created_at, updated_at, expires_at, level_id
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(id, principalId, name.trim(), now, now, expiresAt, levelId);
  db.prepare(
    `INSERT INTO access_grant_capabilities (
       grant_id, capability, source_mode, source_ids, release_mode, policy_family_id
     )
     SELECT ?, capability, source_mode, source_ids, release_mode, policy_family_id
       FROM access_level_capabilities WHERE level_id = ?`,
  ).run(id, levelId);
  return { id, revision: 1 };
}

/** Whether a level carries an Answer rule that can release answers today. */
export function levelHasUsableAnswer(db: Db, levelId: string): boolean {
  return hasUsableAnswer(db, "access_level_capabilities", "level_id", levelId);
}

/** Whether a grant carries an Answer rule that can release answers today. */
export function grantHasUsableAnswer(db: Db, grantId: string): boolean {
  return hasUsableAnswer(db, "access_grant_capabilities", "grant_id", grantId);
}

function hasUsableAnswer(
  db: Db,
  table: "access_grant_capabilities" | "access_level_capabilities",
  keyColumn: "grant_id" | "level_id",
  id: string,
): boolean {
  return !!db
    .prepare<[string], { present: number }>(
      `SELECT 1 AS present FROM ${table} c
       WHERE c.${keyColumn} = ? AND c.capability = 'answer' AND (
         c.release_mode = 'unreviewed' OR (
           c.release_mode = 'reviewed' AND EXISTS (
             SELECT 1 FROM privacy_policy_state s
             JOIN privacy_policy_families f ON f.id = s.family_id
             WHERE s.family_id = c.policy_family_id AND f.archived_at IS NULL
           )
         )
       )`,
    )
    .get(id);
}
