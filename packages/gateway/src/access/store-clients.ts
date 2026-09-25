// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";

import { hashSecret, secretHashMatches } from "./store-helpers.js";
import { parseStringArray } from "./store-rules.js";
import type { Db } from "../data/types.js";
import type {
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

/** Persist a validated Client ID Metadata Document under its URL identity. */
export function upsertOAuthMetadataClient(
  db: Db,
  input: OAuthClientMetadataDocument,
  now = Date.now(),
): OAuthClientRegistration {
  db.prepare(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris, grant_types, response_types,
       token_endpoint_auth_method, client_secret_hash, client_uri, created_at
     ) VALUES (?, ?, ?, ?, ?, 'none', NULL, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       client_name = excluded.client_name,
       redirect_uris = excluded.redirect_uris,
       grant_types = excluded.grant_types,
       response_types = excluded.response_types,
       token_endpoint_auth_method = 'none',
       client_secret_hash = NULL,
       client_uri = excluded.client_uri`,
  ).run(
    input.clientId,
    input.clientName,
    JSON.stringify(input.redirectUris),
    JSON.stringify(input.grantTypes),
    JSON.stringify(input.responseTypes),
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
        token_endpoint_auth_method: "none" | "client_secret_basic";
        client_secret_hash: string | null;
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
    clientUri: row.client_uri,
    createdAt: row.created_at,
  };
}

export function oauthClientAuthenticates(
  db: Db,
  clientId: string,
  clientSecret: string | undefined,
): boolean {
  const row = db
    .prepare<
      [string],
      {
        token_endpoint_auth_method: "none" | "client_secret_basic";
        client_secret_hash: string | null;
      }
    >(
      `SELECT token_endpoint_auth_method, client_secret_hash
       FROM oauth_clients WHERE client_id = ?`,
    )
    .get(clientId);
  if (!row) return false;
  if (row.token_endpoint_auth_method === "none") return clientSecret === undefined;
  return Boolean(
    clientSecret &&
    row.client_secret_hash &&
    secretHashMatches(row.client_secret_hash, clientSecret),
  );
}
