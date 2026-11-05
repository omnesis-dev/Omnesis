// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { expect, test } from "@playwright/test";
import {
  createCloudRelay,
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
  const account = createHash("sha256")
    .update(JSON.stringify(["omnesis-local-test", "fictional-discovery-owner"]))
    .digest("hex");
  accounts.registerAccount(account);
  accounts.registerBinding(account, {
    gatewayId: randomUUID(),
    publicOrigin: "https://gateway.example.test",
    certificate: "fictional-public-routing-metadata",
    identityToken: "fictional-routing-identity",
  });
  let idToken = "";
  const identity = localIdentityProvider(key, "127.0.0.1");
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
    sessions: new RelaySessions(randomBytes(32)),
    tls,
    webLogin: {
      clientId: "fictional-web-client",
      clientSecret: "fictional-backend-secret",
      publicOrigin: origin,
      identity,
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
    await page.goto(`${origin}/_relay/web`);
    await expect(page.getByRole("heading", { name: "Find your gateway" })).toBeVisible();
    await expect(page.getByText("Google sign-in is optional.", { exact: false })).toBeVisible();
    await page.screenshot({ path: "/tmp/omnesis-relay-discovery.png", fullPage: true });
    await page.getByRole("link", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL("https://gateway.example.test/portal/");
    await expect(
      page.getByRole("heading", { name: "Your gateway still requires device pairing" }),
    ).toBeVisible();
    const cookies = await page.context().cookies(`${origin}/_relay/web`);
    expect(
      cookies.find((cookie) => cookie.name === "__Secure-omnesis-relay-login"),
    ).toBeUndefined();
  } finally {
    await browser.close();
    await relay.close();
    accounts.close();
    google.closeAllConnections();
    await new Promise<void>((resolve) => google.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
