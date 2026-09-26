// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import { oauthClientAuthenticates, upsertOAuthMetadataClient } from "./store-clients.js";
import type { Db } from "../data/types.js";
import type { OAuthClientMetadataDocument, VerifiedClientAssertion } from "./types.js";

const CLIENT_ID = "https://client.example.com/oauth/client.json";
const JWKS_URI = "https://client.example.com/oauth/jwks.json";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

function keyClient(
  overrides: Partial<Extract<OAuthClientMetadataDocument, { jwksUri: string }>> = {},
): OAuthClientMetadataDocument {
  return {
    clientId: CLIENT_ID,
    clientName: "Fictional key client",
    redirectUris: ["https://client.example.com/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "private_key_jwt",
    jwksUri: JWKS_URI,
    tokenEndpointAuthSigningAlg: "RS256",
    clientUri: null,
    ...overrides,
  };
}

function proof(overrides: Partial<VerifiedClientAssertion> = {}): VerifiedClientAssertion {
  return {
    method: "private_key_jwt",
    clientId: CLIENT_ID,
    jwksUri: JWKS_URI,
    alg: "RS256",
    ...overrides,
  };
}

describe("oauthClientAuthenticates for a private_key_jwt client", () => {
  test("accepts only a proof over the recorded key set and signing algorithm", () => {
    upsertOAuthMetadataClient(db, keyClient());
    expect(oauthClientAuthenticates(db, CLIENT_ID, { clientAssertion: proof() })).toBe(true);
    expect(
      oauthClientAuthenticates(db, CLIENT_ID, { clientAssertion: proof({ alg: "PS256" }) }),
    ).toBe(false);
    expect(
      oauthClientAuthenticates(db, CLIENT_ID, {
        clientAssertion: proof({ jwksUri: "https://client.example.com/other-jwks.json" }),
      }),
    ).toBe(false);
    expect(oauthClientAuthenticates(db, CLIENT_ID, {})).toBe(false);
  });

  test("a document that names no algorithm accepts any verified one, and a refresh re-pins", () => {
    upsertOAuthMetadataClient(db, keyClient({ tokenEndpointAuthSigningAlg: null }));
    expect(
      oauthClientAuthenticates(db, CLIENT_ID, { clientAssertion: proof({ alg: "ES256" }) }),
    ).toBe(true);

    upsertOAuthMetadataClient(db, keyClient({ tokenEndpointAuthSigningAlg: "PS256" }));
    expect(
      oauthClientAuthenticates(db, CLIENT_ID, { clientAssertion: proof({ alg: "ES256" }) }),
    ).toBe(false);
    expect(
      oauthClientAuthenticates(db, CLIENT_ID, { clientAssertion: proof({ alg: "PS256" }) }),
    ).toBe(true);
  });
});
