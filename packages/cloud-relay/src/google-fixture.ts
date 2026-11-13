// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/** Origins of the APIs the relay calls itself at Google; a fixture serves their paths unchanged. */
const GOOGLE_API_ORIGINS = new Set([
  "https://oauth2.googleapis.com",
  "https://cloudidentity.googleapis.com",
]);

export interface GoogleFixture {
  authorizationEndpoint: string;
  keys: JWTVerifyGetKey;
  fetch: typeof fetch;
}

/**
 * Test-only: one loopback server stands in for Google's sign-in, token, signing-key and Cloud
 * Identity endpoints, so end-to-end tests can sign in without Google. A synthetic relay on a
 * loopback listener only, like the DNS fixture.
 */
export function googleFixture(
  value: string | undefined,
  bind: string,
  synthetic: boolean,
): GoogleFixture | undefined {
  if (value === undefined) return undefined;
  if (!synthetic || (bind !== "127.0.0.1" && bind !== "::1"))
    throw new Error("A Google fixture requires a synthetic relay on a loopback listener");
  const base = new URL(value);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("A Google fixture must be a loopback http origin");
  const origin = base.origin;
  return {
    authorizationEndpoint: `${origin}/o/oauth2/v2/auth`,
    keys: createRemoteJWKSet(new URL(`${origin}/oauth2/v3/certs`)),
    fetch: (input, init) => {
      if (typeof input !== "string" && !(input instanceof URL))
        throw new Error("This fixture takes a URL");
      const url = new URL(input);
      if (!GOOGLE_API_ORIGINS.has(url.origin))
        throw new Error("This fixture serves only Google's API origins");
      return fetch(`${origin}${url.pathname}${url.search}`, init);
    },
  };
}
