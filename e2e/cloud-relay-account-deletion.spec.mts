// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createCloudRelay,
  RelayAccounts,
  RelaySessions,
  AccountEnrollmentAuthority,
  ACCOUNT_BROWSER_PROTOCOL,
  accountBrowserTranscript,
  accountBrowserStarted,
  gatewayKeyAccount,
  gatewayKeyIdentity,
  hostedGatewayHostname,
  tlsSpkiFingerprint,
  KEY_BINDING_PREFIX,
} from "@omnesis/cloud-relay";
import type { AddressInfo } from "node:net";

const origin = "https://relay.example.test";
const DELETION_LINES = [
  "All your gateways are disconnected from this account and can no longer be reached from outside your home network.",
  "New devices can no longer join by signing in.",
  "Devices you already paired keep working on your home network.",
  "Your sign-in methods and everything this service stores about your account are deleted.",
  "This can't be undone. You can create a new account later from a gateway.",
];

/** The mark sits before the name, sized to it and centred, and is skipped by assistive technology. */
async function expectBrand(page: Page) {
  const brand = page.locator("main > .brand");
  await expect(brand).toHaveText("Omnesis");
  const mark = brand.locator("svg.brand-mark");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  const layout = await brand.evaluate((element) => {
    const svg = element.querySelector("svg")!.getBoundingClientRect(),
      range = document.createRange();
    range.selectNodeContents(element.lastChild!);
    const text = range.getBoundingClientRect(),
      column = element.parentElement!.getBoundingClientRect();
    return {
      offCentre: Math.abs((svg.left + text.right) / 2 - (column.left + column.right) / 2),
      width: svg.width,
      height: svg.height,
      gap: text.left - svg.right,
      centres: Math.abs((svg.top + svg.bottom) / 2 - (text.top + text.bottom) / 2),
      textHeight: text.height,
      fill: getComputedStyle(element.querySelector("path")!).fill,
    };
  });
  expect(layout.width).toBe(32);
  expect(layout.height).toBe(32);
  expect(layout.gap).toBe(10);
  expect(layout.offCentre).toBeLessThanOrEqual(1);
  // Level with the word, and no taller than a line of it.
  expect(layout.centres).toBeLessThanOrEqual(1.5);
  expect(layout.height).toBeLessThanOrEqual(layout.textHeight + 6);
  return layout.fill;
}

