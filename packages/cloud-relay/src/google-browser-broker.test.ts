// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { googleBrowserFixture } from "../test/google-browser-fixture.js";
import { GoogleBrowserBroker } from "./google-browser-broker.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import {
  googleBrowserStartTranscript,
  GOOGLE_BROWSER_PROTOCOL,
} from "./google-browser-contract.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "google-browser-broker-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test.each(["owner-link", "device-enrollment"] as const)(
  "%s uses one fixed Google callback, separate browser state, PKCE and backend-only one-use redemption",
  async (purpose) => {
    const f = await googleBrowserFixture(directory),
      flow = f.launch(f.broker, purpose);
    const authorize = new URL(flow.launched.authorizeUrl);
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://relay.example.test/_relay/v2/google/browser/callback",
    );
    expect(authorize.searchParams.get("state")).not.toBe(flow.input.browserState);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.launched.cookie).toMatch(
      /__Host-.*; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=/,
    );
    expect(flow.started.authorizeUrl).not.toContain(flow.secret);
    const completed = await f.broker.callback(flow.callback, flow.launched.cookie);
    const callback = new URL(completed.redirectUrl);
    expect(callback.origin).toBe("https://direct.example.test");
    expect(callback.searchParams.get("state")).toBe(flow.input.browserState);
    expect([...callback.searchParams.keys()].sort()).toEqual(["brokerResult", "state"]);
    expect(completed.cookie).toContain("Max-Age=0");
    const input = {
      operationId: flow.input.operationId,
      result: callback.searchParams.get("brokerResult")!,
      redemptionSecret: flow.secret,
    };
    expect(() =>
      f.broker.redeem(f.owner, {
        ...input,
        redemptionSecret: randomBytes(32).toString("base64url"),
      }),
    ).toThrow("redemption");
    const credentials = f.broker.redeem(f.owner, input);
    await expect(
      f.issuer(credentials.clientId).verify(credentials.idToken, flow.input.nonce),
    ).resolves.toMatchObject({ subject: "synthetic-google-account" });
    expect(completed.redirectUrl).not.toContain(credentials.idToken);
    expect(completed.redirectUrl).not.toContain(flow.secret);
    expect(() => f.broker.redeem(f.owner, input)).toThrow("redemption");
    expect(() => f.broker.start(f.owner, flow.input)).toThrow("already exists");
    f.broker.close();
  },
);

test("owner signatures bind every recipient, identity, callback, purpose, nonce, browser state and capability field", async () => {
  const f = await googleBrowserFixture(directory),
    original = f.request();
  for (const override of [
    { nonce: "x".repeat(43) },
    { browserState: "y".repeat(43) },
    { redemptionSha256: "0".repeat(64) },
    { callbackUrl: "https://other.example.test/admin/cloud-relay/google/callback" },
    { issuedAt: original.input.issuedAt + 1 },
    { expiresAt: original.input.expiresAt - 1 },
    { operationId: "00000000-0000-4000-8000-000000000001" },
  ])
    expect(() => f.broker.start(f.owner, { ...original.input, ...override })).toThrow(
      "owner proof",
    );
  for (const override of [
    { relayOrigin: "https://different.example.test" },
    { gatewayId: "00000000-0000-4000-8000-000000000002" },
    { publicOrigin: "https://other.example.test" },
    { accountId: "a".repeat(64) },
    { tlsSpkiFingerprint: "f".repeat(64) },
  ])
    expect(() => f.broker.start({ ...f.owner, ...override }, original.input)).toThrow(
      "owner proof",
    );
  const badPurpose = f.request("device-enrollment").input;
  expect(() =>
    f.broker.start(f.owner, {
      ...badPurpose,
      purpose: "owner-link",
      callbackUrl: original.input.callbackUrl,
    }),
  ).toThrow("owner proof");
  expect(() =>
    f.broker.start(f.owner, { ...original.input, ownerSignature: "x".repeat(86) }),
  ).toThrow("owner proof");
  expect(() =>
    f.broker.start(f.owner, f.request("owner-link", { nonce: "z".repeat(43) }).input),
  ).toThrow("owner proof");
  expect(() =>
    f.broker.start({ ...f.owner, ownerPublicKey: f.registration.certificate }, original.input),
  ).toThrow("owner proof");
  f.broker.close();
});

