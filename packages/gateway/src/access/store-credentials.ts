// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";

import { activeAccessTokenPredicate } from "./active-access-token.js";
import { getOAuthClient, oauthClientAuthenticates } from "./store-clients.js";
import { appendAudit, getActiveCredential, hashSecret, issueTokenPair } from "./store-helpers.js";
import { parseStringArray } from "./store-rules.js";
import type {
  AccessCapability,
  AccessGrantCapability,
  OAuthTokenSet,
  PrincipalAccessTokenInfo,
} from "./types.js";
import type { AccessMutationResult } from "./store-contracts.js";
import type { Db } from "../data/types.js";

const REFRESH_RETRY_GRACE_MS = 60_000;
const GCM_TAG_BYTES = 16;

/** Resolve the immutable audience bound to an opaque refresh token. */
export function getRefreshTokenAudience(db: Db, refreshToken: string): string | null {
  return (
    db
      .prepare<
        [string],
        { audience: string }
      >("SELECT audience FROM oauth_refresh_tokens WHERE token_hash = ?")
      .get(hashSecret(refreshToken))?.audience ?? null
  );
}

export function refreshPrincipalAccessToken(
  db: Db,
  input: { refreshToken: string; clientId: string; clientSecret?: string; resource?: string },
  now = Date.now(),
): AccessMutationResult<OAuthTokenSet> {
  if (!oauthClientAuthenticates(db, input.clientId, input.clientSecret)) {
    return { ok: false, error: "invalid-client" };
  }
  return db.transaction((): AccessMutationResult<OAuthTokenSet> => {
    const row = db
      .prepare<
        [string],
        {
          id: string;
          credential_id: string;
          family_id: string;
          generation: number;
          audience: string;
          scope: string;
          expires_at: number;
          used_at: number | null;
          revoked_at: number | null;
          replacement_ciphertext: string | null;
          retry_until: number | null;
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
    if (row.used_at !== null) {
      if (
        row.replacement_ciphertext !== null &&
        row.retry_until !== null &&
        row.retry_until >= now
      ) {
        const retried = decryptRefreshReplacement(
          row.replacement_ciphertext,
          input.refreshToken,
          row.id,
        );
        if (!retried) return { ok: false, error: "invalid-grant" };
        const replacement = db
          .prepare<
            [string],
            { expires_at: number }
          >("SELECT expires_at FROM oauth_access_tokens WHERE token_hash = ?")
          .get(hashSecret(retried.accessToken));
        if (!replacement) return { ok: false, error: "invalid-grant" };
        return {
          ok: true,
          value: {
            ...retried,
            expiresIn: Math.max(0, Math.floor((replacement.expires_at - now) / 1000)),
          },
        };
      }
      revokeCompromisedRefreshFamily(db, row, active, now);
      return { ok: false, error: "invalid-grant" };
    }
    if (row.revoked_at !== null) return { ok: false, error: "invalid-grant" };
    db.prepare(
      `UPDATE oauth_refresh_tokens
          SET replacement_ciphertext = NULL, retry_until = NULL
        WHERE family_id = ? AND generation < ?`,
    ).run(row.family_id, row.generation);
    const consumed = db
      .prepare(
        `UPDATE oauth_refresh_tokens SET used_at = ?, revoked_at = ?
         WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now, now, row.id);
    if (consumed.changes !== 1) {
      revokeCompromisedRefreshFamily(db, row, active, now);
      return { ok: false, error: "invalid-grant" };
    }
    const tokens = issueTokenPair(db, {
      credentialId: active.credential_id,
      grantRevision: active.grant_revision,
      audience: row.audience,
      scope: row.scope,
      familyId: row.family_id,
      generation: row.generation + 1,
      authorityExpiresAt: earlierExpiry(active.credential_expires_at, active.grant_expires_at),
      now,
    });
    db.prepare(
      `UPDATE oauth_refresh_tokens
          SET replacement_ciphertext = ?, retry_until = ?
        WHERE id = ?`,
    ).run(
      encryptRefreshReplacement(tokens, input.refreshToken, row.id),
      now + REFRESH_RETRY_GRACE_MS,
      row.id,
    );
    appendAudit(db, {
      eventType: "access-token-refreshed",
      principalId: active.principal_id,
      grantId: active.grant_id,
      grantRevision: active.grant_revision,
      credentialId: active.credential_id,
      oauthClientId: active.oauth_client_id,
      detail: { refreshGeneration: row.generation + 1 },
      now,
    });
    return { ok: true, value: tokens };
  })();
}

function earlierExpiry(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.min(first, second);
}

export function lookupPrincipalAccessToken(
  db: Db,
  rawToken: string,
  audience: string,
  now = Date.now(),
): PrincipalAccessTokenInfo | null {
  // Resolve the token, credential, grant revision, principal, and capability
  // rows in one SQLite statement.  Separate autocommit reads are unsafe here:
  // a writer could revise the grant after the revision check but before the
  // capability read, allowing a stale token to inherit newly-added authority
  // for one request.
  const rows = db
    .prepare<
      { hash: string; now: number; audience: string },
      {
        access_token_id: string;
        credential_id: string;
        oauth_client_id: string;
        execution_device_id: string | null;
        principal_id: string;
        principal_name: string;
        grant_id: string;
        audience: string;
        scope: string;
        grant_revision: number;
        expires_at: number;
        capability: AccessCapability;
        source_mode: "all" | "allowlist" | "denylist";
        source_ids: string;
        release_mode: "reviewed" | "unreviewed" | null;
        policy_family_id: string | null;
        policy_revision: string | null;
        policy_archived_at: number | null;
      }
    >(
      `SELECT
         t.id AS access_token_id, t.audience, t.scope,
         t.grant_revision, t.expires_at,
         c.id AS credential_id, c.oauth_client_id, c.execution_device_id,
         g.id AS grant_id, p.id AS principal_id, p.name AS principal_name,
         cap.capability, cap.source_mode, cap.source_ids,
         cap.release_mode, cap.policy_family_id,
         ps.revision AS policy_revision, pf.archived_at AS policy_archived_at
       FROM oauth_access_tokens t
       JOIN principal_credentials c ON c.id = t.credential_id
       JOIN access_grants g ON g.id = c.grant_id
       JOIN access_principals p ON p.id = g.principal_id
       JOIN access_grant_capabilities cap ON cap.grant_id = g.id
       LEFT JOIN privacy_policy_state ps ON ps.family_id = cap.policy_family_id
       LEFT JOIN privacy_policy_families pf ON pf.id = cap.policy_family_id
       WHERE t.token_hash = @hash AND t.audience = @audience
         AND ${activeAccessTokenPredicate()}
       ORDER BY cap.capability`,
    )
    .all({ hash: hashSecret(rawToken), now, audience });
  const first = rows[0];
  if (!first) return null;
  const capabilities: AccessGrantCapability[] = [];
  for (const row of rows) {
    const sourceIds = parseStringArray(row.source_ids);
    if (
      sourceIds === null ||
      (row.source_mode === "all" && sourceIds.length !== 0) ||
      (row.capability === "notes" && (row.source_mode !== "all" || sourceIds.length !== 0)) ||
      (row.capability !== "answer"
        ? row.release_mode !== null || row.policy_family_id !== null
        : !(
            (row.release_mode === "unreviewed" && row.policy_family_id === null) ||
            (row.release_mode === "reviewed" &&
              row.policy_family_id !== null &&
              row.policy_revision !== null &&
              row.policy_archived_at === null)
          ))
    ) {
      return null;
    }
    capabilities.push({
      capability: row.capability,
      sourceMode: row.source_mode,
      sourceIds,
      releaseMode: row.release_mode,
      policyFamilyId: row.policy_family_id,
      policyRevision: row.policy_revision,
      privacyPolicy:
        row.policy_family_id === DEFAULT_PRIVACY_POLICY_FAMILY_ID
          ? "default"
          : row.policy_family_id,
    });
  }
  return {
    accessTokenId: first.access_token_id,
    principalId: first.principal_id,
    principalName: first.principal_name,
    grantId: first.grant_id,
    grantRevision: first.grant_revision,
    credentialId: first.credential_id,
    oauthClientId: first.oauth_client_id,
    executionDeviceId: first.execution_device_id,
    capabilities,
    audience: first.audience,
    scopes: first.scope.split(/\s+/).filter(Boolean),
    expiresAt: first.expires_at,
  };
}

export function touchPrincipalCredentialUsageBatch(
  db: Db,
  rows: ReadonlyArray<{ credentialId: string; observedAt: number }>,
  now = Date.now(),
): void {
  if (rows.length === 0) return;
  const update = db.prepare(
    `UPDATE principal_credentials SET last_used_at = ?
     WHERE id = ?
       AND (last_used_at IS NULL OR last_used_at < ?)
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND EXISTS (
         SELECT 1
         FROM access_grants g
         JOIN access_principals p ON p.id = g.principal_id
         WHERE g.id = principal_credentials.grant_id
           AND g.revoked_at IS NULL
           AND (g.expires_at IS NULL OR g.expires_at > ?)
           AND p.revoked_at IS NULL
       )`,
  );
  db.transaction(() => {
    for (const row of rows.slice(0, 500)) {
      update.run(row.observedAt, row.credentialId, row.observedAt, now, now);
    }
  })();
}

function revokeCompromisedRefreshFamily(
  db: Db,
  row: { credential_id: string; family_id: string; generation: number },
  active: NonNullable<ReturnType<typeof getActiveCredential>>,
  now: number,
): void {
  const fenced = db
    .prepare(
      `UPDATE oauth_refresh_tokens
          SET revoked_at = COALESCE(revoked_at, ?),
              replacement_ciphertext = NULL, retry_until = NULL
       WHERE family_id = ? AND EXISTS (
         SELECT 1 FROM oauth_refresh_tokens active
         WHERE active.family_id = ? AND active.revoked_at IS NULL
       )`,
    )
    .run(now, row.family_id, row.family_id);
  if (fenced.changes === 0) return;
  appendAudit(db, {
    eventType: "refresh-token-replay-detected",
    principalId: active.principal_id,
    grantId: active.grant_id,
    grantRevision: active.grant_revision,
    credentialId: row.credential_id,
    oauthClientId: active.oauth_client_id,
    detail: { refreshGeneration: row.generation },
    now,
  });
}

/**
 * Re-key the OAuth credential an agent device already holds, on the strength
 * of that device's own management token.
 *
 * This exists because the refresh token is the only thing standing between a
 * quiet harness and a dead Answer path: it rotates on use, expires on a timer,
 * and the browser redirect that would replace it is something no unattended
 * plugin can perform. So the device asks with the authority it does have.
 *
 * It cannot become a way to obtain authority the operator never granted. The
 * statement below only *finds* a credential — one already created by an
 * approved authorization request, already bound to this exact device by the
 * execution binding, and still active. It never creates a principal, a grant,
 * or a credential, and it copies the approved audience and scope off that
 * request rather than accepting them from the caller. Revoke the grant and
 * there is nothing left to find.
 *
 * It leaves the credential's existing refresh tokens alone, which matters more
 * than it looks. Recovery normally runs because the old ticket is already
 * dead, but it also runs when the plugin never saw the reply to a previous
 * one — and in that case the plugin still holds a perfectly good token. Each
 * `issueTokenPair` starts its own family, so an untouched older family is not
 * a reuse of this one. Retiring it is what would do damage: the refresh grant
 * treats a token that is revoked or already used as a stolen-token replay and
 * revokes the whole credential, so the plugin's next ordinary refresh would
 * strand the harness on the browser flow this route exists to avoid.
 */
export function reissueExecutionDeviceTokens(
  db: Db,
  input: { deviceId: string; oauthClientId: string },
  now = Date.now(),
): AccessMutationResult<OAuthTokenSet> {
  const row = db
    .prepare<[string, string, number], { credential_id: string; resource: string; scope: string }>(
      `SELECT c.id AS credential_id, ar.resource, ar.scope
       FROM principal_credentials c
       JOIN devices d ON d.id = c.execution_device_id
       JOIN oauth_authorization_requests ar ON ar.credential_id = c.id
       WHERE c.execution_device_id = ? AND c.oauth_client_id = ?
         AND c.kind = 'interactive' AND c.status = 'active' AND c.revoked_at IS NULL
         AND (c.expires_at IS NULL OR c.expires_at > ?)
         AND d.kind = 'agent' AND d.revoked_at IS NULL
         AND json_extract(d.capabilities, '$.agentIntegration.harness') IS NOT NULL
       ORDER BY c.created_at DESC
       LIMIT 1`,
    )
    .get(input.deviceId, input.oauthClientId, now);
  if (!row) return { ok: false, error: "not-found" };

  return db.transaction((): AccessMutationResult<OAuthTokenSet> => {
    const active = getActiveCredential(db, row.credential_id, now);
    if (!active) return { ok: false, error: "inactive-grant" };
    // `getActiveCredential` re-proves the grant, principal and credential, but
    // not the device. Unpairing a harness revokes its tokens rather than the
    // Access Grant behind them, so a device revoked between the lookup above
    // and this transaction would otherwise still be handed a fresh pair.
    const device = db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM devices WHERE id = ? AND kind = 'agent' AND revoked_at IS NULL")
      .get(input.deviceId);
    if (!device) return { ok: false, error: "not-found" };
    const client = getOAuthClient(db, active.oauth_client_id);
    if (!client) return { ok: false, error: "invalid-client" };
    const tokens = issueTokenPair(db, {
      credentialId: active.credential_id,
      grantRevision: active.grant_revision,
      audience: row.resource,
      scope: row.scope,
      authorityExpiresAt: earlierExpiry(active.credential_expires_at, active.grant_expires_at),
      // Honour what the client registered for, exactly as the authorization-code
      // exchange does. A client that never asked for the refresh grant does not
      // acquire one by taking the recovery route.
      includeRefreshToken: client.grantTypes.includes("refresh_token"),
      now,
    });
    appendAudit(db, {
      eventType: "execution-credential-reissued",
      principalId: active.principal_id,
      grantId: active.grant_id,
      grantRevision: active.grant_revision,
      credentialId: active.credential_id,
      oauthClientId: active.oauth_client_id,
      detail: { executionDeviceId: input.deviceId },
      now,
    });
    return { ok: true, value: tokens };
  })();
}

function refreshRetryKey(refreshToken: string): Buffer {
  return createHash("sha256")
    .update("omnesis-oauth-refresh-retry\0", "utf8")
    .update(refreshToken, "utf8")
    .digest();
}

function encryptRefreshReplacement(
  tokens: OAuthTokenSet,
  refreshToken: string,
  tokenId: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", refreshRetryKey(refreshToken), nonce);
  cipher.setAAD(Buffer.from(tokenId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext]
    .map((value) => value.toString("base64url"))
    .join(".");
}

function decryptRefreshReplacement(
  sealed: string,
  refreshToken: string,
  tokenId: string,
): OAuthTokenSet | null {
  try {
    const [nonceEncoded, tagEncoded, ciphertextEncoded, extra] = sealed.split(".");
    if (!nonceEncoded || !tagEncoded || !ciphertextEncoded || extra !== undefined) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      refreshRetryKey(refreshToken),
      Buffer.from(nonceEncoded, "base64url"),
      { authTagLength: GCM_TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(tokenId, "utf8"));
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<OAuthTokenSet>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      parsed.tokenType !== "Bearer" ||
      typeof parsed.expiresIn !== "number" ||
      typeof parsed.scope !== "string"
    ) {
      return null;
    }
    return parsed as OAuthTokenSet;
  } catch {
    return null;
  }
}
