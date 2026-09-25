// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import {
  createAuthorizationRequest,
  decideAuthorizationRequest,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  registerOAuthClient,
} from "./store.js";
import type { Db } from "../data/types.js";
import type { AuthorizationDecisionSelection, OAuthTokenSet } from "./types.js";

export const TEST_OAUTH_REDIRECT = "http://127.0.0.1:48123/callback";
export const TEST_OAUTH_VERIFIER = "v".repeat(64);

export interface InteractiveAccessFixture {
  clientId: string;
  principalId: string;
  grantId: string;
  credentialId: string;
  tokens: OAuthTokenSet;
}

/**
 * Walk one client through the whole interactive flow at the store level —
 * register it, start an authorization request, approve it with `selection`,
 * issue the code and exchange it for a bearer — and hand back the identities
 * that flow created together with the tokens. This is the only way access is
 * granted, so a test that needs "some authorized principal" starts here.
 *
 * The steps advance the clock by fixed offsets from `now` (+10 approval, +11
 * code, +12 exchange), so callers stamping later events pick larger offsets.
 */
export function authorizeInteractiveAccess(
  db: Db,
  input: {
    selection: AuthorizationDecisionSelection;
    resource: string;
    scope: string;
    clientId?: string;
    /** The registered secret when `clientId` names a `client_secret_basic` client. */
    clientSecret?: string;
    now?: number;
  },
): InteractiveAccessFixture {
  const now = input.now ?? Date.now();
  const clientId =
    input.clientId ??
    registerOAuthClient(
      db,
      {
        clientName: "Stellar MCP Client",
        redirectUris: [TEST_OAUTH_REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        clientUri: "https://example.com/client",
      },
      now,
    ).clientId;
  const pending = createAuthorizationRequest(
    db,
    {
      clientId,
      redirectUri: TEST_OAUTH_REDIRECT,
      state: "state-123",
      codeChallenge: createHash("sha256").update(TEST_OAUTH_VERIFIER).digest("base64url"),
      resource: input.resource,
      scope: input.scope,
    },
    now,
  );
  if (!pending.ok) throw new Error(`authorization request failed: ${pending.error}`);
  const decided = decideAuthorizationRequest(
    db,
    {
      approvalId: pending.value.id,
      decision: "approve",
      selection: input.selection,
      actorTokenId: "portal-token",
    },
    now + 10,
  );
  if (!decided.ok) throw new Error(`approval failed: ${decided.error}`);
  const issued = issueAuthorizationCode(db, pending.value.browserHandle, now + 11);
  if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");
  const exchanged = exchangeAuthorizationCode(
    db,
    {
      code: issued.value.code,
      clientId,
      ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
      redirectUri: TEST_OAUTH_REDIRECT,
      codeVerifier: TEST_OAUTH_VERIFIER,
      resource: input.resource,
    },
    now + 12,
  );
  if (!exchanged.ok) throw new Error(`exchange failed: ${exchanged.error}`);
  const identity = db
    .prepare<[string], { credential_id: string; grant_id: string; principal_id: string }>(
      `SELECT c.id AS credential_id, g.id AS grant_id, g.principal_id
       FROM oauth_authorization_requests r
       JOIN principal_credentials c ON c.id = r.credential_id
       JOIN access_grants g ON g.id = c.grant_id
       WHERE r.id = ?`,
    )
    .get(pending.value.id);
  if (!identity) throw new Error("the approved request left no credential behind");
  return {
    clientId,
    principalId: identity.principal_id,
    grantId: identity.grant_id,
    credentialId: identity.credential_id,
    tokens: exchanged.value,
  };
}
