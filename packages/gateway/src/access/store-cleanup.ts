// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";

import { appendAudit, AUTHORIZATION_REQUEST_TTL_MS } from "./store-helpers.js";
import type { Db } from "../data/types.js";

/**
 * The periodic access sweep: expired bindings, tokens, audit rows, orphaned
 * OAuth clients, and authorization requests together with whatever an
 * abandoned approval created. Each phase is one bounded writer transaction.
 */

export type AccessCleanupPhase =
  | "executionBindings"
  | "authorizationRequests"
  | "accessTokens"
  | "refreshTokens"
  | "auditEvents"
  | "oauthClients";

export interface OAuthClientCleanupCursor {
  createdAt: number;
  clientId: string;
}

export interface AccessCleanupResult {
  phase: AccessCleanupPhase;
  deleted: number;
  hasMore: boolean;
  cursor?: OAuthClientCleanupCursor;
  /**
   * When the soonest still-pending authorization request falls due, so a
   * sweep that found nothing to delete can wake for it rather than for its
   * idle period. Absent when nothing is pending.
   */
  nextDueAt?: number;
}

const OAUTH_CLIENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const ACCESS_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export function cleanupExpiredAccessStateBatch(
  db: Db,
  phase: AccessCleanupPhase,
  now = Date.now(),
  requestedLimit = 200,
  cursor?: OAuthClientCleanupCursor,
): AccessCleanupResult {
  const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit)));
  if (phase === "oauthClients") {
    return cleanupOrphanedOAuthClients(db, now - OAUTH_CLIENT_RETENTION_MS, limit, cursor);
  }
  if (phase === "auditEvents") {
    return cleanupAccessAuditEvents(db, now - ACCESS_AUDIT_RETENTION_MS, limit);
  }
  if (phase === "authorizationRequests") {
    return cleanupAuthorizationRequests(db, now, limit);
  }
  if (phase === "refreshTokens") {
    return cleanupRefreshTokens(db, now, limit);
  }
  const table = cleanupTable(phase);
  return db.transaction(() => {
    const deleted = db
      .prepare(
        `DELETE FROM ${table}
         WHERE id IN (
           SELECT id FROM ${table}
           WHERE expires_at <= ?
           ORDER BY expires_at, id
           LIMIT ?
         )`,
      )
      .run(now, limit).changes;
    const hasMore =
      db
        .prepare<
          [number],
          { present: number }
        >(`SELECT 1 AS present FROM ${table} WHERE expires_at <= ? LIMIT 1`)
        .get(now) !== undefined;
    return { phase, deleted, hasMore };
  })();
}

function cleanupRefreshTokens(
  db: Db,
  now: number,
  limit: number,
): { phase: "refreshTokens"; deleted: number; hasMore: boolean } {
  return db.transaction(() => {
    const retryPayloads = db
      .prepare<[number, number], { id: string }>(
        `SELECT id FROM oauth_refresh_tokens
          WHERE retry_until < ? AND replacement_ciphertext IS NOT NULL
          ORDER BY retry_until, id LIMIT ?`,
      )
      .all(now, limit);
    if (retryPayloads.length > 0) {
      db.prepare(
        `UPDATE oauth_refresh_tokens
            SET replacement_ciphertext = NULL, retry_until = NULL
          WHERE id IN (${retryPayloads.map(() => "?").join(", ")})`,
      ).run(...retryPayloads.map((row) => row.id));
    }
    const remaining = limit - retryPayloads.length;
    const deleted =
      remaining === 0
        ? 0
        : db
            .prepare(
              `DELETE FROM oauth_refresh_tokens
               WHERE id IN (
                 SELECT id FROM oauth_refresh_tokens
                 WHERE expires_at <= ?
                 ORDER BY expires_at, id
                 LIMIT ?
               )`,
            )
            .run(now, remaining).changes;
    const hasMore = Boolean(
      db
        .prepare<[number, number], { present: number }>(
          `SELECT 1 AS present FROM oauth_refresh_tokens
            WHERE expires_at <= ?
               OR (retry_until < ? AND replacement_ciphertext IS NOT NULL)
            LIMIT 1`,
        )
        .get(now, now),
    );
    return { phase: "refreshTokens" as const, deleted, hasMore };
  })();
}

interface ReapedRequestRow {
  id: string;
  credential_id: string | null;
  created_grant_id: string | null;
  created_principal_id: string | null;
  created_level_id: string | null;
}

