// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { expect, test } from "@playwright/test";
import {
  AccountEnrollmentAuthority,
  createCloudRelay,
  gatewayKeyAccount,
  KEY_BINDING_PREFIX,
  localIdentityProvider,
  RelayAccounts,
  RelaySessions,
} from "@omnesis/cloud-relay";
import type { AddressInfo } from "node:net";

test("relay discovery completes browser-bound Google sign-in and opens the account's gateway without granting access", async ({
  playwright,
}) => {
  const key = randomBytes(32);
  const accounts = new RelayAccounts(":memory:");
  const sessions = new RelaySessions(randomBytes(32));
  let idToken = "";
  const identity = localIdentityProvider(key, "127.0.0.1");
  // Account sign-in accepts only Google's issuer; the fixture's signed token stands in for Google's.
  const googleIdentity: typeof identity = {
    verify: async (token, nonce) => ({
      ...(await identity.verify(token, nonce)),
      issuer: "https://accounts.google.com",
    }),
  };
  const directory = await mkdtemp(join(tmpdir(), "omnesis-relay-discovery-"));
  const keyFile = join(directory, "tls-key.pem"),
    certFile = join(directory, "tls-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=relay.example.test",
      "-addext",
      "subjectAltName=DNS:relay.example.test",
    ],
    { stdio: "ignore" },
  );
  const origin = "https://relay.example.test";
  const tls = { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") };
  // A key-owned gateway its owner linked to this Google account: the first Google sign-in
  // creates the account and carries the gateway into it.
  const gatewayKey = generateKeyPairSync("ed25519").publicKey,
    gatewayId = randomUUID();
  const owner = gatewayKeyAccount({
    gatewayId,
    ownerPublicKey: gatewayKey.export({ format: "pem", type: "spki" }).toString(),
  });
  accounts.registerKeyBinding(
    owner,
    {
      gatewayId,
      publicOrigin: "https://gateway.example.test",
      certificate: tls.cert,
      identityToken:
        KEY_BINDING_PREFIX +
        gatewayKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
    true,
  );
  const googleAccount = createHash("sha256")
    .update(JSON.stringify(["https://accounts.google.com", "fictional-discovery-owner"]))
    .digest("hex");
  accounts.linkGoogleAccount(
    googleAccount,
    owner,
    sessions.sealGoogleLink(origin, googleAccount, owner),
  );
  const google = createHttpsServer(tls, (request, response) => {
    void (async () => {
      if (request.headers.host === "gateway.example.test") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><title>Gateway</title><h1>Your gateway still requires device pairing</h1>",
        );
        return;
      }
      const authorization = new URL(request.url!, "https://accounts.google.com");
      expect(authorization.searchParams.get("client_id")).toBe("fictional-web-client");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      idToken = await new SignJWT({ nonce: authorization.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("omnesis-local-test")
        .setSubject("fictional-discovery-owner")
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(key);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        code: "fictional-google-code",
        state: authorization.searchParams.get("state")!,
      }).toString();
      response.writeHead(303, { location: callback.href });
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  google.listen(0, "127.0.0.1");
  await once(google, "listening");
  const googlePort = (google.address() as AddressInfo).port;
  const relay = createCloudRelay({
    accounts,
    identity,
    controlOrigin: origin,
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
    },
    sessions,
    tls,
    webLogin: {
      clientId: "fictional-web-client",
      clientSecret: "fictional-backend-secret",
      publicOrigin: origin,
      identity: googleIdentity,
      fetch: async () => new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" })),
    },
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as AddressInfo).port;
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--ignore-certificate-errors",
      "--no-proxy-server",
      `--host-resolver-rules=MAP relay.example.test:443 127.0.0.1:${port}, MAP accounts.google.com:443 127.0.0.1:${googlePort}, MAP gateway.example.test:443 127.0.0.1:${googlePort}, MAP * ~NOTFOUND`,
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    // The old discovery address lands on the account page, where Google is one choice of two.
    await page.goto(`${origin}/_relay/web`);
    await expect(page).toHaveURL(`${origin}/_relay/account`);
    await expect(
      page.getByRole("heading", { name: "Sign in to your Omnesis account" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in with Passkey", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "/tmp/omnesis-relay-discovery.png", fullPage: true });
    await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your gateways", exact: true })).toBeVisible();
    await page.getByRole("link", { name: /gateway\.example\.test/ }).click();
    // The sign-in travels to the gateway's portal in the fragment, which no server receives; the
    // gateway still verifies it and decides whether this browser joins.
    await expect(page).toHaveURL(
      /^https:\/\/gateway\.example\.test\/portal\/#account-signin=[\w-]+$/,
    );
    const handed = JSON.parse(
      Buffer.from(new URL(page.url()).hash.split("=")[1]!, "base64url").toString(),
    );
    expect(handed).toMatchObject({
      v: 1,
      name: expect.stringMatching(/^Portal [a-f0-9]{8}$/),
      privateKey: { kty: "EC", crv: "P-256" },
      identityToken: expect.any(String),
      proof: { type: "google", idToken },
    });
    await expect(
      page.getByRole("heading", { name: "Your gateway still requires device pairing" }),
    ).toBeVisible();
    const cookies = await page.context().cookies(`${origin}/_relay/web`);
    expect(cookies.find((cookie) => cookie.name === "__Host-omnesis-relay-login")).toBeUndefined();
  } finally {
    await browser.close();
    await relay.close();
    accounts.close();
    google.closeAllConnections();
    await new Promise<void>((resolve) => google.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
