// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createCorpusAuthorization,
  externalAnswerOwnerId,
} from "../access/corpus-authorization.js";
import type { AccessGrantCapability } from "../access/types.js";
import type { Db } from "./types.js";

const LEGACY_OWNER =
  /^principal:([^:]+):grant:([^:]+):revision:(\d+):credential:([^:]+):scope:([A-Za-z0-9_-]+)$/;

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

interface CapabilityRow {
  grant_revision: number;
  source_mode: AccessGrantCapability["sourceMode"];
  source_ids: string;
  release_mode: AccessGrantCapability["releaseMode"];
  policy_family_id: string | null;
  current_policy_revision: string | null;
  current_privacy_policy: string | null;
}

/**
 * Move legacy revision-bound Answer owners to the stable corpus-scope owner.
 *
 * A legacy digest is accepted only when it can be reproduced from the current
 * source/release boundary and either the current or a task-recorded historical
 * policy version. That rescues policy-only revisions while refusing to attach
 * work whose source boundary may have changed. Conflicting retry rows are left
 * in their old, inaccessible namespace instead of guessing which result wins.
 */
export function migrateAnswerOwnersToStableScope(db: Db): void {
  if (!tableExists(db, "answer_tasks") || !tableExists(db, "access_grant_capabilities")) return;
  const ownerTables = [
    "answer_tasks",
    "answer_request_tombstones",
    "answer_conversation_tombstones",
  ].filter((table) => tableExists(db, table));
  const owners = db
    .prepare<[], { owner_id: string }>(
      `SELECT DISTINCT owner_id FROM (${ownerTables
        .map((table) => `SELECT owner_id FROM ${table}`)
        .join(" UNION ALL ")})
        WHERE owner_id GLOB 'principal:*:grant:*:revision:*:credential:*:scope:*'`,
    )
    .all();

  for (const { owner_id: legacyOwner } of owners) {
    const match = LEGACY_OWNER.exec(legacyOwner);
    if (!match) continue;
    const [, principalId, grantId, revisionText, credentialId, legacyDigest] = match;
    const capability = db
      .prepare<[string, string, string], CapabilityRow>(
        `SELECT g.revision AS grant_revision,
                cap.source_mode, cap.source_ids, cap.release_mode, cap.policy_family_id,
                v.revision AS current_policy_revision,
                v.policy AS current_privacy_policy
           FROM access_grants g
           JOIN principal_credentials c ON c.grant_id = g.id
           JOIN access_grant_capabilities cap
             ON cap.grant_id = g.id AND cap.capability = 'answer'
      LEFT JOIN privacy_policy_state ps ON ps.family_id = cap.policy_family_id
      LEFT JOIN privacy_policy_versions v
             ON v.family_id = ps.family_id AND v.generation = ps.generation
          WHERE g.id = ? AND g.principal_id = ? AND c.id = ?`,
      )
      .get(grantId!, principalId!, credentialId!);
    if (!capability) continue;

    const sourceIds = parseSourceIds(capability.source_ids);
    if (!sourceIds) continue;
    const policyCandidates = policyVersionsForOwner(db, legacyOwner, capability);
    const matchedAuthorization = policyCandidates
      .map((policy) =>
        createCorpusAuthorization(
          {
            principalId: principalId!,
            grantId: grantId!,
            grantRevision: Number(revisionText),
            credentialId: credentialId!,
            accessTokenId: "migration",
          },
          [
            {
              capability: "answer",
              sourceMode: capability.source_mode,
              sourceIds,
              releaseMode: capability.release_mode,
              policyFamilyId: capability.policy_family_id,
              policyRevision: policy.revision,
              privacyPolicy: policy.policy,
            },
          ],
          "answer",
        ),
      )
      .find((authorization) => authorization?.digest === legacyDigest);
    if (!matchedAuthorization) continue;

    const stableOwner = externalAnswerOwnerId(matchedAuthorization);
    if (hasRequestCollision(db, legacyOwner, stableOwner)) continue;
    for (const table of ANSWER_OWNER_TABLES) {
      if (tableExists(db, table)) {
        db.prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id = ?`).run(
          stableOwner,
          legacyOwner,
        );
      }
    }
  }
}

function policyVersionsForOwner(
  db: Db,
  ownerId: string,
  capability: CapabilityRow,
): Array<{ revision: string | null; policy: string | null }> {
  if (capability.release_mode === "unreviewed") return [{ revision: null, policy: null }];
  if (!capability.policy_family_id) return [];
  return db
    .prepare<[string], { revision: string; policy: string }>(
      `SELECT revision, policy FROM privacy_policy_versions
        WHERE family_id = ? ORDER BY family_version DESC`,
    )
    .all(capability.policy_family_id);
}

function parseSourceIds(serialized: string): string[] | null {
  try {
    const value = JSON.parse(serialized) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

function hasRequestCollision(db: Db, legacyOwner: string, stableOwner: string): boolean {
  const taskCollision = db
    .prepare<[string, string], { present: number }>(
      `SELECT 1 AS present FROM answer_tasks old
        JOIN answer_tasks current
          ON current.owner_id = ? AND current.client_request_id = old.client_request_id
       WHERE old.owner_id = ? LIMIT 1`,
    )
    .get(stableOwner, legacyOwner);
  if (taskCollision) return true;
  if (!tableExists(db, "answer_request_tombstones")) return false;
  return Boolean(
    db
      .prepare<[string, string], { present: number }>(
        `SELECT 1 AS present FROM answer_request_tombstones old
          JOIN answer_request_tombstones current
            ON current.owner_id = ? AND current.client_request_id = old.client_request_id
         WHERE old.owner_id = ? LIMIT 1`,
      )
      .get(stableOwner, legacyOwner),
  );
}

function tableExists(db: Db, name: string): boolean {
  return Boolean(
    db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}
