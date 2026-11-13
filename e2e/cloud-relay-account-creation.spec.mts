// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Creating an Omnesis account is always an explicit choice made while connecting
 * a gateway; signing in never creates one. A real relay serves its account pages
 * to a real browser, a fixture stands in for Google's authorization endpoint and
 * token signature, and the test plays each gateway's half of the signup protocol
 * with that gateway's owner key. Every identity here is invented.
 */

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  ACCOUNT_BROWSER_PATH,
  AccountEnrollmentAuthority,
  GATEWAY_SIGNUP_PATH,
  GATEWAY_SIGNUP_PROTOCOL,
  KEY_BINDING_PREFIX,
  RelayAccounts,
  RelaySessions,
  createCloudRelay,
  gatewayKeyAccount,
  gatewayKeyIdentity,
  gatewaySignupLinked,
  gatewaySignupPollResult,
  gatewaySignupStarted,
  gatewaySignupTranscript,
  localIdentityProvider,
} from "@omnesis/cloud-relay";
import type { AddressInfo } from "node:net";

const origin = "https://relay.example.test";
const NO_ACCOUNT = "There's no Omnesis account for this sign-in.";

test("an account is created only by an explicit choice while connecting a gateway: with Google or from the sign-in view, never by signing in, and a gateway that starts over replaces the account it created", async ({
  playwright,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "omnesis-account-creation-"));
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
  const tls = { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") };
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));

  // The fixture signs a token for whoever "is at the keyboard"; the relay treats it as Google's.
  const tokenKey = randomBytes(32);
  const identity = localIdentityProvider(tokenKey, "127.0.0.1");
  let googleSubject = "",
    idToken = "";
  const google = createHttpsServer(tls, (request, response) => {
    void (async () => {
      const authorization = new URL(request.url!, "https://accounts.google.com");
      idToken = await new SignJWT({ nonce: authorization.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("omnesis-local-test")
        .setSubject(googleSubject)
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(tokenKey);
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
    sessions,
    identity,
    controlOrigin: origin,
    // One loopback address stands in for every person here, so the per-client sign-in rate
    // (an operator setting) is raised.
    loginLimits: {
      maxConcurrent: 32,
      maxPerMinute: 1000,
      maxConcurrentPerClient: 32,
      maxPerMinutePerClient: 1000,
    },
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
      signup: { policy: "open" },
    },
    webLogin: {
      clientId: "fictional-web-client",
      clientSecret: "fictional-backend-secret",
      publicOrigin: origin,
      identity: {
        verify: async (token, nonce) => ({
          ...(await identity.verify(token, nonce)),
          issuer: "https://accounts.google.com",
        }),
      },
      fetch: async () => new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" })),
    },
    tls,
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as AddressInfo).port;

  const control = (path: string, body: unknown, token?: string) =>
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
            ...(token ? { authorization: `Bearer ${token}` } : {}),
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

  /** A registered gateway and its half of connecting by sign-in. */
  async function gateway(name: string) {
    const ownerKey = generateKeyPairSync("ed25519"),
      gatewayId = randomUUID(),
      ownerPublicKey = ownerKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
      owner = gatewayKeyAccount({ gatewayId, ownerPublicKey });
    /** What registering with an invitation leaves on the relay. */
    const register = () =>
      accounts.registerKeyBinding(
        owner,
        {
          gatewayId,
          publicOrigin: `https://${name}.example.test`,
          certificate: tls.cert,
          identityToken:
            KEY_BINDING_PREFIX +
            ownerKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
        },
        true,
      );
    register();
    const session = await sessions.issue(
      gatewayKeyIdentity({ gatewayId, ownerPublicKey }, Math.floor(Date.now() / 1000) + 3600),
    );
    return {
      owner,
      /** What `POST /admin/cloud-relay/connect` starts, with the choice made in the portal. */
      async start(intent: "create" | "existing") {
        const issuedAt = Math.floor(Date.now() / 1000),
          redemptionSecret = randomBytes(32).toString("base64url");
        const unsigned = {
          protocol: GATEWAY_SIGNUP_PROTOCOL,
          operationId: randomUUID(),
          gatewayId,
          ownerPublicKey,
          nonce: randomBytes(32).toString("base64url"),
          redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
          issuedAt,
          expiresAt: issuedAt + 300,
        };
        const started = await control(`${GATEWAY_SIGNUP_PATH}/start`, {
          ...unsigned,
          ownerSignature: sign(
            null,
            gatewaySignupTranscript(origin, unsigned),
            ownerKey.privateKey,
          ).toString("base64url"),
          intent,
        });
        expect(started.status).toBe(200);
        return {
          ...gatewaySignupStarted.parse(started.value),
          redemption: { operationId: unsigned.operationId, redemptionSecret },
        };
      },
      async poll(pending: { redemption: unknown }) {
        const polled = await control(`${GATEWAY_SIGNUP_PATH}/poll`, pending.redemption);
        expect(polled.status).toBe(200);
        return gatewaySignupPollResult.parse(polled.value);
      },
      /** Collects the approved sign-in and binds the account; returns the account's id. */
      async finish(pending: { redemption: unknown }) {
        expect(await this.poll(pending)).toMatchObject({ status: "approved" });
        const linked = await control(
          `${GATEWAY_SIGNUP_PATH}/link`,
          pending.redemption,
          session.token,
        );
        expect(linked.status).toBe(200);
        const { accountId } = gatewaySignupLinked.parse(linked.value);
        expect(accounts.identities.gatewayAccount(owner)?.accountId).toBe(accountId);
        return accountId;
      },
      /**
       * The owner disconnects the gateway: it leaves its account and its registration goes with
       * it. Connecting again registers it afresh, which is what `register` stands in for.
       */
      async unlink() {
        expect((await control(`${ACCOUNT_BROWSER_PATH}/unlink`, {}, session.token)).status).toBe(
          200,
        );
        expect(accounts.identities.gatewayAccount(owner)).toBeUndefined();
        expect(accounts.gatewayBinding(owner)).toBeUndefined();
        register();
      },
    };
  }

  const browser: Browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--ignore-certificate-errors",
      "--no-proxy-server",
      `--host-resolver-rules=MAP relay.example.test:443 127.0.0.1:${port}, MAP accounts.google.com:443 127.0.0.1:${googlePort}, MAP * ~NOTFOUND`,
    ],
  });
  const errors: string[] = [];
  const refusals: string[] = [];
  /** A person with a browser of their own and one Google identity. */
  async function person(): Promise<Page> {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400)
        void response
          .text()
          .catch(() => "")
          .then((body) =>
            refusals.push(
              `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname} ${body.slice(0, 200)}`,
            ),
          );
    });
    return page;
  }
  const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
  const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
  /**
   * Signed in, the person presses to connect the gateway and the page reaches the end of
   * connecting; a failure names what the relay refused.
   */
  const allSet = async (page: Page) => {
    await button(page, "Connect this gateway").click();
    await expect(
      heading(page, "You're all set"),
      `on ${page.url()}; refused: ${refusals.join(" | ") || "nothing"}`,
    ).toBeVisible();
  };
  /** Signs in on the plain account page, which never creates an account. */
  async function plainSignIn(page: Page) {
    await page.goto(`${origin}/_relay/account`);
    await expect(heading(page, "Sign in to your Omnesis account")).toBeVisible();
    for (const name of ["Create with Google", "Create with a passkey", "Create an account instead"])
      await expect(button(page, name)).toHaveCount(0);
    await button(page, "Sign in with Google").click();
  }

  try {
    // ── Create with Google, chosen in the gateway's portal ──────────────────────────────────
    const home = await gateway("home");
    const first = await person();
    googleSubject = "fictional-first-owner";
    const creating = await home.start("create");
    await first.goto(creating.authorizeUrl);
    await expect(heading(first, "Create your Omnesis account")).toBeVisible();
    await expect(
      first.getByText(
        "Your data stays on your gateway. The account only knows which gateways are yours and how you sign in.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      first.getByText(
        "If this Google account already has an Omnesis account, you'll be signed in to it instead.",
        { exact: true },
      ),
    ).toBeVisible();
    for (const name of ["Create with Google", "Create with a passkey", "I already have an account"])
      await expect(button(first, name)).toBeVisible();
    await expect(button(first, "Sign in with Google")).toHaveCount(0);
    expect(
      await first.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await first.screenshot({
      path: test.info().outputPath("account-create-google-mobile.png"),
      fullPage: true,
    });
    expect(await home.poll(creating)).toMatchObject({ status: "pending" });
    // Creating the account does not connect the gateway; the person presses to connect it.
    await button(first, "Create with Google").click();
    await allSet(first);
    const firstAccount = await home.finish(creating);

    // ── "I already have one", with an identity that has an account ──────────────────────────
    const cabin = await gateway("cabin");
    const signingIn = await cabin.start("existing");
    const returning = await person();
    await returning.goto(signingIn.authorizeUrl);
    await expect(heading(returning, "Sign in to your Omnesis account")).toBeVisible();
    await expect(
      returning.getByText("Sign in to connect this gateway to your account.", { exact: true }),
    ).toBeVisible();
    for (const name of ["Create with Google", "Create with a passkey"])
      await expect(button(returning, name)).toHaveCount(0);
    await expect(button(returning, "Create an account instead")).toBeVisible();
    await button(returning, "Sign in with Google").click();
    await allSet(returning);
    // The same account, now with a second gateway: nothing was created.
    expect(await cabin.finish(signingIn)).toBe(firstAccount);

    // ── "I already have one", with an identity that has none ────────────────────────────────
    const studio = await gateway("studio");
    const mistaken = await studio.start("existing");
    const stranger = await person();
    googleSubject = "fictional-newcomer";
    await stranger.goto(mistaken.authorizeUrl);
    await button(stranger, "Sign in with Google").click();
    await expect(stranger.getByRole("alert")).toHaveText(`${NO_ACCOUNT} You can create one below.`);
    // Back on the same request, still on its sign-in view, with nothing created or approved.
    await expect(stranger).toHaveURL(
      `${origin}/_relay/account?failed=no-account&signup=${mistaken.redemption.operationId}`,
    );
    await expect(heading(stranger, "Sign in to your Omnesis account")).toBeVisible();
    expect(await studio.poll(mistaken)).toMatchObject({ status: "pending" });
    expect(accounts.identities.gatewayAccount(studio.owner)).toBeUndefined();
    await stranger.screenshot({
      path: test.info().outputPath("account-no-account-mobile.png"),
      fullPage: true,
    });
    // The same sign-in on the plain account page is told where an account is created.
    const elsewhere = await person();
    await plainSignIn(elsewhere);
    await expect(elsewhere.getByRole("alert")).toHaveText(
      `${NO_ACCOUNT} Create one from your gateway: open its portal, then Settings and Omnesis account.`,
    );
    await expect(heading(elsewhere, "Sign in to your Omnesis account")).toBeVisible();
    await expect(heading(elsewhere, "Sign-in methods")).toHaveCount(0);
    // The person says they want an account after all, and the same Google identity creates it.
    await button(stranger, "Create an account instead").click();
    await expect(heading(stranger, "Create your Omnesis account")).toBeVisible();
    await button(stranger, "Create with Google").click();
    await allSet(stranger);
    const secondAccount = await studio.finish(mistaken);
    expect(secondAccount).not.toBe(firstAccount);
    // That identity now signs in on the plain page, and sees its gateway.
    await plainSignIn(elsewhere);
    await expect(heading(elsewhere, "Your gateways")).toBeVisible();
    await expect(elsewhere.locator("a.gateway .row-meta")).toHaveText("studio.example.test");

    // ── Starting over: the gateway leaves its account and creates a different one ───────────
    await studio.unlink();
    const again = await studio.start("create");
    const successor = await person();
    googleSubject = "fictional-successor";
    await successor.goto(again.authorizeUrl);
    await button(successor, "Create with Google").click();
    await allSet(successor);
    const thirdAccount = await studio.finish(again);
    expect([firstAccount, secondAccount]).not.toContain(thirdAccount);
    // The account the gateway created before had no gateway left, so it is gone: its session
    // is over, and its Google sign-in finds no account.
    googleSubject = "fictional-newcomer";
    await elsewhere.reload();
    await expect(heading(elsewhere, "Sign in to your Omnesis account")).toBeVisible();
    await expect(heading(elsewhere, "Your gateways")).toHaveCount(0);
    await plainSignIn(elsewhere);
    await expect(elsewhere.getByRole("alert")).toContainText(NO_ACCOUNT);
    await expect(heading(elsewhere, "Sign-in methods")).toHaveCount(0);
    // An account that still has a gateway is not touched by any of this.
    googleSubject = "fictional-first-owner";
    const owner = await person();
    await plainSignIn(owner);
    await expect(heading(owner, "Your gateways")).toBeVisible();
    await expect(owner.locator("a.gateway")).toHaveCount(2);
    expect(accounts.identities.gatewayAccount(home.owner)?.accountId).toBe(firstAccount);
    expect(accounts.identities.gatewayAccount(cabin.owner)?.accountId).toBe(firstAccount);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await relay.close();
    accounts.close();
    google.closeAllConnections();
    await new Promise<void>((resolve) => google.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