test("invalid callback forms, malformed proofs and ambiguous lifetimes never create an operation", async () => {
  const f = await googleBrowserFixture(directory),
    valid = f.request().input;
  for (const callbackUrl of [
    "http://direct.example.test/admin/cloud-relay/google/callback",
    "https://user:secret@direct.example.test/admin/cloud-relay/google/callback",
    valid.callbackUrl + "?next=x",
    valid.callbackUrl + "#x",
    "https://direct.example.test/devices/google/callback",
    "https://direct.example.test:0/admin/cloud-relay/google/callback",
    "not-a-url",
  ])
    expect(() => f.broker.start(f.owner, { ...valid, callbackUrl })).toThrow(
      /Invalid.*browser operation/,
    );
  for (const value of [
    null,
    { ...valid, extra: true },
    { ...valid, expiresAt: valid.issuedAt },
    { ...valid, expiresAt: valid.issuedAt + 301 },
    { ...valid, ownerSignature: "bad" },
  ])
    expect(() => f.broker.start(f.owner, value)).toThrow(/Invalid.*browser operation/);
  expect(() =>
    f.broker.start(
      f.owner,
      f.request("owner-link", {
        issuedAt: Math.floor(Date.now() / 1000) + 32,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }).input,
    ),
  ).toThrow("expired");
  expect(() =>
    f.broker.start(
      f.owner,
      f.request("owner-link", { issuedAt: f.now - 300, expiresAt: f.now }).input,
    ),
  ).toThrow("expired");
  expect(() => f.broker.start({ ...f.owner, sessionExpiresAt: f.now }, valid)).toThrow(
    "session expired",
  );
  f.broker.close();
});

test("operation and owner bounds include consumed replay tombstones, expiry frees capacity, and stop invalidates all pending work", async () => {
  const f = await googleBrowserFixture(directory);
  const broker = new GoogleBrowserBroker({
    ...f.configuration,
    origin: () => f.owner.relayOrigin,
    maxOperations: 1,
    maxOperationsPerOwner: 1,
  });
  const first = f.request();
  broker.start(f.owner, first.input);
  expect(() => broker.start(f.owner, f.request().input)).toThrow("capacity");
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 301_000);
  const next = f.request();
  expect(() => broker.start(f.owner, next.input)).not.toThrow();
  broker.close();
  broker.close();
  expect(() => broker.start(f.owner, f.request().input)).toThrow("closed");
  expect(() => broker.launch(next.input.operationId, "x".repeat(43))).toThrow("launch");
  expect(() => broker.redeem(f.owner, null)).toThrow("redemption");
  f.broker.close();
});

test("browser launch/callback checks cannot be bypassed with a result handle, another cookie or duplicate state", async () => {
  const f = await googleBrowserFixture(directory),
    pending = f.request(),
    started = f.broker.start(f.owner, pending.input);
  const start = new URL(started.authorizeUrl),
    ticket = start.searchParams.get("ticket")!;
  expect(() => f.broker.launch(pending.input.operationId, "bad")).toThrow("launch");
  const launched = f.broker.launch(pending.input.operationId, ticket),
    callback = f.providerCallback(launched.authorizeUrl);
  expect(() => f.broker.launch(pending.input.operationId, ticket)).toThrow("launch");
  for (const cookies of [
    "",
    "unrelated=x",
    launched.cookie.replace(/=[^;]+;/, "=wrong;"),
    launched.cookie + ";" + launched.cookie,
  ])
    await expect(f.broker.callback(callback, cookies)).rejects.toThrow("browser state");
  const duplicate = new URL(callback);
  duplicate.searchParams.append("state", duplicate.searchParams.get("state")!);
  await expect(f.broker.callback(duplicate, launched.cookie)).rejects.toThrow("callback");
  const wrong = new URL(callback);
  wrong.searchParams.set("state", "wrong");
  await expect(f.broker.callback(wrong, launched.cookie)).rejects.toThrow("callback");
  const result = await f.broker.callback(callback, launched.cookie);
  await expect(f.broker.callback(callback, launched.cookie)).rejects.toThrow("callback");
  const redemption = {
    operationId: pending.input.operationId,
    result: new URL(result.redirectUrl).searchParams.get("brokerResult")!,
    redemptionSecret: pending.secret,
  };
  expect(() => f.broker.redeem({ ...f.owner, accountId: "a".repeat(64) }, redemption)).toThrow(
    "redemption",
  );
  expect(() => f.broker.redeem({ ...f.owner, sessionExpiresAt: f.now }, redemption)).toThrow(
    "session expired",
  );
  expect(() => f.broker.redeem(f.owner, { ...redemption, extra: true })).toThrow("redemption");
  expect(() => f.broker.redeem(f.owner, redemption)).not.toThrow();
  f.broker.close();
});

