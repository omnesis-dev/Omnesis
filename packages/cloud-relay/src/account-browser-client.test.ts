// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { z } from "zod";
import { tlsFiles, listen } from "../test/support.js";
import { registeredPasskey, signInOnOperation } from "../test/operation-sign-in.js";
import { ManagedAccountBrowser } from "./account-browser-client.js";
import { ACCOUNT_CREDENTIALS_EVIDENCE } from "./account-browser-contract.js";
import { signInProofSchema } from "./device-enrollment.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { gatewayKeyAccount, KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { GatewayAccountLink } from "./gateway-account-link.js";
import { GooglePairingRequests, googlePairingNonce } from "./google-pairing.js";
import type { AccountBrowserPending } from "./account-browser-client.js";

const origin = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url");
let directory: string, certificateFile: string, privateKeyFile: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-account-client-"));
  const tls = tlsFiles(directory, "*.example.test");
  certificateFile = tls.certFile;
  privateKeyFile = tls.keyFile;
});
afterAll(async () => rm(directory, { recursive: true, force: true }));
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const temporary = await mkdtemp(join(directory, "client-")),
    accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const key = generateKeyPairSync("ed25519"),
    gatewayId = randomUUID(),
    ownerPublicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const owner = gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    ownerFile = join(temporary, "owner.pem");
  await writeFile(ownerFile, key.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const certificate = await readFile(certificateFile, "utf8");
  accounts.registerKeyBinding(
    owner,
    {
      gatewayId,
      publicOrigin: "https://gateway.example.test",
      certificate,
      identityToken:
        KEY_BINDING_PREFIX +
        key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    },
    true,
  );
  const authority = new AccountEnrollmentAuthority(
    origin,
    generateKeyPairSync("ed25519").privateKey,
  );
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    hostnameProof: async () => true,
    accountSignIn: { enrollmentAuthority: authority },
    // Every simulated gateway and browser here shares one test address.
    loginLimits: { maxConcurrent: 8, maxPerMinute: 60, maxPerMinutePerClient: 60 },
  });
  const url = await listen(relay.server);
  const accountId = accounts.identities.signInFederated("google", "a".repeat(64)),
    account = await sessions.issueAccountSession({ accountId, version: 1 }, "passkey", origin);
  accounts.identities.registerSession(
    account.accountId,
    account.version,
    account.sessionId,
    account.expiresAt,
  );
  const env: NodeJS.ProcessEnv = {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_CLOUD_RELAY_URL: origin,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://gateway.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(temporary, "session.json"),
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerFile,
    OMNESIS_ACME_CERT_FILE: certificateFile,
    OMNESIS_ACME_KEY_FILE: privateKeyFile,
    OMNESIS_TLS_CERT: certificateFile,
    OMNESIS_TLS_KEY: privateKeyFile,
  };
  const transport = vi.fn<typeof fetch>(async (target, init) => {
    const address = new URL(String(target));
    expect(address.origin).toBe(origin);
    expect(init?.redirect).toBe("error");
    return fetch(url + address.pathname + address.search, init);
  });
  const options = {
    env: () => env,
    fetch: transport,
    accountId: () => accountId,
    callbackOrigins: () => ({ origins: ["https://gateway.example.test"] }),
  };
  const client = new ManagedAccountBrowser(options);
  cleanup.push(async () => {
    client.cancel();
    await relay.close();
    accounts.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const start = async (purpose: "owner-link" | "device-enrollment" = "owner-link") =>
    client.begin({
      purpose,
      nonce: opaque(),
      browserState: opaque(),
      callbackUrl: await client.callbackUrl("https://gateway.example.test", purpose),
    });
  const passkey = await registeredPasskey(accounts.identities, account);
  const confirm = async (pending: Pick<AccountBrowserPending, "authorizeUrl" | "operationId">) => {
    const launch = new URL(pending.authorizeUrl),
      response = await fetch(url + launch.pathname + launch.search, { redirect: "manual" });
    expect(response.status).toBe(303);
    const operationCookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
    await signInOnOperation(url, `?operation=${pending.operationId}`, operationCookie, passkey);
    const cookie = `${operationCookie}; __Host-omnesis-account=${account.token}`;
    const confirmed = await fetch(
      url + `/_relay/account/api/continue?operation=${pending.operationId}`,
      {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(confirmed.status).toBe(200);
    return new URL((await confirmed.json()).location).searchParams.get("result")!;
  };
  return {
    env,
    client,
    options,
    transport,
    start,
    confirm,
    accounts,
    accountId,
    authority,
    owner,
    url,
  };
}

test("the real gateway client signs owner/TLS registration and verifies provider-independent account and enrollment handoffs", async () => {
  const f = await fixture();
  expect(f.client.available()).toBe(false);
  expect(f.client.authorizationOrigin()).toBe(origin);
  const pending = await f.start();
  expect(f.client.available()).toBe(true);
  expect(pending.authorizeUrl).not.toContain(pending.redemptionSecret);
  const result = await f.client.redeem(pending, await f.confirm(pending));
  expect(result.identity).toMatchObject({
    issuer: origin + "/_relay/account",
    subject: f.accountId,
  });
  await expect(f.client.redeem(pending, "x".repeat(43))).rejects.toThrow("refused");
  const device = await f.start("device-enrollment");
  expect((await f.client.redeem(device, await f.confirm(device))).identity.subject).toBe(
    f.accountId,
  );
  const before = f.transport.mock.calls.length;
  await f.client.refresh();
  expect(f.transport.mock.calls.length).toBe(before);
  await f.client.unlink();
  expect(f.accounts.identities.gatewayAccount(f.owner)).toBeUndefined();
  // Disconnecting takes the gateway's registration with it.
  expect(f.accounts.gatewayBinding(f.owner)).toBeUndefined();
  f.client.cancel();
  expect(f.client.available()).toBe(false);
});

test("a real gateway account manager links a passkey account and enrolls only after explicit trusted gateway approval", async () => {
  const f = await fixture();
  const manager = new GatewayAccountLink({
    ...f.options,
    metadataFile: join(directory, randomUUID(), "account.json"),
  });
  await manager.initialize();
  const launch = await manager.start({ requestOrigin: "https://gateway.example.test" });
  const operationId = new URL(launch.authorizeUrl).searchParams.get("operationId")!,
    state = launch.cookie.split(";")[0]!.split("=")[1]!;
  const result = await f.confirm({ authorizeUrl: launch.authorizeUrl, operationId });
  await manager.callback({
    url: `https://gateway.example.test/admin/cloud-relay/account/callback?operationId=${operationId}&state=${state}&result=${result}`,
    cookie: launch.cookie.split(";")[0],
  });
  expect(manager.verifiedAccountId()).toBe(f.accountId);
  const identity = manager.pairingIdentity()!;
  const createPairing = vi.fn(() =>
    Promise.resolve({ pairingCode: "fictional-approved-code", expiresAt: Date.now() + 60_000 }),
  );
  const requests = new GooglePairingRequests({
    ...identity,
    gatewayFingerprint: () => "c".repeat(64),
    createPairing,
  });
  const request = {
    requestId: randomUUID(),
    name: "Fictional phone",
    kind: "ios" as const,
    secret: randomBytes(32).toString("hex"),
  };
  const browser = manager.managedBrowser(),
    pending = await browser.begin({
      purpose: "device-enrollment",
      nonce: googlePairingNonce(request),
      browserState: opaque(),
      callbackUrl: "https://gateway.example.test/devices/account/callback",
    });
  const proof = await browser.redeem(pending, await f.confirm(pending));
  expect(
    (await requests.startForBrowser({ ...request, identityToken: proof.identityToken })).status,
  ).toBe("pending");
  expect(createPairing).not.toHaveBeenCalled();
  await requests.decide(request.requestId, true);
  expect(requests.poll(request.requestId, request.secret)).toMatchObject({
    status: "approved",
    pairingCode: "fictional-approved-code",
  });
  expect(createPairing).toHaveBeenCalledOnce();
  await manager.unlink();
  expect(manager.pairingIdentity()).toBeUndefined();
  await expect(
    identity.identity.verify(proof.identityToken, googlePairingNonce(request)),
  ).rejects.toThrow();
  manager.cancel();
});

test("the client refuses foreign handoff destinations and private or malformed account verification keys", async () => {
  for (const attack of [
    "destination",
    "missing-ticket",
    "private-key",
    "duplicate-key",
    "unavailable",
    "refused",
  ] as const) {
    const f = await fixture(),
      transport = f.options.fetch;
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (target, init) => {
      const path = new URL(String(target)).pathname;
      if (path.endsWith("account-keys")) {
        if (attack === "unavailable") return new Response("", { status: 503 });
        if (attack === "refused") return new Response("", { status: 403 });
        if (attack === "private-key")
          return Response.json({
            keys: [{ ...f.authority.jwks().keys[0], d: "private-material" }],
          });
        if (attack === "duplicate-key")
          return Response.json({ keys: [...f.authority.jwks().keys, ...f.authority.jwks().keys] });
      }
      const response = await original(target, init);
      if (attack === "destination" && path.endsWith("/start"))
        return Response.json({
          ...(await response.json()),
          authorizeUrl: "https://unrelated.example.test/signin",
        });
      if (attack === "missing-ticket" && path.endsWith("/start")) {
        const value = await response.json(),
          url = new URL(value.authorizeUrl);
        url.searchParams.delete("ticket");
        url.searchParams.set("other", opaque());
        return Response.json({ ...value, authorizeUrl: url.href });
      }
      return response;
    });
    await expect(f.start()).rejects.toThrow();
    if (attack !== "destination" && attack !== "missing-ticket")
      expect(f.client.available()).toBe(false);
  }
});

test("an idle advertised capability still requires a fresh successful probe before a new handoff", async () => {
  for (const status of [404, 503]) {
    const f = await fixture();
    await f.client.refresh();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_001 });
    expect(f.client.available()).toBe(true);
    const before = f.transport.mock.calls.length;
    f.transport.mockResolvedValue(new Response(null, { status }));
    await expect(f.start()).rejects.toThrow("unavailable");
    expect(f.client.available()).toBe(false);
    expect(f.transport.mock.calls.slice(before).map(([url]) => String(url))).toEqual([
      origin + "/_relay/v3/account-keys",
    ]);
  }
});

