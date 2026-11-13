// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { registeredPasskey, signInOnOperation } from "../test/operation-sign-in.js";
import { listen } from "../test/support.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { authorizeAccountDesktop } from "./account-desktop-client.js";
import { RelaySessions } from "./identity.js";
const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const relay = createCloudRelay({ accounts, sessions, controlOrigin: origin, accountSignIn: {} });
  const url = await listen(relay.server),
    accountId = accounts.identities.signInFederated("google", "a".repeat(64));
  const actor = await sessions.issueAccountSession({ accountId, version: 1 }, "passkey", origin);
  accounts.identities.registerSession(accountId, actor.version, actor.sessionId, actor.expiresAt);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const start = async (loopbackPort?: number) => {
    const verifier = opaque(),
      response = await post("/_relay/v3/desktop/start", {
        nonce: opaque(),
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        kind: "cli",
        name: "Fictional terminal",
        ...(loopbackPort ? { loopbackPort } : {}),
      });
    expect(response.status).toBe(200);
    return { ...(await response.json()), verifier };
  };
  const passkey = await registeredPasskey(accounts.identities, { accountId, version: 1 });
  return { relay, url, accounts, sessions, actor, post, start, passkey };
}
test("desktop browser consent keeps account cookies off the native result and returns only discovery authority", async () => {
  const f = await fixture(),
    op = await f.start(49152),
    launchUrl = new URL(op.authorizeUrl);
  const launch = await fetch(f.url + launchUrl.pathname + launchUrl.search, { redirect: "manual" });
  expect(launch.status).toBe(303);
  expect(launch.headers.get("location")).toBe(`/_relay/account?desktop=${op.operationId}`);
  const cookie = launch.headers.getSetCookie()[0]!.split(";")[0]!;
  expect(launch.headers.getSetCookie()[0]).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  const request = { operationId: op.operationId, ticket: op.ticket, verifier: op.verifier };
  expect(await (await f.post("/_relay/v3/desktop/redeem", request)).json()).toMatchObject({
    status: "pending",
  });
  const query = `?desktop=${op.operationId}`;
  const browserCookie = `${cookie}; __Host-omnesis-account=${f.actor.token}`;
  const state = await fetch(f.url + "/_relay/account/api/session" + query, {
    headers: { cookie: browserCookie },
  });
  expect(await state.json()).toMatchObject({
    authenticated: true,
    pending: {
      purpose: "desktop-discovery",
      deviceName: "Fictional terminal",
      code: op.code,
      needsProof: true,
    },
  });
  // An existing session cookie is not enough: this request needs a sign-in of its own.
  expect(
    (await f.post("/_relay/account/api/continue" + query, {}, { cookie: browserCookie, origin }))
      .status,
  ).toBe(409);
  await signInOnOperation(f.url, query, cookie, f.passkey);
  expect(
    (
      await f.post(
        "/_relay/account/api/continue" + query,
        {},
        { cookie: browserCookie, origin: "https://foreign.example.test" },
      )
    ).status,
  ).toBe(403);
  const approve = await f.post(
    "/_relay/account/api/continue" + query,
    {},
    { cookie: browserCookie, origin },
  );
  expect(approve.status).toBe(200);
  // The browser goes on to this machine's own listener, carrying the secret that releases the proof.
  const handoff = new URL((await approve.json()).location);
  expect(handoff.origin + handoff.pathname).toBe("http://127.0.0.1:49152/omnesis/callback");
  const complete = await fetch(f.url + "/_relay/v3/desktop/complete");
  expect(complete.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await complete.text()).toContain("approve it on your phone");
  const redeemed = await f.post("/_relay/v3/desktop/redeem", {
      ...request,
      completion: handoff.searchParams.get("completion"),
    }),
    result = await redeemed.json();
  expect(result).toMatchObject({
    status: "approved",
    accountId: f.actor.accountId,
    credentialPublicKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    signInProof: { type: "passkey", credential: { id: f.passkey.authenticator.id } },
  });
  expect(JSON.stringify(result)).not.toContain(f.actor.token);
  expect(redeemed.headers.get("set-cookie")).toBeNull();
  expect(await f.sessions.verifyAccountDiscovery(result.discoveryToken, origin)).toMatchObject({
    accountId: f.actor.accountId,
  });
  expect((await f.post("/_relay/v3/desktop/redeem", request)).status).toBe(403);
});
test("native desktop boundaries reject browser ambient authority query confusion unsupported methods and oversized bodies", async () => {
  const f = await fixture();
  for (const path of ["start", "redeem", "cancel"]) {
    expect((await fetch(f.url + "/_relay/v3/desktop/" + path)).status).toBe(405);
    expect((await f.post("/_relay/v3/desktop/" + path, {}, { origin })).status).toBe(403);
    expect(
      (await f.post("/_relay/v3/desktop/" + path, {}, { "sec-fetch-site": "same-origin" })).status,
    ).toBe(403);
    expect((await f.post("/_relay/v3/desktop/" + path + "?extra=1", {})).status).toBe(403);
    expect(
      (await f.post("/_relay/v3/desktop/" + path, {}, { "content-type": "text/plain" })).status,
    ).toBe(415);
  }
  expect((await f.post("/_relay/v3/desktop/start", { payload: "x".repeat(8193) })).status).toBe(
    413,
  );
  expect(
    (
      await fetch(f.url + "/_relay/v3/desktop/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid",
      })
    ).status,
  ).toBe(400);
  expect((await fetch(f.url + "/_relay/v3/desktop/begin?operationId=bad&ticket=bad")).status).toBe(
    400,
  );
  expect((await fetch(f.url + "/_relay/v3/desktop/begin?" + "x".repeat(2049))).status).toBe(414);
  expect((await f.post("/_relay/v3/desktop/begin", {})).status).toBe(405);
  expect((await f.post("/_relay/v3/desktop/complete", {})).status).toBe(405);
  expect((await fetch(f.url + "/_relay/v3/desktop/complete?extra=1")).status).toBe(400);
  expect((await fetch(f.url + "/_relay/v3/desktop/unknown")).status).toBe(404);
  expect((await f.post("/_relay/v3/desktop/cancel", {})).status).toBe(400);
  const op = await f.start();
  expect(
    (await f.post("/_relay/v3/desktop/cancel", { operationId: op.operationId, ticket: op.ticket }))
      .status,
  ).toBe(200);
  expect(
    (
      await f.post("/_relay/v3/desktop/redeem", {
        operationId: op.operationId,
        ticket: op.ticket,
        verifier: op.verifier,
      })
    ).status,
  ).toBe(403);
});