test("expired or changed owner/TLS authorization is checked at launch, after provider awaits and at redemption", async () => {
  const f = await googleBrowserFixture(directory),
    flow = f.launch();
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.exchange.getMockImplementation()!;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.exchange.mockImplementationOnce(async (...args) => {
    release();
    await waiting;
    return original(...args);
  });
  const response = f.broker.callback(flow.callback, flow.launched.cookie);
  const rejected = expect(response).rejects.toThrow("authorization changed");
  await entered;
  f.setCurrent(undefined);
  finish();
  await rejected;
  f.setCurrent(f.owner);
  const next = f.launch();
  const completed = await f.broker.callback(next.callback, next.launched.cookie);
  f.setCurrent({ ...f.owner, tlsSpkiFingerprint: "f".repeat(64) });
  expect(() =>
    f.broker.redeem(f.owner, {
      operationId: next.input.operationId,
      result: new URL(completed.redirectUrl).searchParams.get("brokerResult")!,
      redemptionSecret: next.secret,
    }),
  ).toThrow("authorization changed");
  f.broker.close();
});

test("provider failure returns only an opaque failed result, consumes redemption, and aborted or late exchanges never publish credentials", async () => {
  const f = await googleBrowserFixture(directory),
    flow = f.launch();
  flow.callback.searchParams.set("error", "access_denied");
  const failed = await f.broker.callback(flow.callback, flow.launched.cookie);
  const body = {
    operationId: flow.input.operationId,
    result: new URL(failed.redirectUrl).searchParams.get("brokerResult")!,
    redemptionSecret: flow.secret,
  };
  expect(() => f.broker.redeem(f.owner, body)).toThrow("not completed");
  expect(() => f.broker.redeem(f.owner, body)).toThrow("redemption");
  const next = f.launch();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.broker.callback(next.callback, next.launched.cookie, controller.signal),
  ).rejects.toThrow();
  const late = f.launch();
  f.exchange.mockImplementationOnce(async () => {
    f.broker.close();
    return Response.json({ id_token: await f.token(late.input.nonce), token_type: "Bearer" });
  });
  await expect(f.broker.callback(late.callback, late.launched.cookie)).rejects.toThrow("expired");
});

test("configuration is independent of caller arrays and refuses audience confusion, missing secrets and unsafe limits", async () => {
  const f = await googleBrowserFixture(directory);
  const config = f.broker.configuration();
  config.deviceClientIds.length = 0;
  expect(f.broker.configuration().deviceClientIds).toEqual([
    "fixture-device-client",
    "fixture-ios-client",
  ]);
  const empty = new GoogleBrowserBroker({
    origin: f.owner.relayOrigin,
    currentOwner: () => undefined,
  });
  expect(empty.configuration()).toEqual({
    protocol: GOOGLE_BROWSER_PROTOCOL,
    deviceClientIds: [],
    deviceAuthorizedParties: [],
  });
  expect(() => empty.start(f.owner, f.request().input)).toThrow("not configured");
  empty.close();
  const automatic = new GoogleBrowserBroker({
    origin: f.owner.relayOrigin,
    currentOwner: f.configuration.currentOwner,
    deviceEnrollment: f.configuration.deviceEnrollment,
  });
  expect(automatic.configuration().deviceClientIds).toEqual(["fixture-device-client"]);
  automatic.close();
  for (const change of [
    { ownerLink: { ...f.configuration.ownerLink!, clientId: "fixture-device-client" } },
    { ownerLink: { ...f.configuration.ownerLink!, clientSecret: " " } },
    { maxOperations: 0 },
    { maxOperationsPerOwner: 4097 },
    { origin: "https://relay.example.test/path" },
  ])
    expect(() => new GoogleBrowserBroker({ ...f.configuration, ...change })).toThrow();
  f.broker.close();
});

test("same-key renewal preserves enrolled key identity but invalidates an owner nonce tied to the old leaf", async () => {
  const f = await googleBrowserFixture(directory),
    flow = f.launch();
  const renewed = join(directory, "renewed.crt");
  execFileSync(
    "openssl",
    [
      "x509",
      "-in",
      f.files.certFile,
      "-signkey",
      f.files.keyFile,
      "-set_serial",
      "23",
      "-out",
      renewed,
    ],
    { stdio: "ignore" },
  );
  const certificate = await readFile(renewed, "utf8");
  expect(tlsSpkiFingerprint(certificate)).toBe(f.owner.tlsSpkiFingerprint);
  f.setCurrent({ ...f.owner, certificate });
  await expect(f.broker.callback(flow.callback, flow.launched.cookie)).rejects.toThrow(
    "binding changed",
  );
  expect(f.exchange).not.toHaveBeenCalled();
  f.broker.close();
});

test("contract transcript excludes signatures and rejects an invalid unsigned envelope", async () => {
  const f = await googleBrowserFixture(directory),
    { input } = f.request();
  const { ownerSignature: _signature, ...unsigned } = input;
  expect(googleBrowserStartTranscript(f.owner, unsigned).toString()).not.toContain(
    input.ownerSignature,
  );
  expect(() =>
    googleBrowserStartTranscript(f.owner, { ...unsigned, protocol: "invalid" } as never),
  ).toThrow();
  expect(() => googleBrowserStartTranscript(f.owner, input as never)).toThrow();
});
