// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";

import { privacyPolicyDeletionBlockedReason } from "../privacy/policy-history.js";

import { oauthClientAuthenticates } from "./store-clients.js";
import { appendAudit, getActiveCredential, hashSecret } from "./store-helpers.js";
import { listAccessLevels } from "./store-level-summaries.js";
import { capabilityToRule, getGrantCapabilities } from "./store-rules.js";
import type { Db } from "../data/types.js";
import type {
  AccessGrant,
  AccessGrantSummary,
  AccessOverview,
  AccessPrincipal,
  AccessPrincipalRenameInput,
  OAuthClientCredentials,
  PrincipalCredential,
  PrincipalCredentialKind,
  PrincipalKind,
} from "./types.js";
import type { AccessMutationResult } from "./store-contracts.js";

/** One grant in the overview's shape: rules on the wire and its credentials. */
export function loadGrantSummary(db: Db, grantId: string): AccessGrantSummary | null {
  const row = db
    .prepare<[string], GrantRow>("SELECT * FROM access_grants WHERE id = ?")
    .get(grantId);
  if (!row) return null;
  const grant = grantFromRow(db, row);
  return {
    ...grant,
    rules: grant.capabilities.map(capabilityToRule),
    credentials: db
      .prepare<
        [string],
        CredentialRow
      >(`${CREDENTIAL_SELECT} WHERE c.grant_id = ? AND c.kind = 'interactive' ORDER BY c.created_at, c.id`)
      .all(grantId)
      .map(credentialFromRow),
  };
}

export function revokePrincipalCredential(
  db: Db,
  credentialId: string,
  actorTokenId: string,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const active = getActiveCredential(db, credentialId, now);
    const result = db
      .prepare(
        "UPDATE principal_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, credentialId);
    if (result.changes !== 1) return false;
    appendAudit(db, {
      eventType: "credential-revoked",
      principalId: active?.principal_id,
      grantId: active?.grant_id,
      grantRevision: active?.grant_revision,
      credentialId,
      oauthClientId: active?.oauth_client_id,
      actorTokenId,
      now,
    });
    return true;
  })();
}

export function revokeAccessGrant(
  db: Db,
  grantId: string,
  actorTokenId: string,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const grant = db
      .prepare<
        [string],
        { principal_id: string; revision: number }
      >("SELECT principal_id, revision FROM access_grants WHERE id = ? AND revoked_at IS NULL")
      .get(grantId);
    if (!grant) return false;
    db.prepare("UPDATE access_grants SET revoked_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      grantId,
    );
    appendAudit(db, {
      eventType: "grant-revoked",
      principalId: grant.principal_id,
      grantId,
      grantRevision: grant.revision,
      actorTokenId,
      now,
    });
    return true;
  })();
}

export function revokeAccessPrincipal(
  db: Db,
  principalId: string,
  actorTokenId: string,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE access_principals SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, now, principalId);
    if (result.changes !== 1) return false;
    appendAudit(db, {
      eventType: "principal-revoked",
      principalId,
      actorTokenId,
      now,
    });
    return true;
  })();
}

/**
 * Gives a live principal a new name.
 *
 * The name is the owner's label for the connection and nothing keys on it: a
 * credential stays bound to its grant, and a grant to its principal, by id.
 * Live names are read only to suffix a new connection's default name so two
 * connections of one app can be told apart. The connection's sign-ins that
 * still work take the new name as their label in the same transaction,
 * because the places that list sign-ins — a device's revocation impact, the
 * Privacy exchange detail — show that label as the connection's name.
 *
 * A revoked principal is refused as not found: it has left the table the
 * owner renames from. The name it already has is left alone, without an
 * audit row, so a save that changed nothing leaves no trace of a change.
 */
export function renameAccessPrincipal(
  db: Db,
  input: AccessPrincipalRenameInput,
  now = Date.now(),
): AccessMutationResult<AccessPrincipal> {
  const name = input.name.trim();
  return db.transaction((): AccessMutationResult<AccessPrincipal> => {
    const current = db
      .prepare<
        [string],
        PrincipalRow
      >("SELECT * FROM access_principals WHERE id = ? AND revoked_at IS NULL")
      .get(input.principalId);
    if (!current) return { ok: false, error: "not-found" };
    if (current.name === name) return { ok: true, value: principalFromRow(current) };
    db.prepare("UPDATE access_principals SET name = ?, updated_at = ? WHERE id = ?").run(
      name,
      now,
      current.id,
    );
    db.prepare(
      `UPDATE principal_credentials SET label = ?
        WHERE revoked_at IS NULL
          AND grant_id IN (SELECT id FROM access_grants WHERE principal_id = ?)`,
    ).run(name, current.id);
    appendAudit(db, {
      eventType: "principal-renamed",
      principalId: current.id,
      actorTokenId: input.actorTokenId,
      detail: { previousName: current.name, name },
      now,
    });
    return { ok: true, value: principalFromRow({ ...current, name, updated_at: now }) };
  })();
}

