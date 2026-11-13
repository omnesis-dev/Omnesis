// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { testAccountAdmission } from "../test/account-admission.js";
import { listen, closeServer } from "../test/support.js";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { AccountWeb } from "./account-web.js";
import { AccountAuthentication } from "./account-authentication.js";
import { LoginAdmission } from "./admission.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { Passkeys } from "./passkeys.js";
import { RelaySessions } from "./identity.js";
import { RelayError } from "./tunnels.js";
import { ConnectCodes } from "./connect-codes.js";
import { DesktopAccountBrowser } from "./desktop-account-browser.js";
import type { IncomingMessage } from "node:http";

const origin = "https://relay.example.test";
const noCookies = { headers: {} } as IncomingMessage;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  existingCookies?: string | string[],
  googleAvailable = false,
  desktopSignIn = false,
  signup: "trusted" | "missing" | "spent" = "trusted",
  limits?: LoginAdmission,
) {
  const db = new Database(":memory:"),
    accounts = new OmnesisAccounts(db);
  const sessions = new RelaySessions(randomBytes(32));
  const authentication = new AccountAuthentication(
    origin,
    accounts,
    sessions,
    {
      verify: async () => ({
        issuer: "https://accounts.google.com",
        subject: "fictional-web-account",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    },
    undefined,
    () => testAccountAdmission(),
  );
  const passkeys = new Passkeys(accounts, { origin });
  const desktop = desktopSignIn
    ? new DesktopAccountBrowser({
        origin,
        sessions,
        codes: new ConnectCodes(),
        assertCurrent: () => {},
        assertAccount: (actor) => {
          if (!accounts.activeSession(actor.accountId, actor.version, actor.sessionId))
            throw new RelayError(401, "Revoked account");
        },
      })
    : undefined;
  const admission = testAccountAdmission();
  // An allocation is spent for as long as its gateway is linked to the account it created.
  if (signup === "spent")
    accounts.linkGateway(
      accounts.signInFederated("fixture", "f".repeat(64), admission),
      admission.ownerAccountId,
      "c".repeat(43),
    );
  const web = new AccountWeb({
    origin,
    accounts,
    authentication,
    passkeys,
    choices: () => [],
    deleteAccount: (account, version) => void accounts.delete(account, version),
    googleAvailable,
    desktop,
    signupAdmission: signup === "missing" ? undefined : () => admission,
    admission: limits,
  });
  const server = createServer((req, res) => {
    if (existingCookies) res.setHeader("set-cookie", existingCookies);
    void web
      .handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((error: unknown) => {
        res.writeHead(error instanceof RelayError ? error.status : 500, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: "refused" }));
      });
  });
  const url = await listen(server);
  cleanup.push(async () => {
    desktop?.close();
    passkeys.close();
    await closeServer(server);
    db.close();
  });
  const page = await fetch(url + "/_relay/account");
  const browser = page.headers.getSetCookie()[0]!.split(";")[0]!;
  const post = (path: string, body: unknown, cookie = browser, requestOrigin = origin) =>
    fetch(url + "/_relay/account/api/" + path, {
      method: "POST",
      headers: { origin: requestOrigin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    url,
    browser,
    post,
    page,
    accounts,
    sessions,
    web,
    authentication,
    desktop,
    passkeys,
    admission,
  };
}

test("host-only account cookies, strict CSP and JSON CSRF boundaries protect the hosted account surface", async () => {
  const f = await fixture();
  const cookies = f.page.headers.getSetCookie();
  expect(cookies[0]).toMatch(/^__Host-omnesis-account-browser=/);
  expect(cookies[0]).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  expect(cookies[0]).not.toContain("Domain=");
  expect(f.page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await f.page.text()).toContain("account-root");
  const returning = await fetch(f.url + "/_relay/account", { headers: { cookie: f.browser } });
  expect(returning.headers.getSetCookie()).toEqual([]);
  const session = await fetch(f.url + "/_relay/account/api/session");
  expect(await session.json()).toEqual({
    authenticated: false,
    googleAvailable: false,
    canCreateAccount: true,
  });
  expect(
    (await f.post("passkeys/authenticate/options", {}, f.browser, "https://other.example.test"))
      .status,
  ).toBe(403);
  expect(
    (
      await fetch(f.url + "/_relay/account/api/logout", {
        method: "POST",
        headers: { origin },
        body: "{}",
      })
    ).status,
  ).toBe(415);
  expect((await f.post("passkeys/register/options", {})).status).toBe(401);
  expect((await f.post("passkeys/register/options", { unknown: true })).status).toBe(400);
  expect((await f.post("passkeys/authenticate/options", {}, "")).status).toBe(400);
  expect(
    (await f.post("passkeys/authenticate/options", {}, f.browser + ";" + f.browser)).status,
  ).toBe(400);
  for (const [path, mime] of [
    ["script.js", "application/javascript"],
    ["style.css", "text/css"],
    ["google-mark", "image/png"],
  ]) {
    const response = await fetch(f.url + "/_relay/account/" + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(mime);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }
});

const hasSessionCookie = (response: Response) =>
  response.headers.getSetCookie().some((value) => value.startsWith("__Host-omnesis-account="));
/** Creates a passkey for the signed-in account. It waits under the returned name. */
async function createPasskey(f: Awaited<ReturnType<typeof fixture>>, cookie: string) {
  const begin = await (await f.post("passkeys/register/options", {}, cookie)).json(),
    authenticator = passkeyAuthenticator();
  const created = await f.post(
    "passkeys/register/complete",
    {
      ceremonyId: begin.ceremonyId,
      credential: authenticator.registration(begin.options.challenge),
    },
    cookie,
  );
  expect(created.status).toBe(200);
  const { endorse } = (await created.json()) as { endorse: string };
  return { authenticator, endorse, created, userHandle: begin.options.user.id as string };
}

test("an account session adds a passkey once a sign-in vouches for it, and removes one, while unrelated cookies remain intact", async () => {
  for (const existing of ["fixture-cookie=one", ["fixture-cookie=one", "fixture-other=two"]]) {
    const f = await fixture(existing, Array.isArray(existing)),
      accountId = f.accounts.signInFederated("google", "a".repeat(64));
    const session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
    const browser = f.page.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-omnesis-account-browser="))!
      .split(";")[0]!;
    const cookie = `${browser}; __Host-omnesis-account=${session.token}`;
    const beginResponse = await f.post(
      "passkeys/register/options",
      { label: "Additional passkey" },
      cookie,
    );
    expect(beginResponse.status).toBe(200);
    const first = await createPasskey(f, cookie);
    // Creating the passkey stores nothing and signs nobody in.
    expect(first.endorse).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.created.headers.getSetCookie()).toContain("fixture-cookie=one");
    expect(hasSessionCookie(first.created)).toBe(false);
    expect(f.accounts.passkey(first.authenticator.id)).toBeUndefined();
    const confirm = (endorse: string, as = cookie) =>
      f.post(`passkeys/register/confirm?endorse=${endorse}`, {}, as);
    // The session alone can't finish it: a sign-in has to vouch first.
    expect((await confirm(first.endorse)).status).toBe(409);
    expect(f.accounts.passkey(first.authenticator.id)).toBeUndefined();
    // The account's Google sign-in vouches, as its return to the page records it.
    f.passkeys.endorsements.recordProof(first.endorse, browser, {
      type: "google",
      accountId,
      idToken: "fictional-google-token",
      nonce: f.passkeys.endorsements.googleProofNonce(first.endorse, browser),
    });
    const confirmed = await confirm(first.endorse);
    expect(await confirmed.json()).toEqual({ id: first.authenticator.id });
    expect(confirmed.headers.getSetCookie()).toContain("fixture-cookie=one");
    expect(f.accounts.passkey(first.authenticator.id)).toBeDefined();
    expect((await confirm(first.endorse)).status).toBe(403);
    // The first passkey vouches for a second, and the browser is offered only that passkey.
    const second = await createPasskey(f, cookie);
    const login = await (
      await f.post(`passkeys/authenticate/options?endorse=${second.endorse}`, {}, cookie)
    ).json();
    expect(login.options.allowCredentials).toEqual([
      expect.objectContaining({ id: first.authenticator.id }),
    ]);
    const vouched = await f.post(
      `passkeys/authenticate/complete?endorse=${second.endorse}`,
      {
        ceremonyId: login.ceremonyId,
        credential: first.authenticator.authentication(login.options.challenge, first.userHandle),
      },
      cookie,
    );
    expect(vouched.status).toBe(200);
    expect(hasSessionCookie(vouched)).toBe(true);
    expect(f.accounts.passkey(second.authenticator.id)).toBeUndefined();
    expect(await (await confirm(second.endorse)).json()).toEqual({ id: second.authenticator.id });
    const keys = f.accounts.passkeyKeys(accountId);
    expect(keys.find((key) => key.id === first.authenticator.id)!.endorsement).toMatchObject({
      type: "google",
      idToken: "fictional-google-token",
    });
    expect(keys.find((key) => key.id === second.authenticator.id)!.endorsement).toMatchObject({
      type: "passkey",
      credential: { id: first.authenticator.id },
    });
    const removed = await f.post("passkeys/remove", { id: first.authenticator.id }, cookie);
    expect(removed.status).toBe(200);
    expect(
      removed.headers.getSetCookie().some((value) => value.includes("__Host-omnesis-account=;")),
    ).toBe(true);
    expect(f.accounts.passkey(first.authenticator.id)).toBeUndefined();
    expect(f.accounts.passkey(second.authenticator.id)).toBeDefined();
    expect(f.accounts.passkeyKeys(accountId).map((key) => key.id)).toEqual([
      second.authenticator.id,
    ]);
  }
});

test("the new passkey countersigns through the page's routes, bound to its name and browser, and is stored with it", async () => {
  const f = await fixture(undefined, true),
    google = "a".repeat(64),
    accountId = f.accounts.signInFederated("google", google);
  const session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  const cookie = `${f.browser}; __Host-omnesis-account=${session.token}`;
  const added = await createPasskey(f, cookie),
    query = `?endorse=${added.endorse}`;
  const begin = (path = query, as = cookie) =>
    f.post(`passkeys/countersign/options${path}`, {}, as);
  const finish = (ceremony: { ceremonyId: string }, credential: unknown, path = query) =>
    f.post(
      `passkeys/countersign/complete${path}`,
      { ceremonyId: ceremony.ceremonyId, credential },
      cookie,
    );
  // It needs the waiting passkey's name and the browser that created it.
  expect((await begin("")).status).toBe(400);
  expect((await begin(`?desktop=${added.endorse}`)).status).toBe(400);
  expect((await begin("?endorse=b1fba1ce-2398-4c2c-a66b-9044433d1a02")).status).toBe(403);
  expect(
    (await begin(query, `__Host-omnesis-account-browser=${randomBytes(32).toString("base64url")}`))
      .status,
  ).toBe(403);
  expect(
    (await f.post(`passkeys/countersign/options${query}`, { unknown: true }, cookie)).status,
  ).toBe(400);
  const options = await (await begin()).json();
  expect(options.options.allowCredentials).toEqual([
    expect.objectContaining({ id: added.authenticator.id }),
  ]);
  // A signature by another passkey, or for another challenge, is refused and stores nothing.
  const other = passkeyAuthenticator();
  expect(
    (await finish(options, other.authentication(options.options.challenge, added.userHandle)))
      .status,
  ).toBe(400);
  const retry = await (await begin()).json();
  const signature = added.authenticator.authentication(
    retry.options.challenge,
    added.userHandle,
    1,
  );
  expect((await finish(retry, signature, "")).status).toBe(400);
  const signing = await (await begin()).json();
  const signed = await finish(
    signing,
    added.authenticator.authentication(signing.options.challenge, added.userHandle, 2),
  );
  expect(await signed.json()).toEqual({ ok: true });
  // It signs nobody in.
  expect(hasSessionCookie(signed)).toBe(false);
  f.passkeys.endorsements.recordProof(added.endorse, f.browser, {
    type: "google",
    accountId,
    idToken: "fictional-google-token",
    nonce: f.passkeys.endorsements.googleProofNonce(added.endorse, f.browser),
  });
  expect(await (await f.post(`passkeys/register/confirm${query}`, {}, cookie)).json()).toEqual({
    id: added.authenticator.id,
  });
  expect(f.accounts.passkeyKeys(accountId)[0]!.countersignature).toMatchObject({
    proof: { type: "passkey", credential: { id: added.authenticator.id } },
    google: [google],
    passkeys: [],
  });
});

test("a Google sign-in vouches for a new passkey through its round trip, bound to that passkey and browser", async () => {
  const f = await fixture(undefined, true);
  const signedIn = await f.authentication.googleSignIn(
    "fixture-token",
    "fixture-nonce",
    undefined,
    testAccountAdmission(),
  );
  const cookie = f.browser + "; __Host-omnesis-account=" + signedIn.token;
  const request = (query: string, cookieHeader = cookie) =>
    ({ url: "/_relay/web/start" + query, headers: { cookie: cookieHeader } }) as IncomingMessage;
  const added = await createPasskey(f, cookie),
    start = `?endorse=${added.endorse}`;
  const { context, nonce } = await f.web.googleContext(request(start));
  expect(JSON.parse(context!)).toEqual({ endorse: added.endorse });
  expect(nonce).toBe(f.passkeys.endorsements.googleProofNonce(added.endorse, f.browser));
  // The vouching keeps its own page: nothing else named beside it is carried along.
  const beside = await f.web.googleContext(request(start + "&open=portal&then=remove-passkey"));
  expect(JSON.parse(beside.context!)).toEqual({ endorse: added.endorse });
  await expect(f.web.googleContext(request(start + "&link=1"))).rejects.toThrow(
    "Finish this sign-in",
  );
  // Another browser can't start a vouching for it, whatever session it holds.
  const elsewhere = `__Host-omnesis-account-browser=${randomBytes(32).toString("base64url")}`;
  await expect(
    f.web.googleContext(request(start, `${elsewhere}; __Host-omnesis-account=${signedIn.token}`)),
  ).rejects.toThrow("no longer waiting");
  // The page is told nothing about it as a pending operation.
  const session = await fetch(f.url + "/_relay/account/api/session" + start, {
    headers: { cookie },
  });
  expect(await session.json()).not.toHaveProperty("pending");
  // A failed or abandoned Google sign-in returns to the same passkey.
  expect(f.web.googleFailure(context)).toBe(
    `/_relay/account?failed=google&endorse=${added.endorse}`,
  );
  // A token made for anything else vouches for nothing.
  await expect(
    f.web.completeGoogle("fixture-token", "fictional-nonce", context, request("")),
  ).rejects.toThrow("another request");
  await expect(
    f.web.completeGoogle(
      "fixture-token",
      nonce!,
      JSON.stringify({ endorse: added.endorse, operation: added.endorse }),
      request(""),
    ),
  ).rejects.toThrow("Invalid account request");
  expect(f.accounts.passkey(added.authenticator.id)).toBeUndefined();
  const returned = await f.web.completeGoogle("fixture-token", nonce!, context, request(""));
  expect(returned.location).toBe(`/_relay/account?endorse=${added.endorse}`);
  expect(returned.cookie).toContain("__Host-omnesis-account=");
  expect(f.accounts.passkey(added.authenticator.id)).toBeUndefined();
  const confirmed = await f.post(`passkeys/register/confirm${start}`, {}, cookie);
  expect(await confirmed.json()).toEqual({ id: added.authenticator.id });
  expect(f.accounts.passkeyKeys(signedIn.accountId)).toEqual([
    {
      id: added.authenticator.id,
      publicKey: expect.any(String),
      endorsement: { type: "google", idToken: "fixture-token", salt: expect.any(String) },
    },
  ]);
});

test("a sign-in of a different account can't vouch for a passkey, and its session can't finish one", async () => {
  const f = await fixture(undefined, true);
  // The fixture's Google sign-in belongs to one account; the passkey is added to another.
  const google = await f.authentication.googleSignIn(
    "fixture-token",
    "fixture-nonce",
    undefined,
    testAccountAdmission(),
  );
  const accountId = f.accounts.signInFederated("google", "a".repeat(64)),
    owner = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  expect(google.accountId).not.toBe(accountId);
  const cookie = f.browser + "; __Host-omnesis-account=" + owner.token,
    intruder = f.browser + "; __Host-omnesis-account=" + google.token;
  const added = await createPasskey(f, cookie),
    query = `?endorse=${added.endorse}`;
  const request = { url: "/_relay/web/start" + query, headers: { cookie } } as IncomingMessage;
  const { context, nonce } = await f.web.googleContext(request);
  await expect(f.web.completeGoogle("fixture-token", nonce!, context, request)).rejects.toThrow(
    "already has",
  );
  // A passkey of the other account is refused the same way, and signs nobody in.
  const theirs = await createPasskey(f, intruder);
  f.passkeys.endorsements.recordProof(theirs.endorse, f.browser, {
    type: "google",
    accountId: google.accountId,
    idToken: "fixture-token",
    nonce: f.passkeys.endorsements.googleProofNonce(theirs.endorse, f.browser),
  });
  expect(
    (await f.post(`passkeys/register/confirm?endorse=${theirs.endorse}`, {}, intruder)).status,
  ).toBe(200);
  const login = await (await f.post(`passkeys/authenticate/options${query}`, {}, cookie)).json();
  expect(login.options.allowCredentials).toEqual([]);
  const crossed = await f.post(
    `passkeys/authenticate/complete${query}`,
    {
      ceremonyId: login.ceremonyId,
      credential: theirs.authenticator.authentication(login.options.challenge, theirs.userHandle),
    },
    cookie,
  );
  expect(crossed.status).toBe(403);
  expect(crossed.headers.getSetCookie()).toEqual([]);
  // Neither account's session can store it: one is the wrong account, the other has no vouching.
  expect((await f.post(`passkeys/register/confirm${query}`, {}, intruder)).status).toBe(409);
  expect((await f.post(`passkeys/register/confirm${query}`, {}, cookie)).status).toBe(409);
  expect(f.accounts.passkey(added.authenticator.id)).toBeUndefined();
  expect(f.accounts.list(google.accountId).passkeys.map((key) => key.id)).toEqual([
    theirs.authenticator.id,
  ]);
});

test("finishing or cancelling a new passkey needs its name, its browser and a signed-in account", async () => {
  // This test makes more requests than one browser may in a minute.
  const f = await fixture(
    undefined,
    true,
    false,
    "trusted",
    new LoginAdmission(8, 600, { maxPerMinute: 600 }),
  );
  const accountId = f.accounts.signInFederated("google", "a".repeat(64)),
    session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  const cookie = f.browser + "; __Host-omnesis-account=" + session.token;
  const added = await createPasskey(f, cookie),
    query = `?endorse=${added.endorse}`,
    unknown = "?endorse=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
    elsewhere = `__Host-omnesis-account-browser=${randomBytes(32).toString("base64url")}; __Host-omnesis-account=${session.token}`;
  for (const action of ["confirm", "cancel"]) {
    const path = `passkeys/register/${action}`;
    // Without a passkey being added there is nothing to finish, and an operation is not one.
    expect((await f.post(path, {}, cookie)).status).toBe(400);
    expect((await f.post(`${path}?desktop=${added.endorse}`, {}, cookie)).status).toBe(400);
    expect((await f.post(`${path}?endorse=not-a-name`, {}, cookie)).status).toBe(400);
    expect((await f.post(`${path}${query}&endorse=${added.endorse}`, {}, cookie)).status).toBe(400);
    expect((await f.post(`${path}${query}&operation=${added.endorse}`, {}, cookie)).status).toBe(
      400,
    );
    expect((await f.post(path + query, { unknown: true }, cookie)).status).toBe(400);
    expect((await f.post(path + unknown, {}, cookie)).status).toBe(403);
    expect((await f.post(path + query, {}, elsewhere)).status).toBe(403);
  }
  expect((await f.post("passkeys/register/confirm" + query, {}, f.browser)).status).toBe(401);
  expect(
    (
      await f.post(
        "passkeys/register/confirm" + query,
        {},
        f.browser + "; __Host-omnesis-account=invalid",
      )
    ).status,
  ).toBe(401);
  expect((await f.post("passkeys/authenticate/options" + unknown, {}, cookie)).status).toBe(403);
  // A waiting passkey is never an operation to continue, create an account on, or add another on.
  expect((await f.post("continue" + query, {}, cookie)).status).toBe(400);
  expect((await f.post("passkeys/register/options" + query, {}, cookie)).status).toBe(409);
  expect((await f.post("passkeys/register/options" + query, { createAccount: true })).status).toBe(
    403,
  );
  const signedOut = await fetch(f.url + "/_relay/account/api/session" + unknown);
  expect(await signedOut.json()).toEqual({
    authenticated: false,
    googleAvailable: true,
    canCreateAccount: false,
  });
  // Cancelling needs only the browser that created it, and then nothing can finish it.
  const cancelled = await f.post("passkeys/register/cancel" + query, {}, f.browser);
  expect(await cancelled.json()).toEqual({ ok: true });
  expect((await f.post("passkeys/register/confirm" + query, {}, cookie)).status).toBe(403);
  expect((await f.post("passkeys/register/cancel" + query, {}, cookie)).status).toBe(403);
  expect(f.accounts.passkey(added.authenticator.id)).toBeUndefined();
});

test("account boundaries reject invalid sessions, browser requests, unsupported operations and unbounded input", async () => {
  const f = await fixture();
  const invalid = await fetch(f.url + "/_relay/account/api/session", {
    headers: { cookie: "__Host-omnesis-account=invalid" },
  });
  expect(await invalid.json()).toMatchObject({ authenticated: false });
  expect(invalid.headers.getSetCookie()[0]).toContain("Max-Age=0");
  expect((await fetch(f.url + "/unrelated")).status).toBe(404);
  expect(
    (
      await fetch(
        f.url + "/_relay/account/api/session?operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
      )
    ).status,
  ).toBe(503);
  expect((await fetch(f.url + "/_relay/account/unknown")).status).toBe(405);
  expect((await f.post("unknown", {})).status).toBe(404);
  expect((await f.post("passkeys/remove", { id: "fixture" })).status).toBe(401);
  expect(
    (await f.post("passkeys/authenticate/options", {}, "__Host-omnesis-account-browser=bad"))
      .status,
  ).toBe(400);
  expect(
    (
      await fetch(f.url + "/_relay/account/api/session", {
        headers: { cookie: "__Host-omnesis-account=one; __Host-omnesis-account=two" },
      })
    ).status,
  ).toBe(400);
  const request = (body: string, headers: Record<string, string> = {}) =>
    fetch(f.url + "/_relay/account/api/logout", {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body,
    });
  expect((await request("{")).status).toBe(400);
  expect((await request(JSON.stringify({ oversized: "x".repeat(65_536) }))).status).toBe(413);
  expect((await request("{}", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await f.post("logout", {}, "")).status).toBe(200);
  const accountId = f.accounts.signInFederated("google", "a".repeat(64)),
    session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  const cookie = `__Host-omnesis-account=${session.token}`;
  vi.spyOn(f.accounts, "activeSession").mockImplementation(() => {
    throw new Error("synthetic database failure");
  });
  const failure = await fetch(f.url + "/_relay/account/api/session", { headers: { cookie } });
  expect(failure.status).toBe(500);
  expect(failure.headers.getSetCookie()).toEqual([]);
});

test("explicit Google linking requires a fresh signed-in account and returns only a fixed account destination", async () => {
  const f = await fixture();
  const request = (query: string, cookie = "") =>
    ({ url: "/_relay/web/start" + query, headers: { cookie } }) as IncomingMessage;
  expect(await f.web.googleContext(request(""))).toEqual({ context: undefined, nonce: undefined });
  for (const query of ["?link=2", "?link=1&link=1"])
    await expect(f.web.googleContext(request(query))).rejects.toThrow("Invalid");
  await expect(f.web.googleContext(request("?link=1"))).rejects.toThrow("Sign in");
  const accountId = f.accounts.signInFederated("google", "a".repeat(64)),
    session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  const cookie = `__Host-omnesis-account=${session.token}`;
  const { context } = await f.web.googleContext(request("?link=1", cookie));
  expect(JSON.parse(context!).linkSession).toBe(session.token);
  const result = await f.web.completeGoogle(
    "fictional-provider-proof",
    "fictional-server-nonce",
    context,
    noCookies,
  );
  // The page is told what changed, so it can confirm the new sign-in method.
  expect(result.location).toBe("/_relay/account?linked=google");
  expect(result.cookie).toContain("__Host-omnesis-account=");
  expect(f.web.googleFailure(context)).toBe("/_relay/account?failed=google");
});

test("a Google confirmation carries only a known sign-in method change back to the account page", async () => {
  const f = await fixture();
  const request = (query: string, cookie = "") =>
    ({ url: "/_relay/web/start" + query, headers: { cookie } }) as IncomingMessage;
  for (const then of ["remove-passkey", "delete-account"]) {
    const { context } = await f.web.googleContext(request(`?then=${then}&open=portal`));
    expect(JSON.parse(context!)).toEqual({ then });
    const result = await f.web.completeGoogle(
      "fictional-provider-proof",
      "fictional-server-nonce",
      context,
      noCookies,
    );
    expect(result.location).toBe(`/_relay/account?then=${then}`);
    // A failed confirmation resumes nothing.
    expect(f.web.googleFailure(context)).toBe("/_relay/account?failed=google");
  }
  for (const query of [
    "?then=",
    // Adding a passkey is confirmed afterwards, so no confirmation resumes it.
    "?then=add-passkey",
    "?then=Remove-passkey",
    "?then=remove-passkey%20",
    "?then=remove-passkey&then=remove-passkey",
    "?then=remove-passkey&then=add-passkey",
    "?then=https%3A%2F%2Fforeign.example.test%2F",
  ])
    expect(await f.web.googleContext(request(query))).toEqual({
      context: undefined,
      nonce: undefined,
    });
  // A linking request is its own change, and a stored context accepts no other value.
  const accountId = f.accounts.signInFederated("google", "c".repeat(64)),
    session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  const linking = await f.web.googleContext(
    request("?link=1&then=remove-passkey", `__Host-omnesis-account=${session.token}`),
  );
  expect(JSON.parse(linking.context!)).toEqual({ linkSession: session.token });
  await expect(
    f.web.completeGoogle(
      "fictional-provider-proof",
      "fictional-server-nonce",
      JSON.stringify({ then: "sign-out" }),
      noCookies,
    ),
  ).rejects.toThrow("Invalid account request");
});

test("Google sign-in carries only the exact front-door request back to the plain account page", async () => {
  const f = await fixture();
  const request = (query: string, cookie = "") =>
    ({ url: "/_relay/web/start" + query, headers: { cookie } }) as IncomingMessage;
  const { context } = await f.web.googleContext(request("?open=portal"));
  expect(JSON.parse(context!)).toEqual({ open: "portal" });
  const result = await f.web.completeGoogle(
    "fictional-provider-proof",
    "fictional-server-nonce",
    context,
    noCookies,
  );
  expect(result.location).toBe("/_relay/account?open=portal");
  expect(f.web.googleFailure(context)).toBe("/_relay/account?failed=google&open=portal");
  for (const query of [
    "?open=",
    "?open=Portal",
    "?open=portal%20",
    "?open=portal&open=portal",
    "?open=https%3A%2F%2Fforeign.example.test%2F",
  ])
    expect(await f.web.googleContext(request(query))).toEqual({
      context: undefined,
      nonce: undefined,
    });
  // Adding a Google sign-in returns to account management, and a stored context accepts no other value.
  const accountId = f.accounts.signInFederated("google", "b".repeat(64)),
    session = await f.authentication.issuePasskeySession({ accountId, version: 1 });
  const linking = await f.web.googleContext(
    request("?link=1&open=portal", `__Host-omnesis-account=${session.token}`),
  );
  expect(JSON.parse(linking.context!)).toEqual({ linkSession: session.token });
  await expect(
    f.web.completeGoogle(
      "fictional-provider-proof",
      "fictional-server-nonce",
      JSON.stringify({ open: "elsewhere" }),
      noCookies,
    ),
  ).rejects.toThrow("Invalid account request");
  expect(f.web.googleFailure(JSON.stringify({ open: "elsewhere" }))).toBe(
    "/_relay/account?failed=google",
  );
});

test("real WebAuthn over HTTP creates, signs out and signs into the same independent account", async () => {
  const f = await fixture(),
    authenticator = passkeyAuthenticator();
  const options = await f.post("passkeys/register/options", { createAccount: true });
  expect(options.status).toBe(200);
  const begin = await options.json();
  const registered = await f.post("passkeys/register/complete", {
    ceremonyId: begin.ceremonyId,
    credential: authenticator.registration(begin.options.challenge),
  });
  expect(registered.status).toBe(200);
  const sessionCookie = registered.headers.getSetCookie()[0]!;
  expect(sessionCookie).toMatch(/^__Host-omnesis-account=/);
  expect(sessionCookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  const cookie = f.browser + "; " + sessionCookie.split(";")[0]!;
  const status = await fetch(f.url + "/_relay/account/api/session", { headers: { cookie } });
  const account = await status.json();
  expect(account).toMatchObject({
    authenticated: true,
    credentials: {
      federated: [],
      passkeys: [
        {
          id: authenticator.id,
          label: "Passkey",
          deviceType: "multiDevice",
          backedUp: true,
          createdAt: expect.any(Number),
          lastUsedAt: null,
        },
      ],
    },
    gateways: [],
  });
  // The page shows these and nothing else about a passkey.
  expect(Object.keys(account.credentials.passkeys[0]).sort()).toEqual(
    ["backedUp", "createdAt", "deviceType", "id", "label", "lastUsedAt"].sort(),
  );
  expect(JSON.stringify(account)).not.toContain("publicKey");
  expect((await f.post("passkeys/register/options", { createAccount: true }, cookie)).status).toBe(
    409,
  );
  expect((await f.post("passkeys/remove", { id: authenticator.id }, cookie)).status).toBe(409);
  const logout = await f.post("logout", {}, cookie);
  expect(logout.status).toBe(200);
  expect(logout.headers.getSetCookie()[0]).toContain("Max-Age=0");
  const signedOut = async () =>
    (await fetch(f.url + "/_relay/account/api/session", { headers: { cookie } })).json();
  // The gateway may start over until it is linked to the account it created; then it holds that one.
  expect(await signedOut()).toEqual({
    authenticated: false,
    googleAvailable: false,
    canCreateAccount: true,
  });
  f.accounts.linkGateway(
    f.accounts.passkey(authenticator.id)!.accountId,
    f.admission.ownerAccountId,
    "c".repeat(43),
  );
  expect(await signedOut()).toEqual({
    authenticated: false,
    googleAvailable: false,
    canCreateAccount: false,
  });
  expect((await f.post("passkeys/register/options", { createAccount: true })).status).toBe(403);
  const login = await (await f.post("passkeys/authenticate/options", {})).json();
  const assertion = authenticator.authentication(login.options.challenge, begin.options.user.id);
  expect(
    (
      await f.post("passkeys/authenticate/complete", {
        ceremonyId: login.ceremonyId,
        credential: assertion,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.post("passkeys/authenticate/complete", {
        ceremonyId: login.ceremonyId,
        credential: assertion,
      })
    ).status,
  ).toBe(400);
});

test("Google browser context commits to the exact desktop intent and records the proof on it", async () => {
  const f = await fixture(undefined, true, true),
    desktop = f.desktop!;
  const operation = desktop.start({
    nonce: randomBytes(32).toString("base64url"),
    challenge: randomBytes(32).toString("base64url"),
    kind: "cli",
    name: "Fictional terminal",
  });
  const launched = desktop.launch(
    operation.operationId,
    new URL(operation.authorizeUrl).searchParams.get("ticket")!,
    "",
  );
  const cookie = launched.cookie.split(";")[0]!;
  const req = {
    url: `/_relay/web/start?desktop=${operation.operationId}`,
    headers: { cookie },
  } as unknown as IncomingMessage;
  const { context, nonce } = await f.web.googleContext(req);
  expect(JSON.parse(context!)).toEqual({ desktop: operation.operationId });
  // An operation keeps its own page, so a front-door request beside it is dropped.
  const beside = await f.web.googleContext({
    url: `/_relay/web/start?open=portal&desktop=${operation.operationId}`,
    headers: { cookie },
  } as unknown as IncomingMessage);
  expect(JSON.parse(beside.context!)).toEqual({ desktop: operation.operationId });
  expect(nonce).toBe(desktop.googleProofNonce(operation.operationId, cookie));
  const signedIn = await f.web.completeGoogle(
    "verified-fixture-google-token",
    nonce!,
    context,
    req,
  );
  expect(signedIn.location).toBe(`/_relay/account?desktop=${operation.operationId}`);
  expect(desktop.describe(operation.operationId, cookie)).toMatchObject({ needsProof: false });
  // A token whose nonce names something else never counts as this operation's sign-in.
  await expect(
    f.web.completeGoogle("verified-fixture-google-token", "fictional-nonce", context, req),
  ).rejects.toThrow("another request");
  await expect(
    f.web.completeGoogle(
      "verified-fixture-google-token",
      "fictional-nonce",
      JSON.stringify({ desktop: operation.operationId, operation: operation.operationId }),
      req,
    ),
  ).rejects.toThrow();
  await expect(
    f.web.googleContext({
      url: `/_relay/web/start?link=1&desktop=${operation.operationId}`,
      headers: { cookie },
    } as unknown as IncomingMessage),
  ).rejects.toThrow("Finish this sign-in");
  expect(f.web.googleFailure(context)).toBe(
    `/_relay/account?failed=google&desktop=${operation.operationId}`,
  );
  expect(f.web.googleFailure(undefined)).toBe("/_relay/account?failed=google");
  expect(f.web.googleFailure(JSON.stringify({ unknown: true }))).toBe(
    "/_relay/account?failed=google",
  );
});

test("account allocation endpoints fail closed without an unused gateway admission", async () => {
  for (const mode of ["missing", "spent"] as const) {
    const f = await fixture(undefined, true, false, mode);
    const response = await fetch(f.url + "/_relay/account/api/session");
    expect(await response.json()).toMatchObject({ authenticated: false, canCreateAccount: false });
    expect((await f.post("passkeys/register/options", { createAccount: true })).status).toBe(403);
  }
});

test("desktop discovery consent cannot create an account", async () => {
  const f = await fixture(undefined, true, true);
  const response = await f.post(
    "passkeys/register/options?desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
    { createAccount: true },
  );
  expect(response.status).toBe(403);
});

test("an old session is told to sign in again before removing a sign-in method, and may still create a passkey", async () => {
  const f = await fixture(undefined, true);
  const signedIn = await f.authentication.googleSignIn(
    "fixture-token",
    "fixture-nonce",
    undefined,
    testAccountAdmission(),
  );
  const cookie = f.browser + "; __Host-omnesis-account=" + signedIn.token;
  const session = () =>
    fetch(f.url + "/_relay/account/api/session", { headers: { cookie } }).then((response) =>
      response.json(),
    );
  expect(await session()).toMatchObject({ authenticated: true, credentialsRequireSignIn: false });
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
  try {
    expect(await session()).toMatchObject({ authenticated: true, credentialsRequireSignIn: true });
    expect((await f.post("passkeys/remove", { id: "fixture" }, cookie)).status).toBe(401);
    // Creating a passkey asks for no recent sign-in: it is stored only once a fresh one vouches.
    expect((await f.post("passkeys/register/options", {}, cookie)).status).toBe(200);
    const reauthenticated = await f.authentication.googleSignIn("fixture-token", "fixture-nonce");
    const response = await fetch(f.url + "/_relay/account/api/session", {
      headers: { cookie: f.browser + "; __Host-omnesis-account=" + reauthenticated.token },
    });
    expect(await response.json()).toMatchObject({
      authenticated: true,
      credentialsRequireSignIn: false,
    });
  } finally {
    now.mockRestore();
  }
});

test("deleting an account needs its own fresh sign-in and the account the page showed, and ends the session", async () => {
  const f = await fixture(undefined, true);
  const signedIn = await f.authentication.googleSignIn(
    "fixture-token",
    "fixture-nonce",
    undefined,
    testAccountAdmission(),
  );
  const cookie = f.browser + "; __Host-omnesis-account=" + signedIn.token;
  const session = () =>
    fetch(f.url + "/_relay/account/api/session", { headers: { cookie } }).then((response) =>
      response.json(),
    );
  // The page learns which account it shows, and names it when it asks for the deletion.
  expect(await session()).toMatchObject({ authenticated: true, accountId: signedIn.accountId });
  const body = { accountId: signedIn.accountId };
  expect((await f.post("delete", body)).status).toBe(401);
  expect((await f.post("delete", {}, cookie)).status).toBe(400);
  expect((await f.post("delete", { ...body, confirm: true }, cookie)).status).toBe(400);
  // A cross-site page cannot ask, whatever cookie the browser would attach.
  expect((await f.post("delete", body, cookie, "https://foreign.example.test")).status).toBe(403);
  // A sign-in of another account, such as a confirmation made with the wrong passkey.
  expect((await f.post("delete", { accountId: "d".repeat(64) }, cookie)).status).toBe(409);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
  try {
    // A session that is still valid but no longer fresh deletes nothing.
    expect(await session()).toMatchObject({ authenticated: true, credentialsRequireSignIn: true });
    expect((await f.post("delete", body, cookie)).status).toBe(401);
  } finally {
    now.mockRestore();
  }
  expect(f.accounts.sessionVersion(signedIn.accountId)).toBe(1);

  const deleted = await f.post("delete", body, cookie);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ ok: true });
  expect(deleted.headers.getSetCookie()).toContainEqual(
    expect.stringMatching(/^__Host-omnesis-account=; .*Max-Age=0$/),
  );
  expect(f.accounts.sessionVersion(signedIn.accountId)).toBeUndefined();
  expect(await session()).toMatchObject({ authenticated: false });
  // The cookie that outlived the account can do nothing, including deleting again.
  expect((await f.post("delete", body, cookie)).status).toBe(401);
});
