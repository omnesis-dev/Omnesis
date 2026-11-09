// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { fixtureBrowser, registeredPasskey, signInOnOperation } from "../test/operation-sign-in.js";
import { tlsFiles, listen } from "../test/support.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions, accountId } from "./identity.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { ACCOUNT_BROWSER_PROTOCOL, accountBrowserTranscript } from "./account-browser-contract.js";
import { gatewayKeyAccount, gatewayKeyIdentity, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";

const origin = "https://relay.example.test",
  cleanup: (() => Promise<void>)[] = [];
let directory: string, certificate: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-account-browser-http-"));
  certificate = await readFile(tlsFiles(directory, "*.example.test").certFile, "utf8");
});
afterAll(async () => rm(directory, { recursive: true, force: true }));
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  google = false,
  recoveryPolicy?: Parameters<typeof createCloudRelay>[0]["recoveryPolicy"],
) {
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const authority = new AccountEnrollmentAuthority(
    origin,
    generateKeyPairSync("ed25519").privateKey,
  );
  const key = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID(),
    ownerPublicKey = key.publicKey.export({ format: "pem", type: "spki" }).toString();
  const owner = {
    ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    tlsSpkiFingerprint: tlsSpkiFingerprint(certificate),
    ownerPublicKey,
  };
  accounts.registerKeyBinding(
    owner.ownerAccountId,
    {
      gatewayId,
      publicOrigin: owner.publicOrigin,
      certificate,
      identityToken:
        KEY_BINDING_PREFIX +
        key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    },
    true,
  );
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    accountSignIn: { enrollmentAuthority: authority },
    recoveryPolicy,
    ...(google
      ? {
          webLogin: {
            clientId: "fictional-web-client",
            clientSecret: "fictional-server-secret",
            publicOrigin: origin,
            identity: {
              verify: async () => ({
                issuer: "https://accounts.google.com",
                subject: "fictional-browser-account",
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              }),
            },
            fetch: async () => Response.json({ id_token: "fictional-token", token_type: "Bearer" }),
          },
        }
      : {}),
  });
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  const session = await sessions.issue(
    gatewayKeyIdentity({ gatewayId, ownerPublicKey }, Math.floor(Date.now() / 1000) + 3600),
  );
  const accountId = accounts.identities.signInFederated("google", "a".repeat(64)),
    account = await sessions.issueAccountSession({ accountId, version: 1 }, "passkey", origin);
  accounts.identities.registerSession(
    account.accountId,
    account.version,
    account.sessionId,
    account.expiresAt,
  );
  const ownerHeaders = {
    authorization: `Bearer ${session.token}`,
    "content-type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(url + "/_relay/v3/account-browser/" + path, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify(body),
      redirect: "manual",
    });
  const begin = async (purpose: "owner-link" | "device-enrollment" = "owner-link") => {
    const now = Math.floor(Date.now() / 1000),
      redemptionSecret = randomBytes(32).toString("base64url");
    const unsigned = {
      protocol: ACCOUNT_BROWSER_PROTOCOL,
      operationId: randomUUID(),
      purpose,
      nonce: randomBytes(32).toString("base64url"),
      callbackUrl:
        purpose === "owner-link"
          ? "https://local.example.test/admin/cloud-relay/account/callback"
          : "https://gateway.example.test/devices/account/callback",
      browserState: randomBytes(32).toString("base64url"),
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt: now,
      expiresAt: now + 300,
    };
    const started = await post("start", {
      ...unsigned,
      ownerSignature: sign(
        null,
        accountBrowserTranscript(origin, owner, unsigned),
        key.privateKey,
      ).toString("base64url"),
    });
    expect(started.status).toBe(200);
    const intent = await started.json(),
      launchUrl = new URL(intent.authorizeUrl);
    const launch = await fetch(url + launchUrl.pathname + launchUrl.search, { redirect: "manual" });
    expect(launch.status).toBe(303);
    const operationCookie = launch.headers.getSetCookie()[0]!.split(";")[0]!;
    const page = await fetch(url + launch.headers.get("location"), {
      headers: { cookie: operationCookie },
    });
    const browser = page.headers.getSetCookie()[0]!.split(";")[0]!;
    await signInOnOperation(
      url,
      `?operation=${unsigned.operationId}`,
      operationCookie,
      await registeredPasskey(accounts.identities, account),
    );
    return {
      unsigned,
      redemptionSecret,
      intent,
      operationCookie,
      cookie: `${operationCookie}; ${browser}; __Host-omnesis-account=${account.token}`,
    };
  };
  return { accounts, account, owner, ownerHeaders, relay, url, post, begin, sessions };
}

