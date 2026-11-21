// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { tokenAnswerOwnerId } from "../privacy/token-answer-owner.js";
import { activeAccessTokenPredicate } from "./active-access-token.js";
import { currentDeviceAnswerOwner } from "./device-answer-scope.js";
import { createCorpusAuthorization, answerOwnerScopeDigest } from "./corpus-authorization.js";
import { getGrantCapabilities } from "./store-rules.js";
import type { CorpusAuthorization } from "./corpus-authorization.js";
import type { Db } from "../data/types.js";

/** Repeat live identity checks in the final synchronous disclosure snapshot. */
export function corpusAuthorizationIsLive(
  db: Db,
  authorization: CorpusAuthorization,
  now = Date.now(),
): boolean {
  if (authorization.principalId.startsWith("device:")) {
    return (
      currentDeviceAnswerOwner(
        db,
        authorization.principalId.slice("device:".length),
        authorization.accessTokenId,
      ) === tokenAnswerOwnerId(authorization.accessTokenId, authorization)
    );
  }
  return !!db
    .prepare(
      `SELECT 1 FROM oauth_access_tokens t
    JOIN principal_credentials c ON c.id=t.credential_id
    JOIN access_grants g ON g.id=c.grant_id
    JOIN access_principals p ON p.id=g.principal_id
    JOIN access_grant_capabilities cap ON cap.grant_id=g.id AND cap.capability=@capability
    LEFT JOIN privacy_policy_state ps ON ps.family_id=cap.policy_family_id
    LEFT JOIN privacy_policy_families pf ON pf.id=cap.policy_family_id
    WHERE t.id=@accessTokenId AND c.id=@credentialId AND g.id=@grantId
      AND p.id=@principalId AND g.revision=@grantRevision
      AND cap.release_mode IS @releaseMode AND cap.policy_family_id IS @policyFamilyId
      AND (cap.release_mode IS NOT 'reviewed' OR (ps.revision IS NOT NULL AND pf.archived_at IS NULL))
      AND ${activeAccessTokenPredicate()}`,
    )
    .get({
      capability: authorization.capability,
      accessTokenId: authorization.accessTokenId,
      credentialId: authorization.credentialId,
      grantId: authorization.grantId,
      principalId: authorization.principalId,
      grantRevision: authorization.grantRevision,
      releaseMode: authorization.releaseMode,
      policyFamilyId: authorization.policyFamilyId,
      now,
    });
}

/** Task ownership survives bearer rotation and revisions that leave the owner scope unchanged. */
export function corpusAuthorizationBindingIsLive(
  db: Db,
  authorization: CorpusAuthorization,
  now = Date.now(),
): boolean {
  if (authorization.principalId.startsWith("device:"))
    return (
      currentDeviceAnswerOwner(
        db,
        authorization.principalId.slice(7),
        authorization.accessTokenId,
      ) === tokenAnswerOwnerId(authorization.accessTokenId, authorization)
    );
  const row = db
    .prepare<[string, string, string, number, number, string], { revision: number }>(
      `SELECT g.revision FROM principal_credentials c JOIN access_grants g ON g.id=c.grant_id
      JOIN access_principals p ON p.id=g.principal_id
      WHERE c.id=? AND g.id=? AND p.id=? AND c.status='active' AND c.revoked_at IS NULL
        AND p.revoked_at IS NULL AND g.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)
        AND (g.expires_at IS NULL OR g.expires_at>?)
        AND EXISTS (SELECT 1 FROM access_grant_capabilities cap WHERE cap.grant_id=g.id AND cap.capability=?
          AND (cap.release_mode IS NOT 'reviewed' OR EXISTS(SELECT 1 FROM privacy_policy_state ps JOIN privacy_policy_families pf ON pf.id=ps.family_id WHERE ps.family_id=cap.policy_family_id AND pf.archived_at IS NULL)))
        AND (c.execution_device_id IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.id=c.execution_device_id AND d.revoked_at IS NULL))`,
    )
    .get(
      authorization.credentialId,
      authorization.grantId,
      authorization.principalId,
      now,
      now,
      authorization.capability,
    );
  if (!row) return false;
  const current = createCorpusAuthorization(
    { ...authorization, grantRevision: row.revision },
    getGrantCapabilities(db, authorization.grantId),
    authorization.capability,
  );
  return !!current && answerOwnerScopeDigest(current) === answerOwnerScopeDigest(authorization);
}
