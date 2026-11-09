// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { request as httpsRequest } from "node:https";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createCloudRelay,
  RelayAccounts,
  RelaySessions,
  authorizeAccountDesktop,
  AccountEnrollmentAuthority,
  ACCOUNT_BROWSER_PROTOCOL,
  accountBrowserTranscript,
  accountBrowserStarted,
  gatewayKeyAccount,
  gatewayKeyIdentity,
  tlsSpkiFingerprint,
  KEY_BINDING_PREFIX,
} from "@omnesis/cloud-relay";
import type { AddressInfo } from "node:net";

test("real browser WebAuthn creates an account, signs in, adds a second passkey the first one vouches for and revokes one without granting gateway access", async ({
  playwright,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-browser-passkeys-"));
  const keyFile = join(directory, "key.pem"),
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
      "/CN=relay.example.test",
      "-addext",
      "subjectAltName=DNS:relay.example.test",
    ],
    { stdio: "ignore" },
  );
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const origin = "https://relay.example.test";
  const ownerKey = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID();
  const ownerPublicKey = ownerKey.publicKey.export({ format: "pem", type: "spki" }).toString();
  const certificate = await readFile(certFile, "utf8");
  const owner = {
    ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    ownerPublicKey,
    tlsSpkiFingerprint: tlsSpkiFingerprint(certificate),
  };
  accounts.registerKeyBinding(
    owner.ownerAccountId,
    {
      gatewayId,
      publicOrigin: owner.publicOrigin,
      certificate,
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
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
    },
    webLogin: {
      publicOrigin: origin,
      clientId: "fictional-web-client",
      clientSecret: "fictional-backend-secret",
      identity: {
        verify: async () => ({
          issuer: "https://accounts.google.com",
          subject: "fictional-browser-account",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      },
    },
    tls: { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") },
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as AddressInfo).port;
  let restoreClock = () => {};
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--ignore-certificate-errors",
      "--no-proxy-server",
      `--host-resolver-rules=MAP relay.example.test:443 127.0.0.1:${port}, MAP * ~NOTFOUND`,
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
    const authenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/_relay/account");
    await expect(
      page.getByRole("button", { name: "Sign in with Passkey", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in with Google", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Sign in with Google", exact: true })
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("account-signin-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: test.info().outputPath("account-signin-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    // The plain account page signs in and never creates an account.
    for (const name of ["Create with a passkey", "Create an account instead"])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    const refused = await page.evaluate(
      async () =>
        (
          await fetch("/_relay/account/api/passkeys/register/options", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ createAccount: true }),
          })
        ).status,
    );
    expect(refused).toBe(403);
    await page.goto(pending.authorizeUrl);
    // The page would go on to link the gateway by itself. Cut off here, it keeps the button as
    // the way to continue, so this account stays without a gateway for the rest of the test.
    await page.route("**/_relay/account/api/continue**", (route) => route.abort());
    await page.getByRole("button", { name: "Create an account instead", exact: true }).click();
    await page.getByRole("button", { name: "Create with a passkey", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Connect this gateway", exact: true }),
    ).toBeEnabled();
    // Account creation alone does not link or grant access to the gateway.
    expect(accounts.identities.gatewayAccount(owner.ownerAccountId)).toBeUndefined();
    await page.unroute("**/_relay/account/api/continue**");
    await page.goto(origin + "/_relay/account");
    await expect(page.getByRole("heading", { name: "Sign-in methods", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
    await expect(page.locator(".credential .row-meta")).toHaveText(/^Added\s.+\s·\sNever\sused/);
    await expect(page.getByRole("status")).toBeHidden();
    const firstCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "__Host-omnesis-account",
    )!;
    expect(firstCookie).toMatchObject({ secure: true, httpOnly: true, path: "/", sameSite: "Lax" });
    const account = await sessions.verifyAccountSession(firstCookie.value, origin);
    expect(accounts.identities.list(account.accountId).passkeys).toHaveLength(1);
    const routing = await page.evaluate(
      async (token) =>
        (await fetch("/_relay/v2/gateway", { headers: { authorization: `Bearer ${token}` } }))
          .status,
      firstCookie.value,
    );
    expect(routing).toBe(401);
    await expect(
      page.getByRole("button", { name: "Link Google", exact: true }).locator("img"),
    ).toBeVisible();
    const screenshot = test.info().outputPath("account-management-mobile.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach("passkey-account-mobile", {
      path: screenshot,
      contentType: "image/png",
    });
    // Signing out is behind the button in the corner, not on the page.
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "More options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sign in with Passkey", exact: true }),
    ).toBeVisible();
    expect(
      accounts.identities.activeSession(account.accountId, account.version, account.sessionId),
    ).toBe(false);
    await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign-in methods", exact: true })).toBeVisible();
    const signedIn = (await context.cookies()).find(
      (cookie) => cookie.name === "__Host-omnesis-account",
    )!;
    expect((await sessions.verifyAccountSession(signedIn.value, origin)).accountId).toBe(
      account.accountId,
    );
    // That sign-in was also made for a gateway's portal: the page keeps the device key it is bound to.
    const handoff = await page.evaluate(async () => {
      const stored = JSON.parse(sessionStorage.getItem("omnesis.portal-handoff") ?? "null");
      const response = await fetch(`/_relay/account/api/session?portal=${stored?.operationId}`);
      return { key: stored?.privateKey?.crv, ready: (await response.json()).handoff?.ready };
    });
    expect(handoff).toEqual({ key: "P-256", ready: true });
    // Five minutes on, the session still shows the account, and adding a passkey still asks for
    // nothing first: the confirmation comes after, and vouches for the new passkey.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    restoreClock = () => {
      Date.now = realNow;
    };
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign-in methods", exact: true })).toBeVisible();
    await expect(page.getByText("Confirm it's you", { exact: true })).toHaveCount(0);
    await expect(page.locator(".credential .row-meta")).toHaveText(/\s·\sLast\sused\s/);
    await expect(page.getByRole("button", { name: "Add a passkey", exact: true })).toBeEnabled();
    // The new passkey lives on another authenticator, as it would on another device: one
    // authenticator keeps a single passkey per account. `swap` replaces the browser's
    // authenticator with one holding `credentials` and returns what the old one held.
    const authenticatorOptions = {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    } as const;
    let authenticatorId = authenticator.authenticatorId;
    const holding = async () =>
      (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
    type Held = Awaited<ReturnType<typeof holding>>;
    const swap = async (credentials: Held = []): Promise<Held> => {
      const held = await holding();
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: authenticatorOptions,
      }));
      for (const credential of credentials)
        await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
      return held;
    };
    const original = await swap();
    expect(original).toHaveLength(1);
    // Adding asks for nothing first, even on a session this old: the passkey is created at once...
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm it's you to finish", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Your new passkey is ready. Confirm with a sign-in you already use, so that someone else using this browser can't add their own passkey. Your gateways check this confirmation and then trust the new passkey.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Confirm it's you", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Add a passkey", exact: true })).toHaveCount(0);
    // This account has no Google sign-in, so only its passkey can confirm.
    await expect(page.getByRole("button", { name: "Confirm with Google" })).toHaveCount(0);
    // ...but the account does not have it until a sign-in it already had vouches for it.
    expect(accounts.identities.list(account.accountId).passkeys).toHaveLength(1);
    await expect(page.locator(".credential")).toHaveCount(1);
    await page.screenshot({
      path: test.info().outputPath("account-confirm-mobile.png"),
      fullPage: true,
    });
    // Cancelling leaves the account as it was.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("No passkey was added.");
    expect(accounts.identities.list(account.accountId).passkeys).toHaveLength(1);
    await swap();
    // Again, this time confirmed with the first passkey.
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm it's you to finish", exact: true }),
    ).toBeVisible();
    const added = await swap(original);
    expect(added).toHaveLength(1);
    expect(added[0]!.credentialId).not.toBe(original[0]!.credentialId);
    await page.getByRole("button", { name: "Confirm with passkey", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Passkey added. You can now use it to sign in.",
    );
    await expect(
      page.getByRole("heading", { name: "Confirm it's you to finish", exact: true }),
    ).toHaveCount(0);
    // The account keeps the confirmation beside the passkey, for each gateway to verify itself.
    const listed = accounts.identities.passkeyKeys(account.accountId);
    expect(listed).toHaveLength(2);
    expect(listed[0]).not.toHaveProperty("endorsement");
    expect(listed[1]!.endorsement).toMatchObject({ type: "passkey" });
    // From here on this browser holds only the new passkey.
    await swap(added);
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(2);
    await expect(page.locator(".credential")).toHaveCount(2);
    await expect(page.locator(".credential").nth(0).locator(".badge")).toHaveCount(0);
    await expect(page.locator(".credential").nth(1).locator(".badge")).toHaveText("New");
    await expect(page.locator(".credential").nth(1).locator(".row-meta")).toHaveText(
      /^Added\s.+\s·\sNever\sused/,
    );
    expect(accounts.identities.list(account.accountId).passkeys).toHaveLength(2);
    // At phone width nothing overflows and every control is large enough to tap.
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        // The entries of the closed menu are not drawn, so they have no size to check.
        [...document.querySelectorAll("button")].every(
          (button) => button.offsetParent === null || button.getBoundingClientRect().height >= 44,
        ),
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("account-passkey-added-mobile.png"),
      fullPage: true,
    });
    // Removing is different: five minutes after that confirmation, it asks for a fresh one first.
    Date.now = () => realNow() + 12 * 60_000;
    await page.getByRole("button", { name: "Remove", exact: true }).first().click();
    await expect(
      page.getByRole("heading", { name: "Confirm it's you", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/^Confirming with a passkey removes “.+” right away\.$/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a passkey", exact: true })).toHaveCount(0);
    expect(accounts.identities.list(account.accountId).passkeys).toHaveLength(2);
    await page.getByRole("button", { name: "Confirm with passkey", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sign in with Passkey", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      "Passkey removed. Sign in again to continue.",
    );
    expect(accounts.identities.list(account.accountId).passkeys).toHaveLength(1);
    await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign-in methods", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
    await expect(page.getByRole("status")).toBeHidden();
    const nonce = randomBytes(32).toString("base64url");
    const discovery = await authorizeAccountDesktop(
      {
        relayUrl: origin,
        nonce,
        kind: "collector",
        name: "Fictional desktop collector",
        signal: AbortSignal.timeout(30_000),
      },
      {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe(origin);
          return new Promise<Response>((resolve, reject) => {
            const request = httpsRequest(
              {
                hostname: "127.0.0.1",
                port,
                path: url.pathname + url.search,
                method: init!.method,
                rejectUnauthorized: false,
                headers: { "content-type": "application/json" },
                signal: init!.signal!,
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () =>
                  resolve(new Response(Buffer.concat(chunks), { status: response.statusCode! })),
                );
                response.on("error", reject);
              },
            );
            request.on("error", reject);
            request.end(String(init!.body));
          });
        },
        openBrowser: async (launch) => {
          await page.goto(launch);
          await expect(
            page.getByRole("heading", { name: "Connect this device", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("Fictional desktop collector", { exact: true }),
          ).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath("account-desktop-consent-mobile.png"),
            fullPage: true,
          });
          // An existing session is not enough: this request needs a sign-in of its own.
          await expect(
            page.getByRole("button", { name: "Continue on this device", exact: true }),
          ).toHaveCount(0);
          await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).click();
          await page.getByRole("button", { name: "Continue on this device", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "Sign-in finished", exact: true }),
          ).toBeVisible();
        },
      },
    );
    expect(discovery.accountId).toBe(account.accountId);
    expect(await sessions.verifyAccountDiscovery(discovery.discoveryToken, origin)).toMatchObject({
      accountId: account.accountId,
      nonce,
    });
    await expect(sessions.verifyAccountSession(discovery.discoveryToken, origin)).rejects.toThrow();
    expect(errors).toEqual([]);
  } finally {
    restoreClock();
    await browser.close();
    await relay.close();
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