test("a person deletes their Omnesis account from the account page, after a fresh confirmation, and no sign-in finds it afterwards", async ({
  playwright,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-browser-deletion-"));
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
  const ownerKey = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID(),
    hostname = hostedGatewayHostname(gatewayId, "relay.example.test");
  const ownerPublicKey = ownerKey.publicKey.export({ format: "pem", type: "spki" }).toString();
  const certificate = await readFile(certFile, "utf8");
  const owner = {
    ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    gatewayId,
    publicOrigin: `https://${hostname}`,
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
  // Shaped like a Google token; the fixture provider below is what vouches for it.
  const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = `${encoded({ alg: "none" })}.${encoded({ iat: Math.floor(Date.now() / 1000) })}.`;
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    relayDomain: "relay.example.test",
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
      signup: { policy: "open" },
    },
    webLogin: {
      publicOrigin: origin,
      clientId: "fictional-web-client",
      clientSecret: "fictional-backend-secret",
      identity: {
        verify: async () => ({
          issuer: "https://accounts.google.com",
          subject: "fictional-deleting-person",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      },
      fetch: async () => Response.json({ id_token: idToken, token_type: "Bearer" }),
    },
    tls: { key: await readFile(keyFile, "utf8"), cert: certificate },
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as AddressInfo).port;
  // Google's own pages are not part of this test: its consent screen answers at once.
  const google = createHttpsServer(
    { key: await readFile(keyFile, "utf8"), cert: certificate },
    (request, response) => {
      const authorization = new URL(request.url!, "https://accounts.google.com");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        code: "fictional-google-code",
        state: authorization.searchParams.get("state")!,
      }).toString();
      response.writeHead(303, { location: callback.href });
      response.end();
    },
  );
  google.listen(0, "127.0.0.1");
  await once(google, "listening");
  const googlePort = (google.address() as AddressInfo).port;
  let restoreClock = () => {};
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--ignore-certificate-errors",
      "--no-proxy-server",
      `--host-resolver-rules=MAP relay.example.test:443 127.0.0.1:${port}, MAP accounts.google.com:443 127.0.0.1:${googlePort}, MAP * ~NOTFOUND`,
    ],
  });
  try {
    const ownerSession = await sessions.issue(
      gatewayKeyIdentity({ gatewayId, ownerPublicKey }, Math.floor(Date.now() / 1000) + 3600),
    );
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
    const start = await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const payload = JSON.stringify({
        ...unsigned,
        ownerSignature: sign(
          null,
          accountBrowserTranscript(origin, owner, unsigned),
          ownerKey.privateKey,
        ).toString("base64url"),
      });
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/_relay/v3/account-browser/start",
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
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
    expect(start.status).toBe(200);
    const pending = accountBrowserStarted.parse(start.value);

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
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
    const errors: string[] = [],
      refusedByPolicy: string[] = [],
      requested = new Set<string>();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) refusedByPolicy.push(message.text());
    });
    page.on("request", (request) => requested.add(new URL(request.url()).origin));
    // The gateway is not running here; its portal is only where the link flow ends.
    await context.route(`${owner.publicOrigin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "Fixture gateway" }),
    );
    const shot = async (name: string) => {
      const path = test.info().outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await test.info().attach(name, { path, contentType: "image/png" });
    };

    // ── The mark on every page a person sees ────────────────────────────────
    const fills = new Set<string>();
    for (const [path, name] of [
      ["/_relay/account", "signin"],
      ["/_relay/connect", "connect"],
      ["/_relay/v3/signup/complete", "signup-complete"],
      ["/_relay/v3/desktop/complete", "desktop-complete"],
    ] as const) {
      await page.goto(origin + path);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const [width, size] of [
          [390, "mobile"],
          [1440, "desktop"],
        ] as const) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          fills.add(`${scheme}:${await expectBrand(page)}`);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
          await shot(`brand-${name}-${size}-${scheme}`);
        }
      }
    }
    // The portal's blue in each colour scheme.
    expect([...fills].sort()).toEqual(["dark:rgb(88, 166, 255)", "light:rgb(31, 111, 235)"]);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });

    // ── An account with a passkey, Google and one gateway ───────────────────
    await page.goto(pending.authorizeUrl);
    await page.getByRole("button", { name: "Create an account instead", exact: true }).click();
    await expectBrand(page);
    await page.getByRole("button", { name: "Create with a passkey", exact: true }).click();
    // Pressing to connect links the gateway, and the page leaves for it.
    await page.getByRole("button", { name: "Connect this gateway", exact: true }).click();
    await page.waitForURL(`${owner.publicOrigin}/**`);
    await page.goto(origin + "/_relay/account");
    await expect(page.getByRole("heading", { name: "Your gateways", exact: true })).toBeVisible();
    await expect(page.locator("a.gateway .row-meta")).toHaveText(hostname);
    await page.getByRole("button", { name: "Link Google", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Google linked. You can now sign in with Google.",
    );
    const cookie = async () =>
      (await context.cookies()).find((value) => value.name === "__Host-omnesis-account");
    const account = await sessions.verifyAccountSession((await cookie())!.value, origin);
    expect(accounts.identities.list(account.accountId)).toMatchObject({
      federated: [{ provider: "google" }],
      passkeys: [{}],
    });
    expect(accounts.identities.gatewayAccount(owner.ownerAccountId)?.accountId).toBe(
      account.accountId,
    );

    // ── Deleting is out of the way, explained, and never one press ──────────
    await expectBrand(page);
    const panel = page.locator("section.delete-account"),
      moreOptions = page.getByRole("button", { name: "More options", exact: true }),
      menu = page.getByRole("menu", { name: "More options", exact: true }),
      accountHeading = page.getByRole("heading", { name: "Your Omnesis account", exact: true }),
      question = page.getByRole("heading", { name: "Delete your Omnesis account?", exact: true });
    await expect(accountHeading).toBeVisible();
    // Nothing on the page itself deletes or signs out: both are behind the button in the corner.
    await expect(panel).toHaveCount(0);
    await expect(page.getByText("Delete", { exact: false })).toBeHidden();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    await expect(moreOptions).toHaveAttribute("aria-haspopup", "menu");
    await expect(moreOptions).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    await shot("account-page-mobile-light");
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    /** Opens the menu with the keyboard and picks its second entry. */
    const askToDelete = async () => {
      await moreOptions.focus();
      await page.keyboard.press("Enter");
      await expect(moreOptions).toHaveAttribute("aria-expanded", "true");
      await expect(menu.getByRole("menuitem")).toHaveText(["Sign out", "Delete account"]);
      await expect(menu.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", { name: "Delete account", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(question).toBeFocused();
    };
    // The menu opens inside the page, under its button in the top right corner.
    await moreOptions.click();
    const placed = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect(),
        button = box(".more-button"),
        list = box(".more-list"),
        brand = box(".brand svg"),
        name = document.createRange();
      name.selectNodeContents(document.querySelector(".brand")!.lastChild!);
      return {
        right: document.documentElement.clientWidth - button.right,
        top: button.top,
        level: Math.abs((button.top + button.bottom) / 2 - (brand.top + brand.bottom) / 2),
        clear: button.left > name.getBoundingClientRect().right,
        inside: list.left >= 0 && list.right <= document.documentElement.clientWidth,
        below: list.top >= button.bottom,
      };
    });
    expect(placed).toMatchObject({ right: 4, clear: true, inside: true, below: true });
    expect(placed.top).toBeLessThan(60);
    expect(placed.level).toBeLessThanOrEqual(1);
    await shot("more-options-mobile-light");
    // Escape closes it and returns to the button; so does a press anywhere else.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(moreOptions).toBeFocused();
    await moreOptions.click();
    await page.getByRole("heading", { name: "Sign-in methods", exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(moreOptions).toBeFocused();
    await askToDelete();
    await expect(accountHeading).toHaveCount(0);
    await expect(moreOptions).toHaveCount(0);
    await expect(panel.locator("> p").first()).toHaveText(
      "Disconnects your gateways from this account and deletes everything this service stores about it.",
    );
    await expect(panel.getByRole("listitem")).toHaveText(DELETION_LINES);
    // The sign-in is minutes old, so only the last press is left, and it can still be called off.
    await expect(
      panel.getByRole("button", { name: "Delete account permanently", exact: true }),
    ).toBeEnabled();
    await shot("delete-confirm-fresh-mobile-light");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(accountHeading).toBeVisible();
    await expect(moreOptions).toBeFocused();
    expect(accounts.identities.sessionVersion(account.accountId)).toBeDefined();

    // ── Six minutes on, the session cookie alone deletes nothing ────────────
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    restoreClock = () => {
      Date.now = realNow;
    };
    await page.reload();
    await expect(accountHeading).toBeVisible();
    const direct = await page.evaluate(async (accountId) => {
      const response = await fetch("/_relay/account/api/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      return response.status;
    }, account.accountId);
    expect(direct).toBe(401);
    expect(accounts.identities.sessionVersion(account.accountId)).toBeDefined();
    await askToDelete();
    await expect(panel.getByRole("listitem")).toHaveText(DELETION_LINES);
    await expect(
      panel.getByRole("heading", { name: "Confirm it's you", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText(
        "Deleting your account needs a fresh confirmation, so that someone else using this browser can't delete it. Nothing is deleted until you press Delete account afterwards.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Delete account permanently", exact: true }),
    ).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveText([
      "Confirm with passkey",
      "Confirm with Google",
      "Cancel",
    ]);
    // At phone width nothing overflows and every control is large enough to tap.
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          [...document.querySelectorAll("button")].every(
            (button) => button.getBoundingClientRect().height >= 44,
          ),
      ),
    ).toBe(true);
    await shot("delete-confirm-identity-mobile-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot("delete-confirm-identity-desktop-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });

    // A Google confirmation comes back to the page, which then waits for the person again.
    await panel.getByRole("button", { name: "Confirm with Google", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Confirmed. You can delete your account now.",
    );
    expect(new URL(page.url()).search).toBe("");
    await expect(panel).toHaveCount(0);
    expect(accounts.identities.sessionVersion(account.accountId)).toBeDefined();

    // Stale once more, this time confirmed with the passkey: still nothing is deleted by it.
    Date.now = () => realNow() + 12 * 60_000;
    await page.reload();
    await askToDelete();
    await panel.getByRole("button", { name: "Confirm with passkey", exact: true }).click();
    const final = panel.getByRole("button", { name: "Delete account permanently", exact: true });
    await expect(final).toBeEnabled();
    await expect(panel.getByRole("heading", { name: "Confirm it's you", exact: true })).toHaveCount(
      0,
    );
    await expect(panel.getByRole("listitem")).toHaveText(DELETION_LINES);
    expect(accounts.identities.sessionVersion(account.accountId)).toBeDefined();
    expect(accounts.gatewayBinding(owner.ownerAccountId)).toBeDefined();
    await shot("delete-confirm-final-mobile-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot("delete-confirm-final-mobile-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // ── The last press ──────────────────────────────────────────────────────
    await final.click();
    await expect(page.getByRole("status")).toHaveText("Your Omnesis account was deleted.");
    await expect(
      page.getByRole("heading", { name: "Sign in to your Omnesis account", exact: true }),
    ).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expectBrand(page);
    await shot("deleted-mobile-light");
    expect(await cookie()).toBeUndefined();
    expect(dialogs).toBe(0);
    // Nothing of the account or its gateway is left on the relay.
    expect(accounts.identities.sessionVersion(account.accountId)).toBeUndefined();
    expect(accounts.identities.snapshot()).toEqual({
      identityAccounts: 0,
      identityPasskeys: 0,
      identityFederatedCredentials: 0,
      identityGatewayLinks: 0,
      identityActiveSessions: 0,
    });
    expect(accounts.snapshot()).toMatchObject({ accounts: 0, gatewayBindings: 0, googleLinks: 0 });
    expect(accounts.gatewayBinding(owner.ownerAccountId)).toBeUndefined();
    expect(accounts.accountForHostname(hostname)).toBeUndefined();
    // The address is not handed to anyone else either.
    expect(accounts.hostnameAvailable(hostname, randomUUID())).toBe(false);
    const session = await page.evaluate(async () =>
      (await fetch("/_relay/account/api/session")).json(),
    );
    expect(session).toMatchObject({ authenticated: false });

    // ── Signing in again finds no account ───────────────────────────────────
    await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).click();
    // Either the relay refuses the passkey, or the browser already dropped it when told to.
    await expect(page.getByRole("alert")).toHaveText(
      /^(That didn't sign you in\. The passkey may belong to an Omnesis account that no longer exists\.|No passkey was used\.)/,
    );
    await expect(page.getByRole("heading", { name: "Sign-in methods", exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "There's no Omnesis account for this sign-in. Create one from your gateway: open its portal, then Settings and Omnesis account.",
    );
    await expect(
      page.getByRole("heading", { name: "Sign in to your Omnesis account", exact: true }),
    ).toBeVisible();
    await shot("no-account-mobile-light");
    expect(accounts.identities.snapshot().identityAccounts).toBe(0);

    expect(errors).toEqual([]);
    expect(refusedByPolicy).toEqual([]);
    // Nothing was fetched from anywhere but the relay, the stand-in gateway and Google's redirect.
    expect([...requested].sort()).toEqual(
      ["https://accounts.google.com", owner.publicOrigin, origin].sort(),
    );
    await context.close();
  } finally {
    restoreClock();
    await browser.close();
    await relay.close();
    accounts.close();
    google.closeAllConnections();
    await new Promise<void>((resolve) => google.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
