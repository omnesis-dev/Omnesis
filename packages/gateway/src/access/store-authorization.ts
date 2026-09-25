// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import { enqueueNotification } from "../push/queue.js";
import { getOAuthClient, oauthClientAuthenticates } from "./store-clients.js";
import { consumeExecutionBinding } from "./store-execution-bindings.js";
import { registeredRedirectMatches } from "./redirect-uri.js";
import { normalizeInteractiveOAuthScope, OAUTH_OFFLINE_ACCESS_SCOPE } from "./oauth-scopes.js";
import {
  DecisionRefusedError,
  resolveDecision,
  resolveSelection,
  retireReplacedSignIns,
  selectionHasUsableAnswer,
} from "./store-decisions.js";
import { isLevelNameConflict } from "./store-level-writes.js";
import {
  appendAudit,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  type AuthorizationRequestRow,
  findAuthorizationRowByBrowserHandle,
  findAuthorizationRowById,
  formatUserCode,
  generateUserCode,
  getActiveGrant,
  hashSecret,
  isUniqueConstraint,
  issueTokenPair,
  normalizeUserCode,
  parseDecisionSelection,
  parseSelection,
  pkceMatches,
  portalAuthorization,
  publicAuthorization,
  selectionIsUsable,
  urlSafeSecret,
} from "./store-helpers.js";
import type { DeviceId } from "@omnesis/types";
import type { AccessMutationResult } from "./store-contracts.js";
import type { Db } from "../data/types.js";
import type {
  AccessAuthorizationNotificationEnqueueResult,
  AuthorizationDecisionSelection,
  AuthorizationRequestCreateInput,
  AuthorizationRequestDecisionInput,
  AuthorizationRequestPortal,
  AuthorizationRequestPublic,
  OAuthTokenSet,
  PendingAuthorizationRequest,
} from "./types.js";

