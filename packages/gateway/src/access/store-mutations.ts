// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";

import { exchangeAuthorizationCode } from "./store-authorization.js";
import { refreshPrincipalAccessToken } from "./store-credentials.js";
import {
  revokeAccessGrant,
  revokeAccessPrincipal,
  revokeOAuthToken,
  removeConnection,
  removeProfile,
  revokePrincipalCredential,
} from "./store-management.js";
import type { Db } from "../data/types.js";
import type { AccessMutationResult } from "./store-contracts.js";
import type { AccessRevocationInput, OAuthTokenExchangeInput, OAuthTokenSet } from "./types.js";

export function exchangeOAuthToken(
  db: Db,
  input: OAuthTokenExchangeInput,
  now = Date.now(),
): AccessMutationResult<OAuthTokenSet> {
  switch (input.grantType) {
    case "authorization_code":
      return exchangeAuthorizationCode(db, input, now);
    case "refresh_token":
      return refreshPrincipalAccessToken(db, input, now);
    default:
      return assertNever(input);
  }
}

export function revokeAccessEntity(
  db: Db,
  input: AccessRevocationInput,
  now = Date.now(),
): boolean {
  switch (input.kind) {
    case "credential":
      return revokePrincipalCredential(db, input.id, input.actorTokenId, now);
    case "connection":
      return removeConnection(db, input.id, input.actorTokenId, now);
    case "profile":
      return removeProfile(db, input.id, input.actorTokenId, now);
    case "grant":
      return revokeAccessGrant(db, input.id, input.actorTokenId, now);
    case "principal":
      return revokeAccessPrincipal(db, input.id, input.actorTokenId, now);
    case "token":
      return revokeOAuthToken(db, input.token, input.clientId, input.clientSecret, now);
    default:
      return assertNever(input);
  }
}
