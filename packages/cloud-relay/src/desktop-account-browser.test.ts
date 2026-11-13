// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectCodes } from "./connect-codes.js";
import { DesktopAccountBrowser, LOOPBACK_GRACE_MS } from "./desktop-account-browser.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { RelayError } from "./tunnels.js";
const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url");
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
async function fixture(maxPending?: number) {
  const store = new RelayAccounts(":memory:"),
    accounts = store.identities,
    sessions = new RelaySessions(randomBytes(32)),
    accountId = accounts.signInFederated("google", "a".repeat(64));
  const actor = await sessions.issueAccountSession({ accountId, version: 1 }, "passkey", origin);
  accounts.registerSession(accountId, actor.version, actor.sessionId, actor.expiresAt);
  const assertCurrent = vi.fn(),
    codes = new ConnectCodes(),
    broker = new DesktopAccountBrowser({
      origin,
      sessions,
      codes,
      assertCurrent,
      maxPending,
      assertAccount: (value) => {
        if (!accounts.activeSession(value.accountId, value.version, value.sessionId))
          throw new RelayError(401, "Account revoked");
      },
    });
  cleanup.push(() => {
    broker.close();
    store.close();
  });
  const start = (loopbackPort?: number) => {
    const verifier = opaque(),
      nonce = opaque(),
      pending = broker.start({
        kind: "collector",
        name: "Fictional collector",
        nonce,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        ...(loopbackPort === undefined ? {} : { loopbackPort }),
      });
    const url = new URL(pending.authorizeUrl),
      launched = broker.launch(pending.operationId, url.searchParams.get("ticket")!, ""),
      cookie = launched.cookie.split(";")[0]!;
    return { ...pending, verifier, nonce, launched, cookie };
  };
  /** The fresh sign-in `confirm` insists on, as the account page would record it. */
  const signIn = (op: { operationId: string; cookie: string }) =>
    broker.recordProof(op.operationId, op.cookie, {
      type: "google",
      accountId,
      idToken: "fictional-google-token",
      nonce: broker.googleProofNonce(op.operationId, op.cookie),
    });
  return { accounts, sessions, actor, broker, codes, start, signIn, assertCurrent };
}
test("browser approval grants only one-use PKCE-bound native discovery, never account or tunnel administration", async () => {
  const f = await fixture(),
    op = f.start(),
    input = { operationId: op.operationId, ticket: op.ticket, verifier: op.verifier };
  expect(await f.broker.redeem(input)).toMatchObject({ status: "pending" });
  expect(f.broker.describe(op.operationId, op.cookie)).toMatchObject({
    purpose: "desktop-discovery",
    deviceName: "Fictional collector",
    code: op.code,
    needsProof: true,
    // No loopback listener: nothing can show the sign-in finished on this machine.
    approvalRequired: true,
  });
  expect(() => f.broker.confirm(op.operationId, op.cookie, f.actor)).toThrow("Sign in");
  f.signIn(op);
  expect(f.broker.describe(op.operationId, op.cookie)).toMatchObject({ needsProof: false });
  expect(f.broker.confirm(op.operationId, op.cookie, f.actor)).toMatchObject({
    location: origin + "/_relay/v3/desktop/complete",
  });
  const result = await f.broker.redeem(input);
  expect(result.status).toBe("approved");
  if (result.status !== "approved") throw new Error("Expected completed consent");
  expect(result).not.toHaveProperty("signInProof");
  expect(await f.sessions.verifyAccountDiscovery(result.discoveryToken, origin)).toMatchObject({
    accountId: f.actor.accountId,
    nonce: op.nonce,
  });
  await expect(f.sessions.verifyAccountSession(result.discoveryToken, origin)).rejects.toThrow();
  await expect(f.sessions.verify(result.discoveryToken)).rejects.toThrow();
  await expect(f.broker.redeem(input)).rejects.toThrow("unavailable");
});
test("launch, browser and native capabilities are separate and malformed redemption cannot consume a valid request", async () => {
  const f = await fixture(),
    op = f.start(),
    input = { operationId: op.operationId, ticket: op.ticket, verifier: op.verifier };
  const launchTicket = new URL(op.authorizeUrl).searchParams.get("ticket")!;
  for (const value of [
    {},
    { ...input, extra: true },
    { ...input, ticket: "short" },
    { ...input, ticket: launchTicket },
    { ...input, verifier: opaque() },
  ])
    await expect(f.broker.redeem(value)).rejects.toThrow();
  expect(() => f.broker.launch(op.operationId, op.ticket, "")).toThrow("refused");
  for (const cookie of [
    "",
    op.cookie + "; " + op.cookie,
    op.cookie.replace(/=.+/, "=short"),
    op.cookie.replace(/=.+/, "=" + opaque()),
  ])
    expect(() => f.broker.confirm(op.operationId, cookie, f.actor)).toThrow("state mismatch");
  expect(await f.broker.redeem(input)).toMatchObject({ status: "pending" });
  f.signIn(op);
  f.broker.confirm(op.operationId, op.cookie, f.actor);
  expect(() => f.broker.confirm(op.operationId, op.cookie, f.actor)).toThrow("already approved");
  expect(() => f.signIn(op)).toThrow("no longer waiting");
  expect(() => f.broker.proofCommitment(op.operationId, op.cookie)).toThrow("no longer waiting");
});
test("capacity expiry opt-out and independently revoked service policy fail closed", async () => {
  const f = await fixture(1),
    op = f.start();
  expect(() => f.start()).toThrow("Too many");
  expect(() => f.broker.start({})).toThrow("Invalid desktop");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
  expect(() => f.broker.describe(op.operationId, op.cookie)).toThrow("unavailable");
  f.start();
  f.broker.close();
  expect(() => f.start()).toThrow("unavailable");
  for (const maxPending of [0, 4097, 1.5])
    expect(
      () =>
        new DesktopAccountBrowser({
          origin,
          sessions: f.sessions,
          codes: new ConnectCodes(),
          assertAccount: () => {},
          assertCurrent: () => {},
          maxPending,
        }),
    ).toThrow("limits");
});
test("a browser cannot replace pending desktop state and too many launched cookies are refused", async () => {
  const f = await fixture(),
    verifier = opaque();
  const pending = f.broker.start({
    kind: "cli",
    name: "Fictional terminal",
    nonce: opaque(),
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const ticket = new URL(pending.authorizeUrl).searchParams.get("ticket")!;
  expect(() => f.broker.launch(pending.operationId, "bad", "")).toThrow("refused");
  expect(() => f.broker.launch(pending.operationId, opaque(), "")).toThrow("refused");
  const cookies = Array.from(
    { length: 8 },
    (_, index) => `__Host-omnesis-desktop-${index}=opaque`,
  ).join("; ");
  expect(() => f.broker.launch(pending.operationId, ticket, cookies)).toThrow("Too many");
  await expect(
    f.broker.redeem({ operationId: pending.operationId, ticket: pending.ticket, verifier }),
  ).resolves.toMatchObject({ status: "pending" });
  f.broker.cancel(pending.operationId, pending.ticket);
  expect(() => f.broker.launch(pending.operationId, ticket, "")).toThrow("unavailable");
});
test("revocation cancellation expiry and replacement during credential signing cannot return a late discovery session", async () => {
  for (const attack of ["revoked", "cancel", "close", "expiry", "service"] as const) {
    const f = await fixture(),
      op = f.start(),
      input = { operationId: op.operationId, ticket: op.ticket, verifier: op.verifier };
    f.signIn(op);
    f.broker.confirm(op.operationId, op.cookie, f.actor);
    const issue = f.sessions.issueAccountDiscovery.bind(f.sessions);
    let release!: () => void;
    vi.spyOn(f.sessions, "issueAccountDiscovery").mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return issue(...args);
    });
    const result = f.broker.redeem(input);
    await expect(f.broker.redeem(input)).rejects.toThrow("in progress");
    if (attack === "revoked") f.accounts.revokeSession(f.actor.accountId, f.actor.sessionId);
    if (attack === "cancel") f.broker.cancel(op.operationId, op.ticket);
    if (attack === "close") f.broker.close();
    if (attack === "expiry") vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
    if (attack === "service")
      f.assertCurrent.mockImplementation(() => {
        throw new RelayError(503, "Service unavailable");
      });
    release();
    await expect(result).rejects.toThrow();
    vi.useRealTimers();
  }
});
test("a typed code launches in place of the launch URL, and shows the same code as a direct launch", async () => {
  const f = await fixture(),
    codes = new ConnectCodes(),
    broker = new DesktopAccountBrowser({
      origin,
      sessions: f.sessions,
      codes,
      assertAccount: () => {},
      assertCurrent: () => {},
    });
  cleanup.push(() => broker.close());
  const start = () =>
    broker.start({
      kind: "cli",
      name: "Fictional terminal",
      nonce: opaque(),
      challenge: opaque(),
    });
  const typed = start();
  expect(typed.connectUrl).toBe(origin + "/_relay/connect");
  expect(typed).not.toHaveProperty("connectShortUrl");
  const short = new DesktopAccountBrowser({
    origin,
    sessions: f.sessions,
    codes,
    connectShortUrl: "https://front.example.test/connect",
    assertAccount: () => {},
    assertCurrent: () => {},
  });
  cleanup.push(() => short.close());
  expect(
    short.start({ kind: "cli", name: "Fictional terminal", nonce: opaque(), challenge: opaque() }),
  ).toMatchObject({
    connectUrl: origin + "/_relay/connect",
    connectShortUrl: "https://front.example.test/connect",
  });
  expect(typed.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  const claimed = codes.claim(typed.code.toLowerCase(), "");
  expect(claimed.location).toBe(`/_relay/account?desktop=${typed.operationId}`);
  expect(broker.describe(typed.operationId, claimed.cookie.split(";")[0]!)).toMatchObject({
    code: typed.code,
  });
  const ticket = new URL(typed.authorizeUrl).searchParams.get("ticket")!;
  // Nobody has signed in, so the link and the code both still open it, each for a new browser.
  const linked = broker.launch(typed.operationId, ticket, "").cookie.split(";")[0]!;
  expect(() => broker.describe(typed.operationId, claimed.cookie.split(";")[0]!)).toThrow(
    "mismatch",
  );
  expect(broker.describe(typed.operationId, linked)).toMatchObject({ code: typed.code });
  expect(codes.claim(typed.code, "").location).toBe(claimed.location);
  const direct = start();
  broker.launch(direct.operationId, new URL(direct.authorizeUrl).searchParams.get("ticket")!, "");
  expect(codes.claim(direct.code, "").location).toBe(
    `/_relay/account?desktop=${direct.operationId}`,
  );
  broker.cancel(direct.operationId, direct.ticket);
  expect(() => codes.claim(direct.code, "")).toThrow("unavailable");
});

test("the link and the code reopen a request until somebody signs in, and a code launch keeps the proof home", async () => {
  const f = await fixture(),
    op = f.start(49153),
    ticket = new URL(op.authorizeUrl).searchParams.get("ticket")!;
  expect(f.broker.describe(op.operationId, op.cookie)).toMatchObject({ approvalRequired: false });
  // The link again: the first tab is dropped, and the listener is still where the browser goes.
  const second = f.broker.launch(op.operationId, ticket, op.cookie).cookie.split(";")[0]!;
  expect(second).not.toBe(op.cookie);
  expect(() => f.broker.describe(op.operationId, op.cookie)).toThrow("mismatch");
  expect(() => f.signIn(op)).toThrow("mismatch");
  expect(f.broker.describe(op.operationId, second)).toMatchObject({ approvalRequired: false });
  // The code after the link, then the link once more: the code's caution is never undone.
  const typed = f.codes.claim(op.code, second).cookie.split(";")[0]!;
  expect(() => f.broker.describe(op.operationId, second)).toThrow("mismatch");
  expect(f.broker.describe(op.operationId, typed)).toMatchObject({ approvalRequired: true });
  const cookie = f.broker.launch(op.operationId, ticket, typed).cookie.split(";")[0]!;
  expect(f.broker.describe(op.operationId, cookie)).toMatchObject({ approvalRequired: true });
  expect(f.codes.claim(op.code, "").cookie.split(";")[0]).not.toBe(cookie);
  const last = { operationId: op.operationId, cookie: "" };
  last.cookie = f.broker.launch(op.operationId, ticket, "").cookie.split(";")[0]!;

  f.signIn(last);
  // A sign-in is on the request now: neither capability hands it to another browser.
  expect(() => f.broker.launch(op.operationId, ticket, "")).toThrow("refused");
  expect(() => f.codes.claim(op.code, "")).toThrow("refused");
  expect(f.broker.confirm(op.operationId, last.cookie, f.actor).location).toBe(
    origin + "/_relay/v3/desktop/complete",
  );
  expect(() => f.broker.launch(op.operationId, ticket, "")).toThrow("refused");
  expect(() => f.codes.claim(op.code, "")).toThrow("refused");
  const redeemed = await f.broker.redeem({
    operationId: op.operationId,
    ticket: op.ticket,
    verifier: op.verifier,
    completion: opaque(),
  });
  expect(redeemed.status).toBe("approved");
  expect(redeemed).not.toHaveProperty("signInProof");
  expect(() => f.codes.claim(op.code, "")).toThrow("unavailable");
});

test("the sign-in proof leaves only to a desktop holding the completion its own browser was handed over loopback", async () => {
  const f = await fixture(),
    op = f.start(49152),
    input = { operationId: op.operationId, ticket: op.ticket, verifier: op.verifier };
  expect(f.broker.describe(op.operationId, op.cookie)).toMatchObject({ approvalRequired: false });
  f.signIn(op);
  const location = new URL(f.broker.confirm(op.operationId, op.cookie, f.actor).location);
  expect(location.origin + location.pathname).toBe("http://127.0.0.1:49152/omnesis/callback");
  expect([...location.searchParams.keys()]).toEqual(["operationId", "completion"]);
  expect(location.searchParams.get("operationId")).toBe(op.operationId);
  const completion = location.searchParams.get("completion")!;
  // Within the grace period, a redemption without the right completion waits for the browser.
  expect(await f.broker.redeem(input)).toMatchObject({ status: "pending" });
  expect(await f.broker.redeem({ ...input, completion: opaque() })).toMatchObject({
    status: "pending",
  });
  const result = await f.broker.redeem({ ...input, completion });
  expect(result).toMatchObject({
    status: "approved",
    signInProof: { type: "google", idToken: "fictional-google-token" },
  });
});

test("a desktop sign-in completed elsewhere, by link or by code, only ever releases discovery without a proof", async () => {
  const f = await fixture();
  // An attacker started this and sent the owner the link: the owner's browser went to the
  // owner's own loopback, so the attacker never learns the completion.
  const phished = f.start(49153),
    input = {
      operationId: phished.operationId,
      ticket: phished.ticket,
      verifier: phished.verifier,
    };
  f.signIn(phished);
  f.broker.confirm(phished.operationId, phished.cookie, f.actor);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + LOOPBACK_GRACE_MS + 1 });
  const late = await f.broker.redeem({ ...input, completion: opaque() });
  expect(late.status).toBe("approved");
  expect(late).not.toHaveProperty("signInProof");
  expect(late).not.toHaveProperty("credentialPublicKey");
  vi.useRealTimers();

  // A connect code may be typed on any machine: no loopback handoff, no proof.
  const codes = new ConnectCodes(),
    broker = new DesktopAccountBrowser({
      origin,
      sessions: f.sessions,
      codes,
      assertAccount: () => {},
      assertCurrent: () => {},
    });
  cleanup.push(() => broker.close());
  const verifier = opaque(),
    typed = broker.start({
      kind: "cli",
      name: "Fictional terminal",
      nonce: opaque(),
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      loopbackPort: 49154,
    });
  const cookie = codes.claim(typed.code, "").cookie.split(";")[0]!;
  expect(broker.describe(typed.operationId, cookie)).toMatchObject({ approvalRequired: true });
  broker.recordProof(typed.operationId, cookie, {
    type: "google",
    accountId: f.actor.accountId,
    idToken: "fictional-google-token",
    nonce: broker.googleProofNonce(typed.operationId, cookie),
  });
  expect(broker.confirm(typed.operationId, cookie, f.actor).location).toBe(
    origin + "/_relay/v3/desktop/complete",
  );
  const redeemed = await broker.redeem({
    operationId: typed.operationId,
    ticket: typed.ticket,
    verifier,
    completion: opaque(),
  });
  expect(redeemed.status).toBe("approved");
  expect(redeemed).not.toHaveProperty("signInProof");
  for (const loopbackPort of [80, 65536, 1.5])
    expect(() =>
      broker.start({
        kind: "cli",
        name: "Fictional terminal",
        nonce: opaque(),
        challenge: opaque(),
        loopbackPort,
      }),
    ).toThrow("Invalid desktop");
});