test("last-known UI capability never authorizes a handoff after a failed fresh probe", async () => {
  for (const failure of ["network", "http", "malformed"]) {
    const f = await fixture();
    await f.client.refresh();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_001 });
    expect(f.client.available()).toBe(true);
    const before = f.transport.mock.calls.length;
    f.transport.mockImplementation(async () => {
      if (failure === "network") throw new Error("Fictional offline service");
      return failure === "http"
        ? new Response(null, { status: 500 })
        : Response.json({ malformed: true });
    });
    await expect(f.start()).rejects.toThrow();
    expect(f.client.available()).toBe(true);
    expect(f.transport.mock.calls.slice(before).map(([url]) => String(url))).toEqual([
      origin + "/_relay/v3/account-keys",
    ]);
  }
});

test("local opt-out, account changes, expiry and cancellation cannot produce late handoff results", async () => {
  const f = await fixture();
  f.env.OMNESIS_CLOUD_RELAY_ENABLED = "0";
  await f.client.refresh();
  expect(f.client.available()).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
  await expect(f.start()).rejects.toThrow("unavailable");
  await expect(f.client.unlink()).rejects.toThrow("unavailable");
  f.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
  const pending = await f.start(),
    result = await f.confirm(pending);
  f.env.OMNESIS_CLOUD_RELAY_URL = "https://other.example.test";
  await expect(f.client.redeem(pending, result)).rejects.toThrow("service changed");
  f.env.OMNESIS_CLOUD_RELAY_URL = origin;
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
  await expect(f.client.redeem(pending, result)).rejects.toThrow("expired");
  vi.useRealTimers();
  const controller = new AbortController();
  controller.abort();
  await expect(f.client.redeem(pending, result, controller.signal)).rejects.toThrow();
});

