// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";

import { hashSecret, secretHashMatches } from "./store-helpers.js";
import { parseStringArray } from "./store-rules.js";
import type { Db } from "../data/types.js";
import type {
  ClientAssertionAlgorithm,
  OAuthClientAuthMethod,
  OAuthClientCredentials,
  OAuthClientMetadataDocument,
  OAuthClientRegistration,
  OAuthClientRegistrationInput,
} from "./types.js";

export function registerOAuthClient(
  db: Db,
  input: OAuthClientRegistrationInput,
  now = Date.now(),
): OAuthClientRegistration {
  const clientId = `omn_oc_${randomBytes(18).toString("base64url")}`;
  const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? "none";
  const clientSecret =
    tokenEndpointAuthMethod === "client_secret_basic"
      ? `omn_ocs_${randomBytes(32).toString("base64url")}`
      : null;
  const record: OAuthClientRegistration = {
    ...input,
    clientId,
    clientSecret,
    tokenEndpointAuthMethod,
    jwksUri: null,
    tokenEndpointAuthSigningAlg: null,
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris, grant_types, response_types,
       token_endpoint_auth_method, client_secret_hash, client_uri, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.clientId,
    record.clientName,
    JSON.stringify(record.redirectUris),
    JSON.stringify(record.grantTypes),
    JSON.stringify(record.responseTypes),
    record.tokenEndpointAuthMethod,
    clientSecret ? hashSecret(clientSecret) : null,
    record.clientUri,
    record.createdAt,
  );
  return record;
}

/**
 * Persist a validated Client ID Metadata Document under its URL identity.
 * The document is authoritative on every refresh, including a change of
 * authentication method or key-set location.
 */
export function upsertOAuthMetadataClient(
  db: Db,
  input: OAuthClientMetadataDocument,
  now = Date.now(),
): OAuthClientRegistration {
  db.prepare(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris, grant_types, response_types,
       token_endpoint_auth_method, client_secret_hash, jwks_uri,
       token_endpoint_auth_signing_alg, client_uri, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       client_name = excluded.client_name,
       redirect_uris = excluded.redirect_uris,
       grant_types = excluded.grant_types,
       response_types = excluded.response_types,
       token_endpoint_auth_method = excluded.token_endpoint_auth_method,
       client_secret_hash = NULL,
       jwks_uri = excluded.jwks_uri,
       token_endpoint_auth_signing_alg = excluded.token_endpoint_auth_signing_alg,
       client_uri = excluded.client_uri`,
  ).run(
    input.clientId,
    input.clientName,
    JSON.stringify(input.redirectUris),
    JSON.stringify(input.grantTypes),
    JSON.stringify(input.responseTypes),
    input.tokenEndpointAuthMethod,
    input.jwksUri,
    input.tokenEndpointAuthSigningAlg,
    input.clientUri,
    now,
  );
  return getOAuthClient(db, input.clientId)!;
}

export function getOAuthClient(db: Db, clientId: string): OAuthClientRegistration | null {
  const row = db
    .prepare<
      [string],
      {
        client_id: string;
        client_name: string;
        redirect_uris: string;
        grant_types: string;
        response_types: string;
        token_endpoint_auth_method: OAuthClientAuthMethod;
        client_secret_hash: string | null;
        jwks_uri: string | null;
        token_endpoint_auth_signing_alg: ClientAssertionAlgorithm | null;
        client_uri: string | null;
        created_at: number;
      }
    >("SELECT * FROM oauth_clients WHERE client_id = ?")
    .get(clientId);
  if (!row) return null;
  const redirectUris = parseStringArray(row.redirect_uris);
  const grantTypes = parseStringArray(row.grant_types);
  const responseTypes = parseStringArray(row.response_types);
  if (!redirectUris || !grantTypes || !responseTypes) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris,
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    clientSecret: null,
    jwksUri: row.jwks_uri,
    tokenEndpointAuthSigningAlg: row.token_endpoint_auth_signing_alg,
    clientUri: row.client_uri,
    createdAt: row.created_at,
  };
}

/**
 * Whether the presented credentials are exactly the registered method's:
 * no credential for a public client, the matching secret for
 * `client_secret_basic`, and a verified assertion over the client's current
 * key set — signed with its declared algorithm, when it declares one — for
 * `private_key_jwt`. Presenting any other method fails.
 */
export function oauthClientAuthenticates(
  db: Db,
  clientId: string,
  credentials: OAuthClientCredentials,
): boolean {
  const row = db
    .prepare<
      [string],
      {
        token_endpoint_auth_method: OAuthClientAuthMethod;
        client_secret_hash: string | null;
        jwks_uri: string | null;
        token_endpoint_auth_signing_alg: ClientAssertionAlgorithm | null;
      }
    >(
      `SELECT token_endpoint_auth_method, client_secret_hash, jwks_uri,
              token_endpoint_auth_signing_alg
       FROM oauth_clients WHERE client_id = ?`,
    )
    .get(clientId);
  if (!row) return false;
  const { clientSecret, clientAssertion } = credentials;
  switch (row.token_endpoint_auth_method) {
    case "none":
      return clientSecret === undefined && clientAssertion === undefined;
    case "client_secret_basic":
      return Boolean(
        clientAssertion === undefined &&
        clientSecret &&
        row.client_secret_hash &&
        secretHashMatches(row.client_secret_hash, clientSecret),
      );
    case "private_key_jwt":
      return (
        clientSecret === undefined &&
        clientAssertion !== undefined &&
        clientAssertion.method === "private_key_jwt" &&
        clientAssertion.clientId === clientId &&
        row.jwks_uri !== null &&
        clientAssertion.jwksUri === row.jwks_uri &&
        (row.token_endpoint_auth_signing_alg === null ||
          clientAssertion.alg === row.token_endpoint_auth_signing_alg)
      );
    default:
      return false;
  }
}