function cleanupAuthorizationRequests(
  db: Db,
  now: number,
  limit: number,
): { phase: "authorizationRequests"; deleted: number; hasMore: boolean; nextDueAt?: number } {
  return db.transaction(() => {
    const codeIssued = db
      .prepare<[number, number], ReapedRequestRow>(
        `SELECT id, credential_id, created_grant_id, created_principal_id, created_level_id
         FROM oauth_authorization_requests
         WHERE status = 'code-issued' AND authorization_code_expires_at <= ?
         ORDER BY authorization_code_expires_at, id
         LIMIT ?`,
      )
      .all(now, limit);
    const remaining = limit - codeIssued.length;
    const ordinary =
      remaining > 0
        ? db
            .prepare<[number, number], ReapedRequestRow>(
              `SELECT id, credential_id, created_grant_id, created_principal_id, created_level_id
               FROM oauth_authorization_requests
               WHERE status != 'code-issued' AND expires_at <= ?
               ORDER BY expires_at, id
               LIMIT ?`,
            )
            .all(now, remaining)
        : [];
    const selected = [...codeIssued, ...ordinary];
    const pendingCredentialIds = [
      ...new Set(selected.flatMap((row) => (row.credential_id ? [row.credential_id] : []))),
    ];
    if (pendingCredentialIds.length > 0) {
      db.prepare(
        `DELETE FROM principal_credentials
         WHERE status = 'pending' AND id IN (${pendingCredentialIds.map(() => "?").join(", ")})`,
      ).run(...pendingCredentialIds);
    }
    const deleted =
      selected.length === 0
        ? 0
        : db
            .prepare(
              `DELETE FROM oauth_authorization_requests
               WHERE id IN (${selected.map(() => "?").join(", ")})`,
            )
            .run(...selected.map((row) => row.id)).changes;
    const createdGrantIds = [
      ...new Set(selected.flatMap((row) => (row.created_grant_id ? [row.created_grant_id] : []))),
    ];
    const deleteEmptyGrant = db.prepare(
      `DELETE FROM access_grants
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM principal_credentials WHERE grant_id = access_grants.id)`,
    );
    for (const grantId of createdGrantIds) deleteEmptyGrant.run(grantId);
    const createdPrincipalIds = [
      ...new Set(
        selected.flatMap((row) => (row.created_principal_id ? [row.created_principal_id] : [])),
      ),
    ];
    const deleteEmptyPrincipal = db.prepare(
      `DELETE FROM access_principals
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM access_grants WHERE principal_id = access_principals.id)`,
    );
    for (const principalId of createdPrincipalIds) deleteEmptyPrincipal.run(principalId);
    retireAbandonedLevels(db, selected, now);
    // A pending credential whose request row is already gone has nothing
    // left to redeem it and nothing left to reap it through, so it is
    // collected on its own once the request's window has certainly closed.
    // Its grant and agent go too if it was all they had: every grant is born
    // with a credential in the same transaction, so a grant with no credential
    // row at all can only be one whose pending credential was reaped, never
    // one an owner made deliberately. A grant that keeps revoked credentials
    // keeps its history and stays.
    const orphanBudget = limit - selected.length;
    const orphans =
      orphanBudget > 0
        ? db
            .prepare<[number, number], { id: string; grant_id: string }>(
              `SELECT c.id, c.grant_id FROM principal_credentials c
               WHERE c.status = 'pending' AND c.created_at <= ?
                 AND NOT EXISTS (
                   SELECT 1 FROM oauth_authorization_requests r WHERE r.credential_id = c.id
                 )
               ORDER BY c.created_at, c.id
               LIMIT ?`,
            )
            .all(now - AUTHORIZATION_REQUEST_TTL_MS, orphanBudget)
        : [];
    if (orphans.length > 0) {
      db.prepare(
        `DELETE FROM principal_credentials WHERE id IN (${orphans.map(() => "?").join(", ")})`,
      ).run(...orphans.map((row) => row.id));
      const principalOf = db.prepare<[string], { principal_id: string }>(
        "SELECT principal_id FROM access_grants WHERE id = ?",
      );
      for (const orphan of orphans) {
        const principalId = principalOf.get(orphan.grant_id)?.principal_id;
        deleteEmptyGrant.run(orphan.grant_id);
        if (principalId) deleteEmptyPrincipal.run(principalId);
      }
    }
    const codeIssuedRemain =
      db
        .prepare<[number], { present: number }>(
          `SELECT 1 AS present FROM oauth_authorization_requests
           WHERE status = 'code-issued' AND authorization_code_expires_at <= ? LIMIT 1`,
        )
        .get(now) !== undefined;
    const ordinaryRemain =
      db
        .prepare<[number], { present: number }>(
          `SELECT 1 AS present FROM oauth_authorization_requests
           WHERE status != 'code-issued' AND expires_at <= ? LIMIT 1`,
        )
        .get(now) !== undefined;
    const orphansRemain =
      db
        .prepare<[number], { present: number }>(
          `SELECT 1 AS present FROM principal_credentials c
           WHERE c.status = 'pending' AND c.created_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM oauth_authorization_requests r WHERE r.credential_id = c.id
             )
           LIMIT 1`,
        )
        .get(now - AUTHORIZATION_REQUEST_TTL_MS) !== undefined;
    // The soonest moment anything still pending falls due, for the sweep to
    // wake on instead of its idle period. Two indexed minimums, one per
    // expiry column, rather than one expression over both that no index can
    // serve: this runs on the writer every tick.
    const codeDue = db
      .prepare<[], { due: number | null }>(
        `SELECT MIN(authorization_code_expires_at) AS due
         FROM oauth_authorization_requests WHERE status = 'code-issued'`,
      )
      .get()?.due;
    const requestDue = db
      .prepare<[], { due: number | null }>(
        `SELECT MIN(expires_at) AS due
         FROM oauth_authorization_requests WHERE status != 'code-issued'`,
      )
      .get()?.due;
    const dues = [codeDue, requestDue].filter((due): due is number => due != null);
    return {
      phase: "authorizationRequests" as const,
      deleted: deleted + orphans.length,
      hasMore: codeIssuedRemain || ordinaryRemain || orphansRemain,
      ...(dues.length > 0 ? { nextDueAt: Math.min(...dues) } : {}),
    };
  })();
}