test("certificate-bound callbacks and default owner-key paths work without injected transport or callback policy", async () => {
  const f = await fixture(),
    realFetch = fetch;
  vi.stubGlobal("fetch", (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(target));
    return realFetch(url.origin === origin ? f.url + url.pathname + url.search : target, init);
  });
  await copyFile(
    f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!,
    `${f.env.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`,
  );
  delete f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE;
  const client = new ManagedAccountBrowser({ env: () => f.env });
  expect(await client.callbackUrl("https://gateway.example.test", "owner-link")).toBe(
    "https://gateway.example.test/admin/cloud-relay/account/callback",
  );
  expect(await client.callbackUrl("https://gateway.example.test", "device-enrollment")).toBe(
    "https://gateway.example.test/devices/account/callback",
  );
  delete f.env.OMNESIS_TLS_CERT;
  await expect(client.callbackUrl("https://foreign.example.test", "owner-link")).rejects.toThrow();
  f.env.OMNESIS_TLS_CERT = certificateFile;
  const pending = await client.begin({
    purpose: "owner-link",
    nonce: opaque(),
    browserState: opaque(),
    callbackUrl: await client.callbackUrl("https://gateway.example.test", "owner-link"),
  });
  expect((await client.redeem(pending, await f.confirm(pending))).identity.subject).toBe(
    f.accountId,
  );
  client.cancel();
});

