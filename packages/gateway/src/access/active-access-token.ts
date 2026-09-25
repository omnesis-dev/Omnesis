// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What makes an OAuth access token row live.
 *
 * Revocation is enforced by the join, not by the row: revoking a device, a
 * credential, a grant or a principal marks that row and leaves every access
 * token minted under it untouched (a test holds the store to that). A token
 * is therefore live only in the company of its credential, the device that
 * credential executes on, its grant at the revision the token was minted
 * at, and its principal — all of them unrevoked and unexpired. A query that
 * reads `oauth_access_tokens` for authority without these joins silently
 * outlives every revocation above it.
 *
 * This predicate is the one statement of that rule. Every authority read of
 * the table spells its joins with the aliases below and appends this; a
 * guard test lists the few reads that legitimately do not decide authority
 * (minting, expiry cleanup, resolving a hash to its credential) and fails on
 * any other.
 */

export interface ActiveAccessTokenAliases {
  /** `oauth_access_tokens` */
  token: string;
  /** `principal_credentials`, joined on the token's `credential_id` */
  credential: string;
  /** `access_grants`, joined on the credential's `grant_id` */
  grant: string;
  /** `access_principals`, joined on the grant's `principal_id` */
  principal: string;
}

export const ACTIVE_ACCESS_TOKEN_ALIASES: ActiveAccessTokenAliases = {
  token: "t",
  credential: "c",
  grant: "g",
  principal: "p",
};

/** The name of the bound parameter carrying the clock, in milliseconds. */
const ACTIVE_ACCESS_TOKEN_NOW_PARAM = "@now";

/**
 * The conjunction that keeps a token row live, over the four joined tables.
 * Bind the clock as `@now`; every other condition is on the joined rows.
 */
export function activeAccessTokenPredicate(
  aliases: ActiveAccessTokenAliases = ACTIVE_ACCESS_TOKEN_ALIASES,
): string {
  const { token: t, credential: c, grant: g, principal: p } = aliases;
  const now = ACTIVE_ACCESS_TOKEN_NOW_PARAM;
  return [
    `${t}.revoked_at IS NULL AND ${t}.expires_at > ${now}`,
    `${c}.status = 'active' AND ${c}.revoked_at IS NULL`,
    // A credential bound to a device is only as trusted as that device.
    `(${c}.execution_device_id IS NULL OR EXISTS (
       SELECT 1 FROM devices d WHERE d.id = ${c}.execution_device_id AND d.revoked_at IS NULL
     ))`,
    `(${c}.expires_at IS NULL OR ${c}.expires_at > ${now})`,
    `${g}.revoked_at IS NULL AND (${g}.expires_at IS NULL OR ${g}.expires_at > ${now})`,
    `${p}.revoked_at IS NULL`,
    // A grant revised since the token was minted has moved its authority on.
    `${g}.revision = ${t}.grant_revision`,
  ].join("\n         AND ");
}