/**
 * Retire the levels abandoned approvals made for themselves. A level still
 * recorded on its request was never chosen or edited by anyone else — either
 * clears the record — so once no grant or device refers to it, not even a
 * revoked one, nothing about it belongs to anybody. It is retired, never deleted, and the
 * retirement is audited like any other.
 */
function retireAbandonedLevels(db: Db, reaped: readonly ReapedRequestRow[], now: number): void {
  const findAbandoned = db.prepare<[string], { name: string }>(
    `SELECT name FROM access_levels l
      WHERE l.id = ? AND l.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM access_grants g WHERE g.level_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.access_level_id = l.id)`,
  );
  const retire = db.prepare("UPDATE access_levels SET revoked_at = ?, updated_at = ? WHERE id = ?");
  for (const row of reaped) {
    if (row.created_level_id === null) continue;
    const level = findAbandoned.get(row.created_level_id);
    if (!level) continue;
    retire.run(now, now, row.created_level_id);
    appendAudit(db, {
      eventType: "level-deleted",
      detail: {
        levelId: row.created_level_id,
        name: level.name,
        abandonedAuthorizationRequestId: row.id,
      },
      now,
    });
  }
}

function cleanupAccessAuditEvents(
  db: Db,
  cutoff: number,
  limit: number,
): { phase: "auditEvents"; deleted: number; hasMore: boolean } {
  return db.transaction(() => {
    const deleted = db
      .prepare(
        `DELETE FROM access_audit_events
         WHERE id IN (
           SELECT id FROM access_audit_events
           WHERE occurred_at < ?
           ORDER BY occurred_at, id
           LIMIT ?
         )`,
      )
      .run(cutoff, limit).changes;
    const hasMore =
      db
        .prepare<
          [number],
          { present: number }
        >("SELECT 1 AS present FROM access_audit_events WHERE occurred_at < ? LIMIT 1")
        .get(cutoff) !== undefined;
    return { phase: "auditEvents" as const, deleted, hasMore };
  })();
}

function cleanupOrphanedOAuthClients(
  db: Db,
  cutoff: number,
  limit: number,
  cursor?: OAuthClientCleanupCursor,
): AccessCleanupResult {
  return db.transaction(() => {
    const afterCursor = cursor
      ? "AND (c.created_at, c.client_id) > (@cursorCreatedAt, @cursorClientId)"
      : "";
    const candidates = db
      .prepare<
        {
          cutoff: number;
          cursorCreatedAt: number | null;
          cursorClientId: string | null;
          candidateLimit: number;
        },
        { client_id: string; created_at: number; orphan: number }
      >(
        `SELECT c.client_id, c.created_at,
           NOT EXISTS (
             SELECT 1 FROM principal_credentials pc WHERE pc.oauth_client_id = c.client_id
           ) AND NOT EXISTS (
             SELECT 1 FROM oauth_authorization_requests ar WHERE ar.client_id = c.client_id
           ) AND NOT EXISTS (
             SELECT 1 FROM oauth_execution_bindings eb WHERE eb.oauth_client_id = c.client_id
           ) AS orphan
         FROM oauth_clients c
         -- A secret cannot be handed out again, so only clients without one —
         -- public and metadata-document clients, which re-register on their
         -- next authorization — are collected.
         WHERE c.token_endpoint_auth_method IN ('none', 'private_key_jwt')
           AND c.created_at < @cutoff
           ${afterCursor}
         ORDER BY c.created_at, c.client_id
         LIMIT @candidateLimit`,
      )
      .all({
        cutoff,
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorClientId: cursor?.clientId ?? null,
        candidateLimit: limit + 1,
      });
    const inspected = candidates.slice(0, limit);
    const remove = db.prepare("DELETE FROM oauth_clients WHERE client_id = ?");
    let deleted = 0;
    for (const candidate of inspected) {
      if (candidate.orphan === 1) deleted += remove.run(candidate.client_id).changes;
    }
    const hasMore = candidates.length > limit;
    const last = inspected.at(-1);
    return {
      phase: "oauthClients" as const,
      deleted,
      hasMore,
      ...(hasMore && last
        ? { cursor: { createdAt: last.created_at, clientId: last.client_id } }
        : {}),
    };
  })();
}

function cleanupTable(
  phase: Exclude<
    AccessCleanupPhase,
    "oauthClients" | "auditEvents" | "authorizationRequests" | "refreshTokens"
  >,
): string {
  switch (phase) {
    case "executionBindings":
      return "oauth_execution_bindings";
    case "accessTokens":
      return "oauth_access_tokens";
    default:
      return assertNever(phase);
  }
}