test("slow desktop bodies release admission after the body deadline", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let reading = false;
  f.relay.server.prependListener("request", (request) => {
    const iterator = request.iterator.bind(request);
    request.iterator = (options) => {
      reading = true;
      return iterator(options);
    };
  });
  const failed = new Promise<Error>((resolve, reject) => {
    const request = httpRequest(
      f.url + "/_relay/v3/desktop/start",
      { method: "POST", headers: { "content-type": "application/json" } },
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

test("the real desktop SDK obtains only nonce-bound discovery through browser consent on the running relay", async () => {
  const f = await fixture(),
    nonce = opaque();
  const transport: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    expect(target.origin).toBe(origin);
    return fetch(f.url + target.pathname + target.search, init);
  };
  const result = await authorizeAccountDesktop(
    {
      relayUrl: origin,
      nonce,
      kind: "collector",
      name: "Fictional laptop",
      signal: new AbortController().signal,
    },
    {
      fetch: transport,
      openBrowser: async (launch) => {
        const target = new URL(launch);
        const response = await fetch(f.url + target.pathname + target.search, {
          redirect: "manual",
        });
        expect(response.status).toBe(303);
        const cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
        const query = new URL(response.headers.get("location")!, origin).search;
        await signInOnOperation(f.url, query, cookie, f.passkey);
        const consent = await f.post(
          "/_relay/account/api/continue" + query,
          {},
          { origin, cookie: `${cookie}; __Host-omnesis-account=${f.actor.token}` },
        );
        expect(consent.status).toBe(200);
      },
    },
  );
  expect(result.accountId).toBe(f.actor.accountId);
  expect(await f.sessions.verifyAccountDiscovery(result.discoveryToken, origin)).toMatchObject({
    accountId: f.actor.accountId,
    nonce,
  });
  await expect(f.sessions.verifyAccountSession(result.discoveryToken, origin)).rejects.toThrow();
});

test("revoking the browser account during asynchronous desktop token issuance prevents native redemption", async () => {
  const f = await fixture(),
    operation = await f.start(),
    target = new URL(operation.authorizeUrl);
  const launch = await fetch(f.url + target.pathname + target.search, { redirect: "manual" });
  const cookie = launch.headers.getSetCookie()[0]!.split(";")[0]!;
  await signInOnOperation(f.url, `?desktop=${operation.operationId}`, cookie, f.passkey);
  expect(
    (
      await f.post(
        `/_relay/account/api/continue?desktop=${operation.operationId}`,
        {},
        { origin, cookie: `${cookie}; __Host-omnesis-account=${f.actor.token}` },
      )
    ).status,
  ).toBe(200);
  const original = f.sessions.issueAccountDiscovery.bind(f.sessions);
  vi.spyOn(f.sessions, "issueAccountDiscovery").mockImplementation(async (...args) => {
    const issued = await original(...args);
    f.accounts.identities.revokeSession(f.actor.accountId, f.actor.sessionId);
    return issued;
  });
  const response = await f.post("/_relay/v3/desktop/redeem", {
    operationId: operation.operationId,
    ticket: operation.ticket,
    verifier: operation.verifier,
  });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("discoveryToken");
});