export function createAuthorizationRequest(
  db: Db,
  input: AuthorizationRequestCreateInput,
  now = Date.now(),
): AccessMutationResult<{
  id: string;
  browserHandle: string;
  userCode: string;
  expiresAt: number;
}> {
  const preflight = preflightAuthorizationRequest(db, input);
  if (!preflight.ok) return preflight;
  const client = getOAuthClient(db, input.clientId);
  if (!client) return { ok: false, error: "invalid-client" };
  const normalizedScope = normalizeInteractiveOAuthScope(input.scope);
  if (!normalizedScope) return { ok: false, error: "invalid-request" };
  const id = randomUUID();
  const browserHandle = `omn_oar_${urlSafeSecret(24)}`;
  const expiresAt = now + (input.ttlMs ?? AUTHORIZATION_REQUEST_TTL_MS);
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const userCode = generateUserCode();
    try {
      const inserted = db.transaction((): AccessMutationResult<null> => {
        let executionDeviceId: string | null = null;
        if (input.executionBinding) {
          const binding = consumeExecutionBinding(db, input.executionBinding, client.clientId, now);
          if (!binding.ok) return binding;
          executionDeviceId = binding.value;
        }
        db.prepare(
          `INSERT INTO oauth_authorization_requests (
             id, browser_handle_hash, user_code, client_id, client_name, client_uri,
             redirect_uri, state, code_challenge, resource, scope, created_at,
             expires_at, execution_device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          hashSecret(browserHandle),
          userCode,
          client.clientId,
          client.clientName,
          client.clientUri,
          input.redirectUri,
          input.state ?? "",
          input.codeChallenge,
          input.resource,
          normalizedScope,
          now,
          expiresAt,
          executionDeviceId,
        );
        return { ok: true, value: null };
      })();
      if (!inserted.ok) return inserted;
      return {
        ok: true,
        value: { id, browserHandle, userCode: formatUserCode(userCode), expiresAt },
      };
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
  }
  throw new Error("Could not allocate a unique OAuth approval code.");
}

/**
 * Atomically enqueue the generic phone notification and mark its request sent.
 *
 * The notification outbox and one-shot marker commit in the same transaction:
 * a crash before commit leaves neither, while a crash after commit leaves a
 * durable pending wake that the push retry scheduler owns.
 */
export function enqueueAccessAuthorizationNotification(
  db: Db,
  requestId: string,
  deviceIds: readonly DeviceId[],
  now = Date.now(),
): AccessAuthorizationNotificationEnqueueResult | null {
  return db
    .transaction(() => {
      const row = db
        .prepare<[string, number], { expires_at: number }>(
          `SELECT expires_at FROM oauth_authorization_requests
          WHERE id = ? AND status = 'pending' AND expires_at > ?
            AND access_notification_sent_at IS NULL
            AND browser_handle_hash <> '' AND user_code <> '' AND client_id <> ''
            AND redirect_uri <> '' AND code_challenge <> '' AND resource <> '' AND scope <> ''`,
        )
        .get(requestId, now);
      if (!row) return null;

      // Target selection happens on a reader before this writer turn. Recheck
      // the security-relevant phone state inside the same transaction so a
      // concurrently revoked or notification-disabled installation cannot gain
      // a fresh delivery after its revocation/supersede write.
      const eligiblePhone = db.prepare<[string], { present: number }>(
        `SELECT 1 AS present FROM devices
        WHERE id = ? AND kind IN ('ios', 'android') AND revoked_at IS NULL
          AND (notification_delivery_health IS NULL OR notification_delivery_health NOT IN (
            'not-determined', 'permission-denied', 'alerts-disabled'
          ))`,
      );
      const eligibleDeviceIds = [...new Set(deviceIds)].filter(
        (deviceId) => eligiblePhone.get(deviceId) !== undefined,
      );
      if (eligibleDeviceIds.length === 0) return null;

      const queued = enqueueNotification(db, {
        message: {
          kind: "access-authorization",
          title: "Access request waiting",
          body: "Tap to enter the displayed code in Omnesis, or use Connect an agent on Portal → Settings → Access.",
          data: {},
          collapseId: "access:authorization",
        },
        deviceIds: eligibleDeviceIds,
        createdAt: now,
        expiresAt: row.expires_at,
      });
      if (!queued) return null;

      const marked = db
        .prepare(
          `UPDATE oauth_authorization_requests
            SET access_notification_reserved_at = ?, access_notification_sent_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
            AND access_notification_sent_at IS NULL`,
        )
        .run(now, now, requestId, now);
      if (marked.changes !== 1) {
        throw new Error("authorization notification request changed during atomic enqueue");
      }
      return {
        requestId,
        expiresAt: row.expires_at,
        deviceIds: queued.deviceIds,
      };
    })
    .immediate();
}

/** Reject public authorization noise before it enters the single writer queue. */
export function preflightAuthorizationRequest(
  db: Db,
  input: AuthorizationRequestCreateInput,
): AccessMutationResult<null> {
  const client = getOAuthClient(db, input.clientId);
  if (!client) return { ok: false, error: "invalid-client" };
  if (
    !client.redirectUris.some((registered) =>
      /^https:/iu.test(input.clientId)
        ? registered === input.redirectUri
        : registeredRedirectMatches(registered, input.redirectUri),
    ) ||
    !client.grantTypes.includes("authorization_code") ||
    !client.responseTypes.includes("code")
  ) {
    return { ok: false, error: "invalid-redirect-uri" };
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    return { ok: false, error: "invalid-pkce" };
  }
  const scope = normalizeInteractiveOAuthScope(input.scope);
  if (!scope) return { ok: false, error: "invalid-request" };
  if (
    scope.split(/\s+/u).includes(OAUTH_OFFLINE_ACCESS_SCOPE) &&
    !client.grantTypes.includes("refresh_token")
  ) {
    return { ok: false, error: "invalid-scope" };
  }
  return { ok: true, value: null };
}

/** Undecided, unexpired requests, newest first — what a client shows as waiting. */
export function listPendingAuthorizationRequests(
  db: Db,
  now = Date.now(),
): PendingAuthorizationRequest[] {
  return db
    .prepare<
      [number],
      Pick<
        AuthorizationRequestRow,
        "id" | "client_name" | "user_code" | "created_at" | "expires_at"
      >
    >(
      `SELECT id, client_name, user_code, created_at, expires_at
       FROM oauth_authorization_requests
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(now)
    .map((row) => ({
      id: row.id,
      clientName: row.client_name,
      userCode: formatUserCode(row.user_code),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
}

export function getAuthorizationRequestByBrowserHandle(
  db: Db,
  browserHandle: string,
  now = Date.now(),
): AuthorizationRequestPublic | null {
  const row = findAuthorizationRowByBrowserHandle(db, browserHandle);
  return row ? publicAuthorization(row, now) : null;
}

export function getAuthorizationRequestByUserCode(
  db: Db,
  userCode: string,
  now = Date.now(),
): AuthorizationRequestPortal | null {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return null;
  const row = db
    .prepare<
      [string],
      AuthorizationRequestRow
    >("SELECT * FROM oauth_authorization_requests WHERE user_code = ?")
    .get(normalized);
  if (!row) return null;
  return portalAuthorization(row, now);
}

export function getAuthorizationRequestById(
  db: Db,
  requestId: string,
  now = Date.now(),
): AuthorizationRequestPortal | null {
  const row = findAuthorizationRowById(db, requestId);
  return row ? portalAuthorization(row, now) : null;
}

export function decideAuthorizationRequest(
  db: Db,
  input: AuthorizationRequestDecisionInput,
  now = Date.now(),
): AccessMutationResult<AuthorizationRequestPublic> {
  const row = findAuthorizationRowById(db, input.approvalId);
  if (!row) return { ok: false, error: "not-found" };
  if (row.expires_at <= now) return { ok: false, error: "expired" };
  if (row.status !== "pending") return { ok: false, error: "already-decided" };

  let approvedSelection: AuthorizationDecisionSelection | null = null;
  if (input.decision === "approve") {
    const selection = parseDecisionSelection(input.selection);
    if (!selection) return { ok: false, error: "invalid-selection" };
    if (
      selection.kind === "new-principal" ||
      selection.kind === "new-grant" ||
      selection.kind === "existing-grant"
    ) {
      if (!selectionIsUsable(db, selection, now)) return { ok: false, error: "inactive-grant" };
      if (row.execution_device_id !== null && !selectionHasUsableAnswer(db, selection)) {
        return { ok: false, error: "invalid-selection" };
      }
    }
    approvedSelection = selection;
  }

  const status = input.decision === "approve" ? "approved" : "denied";
  let updated: "updated" | "lost-race";
  try {
    updated = db.transaction((): "updated" | "lost-race" => {
      const result = db
        .prepare(
          `UPDATE oauth_authorization_requests
           SET status = ?, decision_token_id = ?, decision_at = ?
           WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(status, input.actorTokenId, now, row.id, now);
      if (result.changes !== 1) return "lost-race";

      let resolved: ReturnType<typeof resolveSelection> = null;
      let credentialId: string | undefined;
      if (approvedSelection) {
        const decision = resolveDecision(db, row, approvedSelection, input.actorTokenId, now);
        const primitive = decision.primitive;
        resolved = resolveSelection(db, primitive, now, {
          actorTokenId: input.actorTokenId,
          ...(decision.levelId ? { levelId: decision.levelId } : {}),
        });
        if (!resolved) throw new DecisionRefusedError("inactive-grant");
        credentialId = randomUUID();
        db.prepare(
          `INSERT INTO principal_credentials (
             id, grant_id, oauth_client_id, kind, status, label, execution_device_id,
             created_at, expires_at
           ) VALUES (?, ?, ?, 'interactive', 'pending', ?, ?, ?, ?)`,
        ).run(
          credentialId,
          resolved.grantId,
          row.client_id,
          primitive.credentialLabel,
          row.execution_device_id,
          now,
          resolved.expiresAt,
        );
        db.prepare(
          `UPDATE oauth_authorization_requests
           SET selection_json = ?, credential_id = ?, created_grant_id = ?,
               created_principal_id = ?, created_level_id = ?
           WHERE id = ?`,
        ).run(
          JSON.stringify(primitive),
          credentialId,
          primitive.kind === "existing-grant" ? null : resolved.grantId,
          primitive.kind === "new-principal" ? resolved.principalId : null,
          decision.createdLevelId ?? resolved.createdLevelId ?? null,
          row.id,
        );
      }
      appendAudit(db, {
        eventType: input.decision === "approve" ? "authorization-approved" : "authorization-denied",
        principalId: resolved?.principalId,
        grantId: resolved?.grantId,
        grantRevision: resolved?.grantRevision,
        credentialId,
        oauthClientId: row.client_id,
        actorTokenId: input.actorTokenId,
        detail: { authorizationRequestId: row.id },
        now,
      });
      return "updated";
    })();
  } catch (error) {
    if (error instanceof DecisionRefusedError) return { ok: false, error: error.code };
    if (isLevelNameConflict(error)) return { ok: false, error: "level-name-taken" };
    throw error;
  }
  if (updated === "lost-race") return { ok: false, error: "already-decided" };
  const next = findAuthorizationRowById(db, row.id);
  if (!next) return { ok: false, error: "not-found" };
  return { ok: true, value: publicAuthorization(next, now) };
}

export function issueAuthorizationCode(
  db: Db,
  browserHandle: string,
  now = Date.now(),
): AccessMutationResult<
  | { status: "denied"; redirectUri: string; state: string }
  | { status: "approved"; redirectUri: string; state: string; code: string }
> {
  const row = findAuthorizationRowByBrowserHandle(db, browserHandle);
  return issueAuthorizationCodeForRow(db, row, now);
}

export function issueAuthorizationCodeById(
  db: Db,
  requestId: string,
  now = Date.now(),
): AccessMutationResult<
  | { status: "denied"; redirectUri: string; state: string }
  | { status: "approved"; redirectUri: string; state: string; code: string }
> {
  return issueAuthorizationCodeForRow(db, findAuthorizationRowById(db, requestId), now);
}

function issueAuthorizationCodeForRow(
  db: Db,
  row: AuthorizationRequestRow | null | undefined,
  now: number,
): AccessMutationResult<
  | { status: "denied"; redirectUri: string; state: string }
  | { status: "approved"; redirectUri: string; state: string; code: string }
> {
  if (!row) return { ok: false, error: "not-found" };
  if (row.expires_at <= now) return { ok: false, error: "expired" };
  if (row.status === "denied") {
    return {
      ok: true,
      value: { status: "denied", redirectUri: row.redirect_uri, state: row.state },
    };
  }
  if (row.status === "pending") return { ok: false, error: "authorization-pending" };
  if (row.status !== "approved") return { ok: false, error: "already-decided" };
  const code = `omn_oac_${urlSafeSecret(24)}`;
  const result = db
    .prepare(
      `UPDATE oauth_authorization_requests
       SET status = 'code-issued', authorization_code_hash = ?,
           authorization_code_expires_at = ?, authorization_code_issued_at = ?
       WHERE id = ? AND status = 'approved'`,
    )
    .run(hashSecret(code), now + AUTHORIZATION_CODE_TTL_MS, now, row.id);
  if (result.changes !== 1) return { ok: false, error: "already-decided" };
  return {
    ok: true,
    value: { status: "approved", redirectUri: row.redirect_uri, state: row.state, code },
  };
}

export function exchangeAuthorizationCode(
  db: Db,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    clientSecret?: string;
    resource: string;
  },
  now = Date.now(),
): AccessMutationResult<OAuthTokenSet> {
  if (!oauthClientAuthenticates(db, input.clientId, input.clientSecret)) {
    return { ok: false, error: "invalid-client" };
  }
  const client = getOAuthClient(db, input.clientId);
  if (!client) return { ok: false, error: "invalid-client" };
  const row = db
    .prepare<
      [string],
      AuthorizationRequestRow
    >("SELECT * FROM oauth_authorization_requests WHERE authorization_code_hash = ?")
    .get(hashSecret(input.code));
  if (!row || row.status !== "code-issued" || row.authorization_code_consumed_at !== null) {
    return { ok: false, error: "invalid-code" };
  }
  if (row.authorization_code_expires_at === null || row.authorization_code_expires_at <= now) {
    return { ok: false, error: "expired" };
  }
  if (row.client_id !== input.clientId) return { ok: false, error: "invalid-client" };
  if (row.redirect_uri !== input.redirectUri) {
    return { ok: false, error: "invalid-redirect-uri" };
  }
  if (row.resource !== input.resource) return { ok: false, error: "invalid-resource" };
  if (!pkceMatches(row.code_challenge, input.codeVerifier)) {
    return { ok: false, error: "invalid-pkce" };
  }
  if (!row.credential_id) return { ok: false, error: "invalid-selection" };
  const credentialId = row.credential_id;

  return db.transaction((): AccessMutationResult<OAuthTokenSet> => {
    const credential = db
      .prepare<
        [string, string],
        {
          id: string;
          grant_id: string;
          oauth_client_id: string;
          status: "pending" | "active";
          expires_at: number | null;
          revoked_at: number | null;
        }
      >(
        `SELECT id, grant_id, oauth_client_id, status, expires_at, revoked_at
         FROM principal_credentials WHERE id = ? AND oauth_client_id = ?`,
      )
      .get(credentialId, row.client_id);
    if (
      !credential ||
      credential.status !== "pending" ||
      credential.revoked_at !== null ||
      (credential.expires_at !== null && credential.expires_at <= now)
    ) {
      return { ok: false, error: "inactive-grant" };
    }
    const grant = getActiveGrant(db, credential.grant_id, now);
    if (!grant || grant.principal_kind !== "interactive") {
      return { ok: false, error: "inactive-grant" };
    }
    const claimed = db
      .prepare(
        `UPDATE oauth_authorization_requests
         SET status = 'complete', authorization_code_consumed_at = ?
         WHERE id = ? AND status = 'code-issued' AND authorization_code_consumed_at IS NULL`,
      )
      .run(now, row.id);
    if (claimed.changes !== 1) return { ok: false, error: "invalid-code" };
    const activated = db
      .prepare(
        "UPDATE principal_credentials SET status = 'active' WHERE id = ? AND status = 'pending'",
      )
      .run(credential.id);
    if (activated.changes !== 1) return { ok: false, error: "invalid-code" };
    const selection = parseSelection(row.selection_json);
    if (selection?.kind === "existing-grant" && selection.replaces === true) {
      retireReplacedSignIns(db, { grant, credentialId: credential.id, row, now });
    }
    const tokens = issueTokenPair(db, {
      credentialId: credential.id,
      grantRevision: grant.revision,
      audience: row.resource,
      scope: row.scope,
      authorityExpiresAt: credential.expires_at,
      // OAuth 2.0 leaves refresh-token issuance to the authorization server.
      // MCP clients such as ChatGPT register the refresh_token grant but request
      // only the protected resource's challenged scope. Requiring the optional
      // OIDC-style offline_access hint would strand them after the short-lived
      // access token expires.
      includeRefreshToken: client.grantTypes.includes("refresh_token"),
      now,
    });
    appendAudit(db, {
      eventType: "credential-issued",
      principalId: grant.principal_id,
      grantId: grant.id,
      grantRevision: grant.revision,
      credentialId: credential.id,
      oauthClientId: row.client_id,
      actorTokenId: row.decision_token_id,
      detail: { authorizationRequestId: row.id, kind: "interactive" },
      now,
    });
    return { ok: true, value: tokens };
  })();
}