test("owner-session mismatch and rejected starts cannot launch account sign-in", async () => {
  for (const attack of ["owner", "start"] as const) {
    const f = await fixture(),
      original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (target, init) => {
      const response = await original(target, init);
      const path = new URL(String(target)).pathname;
      if (attack === "owner" && path.endsWith("/key/complete"))
        return Response.json({ ...(await response.json()), accountId: "b".repeat(64) });
      if (attack === "start" && path.endsWith("/start")) return new Response("", { status: 403 });
      return response;
    });
    await expect(f.start()).rejects.toThrow();
  }
});

test("a validly signed proof must still match the result account and original handoff lifetime", async () => {
  for (const attack of ["account", "issued", "expiry", "keys"] as const) {
    const f = await fixture(),
      pending = await f.start(),
      result = await f.confirm(pending),
      original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (target, init) => {
      const path = new URL(String(target)).pathname;
      if (attack === "keys" && path.endsWith("account-keys"))
        return new Response("", { status: 503 });
      const response = await original(target, init);
      if (attack === "account" && path.endsWith("/redeem"))
        return Response.json({ ...(await response.json()), accountId: "b".repeat(64) });
      return response;
    });
    if (attack === "issued") pending.issuedAt += 120;
    if (attack === "expiry") pending.expiresAt -= 1;
    await expect(f.client.redeem(pending, result)).rejects.toThrow();
  }
});

test("local identity, configuration, or cancellation changes across network awaits invalidate the operation", async () => {
  for (const attack of ["gateway", "origin", "enabled", "cancel", "owner"] as const) {
    const f = await fixture(),
      pending = await f.start(),
      result = await f.confirm(pending),
      original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (target, init) => {
      const response = await original(target, init);
      if (new URL(String(target)).pathname.endsWith("/key/complete")) {
        if (attack === "gateway") f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = randomUUID();
        if (attack === "origin")
          f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = "https://other.example.test";
        if (attack === "enabled") f.env.OMNESIS_CLOUD_RELAY_ENABLED = "0";
        if (attack === "cancel") f.client.cancel();
        if (attack === "owner")
          pending.owner = { ...pending.owner, publicOrigin: "https://other.example.test" };
      }
      return response;
    });
    await expect(f.client.redeem(pending, result)).rejects.toThrow();
  }
});