test("a gateway owner starts a browser-bound intent and the signed-in user explicitly confirms its account association", async () => {
  const f = await fixture(),
    value = await f.begin();
  const path = `/_relay/account/api/session?operation=${value.unsigned.operationId}`;
  const beforeLogin = await (
    await fetch(f.url + path, { headers: { cookie: value.operationCookie } })
  ).json();
  expect(beforeLogin).toMatchObject({
    authenticated: false,
    pending: { purpose: "owner-link", hostname: "gateway.example.test" },
  });
  const status = await (await fetch(f.url + path, { headers: { cookie: value.cookie } })).json();
  expect(status).toMatchObject({ authenticated: true, pending: { purpose: "owner-link" } });
  expect(f.accounts.identities.gatewayAccount(f.owner.ownerAccountId)).toBeUndefined();
  const confirm = await fetch(
    f.url + `/_relay/account/api/continue?operation=${value.unsigned.operationId}`,
    {
      method: "POST",
      headers: { origin, cookie: value.cookie, "content-type": "application/json" },
      body: "{}",
    },
  );
  expect(confirm.status).toBe(200);
  expect(confirm.headers.getSetCookie()[0]).toContain("Max-Age=0");
  const callback = new URL((await confirm.json()).location);
  expect(callback.origin).toBe("https://local.example.test");
  expect(f.accounts.identities.gatewayAccount(f.owner.ownerAccountId)?.accountId).toBe(
    f.account.accountId,
  );
  const redeemed = await f.post("redeem", {
    operationId: value.unsigned.operationId,
    result: callback.searchParams.get("result"),
    redemptionSecret: value.redemptionSecret,
  });
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toMatchObject({ accountId: f.account.accountId });
  expect(
    (
      await f.post("redeem", {
        operationId: value.unsigned.operationId,
        result: callback.searchParams.get("result"),
        redemptionSecret: value.redemptionSecret,
      })
    ).status,
  ).toBe(410);
});

