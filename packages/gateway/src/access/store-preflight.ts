// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";

import { oauthClientAuthenticates } from "./store-clients.js";
import {
  type AuthorizationRequestRow,
  getActiveCredential,
  hashSecret,
  parseSelection,
  pkceMatches,
  selectionIsUsable,
} from "./store-helpers.js";
import type { Db } from "../data/types.js";
import type { AccessMutationResult } from "./store-contracts.js";
import type { OAuthTokenExchangeInput, AccessRevocationInput } from "./types.js";

export type OAuthRevocationPreflight =
  | { ok: true }
  | { ok: false; error: "invalid-client" | "not-found" };

/** Authenticate a token's owning client before scheduling its writer-side revocation. */
export function preflightOAuthTokenRevocation(
  db: Db,
  input: Extract<AccessRevocationInput, { kind: "token" }>,
): OAuthRevocationPreflight {
  const tokenHash = hashSecret(input.token);
  const row = db
    .prepare<[string, string], { oauth_client_id: string }>(
      `SELECT c.oauth_client_id
       FROM principal_credentials c
       WHERE c.id = COALESCE(
         (SELECT credential_id FROM oauth_access_tokens WHERE token_hash = ?),
         (SELECT credential_id FROM oauth_refresh_tokens WHERE token_hash = ?)
       )`,
    )
    .get(tokenHash, tokenHash);
  if (!row) return { ok: false, error: "not-found" };
  if (row.oauth_client_id !== input.clientId) return { ok: false, error: "invalid-client" };
  if (!oauthClientAuthenticates(db, row.oauth_client_id, input)) {
    return { ok: false, error: "invalid-client" };
  }
  return { ok: true };
}

/**
 * Reject token requests that cannot possibly mutate state before they enter
 * the gateway's single writer queue. The writer repeats every authority and
 * one-use check before issuing anything; this read-side pass is admission, not
 * the security linearization point.
 *
 * The first known refresh-token replay is admitted because replay handling
 * must fence that credential durably. Once fenced, repeats are rejected here
 * and never consume writer capacity.
 */
export function preflightOAuthTokenExchange(
  db: Db,
  input: OAuthTokenExchangeInput,
  now = Date.now(),
): AccessMutationResult<null> {
  switch (input.grantType) {
    case "authorization_code":
      return preflightAuthorizationCode(db, input, now);
    case "refresh_token":
      return preflightRefreshToken(db, input, now);
    default:
      return assertNever(input);
  }
}

function preflightAuthorizationCode(
  db: Db,
  input: Extract<OAuthTokenExchangeInput, { grantType: "authorization_code" }>,
  now: number,
): AccessMutationResult<null> {
  if (!oauthClientAuthenticates(db, input.clientId, input)) {
    return { ok: false, error: "invalid-client" };
  }
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
  const selection = parseSelection(row.selection_json);
  if (!selection) return { ok: false, error: "invalid-selection" };
  if (!selectionIsUsable(db, selection, now)) return { ok: false, error: "inactive-grant" };
  return { ok: true, value: null };
}

function preflightRefreshToken(
  db: Db,
  input: Extract<OAuthTokenExchangeInput, { grantType: "refresh_token" }>,
  now: number,
): AccessMutationResult<null> {
  if (!oauthClientAuthenticates(db, input.clientId, input)) {
    return { ok: false, error: "invalid-client" };
  }
  const row = db
    .prepare<
      [string],
      {
        credential_id: string;
        family_id: string;
        audience: string;
        expires_at: number;
        used_at: number | null;
        revoked_at: number | null;
        retry_until: number | null;
        replacement_ciphertext: string | null;
      }
    >("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?")
    .get(hashSecret(input.refreshToken));
  if (!row) return { ok: false, error: "invalid-grant" };
  if (row.expires_at <= now) return { ok: false, error: "expired" };
  if (input.resource !== undefined && row.audience !== input.resource) {
    return { ok: false, error: "invalid-resource" };
  }
  const active = getActiveCredential(db, row.credential_id, now);
  if (!active) return { ok: false, error: "invalid-grant" };
  if (active.oauth_client_id !== input.clientId) return { ok: false, error: "invalid-client" };
  // A retry inside the short idempotency window must reach the writer so it
  // can return the encrypted prior response. Outside it, exactly one writer
  // transaction fences the refresh family and records the replay.
  if (row.used_at !== null) {
    if (row.replacement_ciphertext !== null && row.retry_until !== null && now <= row.retry_until) {
      return { ok: true, value: null };
    }
    const familyActive = db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM oauth_refresh_tokens WHERE family_id = ? AND revoked_at IS NULL LIMIT 1")
      .get(row.family_id);
    return familyActive ? { ok: true, value: null } : { ok: false, error: "invalid-grant" };
  }
  if (row.revoked_at !== null) return { ok: false, error: "invalid-grant" };
  return { ok: true, value: null };
}

/**
 * Is there anything for `reissueExecutionDeviceTokens` to re-key?
 *
 * Read on the reader so a refusal — which is every call from a device whose
 * grant the operator revoked, and every call from anyone who guessed a device
 * id — costs nothing on the single writer thread. Deliberately the same
 * predicate the writer uses, so this can only ever decline work the writer
 * would also have declined; the writer re-proves all of it inside its
 * transaction regardless.
 */
export function preflightExecutionTokensReissue(
  db: Db,
  input: { deviceId: string; oauthClientId: string },
  now = Date.now(),
): boolean {
  return (
    db
      .prepare<[string, string, number], { present: number }>(
        `SELECT 1 AS present
         FROM principal_credentials c
         JOIN devices d ON d.id = c.execution_device_id
         JOIN oauth_authorization_requests ar ON ar.credential_id = c.id
         WHERE c.execution_device_id = ? AND c.oauth_client_id = ?
           AND c.kind = 'interactive' AND c.status = 'active' AND c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR c.expires_at > ?)
           AND d.kind = 'agent' AND d.revoked_at IS NULL
           AND json_extract(d.capabilities, '$.agentIntegration.harness') IS NOT NULL
         LIMIT 1`,
      )
      .get(input.deviceId, input.oauthClientId, now) !== undefined
  );
}
