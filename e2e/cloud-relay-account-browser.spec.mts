// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet } from "jose";
import { expect, test } from "@playwright/test";
import {
  createCloudRelay,
  RelayAccounts,
  RelaySessions,
  AccountEnrollmentAuthority,
  AccountGatewayLinkVerifier,
  ACCOUNT_BROWSER_PROTOCOL,
  accountBrowserTranscript,
  accountBrowserStarted,
  accountBrowserRedeemed,
  gatewayKeyAccount,
  gatewayKeyIdentity,
  tlsSpkiFingerprint,
  KEY_BINDING_PREFIX,
} from "@omnesis/cloud-relay";
import type { AddressInfo } from "node:net";

test("an owner-signed gateway request creates an account only on the person's explicit choice, and the gateway is linked only when the person presses to connect it", async ({
  playwright,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-account-browser-")),
    keyFile = join(directory, "key.pem"),
    certFile = join(directory, "cert.pem");
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
      "/CN=*.example.test",
      "-addext",
      "subjectAltName=DNS:*.example.test",
    ],
    { stdio: "ignore" },
  );
  const tls = { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") };
  const origin = "https://relay.example.test",
    accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const authority = new AccountEnrollmentAuthority(
    origin,
    generateKeyPairSync("ed25519").privateKey,
  );
  const ownerKey = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID(),
    ownerPublicKey = ownerKey.publicKey.export({ format: "pem", type: "spki" }).toString();
  const owner = {
    ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    tlsSpkiFingerprint: tlsSpkiFingerprint(tls.cert),
    ownerPublicKey,
  };
  accounts.registerKeyBinding(
    owner.ownerAccountId,
    {
      gatewayId,
      publicOrigin: owner.publicOrigin,
      certificate: tls.cert,
      identityToken:
        KEY_BINDING_PREFIX +
        ownerKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    },
    true,
  );
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    accountSignIn: { enrollmentAuthority: authority },
    tls,
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as AddressInfo).port;
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--ignore-certificate-errors",
      "--no-proxy-server",
      `--host-resolver-rules=MAP relay.example.test:443 127.0.0.1:${port}, MAP gateway.example.test:443 127.0.0.1:${port}, MAP * ~NOTFOUND`,
    ],
  });
  try {
    const ownerSession = await sessions.issue(
      gatewayKeyIdentity({ gatewayId, ownerPublicKey }, Math.floor(Date.now() / 1000) + 3600),
    );
    const control = (path: string, body: unknown) =>
      new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = httpsRequest(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method: "POST",
            rejectUnauthorized: false,
            headers: {
              host: "relay.example.test",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              authorization: `Bearer ${ownerSession.token}`,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              try {
                resolve({
                  status: response.statusCode!,
                  value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.on("error", reject);
        request.end(payload);
      });
    const now = Math.floor(Date.now() / 1000),
      redemptionSecret = randomBytes(32).toString("base64url");
    const unsigned = {
      protocol: ACCOUNT_BROWSER_PROTOCOL,
      operationId: randomUUID(),
      purpose: "owner-link" as const,
      nonce: randomBytes(32).toString("base64url"),
      callbackUrl: owner.publicOrigin + "/admin/cloud-relay/account/callback",
      browserState: randomBytes(32).toString("base64url"),
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt: now,
      expiresAt: now + 300,
    };
    const start = await control("/_relay/v3/account-browser/start", {
      ...unsigned,
      ownerSignature: sign(
        null,
        accountBrowserTranscript(origin, owner, unsigned),
        ownerKey.privateKey,
      ).toString("base64url"),
    });
    expect(start.status).toBe(200);
    const pending = accountBrowserStarted.parse(start.value);
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    let gatewayCookies: string | undefined;
    page.on("request", (request) => {
      if (new URL(request.url()).hostname === "gateway.example.test")
        gatewayCookies = request.headers().cookie ?? "";
    });
    await page.goto(pending.authorizeUrl);
    await expect(page).toHaveURL(`${origin}/_relay/account?operation=${unsigned.operationId}`);
    // Linking signs in to an account: the page opens on the sign-in view and creates nothing there.
    await expect(
      page.getByRole("heading", { name: "Sign in to your Omnesis account", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("gateway.example.test", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in with Passkey", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Create with a passkey" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect this gateway" })).toHaveCount(0);
    expect(accounts.identities.gatewayAccount(owner.ownerAccountId)).toBeUndefined();
    // Creating an account is a separate, explicit choice, and it can be taken back.
    await page.getByRole("button", { name: "Create an account instead", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create your Omnesis account", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Creating the account also connects this gateway to it.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with Passkey" })).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("account-create-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "I already have an account", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to your Omnesis account", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create an account instead", exact: true }).click();
    expect(accounts.identities.gatewayAccount(owner.ownerAccountId)).toBeUndefined();
    // Making the account does not link the gateway: the person presses to connect it.
    await page.getByRole("button", { name: "Create with a passkey", exact: true }).click();
    const connect = page.getByRole("button", { name: "Connect this gateway", exact: true });
    await expect(connect).toBeVisible();
    expect(accounts.identities.gatewayAccount(owner.ownerAccountId)).toBeUndefined();
    await connect.click();
    await expect(page).toHaveURL(
      /https:\/\/gateway\.example\.test\/admin\/cloud-relay\/account\/callback\?/,
    );
    expect(gatewayCookies).toBe("");
    const callback = new URL(page.url());
    expect(callback.searchParams.get("state")).toBe(unsigned.browserState);
    const association = accounts.identities.gatewayAccount(owner.ownerAccountId)!;
    expect(
      sessions.verifyAccountGatewayLink(
        origin,
        association.accountId,
        owner.ownerAccountId,
        association.seal,
      ),
    ).toBe(true);
    const result = await control("/_relay/v3/account-browser/redeem", {
      operationId: unsigned.operationId,
      result: callback.searchParams.get("result"),
      redemptionSecret,
    });
    expect(result.status).toBe(200);
    const proof = accountBrowserRedeemed.parse(result.value);
    expect(
      await new AccountGatewayLinkVerifier(
        origin,
        createLocalJWKSet(authority.jwks()),
        gatewayId,
        owner.ownerAccountId,
      ).verify(proof.identityToken, unsigned.nonce),
    ).toMatchObject({ subject: association.accountId });
    await expect(sessions.verifyAccountSession(proof.identityToken, origin)).rejects.toThrow();
    expect(
      (
        await control("/_relay/v3/account-browser/redeem", {
          operationId: unsigned.operationId,
          result: callback.searchParams.get("result"),
          redemptionSecret,
        })
      ).status,
    ).toBe(410);
    // The account page lists the gateway as one row that fits a phone.
    await page.goto(origin + "/_relay/account");
    const row = page.locator("a.gateway");
    await expect(row).toHaveAttribute("href", "https://gateway.example.test/portal/");
    await expect(row.locator(".row-title")).toHaveText("Gateway");
    await expect(row.locator(".row-meta")).toHaveText("gateway.example.test");
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    const layout = await row.evaluate((link) => {
      const title = link.querySelector(".row-title")!.getBoundingClientRect(),
        address = link.querySelector(".row-meta")!.getBoundingClientRect();
      return {
        height: link.getBoundingClientRect().height,
        stacked: address.top >= title.bottom,
        addressLines: Math.round(
          address.height /
            parseFloat(getComputedStyle(link.querySelector(".row-meta")!).lineHeight),
        ),
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });
    expect(layout.height).toBeGreaterThanOrEqual(44);
    expect(layout).toMatchObject({ stacked: true, addressLines: 1, fits: true });
    await expect(page.locator(".credential .row-meta")).toHaveText(/^Added\s.+\s·\sNever\sused/);
    await page.screenshot({
      path: test.info().outputPath("account-gateways-mobile.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
    await relay.close();
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