test("owner-control and browser confirmation boundaries refuse ambient sessions, invalid launches and oversized input", async () => {
  const f = await fixture(),
    value = await f.begin(),
    path = "/_relay/v3/account-browser/";
  expect(
    (
      await fetch(f.url + path + "start", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: value.cookie },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(f.url + path + "start", {
        method: "POST",
        headers: { ...f.ownerHeaders, authorization: `Bearer ${f.account.token}` },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect((await fetch(f.url + path + "start")).status).toBe(405);
  expect((await f.post("unknown", {})).status).toBe(404);
  expect((await f.post("start?unexpected=1", {})).status).toBe(400);
  expect(
    (
      await fetch(f.url + path + "start", {
        method: "POST",
        headers: { ...f.ownerHeaders, "content-type": "text/plain" },
        body: "{}",
      })
    ).status,
  ).toBe(415);
  expect((await f.post("start", { oversized: "x".repeat(8192) })).status).toBe(413);
  expect(
    (await fetch(f.url + path + "start", { method: "POST", headers: f.ownerHeaders, body: "{" }))
      .status,
  ).toBe(400);
  for (const query of [
    "",
    "?operationId=bad&ticket=bad",
    `?operationId=${value.unsigned.operationId}&operationId=${value.unsigned.operationId}&ticket=bad`,
  ])
    expect((await fetch(f.url + path + "begin" + query, { redirect: "manual" })).status).toBe(400);
  expect((await f.post("begin", {})).status).toBe(405);
  expect((await fetch(f.url + path + `begin?oversized=${"x".repeat(4096)}`)).status).toBe(414);
  expect((await f.post("cancel", {})).status).toBe(400);
  expect((await f.post("cancel", { operationId: value.unsigned.operationId })).status).toBe(200);
  const continuation = (query: string, cookie = value.cookie) =>
    fetch(f.url + "/_relay/account/api/continue" + query, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: "{}",
    });
  expect((await continuation("")).status).toBe(400);
  expect((await continuation("?operation=invalid")).status).toBe(400);
  expect(
    (
      await continuation(
        `?operation=${value.unsigned.operationId}&operation=${value.unsigned.operationId}`,
      )
    ).status,
  ).toBe(400);
  expect(
    (await continuation(`?operation=${value.unsigned.operationId}`, value.operationCookie)).status,
  ).toBe(401);
  expect(
    (
      await fetch(f.url + `/_relay/account/api/continue?operation=${value.unsigned.operationId}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect((await continuation(`?operation=${value.unsigned.operationId}`)).status).toBe(410);
});

test("Google OAuth returns to the same pending account intent, creating an account only once the person chose to", async () => {
  const f = await fixture(true),
    value = await f.begin(),
    operation = `operation=${value.unsigned.operationId}`;
  const google = async () => {
    const start = await fetch(f.url + `/_relay/web/start?${operation}`, {
      method: "POST",
      headers: { origin, cookie: value.cookie },
      redirect: "manual",
    });
    expect(start.status).toBe(303);
    const authorization = new URL(start.headers.get("location")!);
    const googleCookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    return fetch(
      f.url +
        `/_relay/web/callback?state=${authorization.searchParams.get("state")}&code=fictional-code`,
      { headers: { cookie: value.cookie + "; " + googleCookie }, redirect: "manual" },
    );
  };
  const intent = (body: unknown, query = `?${operation}`, cookie = value.cookie) =>
    fetch(f.url + "/_relay/account/api/intent" + query, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const before = f.accounts.identities.snapshot();
  // Linking starts as a sign-in, and a sign-in no account uses creates nothing.
  const refused = await google();
  expect(refused.status).toBe(303);
  expect(refused.headers.get("location")).toBe(
    origin + `/_relay/account?failed=no-account&${operation}`,
  );
  expect(refused.headers.getSetCookie().some((header) => header.includes("omnesis-account="))).toBe(
    false,
  );
  expect(f.accounts.identities.snapshot()).toEqual(before);
  expect((await intent({ intent: "anything" })).status).toBe(400);
  expect((await intent({ intent: "create", extra: true })).status).toBe(400);
  expect((await intent({ intent: "create" }, `?${operation}`, "")).status).toBe(403);
  expect((await intent({ intent: "create" })).status).toBe(200);
  expect((await intent({ intent: "existing" })).status).toBe(200);
  expect((await google()).headers.get("location")).toContain("failed=no-account");
  expect(f.accounts.identities.snapshot()).toEqual(before);
  // A passkey can't create one from the sign-in view either.
  const signedOut = `${value.operationCookie}; ${fixtureBrowser()}`;
  const offered = async () =>
    (
      await (
        await fetch(f.url + `/_relay/account/api/session?${operation}`, {
          headers: { cookie: signedOut },
        })
      ).json()
    ).canCreateAccount;
  const createWithPasskey = () =>
    fetch(f.url + `/_relay/account/api/passkeys/register/options?${operation}`, {
      method: "POST",
      headers: { origin, cookie: signedOut, "content-type": "application/json" },
      body: JSON.stringify({ createAccount: true }),
    });
  expect(await offered()).toBe(false);
  expect((await createWithPasskey()).status).toBe(403);
  // The person chose to create an account on the page.
  const chosen = await intent({ intent: "create" });
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toEqual({ ok: true });
  expect(await offered()).toBe(true);
  expect((await createWithPasskey()).status).toBe(200);
  const callback = await google();
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe(origin + `/_relay/account?${operation}`);
  expect(f.accounts.identities.snapshot().identityAccounts).toBe(before.identityAccounts + 1);
  expect(f.accounts.identities.gatewayAccount(f.owner.ownerAccountId)).toBeUndefined();
  const cookie = callback.headers
    .getSetCookie()
    .find((header) => header.startsWith("__Host-omnesis-account="))!
    .split(";")[0]!;
  const status = await fetch(
    f.url + `/_relay/account/api/session?operation=${value.unsigned.operationId}`,
    { headers: { cookie: `${value.operationCookie}; ${cookie}` } },
  );
  expect(await status.json()).toMatchObject({
    authenticated: true,
    pending: { purpose: "owner-link", hostname: "gateway.example.test", intent: "create" },
  });
  expect(
    (await fetch(f.url + `/_relay/account/api/session?operation=${value.unsigned.operationId}`))
      .status,
  ).toBe(403);
  expect(
    (
      await fetch(f.url + `/_relay/web/start?operation=${value.unsigned.operationId}`, {
        method: "POST",
        headers: { origin },
        redirect: "manual",
      })
    ).status,
  ).toBe(403);
});

test("signing in where nothing can create an account creates none: the plain page, pairing a device and a desktop", async () => {
  const f = await fixture(true);
  const page = await fetch(f.url + "/_relay/account");
  const browser = page.headers.getSetCookie()[0]!.split(";")[0]!;
  const device = await f.begin("device-enrollment");
  const started = await (
    await fetch(f.url + "/_relay/v3/desktop/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "cli",
        name: "Fictional terminal",
        nonce: randomBytes(32).toString("base64url"),
        challenge: randomBytes(32).toString("base64url"),
      }),
    })
  ).json();
  const authorize = new URL(started.authorizeUrl);
  const launch = await fetch(f.url + authorize.pathname + authorize.search, { redirect: "manual" });
  expect(launch.status).toBe(303);
  const desktop = launch.headers.getSetCookie()[0]!.split(";")[0]!;
  const before = f.accounts.identities.snapshot();
  for (const [query, cookie, intentRefusal] of [
    ["", browser, 400],
    [`operation=${device.unsigned.operationId}`, device.operationCookie, 400],
    [`desktop=${started.operationId}`, desktop, 400],
  ] as const) {
    const search = query ? `?${query}` : "";
    const google = async () => {
      const start = await fetch(f.url + "/_relay/web/start" + search, {
        method: "POST",
        headers: { origin, cookie },
        redirect: "manual",
      });
      expect(start.status).toBe(303);
      const state = new URL(start.headers.get("location")!).searchParams.get("state");
      const googleCookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
      return fetch(f.url + `/_relay/web/callback?state=${state}&code=fictional-code`, {
        headers: { cookie: `${cookie}; ${googleCookie}` },
        redirect: "manual",
      });
    };
    const switching = async () => {
      const response = await fetch(f.url + "/_relay/account/api/intent" + search, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ intent: "create" }),
      });
      expect([query, response.status]).toEqual([query, intentRefusal]);
    };
    const refused = async () => {
      const callback = await google();
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe(
        origin + "/_relay/account?failed=no-account" + (query ? `&${query}` : ""),
      );
      expect(
        callback.headers
          .getSetCookie()
          .some((value) => value.startsWith("__Host-omnesis-account=")),
      ).toBe(false);
      expect(f.accounts.identities.snapshot()).toEqual(before);
    };
    // Nothing here can be switched to creating one, and asking changes nothing.
    await switching();
    await refused();
    const session = await (
      await fetch(f.url + "/_relay/account/api/session" + search, { headers: { cookie } })
    ).json();
    expect(session.canCreateAccount).toBe(false);
    expect(session.pending ?? {}).not.toHaveProperty("intent");
    expect(
      (
        await fetch(f.url + "/_relay/account/api/passkeys/register/options" + search, {
          method: "POST",
          headers: {
            origin,
            cookie: cookie === browser ? cookie : `${cookie}; ${browser}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ createAccount: true }),
        })
      ).status,
    ).toBe(403);
    expect(f.accounts.identities.snapshot()).toEqual(before);
  }
});

