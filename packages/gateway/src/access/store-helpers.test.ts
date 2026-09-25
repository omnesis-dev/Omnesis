// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import { registerOAuthClient } from "./store-clients.js";
import { createAuthorizationRequest, issueAuthorizationCode } from "./store-authorization.js";
import { urlSafeSecret } from "./store-helpers.js";
import type { Db } from "../data/types.js";

describe("urlSafeSecret", () => {
  test("never ends in the base64url punctuation a pasted link loses", () => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const secret = urlSafeSecret(24);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(secret).toMatch(/[A-Za-z0-9]$/);
    }
  });

  test("keeps the full length of the requested entropy", () => {
    expect(urlSafeSecret(32)).toHaveLength(43);
    expect(urlSafeSecret(24)).toHaveLength(32);
  });
});

describe("authorization secrets that land in URLs", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  test("the browser handle and the authorization code end alphanumerically", () => {
    const client = registerOAuthClient(
      db,
      {
        clientName: "Fictional notebook",
        redirectUris: ["http://127.0.0.1:48123/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        clientUri: null,
      },
      1_000,
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const created = createAuthorizationRequest(
        db,
        {
          clientId: client.clientId,
          redirectUri: "http://127.0.0.1:48123/callback",
          state: `state-${attempt}`,
          codeChallenge: "c".repeat(43),
          resource: "https://gateway.example.org/mcp",
          scope: "omnesis:access",
        },
        1_000,
      );
      if (!created.ok) throw new Error(created.error);
      expect(created.value.browserHandle).toMatch(/^omn_oar_[A-Za-z0-9_-]{31}[A-Za-z0-9]$/);
      db.prepare("UPDATE oauth_authorization_requests SET status = 'approved' WHERE id = ?").run(
        created.value.id,
      );
      const issued = issueAuthorizationCode(db, created.value.browserHandle, 2_000);
      if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");
      expect(issued.value.code).toMatch(/^omn_oac_[A-Za-z0-9_-]{31}[A-Za-z0-9]$/);
    }
  });
});