test("unlink refuses failed control responses and expired capability probes refresh without hiding sign-in", async () => {
  const f = await fixture(),
    original = f.transport.getMockImplementation()!;
  await f.client.refresh();
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_001 });
  expect(f.client.available()).toBe(true);
  const before = f.transport.mock.calls.length;
  await f.client.refresh();
  expect(f.transport.mock.calls.length).toBe(before + 1);
  expect(f.client.available()).toBe(true);
  vi.useRealTimers();
  f.transport.mockImplementation(async (target, init) =>
    new URL(String(target)).pathname.endsWith("/unlink")
      ? new Response("", { status: 503 })
      : original(target, init),
  );
  await expect(f.client.unlink()).rejects.toThrow("refused");
});

test("a local owner-key rotation immediately after registration cannot authorize a stale handoff", async () => {
  const f = await fixture();
  const client = new ManagedAccountBrowser({
    ...f.options,
    register: async (input) => {
      const session = await registerGatewayKey(input);
      await writeFile(
        f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!,
        generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
      return session;
    },
  });
  await expect(
    client.begin({
      purpose: "owner-link",
      nonce: opaque(),
      browserState: opaque(),
      callbackUrl: "https://gateway.example.test/admin/cloud-relay/account/callback",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Gateway owner session changed");
  client.cancel();
});

test("native enrollment verification refuses unavailable authorities, account changes and local opt-out", async () => {
  for (const attack of ["disabled", "keys", "account"] as const) {
    const f = await fixture();
    const linked = await f.start();
    await f.confirm(linked);
    const pending = await f.start("device-enrollment"),
      proof = await f.client.redeem(pending, await f.confirm(pending));
    const original = f.transport.getMockImplementation()!;
    if (attack === "disabled") f.env.OMNESIS_CLOUD_RELAY_ENABLED = "0";
    f.transport.mockImplementation(async (target, init) => {
      if (new URL(String(target)).pathname.endsWith("account-keys")) {
        if (attack === "keys") return new Response("", { status: 503 });
        if (attack === "account") f.options.accountId = () => "b".repeat(64);
      }
      return original(target, init);
    });
    await expect(f.client.verifyEnrollment(proof.identityToken, pending.nonce)).rejects.toThrow();
  }
});

test("credentials list the linked account's current sign-ins and answer nothing when unlinked, refused or opted out", async () => {
  const f = await fixture();
  const pending = await f.start();
  await f.client.redeem(pending, await f.confirm(pending));
  const listed = await f.client.credentials();
  expect(listed).toMatchObject({ accountId: f.accountId });
  expect(listed!.google).toEqual(expect.any(Array));
  expect(listed!.passkeys.length).toBeGreaterThan(0);
  // The passkey was added to an existing account, so it comes with the sign-in that vouched for it.
  expect(listed!.passkeys[0]).toEqual({
    id: expect.any(String),
    publicKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    endorsement: { type: "google", idToken: "fixture-google-token", salt: expect.any(String) },
  });
  const request = f.transport.mock.calls.at(-1)!;
  expect(new URL(String(request[0])).pathname).toBe("/_relay/v3/account-browser/credentials");
  // A passkey without a vouching sign-in is listed as it is; anything else in its place is refused.
  const original = f.transport.getMockImplementation()!;
  for (const [endorsement, accepted] of [
    [undefined, true],
    [{ type: "relay-says-so" }, false],
  ] as const) {
    f.transport.mockImplementation(async (target, init) =>
      new URL(String(target)).pathname.endsWith("/credentials")
        ? Response.json({
            accountId: f.accountId,
            google: [],
            passkeys: [{ id: "fictional", publicKey: "ZmljdGlvbmFs", endorsement }],
          })
        : original(target, init),
    );
    if (accepted)
      expect((await f.client.credentials())!.passkeys).toEqual([
        { id: "fictional", publicKey: "ZmljdGlvbmFs" },
      ]);
    else await expect(f.client.credentials()).rejects.toThrow();
  }
  f.transport.mockImplementation(original);
  // A registered gateway that no account lists gets no credentials.
  f.accounts.identities.unlinkGatewayOwner(f.owner);
  expect(await f.client.credentials()).toBeUndefined();
  // Once it has disconnected, the relay no longer knows it at all.
  await f.client.unlink();
  await expect(f.client.credentials()).rejects.toThrow("no longer has a registration");
  f.env.OMNESIS_CLOUD_RELAY_ENABLED = "0";
  const before = f.transport.mock.calls.length;
  expect(await f.client.credentials()).toBeUndefined();
  expect(f.transport.mock.calls.length).toBe(before);
});

/** Base64url text of a given length, standing in for signed bytes whose content is not checked here. */
const filler = (length: number) => "A".repeat(length);
/** A passkey assertion's shape, as large as the biggest real one: an id of 1023 bytes, RSA signature. */
const assertionShape = (id: string) => ({
  type: "passkey" as const,
  salt: opaque(),
  issuedAt: "1793318400",
  credential: {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: filler(400),
      authenticatorData: filler(50),
      signature: filler(342),
      userHandle: filler(43),
    },
  },
});
/** An RSA-2048 public key as COSE, the larger of the two algorithms a passkey may use. */
const rsaCoseKey = () => {
  const { n, e } = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    format: "jwk",
  });
  return Buffer.from(
    isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 3],
        [3, -257],
        [-1, Buffer.from(n!, "base64url")],
        [-2, Buffer.from(e!, "base64url")],
      ]),
    ),
  );
};
/** The listing a gateway from before countersignatures accepts, kept as it was. */
const strictListing = z
  .object({
    accountId: z.string(),
    google: z.array(z.string().max(128)).max(64),
    passkeys: z
      .array(
        z
          .object({
            id: z.string().max(2048),
            publicKey: z.string().max(4096),
            endorsement: signInProofSchema.optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

test("countersignatures reach only a gateway that asks for them, so one from before them still reads the listing", async () => {
  const f = await fixture();
  const pending = await f.start();
  await f.client.redeem(pending, await f.confirm(pending));
  const id = randomBytes(32).toString("base64url");
  f.accounts.identities.registerPasskey(
    f.accountId,
    {
      credential: { id, publicKey: new Uint8Array(rsaCoseKey()), counter: 0 },
      deviceType: "multiDevice",
      backedUp: true,
      label: "Fixture passkey",
    },
    false,
    undefined,
    undefined,
    undefined,
    { proof: assertionShape(id), signIns: [opaque()] },
  );
  const listed = await f.client.credentials();
  expect(listed!.passkeys.find((passkey) => passkey.id === id)!.countersignature).toMatchObject({
    signIns: [expect.any(String)],
  });
  const [, init] = f.transport.mock.calls.at(-1)!;
  const headers = new Headers(init!.headers);
  expect(headers.get(ACCOUNT_CREDENTIALS_EVIDENCE.header)).toBe(
    ACCOUNT_CREDENTIALS_EVIDENCE.countersignatures,
  );
  // An older gateway sends no such header and gets the listing it has always parsed.
  headers.delete(ACCOUNT_CREDENTIALS_EVIDENCE.header);
  const path = "/_relay/v3/account-browser/credentials";
  const older = await (await f.transport(origin + path, { headers, redirect: "error" })).json();
  expect(strictListing.parse(older).passkeys.map((passkey) => passkey.id)).toContain(id);
  expect(JSON.stringify(older)).not.toContain("countersignature");
  // Sent to it anyway, the listing would have been refused whole: that is why it asks.
  headers.set(ACCOUNT_CREDENTIALS_EVIDENCE.header, ACCOUNT_CREDENTIALS_EVIDENCE.countersignatures);
  const newer = await (await f.transport(origin + path, { headers, redirect: "error" })).json();
  expect(() => strictListing.parse(newer)).toThrow();
  // Any other value is no request for them.
  headers.set(ACCOUNT_CREDENTIALS_EVIDENCE.header, "countersignature-v1");
  expect(
    JSON.stringify(await (await f.transport(origin + path, { headers, redirect: "error" })).json()),
  ).not.toContain("countersignature");
  // This gateway drops fields it does not know instead of refusing the listing, top-level or
  // on an entry, so the next addition can't cut it off either.
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (target, init) =>
    new URL(String(target)).pathname.endsWith("/credentials")
      ? Response.json({
          ...newer,
          laterField: true,
          passkeys: newer.passkeys.map((passkey: object) => ({ ...passkey, laterField: 1 })),
        })
      : original(target, init),
  );
  const tolerant = await f.client.credentials();
  expect(tolerant!.passkeys.map((passkey) => passkey.id)).toContain(id);
  expect(JSON.stringify(tolerant)).not.toContain("laterField");
});

test("a full account of RSA passkeys with the longest ids lists within the bound", async () => {
  const f = await fixture();
  const pending = await f.start();
  await f.client.redeem(pending, await f.confirm(pending));
  // The account has Google and one passkey; fill it to its sixteen sign-ins.
  const ids: string[] = [];
  for (let index = 0; ids.length < 14; index++) {
    const id = randomBytes(1023).toString("base64url");
    const endorser = ids.at(-1) ?? id;
    f.accounts.identities.registerPasskey(
      f.accountId,
      {
        credential: { id, publicKey: new Uint8Array(rsaCoseKey()), counter: 0 },
        deviceType: "multiDevice",
        backedUp: true,
        label: `Fixture passkey ${index}`,
      },
      false,
      undefined,
      undefined,
      { ...assertionShape(endorser), credentialPublicKey: rsaCoseKey().toString("base64url") },
      { proof: assertionShape(id), signIns: Array.from({ length: 15 }, opaque) },
    );
    ids.push(id);
  }
  expect(() =>
    f.accounts.identities.registerPasskey(
      f.accountId,
      {
        credential: { id: opaque(), publicKey: new Uint8Array(rsaCoseKey()), counter: 0 },
        deviceType: "multiDevice",
        backedUp: true,
        label: "One too many",
      },
      false,
    ),
  ).toThrow("limit");
  const listed = await f.client.credentials();
  expect(listed!.passkeys).toHaveLength(15);
  expect(listed!.passkeys.filter((passkey) => passkey.countersignature)).toHaveLength(14);
  // It is well past what other relay answers are held to, and within this bound.
  const size = JSON.stringify(listed).length;
  expect(size).toBeGreaterThan(65_536);
  expect(size).toBeLessThan(262_144);
});

test("redemption passes the operation's sign-in proof through, with or without an offered key", async () => {
  const f = await fixture();
  const link = await f.start();
  await f.client.redeem(link, await f.confirm(link));
  const pending = await f.start("device-enrollment");
  const result = await f.client.redeem(pending, await f.confirm(pending));
  expect(result.signInProof).toMatchObject({ type: "passkey" });
  expect(result.credentialPublicKey).toEqual(expect.any(String));
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (target, init) => {
    const response = await original(target, init);
    if (!new URL(String(target)).pathname.endsWith("/redeem")) return response;
    const { credentialPublicKey: _key, ...rest } = await response.json();
    return Response.json(rest);
  });
  const plain = await f.start("device-enrollment");
  const bare = await f.client.redeem(plain, await f.confirm(plain));
  expect(bare.identity.subject).toBe(f.accountId);
  expect(bare.signInProof).toMatchObject({ type: "passkey" });
  expect(bare).not.toHaveProperty("credentialPublicKey");
});