test("logging out after confirmation prevents redeeming a pending account handoff", async () => {
  const f = await fixture(),
    value = await f.begin();
  const headers = { origin, cookie: value.cookie, "content-type": "application/json" };
  const confirmed = await fetch(
    f.url + `/_relay/account/api/continue?operation=${value.unsigned.operationId}`,
    { method: "POST", headers, body: "{}" },
  );
  expect(confirmed.status).toBe(200);
  const callback = new URL((await confirmed.json()).location);
  expect(
    (await fetch(f.url + "/_relay/account/api/logout", { method: "POST", headers, body: "{}" }))
      .status,
  ).toBe(200);
  expect(
    (
      await f.post("redeem", {
        operationId: value.unsigned.operationId,
        result: callback.searchParams.get("result"),
        redemptionSecret: value.redemptionSecret,
      })
    ).status,
  ).toBe(401);
});

test("owner-controlled unlink removes the gateway from its account with its registration, and rejects unrecognized options", async () => {
  const f = await fixture(),
    value = await f.begin();
  const headers = { origin, cookie: value.cookie, "content-type": "application/json" };
  expect(
    (
      await fetch(f.url + `/_relay/account/api/continue?operation=${value.unsigned.operationId}`, {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect((await f.post("unlink", { unrecognized: true })).status).toBe(400);
  expect(f.accounts.identities.gatewayAccount(f.owner.ownerAccountId)).toBeDefined();
  expect((await f.post("unlink", {})).status).toBe(200);
  expect(f.accounts.identities.gatewayAccount(f.owner.ownerAccountId)).toBeUndefined();
  // Disconnecting is complete: the gateway keeps no public address without an account.
  expect(f.accounts.gatewayBinding(f.owner.ownerAccountId)).toBeUndefined();
  expect(f.accounts.registered(f.owner.ownerAccountId)).toBe(false);
  // Its session is now a session of nothing, so asking again is refused.
  expect((await f.post("unlink", {})).status).toBe(403);
});

test("owner signatures can recover an untrusted restored account association while valid associations remain protected", async () => {
  for (const mode of ["invalid", "other-root", "trusted"]) {
    const f = await fixture(),
      other = f.accounts.identities.signInFederated("google", "b".repeat(64));
    const signer = mode === "trusted" ? f.sessions : new RelaySessions(randomBytes(32));
    const seal =
      mode === "invalid"
        ? "a".repeat(43)
        : signer.sealAccountGatewayLink(origin, other, f.owner.ownerAccountId);
    f.accounts.identities.linkGateway(other, f.owner.ownerAccountId, seal);
    const value = await f.begin();
    const response = await fetch(
      f.url + `/_relay/account/api/continue?operation=${value.unsigned.operationId}`,
      {
        method: "POST",
        headers: { origin, cookie: value.cookie, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(mode === "trusted" ? 403 : 200);
    expect(f.accounts.identities.gatewayAccount(f.owner.ownerAccountId)?.accountId).toBe(
      mode === "trusted" ? other : f.account.accountId,
    );
  }
});

test("slow owner-control bodies hit their deadline and release authentication admission", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let reading = false;
  f.relay.server.on("request", (request) => {
    const iterator = request.iterator.bind(request);
    request.iterator = (options) => {
      reading = true;
      return iterator(options);
    };
  });
  const failed = new Promise<Error>((resolve, reject) => {
    const request = httpRequest(
      f.url + "/_relay/v3/account-browser/start",
      { method: "POST", headers: f.ownerHeaders },
      () => reject(new Error("Incomplete body returned a response")),
    );
    request.on("error", resolve);
    request.write("{");
  });
  await vi.waitFor(() => expect(f.relay.metrics()).toContain("cloud_relay_active_logins 1"));
  await vi.waitFor(() => expect(reading).toBe(true));
  await vi.advanceTimersByTimeAsync(5001);
  expect(await failed).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(f.relay.metrics()).toContain("cloud_relay_active_logins 0"));
});

test("account owner controls reject routing identities, unregistered keys and legacy unverified registry bindings", async () => {
  const f = await fixture();
  expect(() =>
    createCloudRelay({ accounts: f.accounts, sessions: f.sessions, accountSignIn: {} }),
  ).toThrow("control origin");
  const google = {
    issuer: "https://accounts.google.com",
    subject: "fictional-routing-account",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  f.accounts.linkGoogleAccount(accountId(google), f.owner.ownerAccountId);
  const routing = await f.sessions.issue(google);
  const control = (token: string) =>
    fetch(f.url + "/_relay/v3/account-browser/start", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
  expect((await control(routing.token)).status).toBe(403);
  const key = generateKeyPairSync("ed25519"),
    unknown = await f.sessions.issue(
      gatewayKeyIdentity(
        {
          gatewayId: randomUUID(),
          ownerPublicKey: key.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
        Math.floor(Date.now() / 1000) + 3600,
      ),
    );
  expect((await control(unknown.token)).status).toBe(403);
  f.accounts.registerBinding(f.owner.ownerAccountId, {
    ...f.accounts.gatewayBinding(f.owner.ownerAccountId)!,
    identityToken: "historical-google-attestation",
  });
  expect((await f.post("start", {})).status).toBe(403);
});
test("account discovery enforces the independent recovery policy before returning any gateway metadata", async () => {
  const recovery = await recoveryFixture(await mkdtemp(join(directory, "account-policy-"))),
    f = await fixture(false, recovery.policy());
  const discovery = await f.sessions.issueAccountDiscovery(
    f.account,
    randomBytes(32).toString("base64url"),
    origin,
  );
  const request = () =>
    fetch(f.url + "/_relay/v3/gateways", {
      headers: { authorization: `Bearer ${discovery.discoveryToken}` },
    });
  expect((await request()).status).toBe(200);
  vi.useFakeTimers({ toFake: ["Date"], now: (recovery.policy().expiresAt + 1) * 1000 });
  expect((await request()).status).toBe(503);
});
