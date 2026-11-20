// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { decodeJwt } from "jose";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Google compares addresses without case; anything else is not an address. */
export function normalizeGoogleEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) && !/\p{Cc}/u.test(email)
    ? email
    : undefined;
}

/**
 * The address a Google ID token vouches for, or nothing when Google did not verify it. Call it only
 * with a token the identity provider has already verified: this reads the claims, it checks nothing.
 */
export function verifiedGoogleEmail(idToken: string): string | undefined {
  let claims;
  try {
    claims = decodeJwt(idToken);
  } catch {
    return undefined;
  }
  return claims.email_verified === true && typeof claims.email === "string"
    ? normalizeGoogleEmail(claims.email)
    : undefined;
}
