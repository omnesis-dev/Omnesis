// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import { expect, test, vi } from "vitest";
import { listen, tlsFiles } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { accountId, RelaySessions } from "./identity.js";
import { createCloudRelay } from "./server.js";
import { gatewayKeyAccount, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";

const origin = "https://relay.example.test";
test("fresh Google proof migrates both gateway associations into one provider-independent account without granting device access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-account-integration-"));
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32)),
    googleKey = randomBytes(32);
  const identity = {
    issuer: "https://accounts.google.com",
    subject: "fictional-shared-account",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const provider = {
    verify: async (token: string, nonce?: string) => {
      const { payload } = await jwtVerify(token, googleKey, {
        issuer: identity.issuer,
        audience: "fixture-device-web",
      });
      if (payload.nonce !== nonce) throw new Error("Fixture nonce mismatch");
      return identity;
    },
  };
  let expectedNonce = "";
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      id_token: await new SignJWT({ nonce: expectedNonce })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(identity.issuer)
        .setAudience("fixture-device-web")
        .setSubject(identity.subject)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(googleKey),
      token_type: "Bearer",
    }),
  );
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    accountSignIn: {},
    webLogin: {
      clientId: "fixture-device-web",
      clientSecret: "fixture-backend-secret",
      publicOrigin: origin,
      identity: provider,
      fetch: transport,
    },
  });
  const url = await listen(relay.server);
  try {
    const certificate = await readFile(tlsFiles(directory, "*.example.test").certFile, "utf8");
    for (const name of ["first", "second"]) {
      const key = generateKeyPairSync("ed25519").publicKey,
        gatewayId = randomUUID(),
        publicOrigin = `https://${name}.example.test`;
      const owner = gatewayKeyAccount({
        gatewayId,
        ownerPublicKey: key.export({ format: "pem", type: "spki" }).toString(),
      });
      accounts.registerKeyBinding(
        owner,
        {
          gatewayId,
          publicOrigin,
          certificate,
          identityToken:
            KEY_BINDING_PREFIX + key.export({ format: "der", type: "spki" }).toString("base64url"),
        },
        true,
      );
      accounts.linkGoogleAccount(
        accountId(identity),
        owner,
        sessions.sealGoogleLink(origin, accountId(identity), owner),
      );
    }
    const signedOut = await fetch(url + "/_relay/account/api/session");
    expect(await signedOut.json()).toMatchObject({ authenticated: false, canCreateAccount: false });
    const page = await fetch(url + "/_relay/web", { redirect: "manual" });
    expect(page.headers.get("location")).toBe("/_relay/account");
    const start = await fetch(url + "/_relay/web/start", {
      method: "POST",
      headers: { origin },
      redirect: "manual",
    });
    const authorization = new URL(start.headers.get("location")!);
    expectedNonce = authorization.searchParams.get("nonce")!;
    const cookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const callback = await fetch(
      url +
        `/_relay/web/callback?state=${authorization.searchParams.get("state")}&code=fixture-code`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(origin + "/_relay/account");
    const accountCookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-omnesis-account="))!
      .split(";")[0]!;
    const response = await fetch(url + "/_relay/account/api/session", {
      headers: { cookie: accountCookie },
    });
    const status = await response.json();
    expect(status.authenticated).toBe(true);
    expect(
      status.gateways.map((value: { publicOrigin: string }) => value.publicOrigin).sort(),
    ).toEqual(["https://first.example.test", "https://second.example.test"]);
    const token = accountCookie.slice(accountCookie.indexOf("=") + 1),
      account = await sessions.verifyAccountSession(token, origin);
    expect(account.accountId).not.toBe(accountId(identity));
    expect(accounts.identities.list(account.accountId).federated).toHaveLength(1);
    expect(
      (await fetch(url + "/_relay/v2/gateway", { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(401);
  } finally {
    await relay.close();
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
