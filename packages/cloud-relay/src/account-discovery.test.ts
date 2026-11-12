// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { AccountDiscovery } from "./account-discovery.js";
import { GatewayDirectory } from "./gateway-directory.js";
import { NativeAccountAuthentication } from "./native-account-authentication.js";
import { AccountAuthentication } from "./account-authentication.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { RelaySessions } from "./identity.js";
import { Passkeys } from "./passkeys.js";
import { KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { RelayError } from "./tunnels.js";

test("unconfigured authority, unsupported gateway identities and unavailable recovery policy fail closed", async () => {
  const db = new Database(":memory:"),
    origin = "https://relay.example.test";
  const accounts = new OmnesisAccounts(db),
    sessions = new RelaySessions(randomBytes(32));
  const passkeys = new Passkeys(accounts, { origin });
  const authentication = new NativeAccountAuthentication({
    origin,
    accounts,
    sessions,
    passkeys,
    googleAuthentication: new AccountAuthentication(origin, accounts, sessions),
  });
  try {
    const accountId = accounts.signInFederated("google", "a".repeat(64));
    const token = await sessions.issueAccountDiscovery(
      { accountId, version: 1 },
      randomBytes(32).toString("base64url"),
      origin,
    );
    const key = generateKeyPairSync("ed25519").publicKey;
    const binding = {
      gatewayId: randomUUID(),
      publicOrigin: "https://gateway.example.test",
      certificate: "synthetic-directory-certificate",
      identityToken:
        KEY_BINDING_PREFIX + key.export({ type: "spki", format: "der" }).toString("base64url"),
    };
    const directory = new GatewayDirectory({
      accounts: () => ["owner"],
      binding: () => binding,
      name: () => undefined,
    });
    const discovery = new AccountDiscovery({ authentication, directory, assertCurrent() {} });
    expect(() => discovery.jwks()).toThrow("unavailable");
    const query = new URLSearchParams({ gatewayId: binding.gatewayId });
    await expect(discovery.select(token.discoveryToken, query)).rejects.toThrow("unavailable");
    binding.identityToken = "synthetic-legacy-google-identity";
    await expect(discovery.select(token.discoveryToken, query)).rejects.toThrow("update");
    const unavailable = new AccountDiscovery({
      authentication,
      directory,
      assertCurrent() {
        throw new RelayError(503, "Recovery policy unavailable");
      },
    });
    await expect(unavailable.list(token.discoveryToken, new URLSearchParams())).rejects.toThrow(
      "Recovery policy",
    );
    await expect(unavailable.select(token.discoveryToken, query)).rejects.toThrow(
      "Recovery policy",
    );
  } finally {
    authentication.close();
    passkeys.close();
    db.close();
  }
});