/**
 * Fence the agent once nothing live is left under it.
 *
 * "Live" is the gateway's own test: a grant that is neither revoked nor
 * expired. The revoke it performs is the ordinary one, with its own audit
 * event; a principal that is already fenced makes that a no-op.
 */
function revokePrincipalIfUnheld(
  db: Db,
  principalId: string,
  actorTokenId: string,
  now: number,
): void {
  const stillHeld =
    db
      .prepare<[string, number], { present: number }>(
        `SELECT 1 AS present FROM access_grants
         WHERE principal_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(principalId, now) !== undefined;
  if (!stillHeld) revokeAccessPrincipal(db, principalId, actorTokenId, now);
}

/**
 * Remove a connection the way its owner means it.
 *
 * The credential is fenced first. Then the grant, if this was the last
 * credential still live on it, and the agent, if that was its last live grant
 * — a pending sibling counts as live, since it is a connection in progress,
 * while an expired one does not, since it can no longer authenticate. Each
 * step is the ordinary revoke with its own audit event, in one transaction,
 * so nothing is left behind that the owner would have to find and fence by
 * hand. A grant or agent that is already fenced makes its step a no-op; the
 * result is never less fencing than asked for.
 */
export function removeConnection(
  db: Db,
  credentialId: string,
  actorTokenId: string,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const owner = db
      .prepare<[string], { grant_id: string; principal_id: string }>(
        `SELECT c.grant_id, g.principal_id
         FROM principal_credentials c
         JOIN access_grants g ON g.id = c.grant_id
         WHERE c.id = ?`,
      )
      .get(credentialId);
    if (!owner) return false;
    if (!revokePrincipalCredential(db, credentialId, actorTokenId, now)) return false;

    const grantStillHeld =
      db
        .prepare<[string, number], { present: number }>(
          `SELECT 1 AS present FROM principal_credentials
           WHERE grant_id = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           LIMIT 1`,
        )
        .get(owner.grant_id, now) !== undefined;
    if (grantStillHeld) return true;
    revokeAccessGrant(db, owner.grant_id, actorTokenId, now);
    revokePrincipalIfUnheld(db, owner.principal_id, actorTokenId, now);
    return true;
  })();
}

/**
 * Remove an access profile the way its owner means it: the grant, and the
 * agent with it when this was the last live profile it held. The profile's
 * own connections are fenced by the grant's revocation.
 */
export function removeProfile(
  db: Db,
  grantId: string,
  actorTokenId: string,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const owner = db
      .prepare<
        [string],
        { principal_id: string }
      >("SELECT principal_id FROM access_grants WHERE id = ?")
      .get(grantId);
    if (!owner) return false;
    if (!revokeAccessGrant(db, grantId, actorTokenId, now)) return false;
    revokePrincipalIfUnheld(db, owner.principal_id, actorTokenId, now);
    return true;
  })();
}

export function revokeOAuthToken(
  db: Db,
  rawToken: string,
  clientId: string,
  credentials: OAuthClientCredentials,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const tokenHash = hashSecret(rawToken);
    const credential = db
      .prepare<
        [string, string],
        {
          id: string;
          principal_id: string;
          grant_id: string;
          grant_revision: number;
          oauth_client_id: string;
        }
      >(
        `SELECT c.id, g.principal_id, c.grant_id, g.revision AS grant_revision, c.oauth_client_id
         FROM principal_credentials c
         JOIN access_grants g ON g.id = c.grant_id
         WHERE c.id = COALESCE(
           (SELECT credential_id FROM oauth_access_tokens WHERE token_hash = ?),
           (SELECT credential_id FROM oauth_refresh_tokens WHERE token_hash = ?)
         )`,
      )
      .get(tokenHash, tokenHash);
    if (!credential || credential.oauth_client_id !== clientId) return false;
    if (!oauthClientAuthenticates(db, credential.oauth_client_id, credentials)) return false;
    const revoked = db
      .prepare(
        "UPDATE principal_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, credential.id);
    if (revoked.changes !== 1) return false;
    appendAudit(db, {
      eventType: "oauth-authorization-revoked",
      principalId: credential.principal_id,
      grantId: credential.grant_id,
      grantRevision: credential.grant_revision,
      credentialId: credential.id,
      oauthClientId: credential.oauth_client_id,
      now,
    });
    return true;
  })();
}

/**
 * The principal, grant and credential state; the service adds the pending
 * request queue. The schema still admits the legacy `service` principal and
 * credential kind, but those rows are revoked and nothing can authenticate as
 * them, so the overview is the interactive rows alone.
 */
export function listAccessOverview(
  db: Db,
  now = Date.now(),
): Omit<AccessOverview, "pendingRequests"> {
  const principals = db
    .prepare<
      [],
      PrincipalRow
    >("SELECT * FROM access_principals WHERE kind = 'interactive' ORDER BY created_at, id")
    .all()
    .map(principalFromRow);
  const grants = db
    .prepare<[], GrantRow>(
      `SELECT g.* FROM access_grants g
       JOIN access_principals p ON p.id = g.principal_id
       WHERE p.kind = 'interactive'
       ORDER BY g.created_at, g.id`,
    )
    .all()
    .map((row) => grantFromRow(db, row));
  const credentials = db
    .prepare<
      [],
      CredentialRow
    >(`${CREDENTIAL_SELECT} WHERE c.kind = 'interactive' ORDER BY c.created_at, c.id`)
    .all()
    .map(credentialFromRow);
  const availableSources = db
    .prepare<[], { id: string; type: string; label: string | null; icon: string | null }>(
      `SELECT s.id, s.type,
              (SELECT ss.label FROM sync_state ss WHERE ss.source_id = s.id
                AND ss.label IS NOT NULL ORDER BY ss.device_id LIMIT 1) AS label,
              (SELECT ss.icon FROM sync_state ss WHERE ss.source_id = s.id
                AND ss.icon IS NOT NULL ORDER BY ss.device_id LIMIT 1) AS icon
         FROM sources s ORDER BY s.created_at, s.id`,
    )
    .all()
    .map((source) => ({
      id: source.id,
      name: source.label ?? source.type,
      icon: source.icon,
      available: true,
    }));
  const availableSourceIds = new Set(availableSources.map((source) => source.id));
  const missingReferencedSourceIds = [
    ...new Set(grants.flatMap((grant) => grant.capabilities.flatMap((rule) => rule.sourceIds))),
  ]
    .filter((sourceId) => !availableSourceIds.has(sourceId))
    .sort();
  const policyFamilies = db
    .prepare<[], { id: string; name: string; revision: string }>(
      `SELECT f.id, f.name, s.revision
         FROM privacy_policy_families f
         JOIN privacy_policy_state s ON s.family_id = f.id
        WHERE f.archived_at IS NULL ORDER BY f.created_at, f.id`,
    )
    .all()
    .map((family) => ({
      ...family,
      deletionBlockedReason: privacyPolicyDeletionBlockedReason(db, family.id),
    }));
  return {
    sources: [
      ...availableSources,
      ...missingReferencedSourceIds.map((id) => ({
        id,
        name: id,
        icon: null,
        available: false,
      })),
    ],
    policyFamilies,
    defaultPolicyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
    privacyPolicies: policyFamilies,
    levels: listAccessLevels(db, now),
    principals: principals.map((principal) => ({
      ...principal,
      grants: grants
        .filter((grant) => grant.principalId === principal.id)
        .map((grant) => ({
          ...grant,
          rules: grant.capabilities.map(capabilityToRule),
          credentials: credentials.filter((credential) => credential.grantId === grant.id),
        })),
    })),
  };
}

interface PrincipalRow {
  id: string;
  name: string;
  kind: PrincipalKind;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

interface GrantRow {
  id: string;
  principal_id: string;
  name: string;
  revision: number;
  level_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

/** A credential and the name its OAuth client registered under, when still registered. */
const CREDENTIAL_SELECT = `SELECT c.*, oc.client_name
  FROM principal_credentials c LEFT JOIN oauth_clients oc ON oc.client_id = c.oauth_client_id`;

interface CredentialRow {
  id: string;
  grant_id: string;
  oauth_client_id: string;
  kind: PrincipalCredentialKind;
  status: "pending" | "active";
  label: string;
  client_name: string | null;
  execution_device_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

function principalFromRow(row: PrincipalRow): AccessPrincipal {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function grantFromRow(db: Db, row: GrantRow): AccessGrant {
  return {
    id: row.id,
    principalId: row.principal_id,
    name: row.name,
    revision: row.revision,
    levelId: row.level_id,
    capabilities: getGrantCapabilities(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function credentialFromRow(row: CredentialRow): PrincipalCredential {
  return {
    id: row.id,
    grantId: row.grant_id,
    oauthClientId: row.oauth_client_id,
    kind: row.kind,
    status: row.status,
    label: row.label,
    clientName: row.client_name,
    executionDeviceId: row.execution_device_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
