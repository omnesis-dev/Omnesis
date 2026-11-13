// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { GatewayAccountLink } from "./gateway-account-link.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { GatewaySignInVerifier } from "./gateway-sign-in-proof.js";
import { accountId as identityDigest, googleIdentityProvider } from "./identity.js";
import {
  googleProofNonce,
  passkeyCountersignatureNonce,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  signInDigest,
  type AccountSignIn,
  type PasskeyCountersignature,
  type SignInProof,
} from "./device-enrollment.js";
import type { AccountBrowserPending, AccountBrowserPort } from "./account-browser-client.js";

const filesystem = vi.hoisted(() => ({
  afterMkdir: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      await filesystem.afterMkdir?.();
      return result;
    },
  };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-account-link-"));
});
afterEach(async () => {
  filesystem.afterMkdir = undefined;
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
const opaque = () => randomBytes(32).toString("base64url"),
  origin = "https://relay.example.test",
  gatewayOrigin = "https://gateway.example.test";
async function fixture() {
  const key = generateKeyPairSync("ed25519").privateKey,
    ownerPublicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
    gatewayId = randomUUID(),
    ownerAccountId = gatewayKeyAccount({ gatewayId, ownerPublicKey });
  const env: NodeJS.ProcessEnv = {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_CLOUD_RELAY_URL: origin,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: join(directory, "owner.pem"),
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
  };
  await writeFile(
    env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!,
    key.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const accountId = "a".repeat(64),
    operations: AccountBrowserPending[] = [];
  const browser = {
    available: vi.fn(() => true),
    authorizationOrigin: () => origin,
    refresh: vi.fn(() => Promise.resolve()),
    callbackUrl: vi.fn((requestOrigin: string) =>
      Promise.resolve(requestOrigin + "/admin/cloud-relay/account/callback"),
    ),
    begin: vi.fn((input: Parameters<AccountBrowserPort["begin"]>[0]) => {
      const pending: AccountBrowserPending = {
        operationId: randomUUID(),
        purpose: input.purpose,
        authorizeUrl: origin + "/_relay/account",
        nonce: input.nonce,
        browserState: input.browserState,
        callbackUrl: input.callbackUrl,
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        redemptionSecret: opaque(),
        relayOrigin: origin,
        owner: {
          ownerAccountId,
          gatewayId,
          publicOrigin: gatewayOrigin,
          tlsSpkiFingerprint: "f".repeat(64),
          ownerPublicKey,
        },
      };
      operations.push(pending);
      return Promise.resolve(pending);
    }),
    redeem: vi.fn(() =>
      Promise.resolve({
        identityToken: "verified-role-proof",
        identity: {
          issuer: origin + "/_relay/account",
          subject: accountId,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        },
      }),
    ),
    cancel: vi.fn(),
    verifyEnrollment: vi.fn(() =>
      Promise.resolve({
        issuer: origin + "/_relay/account",
        subject: accountId,
        expiresAt: Date.now() / 1000 + 300,
      }),
    ),
    unlink: vi.fn(() => Promise.resolve()),
  } satisfies AccountBrowserPort;
  const options = {
    env: () => env,
    metadataFile: join(directory, "metadata", "account.json"),
    browser,
  };
  const manager = new GatewayAccountLink(options);
  await manager.initialize();
  const callback = async () => {
    const launch = await manager.start({ requestOrigin: gatewayOrigin }),
      pending = operations.at(-1)!;
    return {
      launch,
      pending,
      input: {
        url: `${pending.callbackUrl}?operationId=${pending.operationId}&state=${pending.browserState}&result=${opaque()}`,
        cookie: launch.cookie.split(";")[0],
      },
    };
  };
  const link = async () => {
    const operation = await callback();
    return manager.callback(operation.input);
  };
  return {
    env,
    manager,
    browser,
    options,
    callback,
    link,
    operations,
    accountId,
    gatewayId,
    ownerAccountId,
  };
}

test("a verified account link persists privately across restart and unlink leaves gateway identity intact", async () => {
  const f = await fixture();
  expect(f.manager.accountModeActivated()).toBe(false);
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  const ownerBefore = await readFile(f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!, "utf8");
  expect(await f.link()).toMatchObject({ redirectUrl: gatewayOrigin + "/portal/settings/account" });
  expect(f.manager.status()).toMatchObject({ linked: true, canLink: false, canUnlink: true });
  expect(f.manager.verifiedAccountId()).toBe(f.accountId);
  expect((await stat(f.options.metadataFile)).mode & 0o777).toBe(0o600);
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.verifiedAccountId()).toBe(f.accountId);
  expect(restored.managedBrowser()).toBe(f.browser);
  await restored.unlink();
  expect(restored.accountModeActivated()).toBe(true);
  expect(restored.status()).toMatchObject({ linked: false, pendingUnlink: false });
  expect(await readFile(f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!, "utf8")).toBe(ownerBefore);
  const unlinked = new GatewayAccountLink(f.options);
  await unlinked.initialize();
  expect(unlinked.accountModeActivated()).toBe(true);
  expect(unlinked.verifiedAccountId()).toBeUndefined();
});

test("local unlink succeeds offline, persists its retry, and synchronizes when the relay returns", async () => {
  const f = await fixture();
  await f.link();
  f.browser.unlink.mockRejectedValue(new Error("offline"));
  await f.manager.unlink();
  expect(f.manager.status()).toMatchObject({
    linked: false,
    pendingUnlink: true,
    lastError: "account-link-failed",
  });
  await expect(f.manager.start({ requestOrigin: gatewayOrigin })).rejects.toThrow(
    "account-unavailable",
  );
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.verifiedAccountId()).toBeUndefined();
  f.browser.unlink.mockResolvedValue();
  await restored.refresh(new AbortController().signal);
  expect(restored.status()).toMatchObject({
    linked: false,
    pendingUnlink: false,
    lastError: undefined,
  });
});

test("unknown browser state, repeated fields and foreign callbacks cannot consume or adopt a pending link", async () => {
  const f = await fixture(),
    operation = await f.callback();
  for (const input of [
    { ...operation.input, cookie: undefined },
    { ...operation.input, cookie: operation.input.cookie + "; " + operation.input.cookie },
    { ...operation.input, url: operation.input.url + "&state=" + operation.pending.browserState },
    {
      ...operation.input,
      url: operation.input.url.replace(operation.pending.operationId, randomUUID()),
    },
    {
      ...operation.input,
      url: operation.input.url.replace(gatewayOrigin, "https://foreign.example.test"),
    },
    { ...operation.input, url: operation.input.url + "#fragment" },
    { ...operation.input, url: "x".repeat(4097) },
  ])
    await expect(f.manager.callback(input)).rejects.toThrow("account-link-failed");
  expect(f.browser.redeem).not.toHaveBeenCalled();
  await f.manager.callback(operation.input);
  expect(f.manager.verifiedAccountId()).toBe(f.accountId);
  await expect(f.manager.callback(operation.input)).rejects.toThrow("account-link-failed");
});

test("expiry and bounded pending requests remain recoverable", async () => {
  const f = await fixture(),
    operation = await f.callback();
  for (let index = 1; index < 8; index++) await f.callback();
  await expect(f.callback()).rejects.toThrow("operation-in-progress");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
  await expect(f.manager.callback(operation.input)).rejects.toThrow("account-link-failed");
  await f.callback();
  expect(f.browser.begin).toHaveBeenCalledTimes(9);
});

test("owner rotation, changed routing identity and opt-out never reuse a saved account", async () => {
  const f = await fixture();
  await f.link();
  f.env.OMNESIS_CLOUD_RELAY_ENABLED = "0";
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = randomUUID();
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  await f.manager.refresh();
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = f.gatewayId;
  await writeFile(
    f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await f.manager.refresh();
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.accountModeActivated()).toBe(true);
  expect(restored.verifiedAccountId()).toBeUndefined();
});

test("corrupt metadata blocks legacy fallback while allowing explicit local cleanup", async () => {
  const f = await fixture();
  await f.manager.unlink();
  await writeFile(f.options.metadataFile, "invalid json");
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.accountModeActivated()).toBe(true);
  expect(restored.status()).toMatchObject({ linked: false, lastError: "account-link-failed" });
  await restored.unlink();
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).toEqual({
    version: 1,
    linked: false,
  });
});

test("cancelled or failed proof verification cannot publish a late account association", async () => {
  for (const attack of ["cancel", "proof", "binding"] as const) {
    const f = await fixture(),
      operation = await f.callback();
    if (attack === "cancel")
      f.browser.redeem.mockImplementationOnce(() => {
        f.manager.cancel();
        return Promise.resolve({
          identityToken: "verified",
          identity: { issuer: origin, subject: f.accountId, expiresAt: Date.now() / 1000 + 60 },
        });
      });
    if (attack === "proof") f.browser.redeem.mockRejectedValueOnce(new Error("invalid proof"));
    if (attack === "binding") f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = randomUUID();
    await f.manager.callback(operation.input);
    expect(f.manager.verifiedAccountId()).toBeUndefined();
    expect(f.manager.status().lastError).toBe("account-link-failed");
  }
});

test("account mutations serialize and a cancelled refresh cannot reopen linking", async () => {
  const f = await fixture(),
    operation = await f.callback();
  let release!: (value: Awaited<ReturnType<AccountBrowserPort["redeem"]>>) => void;
  f.browser.redeem.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const callback = f.manager.callback(operation.input);
  await vi.waitFor(() => expect(f.browser.redeem).toHaveBeenCalled());
  await expect(f.manager.start({ requestOrigin: gatewayOrigin })).rejects.toThrow(
    "operation-in-progress",
  );
  await expect(f.manager.callback(operation.input)).rejects.toThrow("operation-in-progress");
  await expect(f.manager.unlink()).rejects.toThrow("operation-in-progress");
  release({
    identityToken: "verified",
    identity: { issuer: origin, subject: f.accountId, expiresAt: Date.now() / 1000 + 300 },
  });
  await callback;
  f.browser.refresh.mockImplementationOnce(() => {
    f.manager.cancel();
    return Promise.resolve();
  });
  await expect(f.manager.start({ requestOrigin: gatewayOrigin })).rejects.toThrow(
    "account-unavailable",
  );
  expect(f.manager.verifiedAccountId()).toBeUndefined();
});

test("failed local persistence is reported and never claims a successful unlink", async () => {
  const f = await fixture();
  const blocker = join(directory, "file");
  await writeFile(blocker, "synthetic");
  const manager = new GatewayAccountLink({
    ...f.options,
    metadataFile: join(blocker, "account.json"),
  });
  await manager.initialize();
  await expect(manager.unlink()).rejects.toThrow("account-link-failed");
  expect(manager.status().lastError).toBe("account-link-failed");
  expect(f.browser.unlink).not.toHaveBeenCalled();
});

test("queued unlink cannot remove the association of a replacement gateway", async () => {
  const f = await fixture();
  await f.link();
  f.browser.unlink.mockRejectedValue(new Error("offline"));
  await f.manager.unlink();
  f.browser.unlink.mockClear();
  f.env.OMNESIS_CLOUD_RELAY_URL = "https://other.example.test";
  await f.manager.refresh();
  expect(f.browser.unlink).not.toHaveBeenCalled();
  expect(f.manager.status()).toMatchObject({
    pendingUnlink: true,
    lastError: "account-unavailable",
  });
});

test("a stored unlink remains authoritative across concurrent metadata reload and remote completion", async () => {
  const f = await fixture();
  await f.link();
  f.browser.unlink.mockRejectedValueOnce(new Error("offline"));
  await f.manager.unlink();
  let release!: () => void;
  f.browser.unlink.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const refresh = f.manager.refresh();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await f.manager.initialize();
  release();
  await refresh;
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  expect(f.manager.status().pendingUnlink).toBe(true);
  await f.manager.refresh();
  expect(f.manager.status().pendingUnlink).toBe(false);
});

test("the default owner-key location and configured authority are part of the saved account binding", async () => {
  const f = await fixture();
  await writeFile(
    `${f.env.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`,
    await readFile(f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!),
  );
  delete f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE;
  await f.link();
  f.env.OMNESIS_CLOUD_RELAY_URL = "https://other.example.test";
  expect(f.manager.verifiedAccountId()).toBeUndefined();
});

test("a metadata reload during asynchronous directory creation cannot be overwritten by an older unlink completion", async () => {
  const f = await fixture();
  await f.link();
  f.browser.unlink.mockRejectedValueOnce(new Error("offline"));
  await f.manager.unlink();
  filesystem.afterMkdir = async () => {
    filesystem.afterMkdir = undefined;
    await f.manager.initialize();
  };
  await f.manager.refresh();
  expect(f.manager.status()).toMatchObject({
    linked: false,
    pendingUnlink: true,
    lastError: "account-unavailable",
  });
  await f.manager.refresh();
  expect(f.manager.status().pendingUnlink).toBe(false);
});

/** A real WebAuthn registration bound to the link operation, as the relay hands it over. */
function registrationProof(device: ReturnType<typeof passkeyAuthenticator>, nonce: string) {
  const salt = opaque(),
    issuedAt = String(Math.floor(Date.now() / 1000));
  return {
    type: "passkey-registration" as const,
    salt,
    issuedAt,
    credential: device.registration(
      passkeyProofChallenge(salt, issuedAt, nonce),
      origin,
    ) as Extract<SignInProof, { type: "passkey-registration" }>["credential"],
  };
}
function assertionProof(
  device: ReturnType<typeof passkeyAuthenticator>,
  nonce: string,
  from = origin,
) {
  const salt = opaque(),
    issuedAt = String(Math.floor(Date.now() / 1000));
  return {
    type: "passkey" as const,
    salt,
    issuedAt,
    credential: device.authentication(
      passkeyProofChallenge(salt, issuedAt, nonce),
      "dXNlcg",
      0,
      from,
    ) as Extract<SignInProof, { type: "passkey" }>["credential"],
  };
}

test("the link callback pins its own sign-in, and enrollment choices stay local and explicit", async () => {
  const f = await fixture();
  const device = passkeyAuthenticator();
  f.browser.redeem.mockImplementationOnce(((pending: AccountBrowserPending) =>
    Promise.resolve({
      identityToken: "verified-role-proof",
      identity: { issuer: origin + "/_relay/account", subject: f.accountId, expiresAt: 1 },
      signInProof: registrationProof(device, pending.nonce),
    })) as never);
  // Not linked: nothing joins automatically, and there is no policy to set.
  expect(f.manager.enrollmentPolicy()).toBe("ask");
  await expect(f.manager.setEnrollmentPolicy("ask")).rejects.toMatchObject({
    code: "configuration-invalid",
  });
  await f.link();
  // Linked with nothing chosen: automatic, and nothing about it is written down.
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).not.toHaveProperty(
    "enrollmentPolicy",
  );
  expect(f.manager.enrollmentStatus()).toEqual({
    policy: "automatic",
    trustedSignIns: [
      { type: "passkey", id: device.id, addedAt: expect.any(Number), source: "link-page" },
    ],
  });
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  expect(enrollment.policy()).toBe("automatic");
  expect(enrollment.spkiFingerprint()).toBeUndefined();
  expect(enrollment.challenges.consume(enrollment.challenges.issue().challenge)).toBe(true);
  // The pinned key verifies the same passkey's later sign-in; the relay offers no key.
  const nonce = opaque();
  const verified = await enrollment.verifyProof(assertionProof(device, nonce), nonce);
  expect(verified).toMatchObject({ type: "passkey", id: device.id, trusted: true });
  // The default survives a restart, and so does each explicit choice.
  const restored = async () => {
    const manager = new GatewayAccountLink(f.options);
    await manager.initialize();
    return manager.enrollmentPolicy();
  };
  expect(await restored()).toBe("automatic");
  await f.manager.setEnrollmentPolicy("ask");
  expect(enrollment.policy()).toBe("ask");
  expect(f.manager.enrollmentStatus()).toMatchObject({ policy: "ask" });
  expect(await restored()).toBe("ask");
  await f.manager.setEnrollmentPolicy("automatic");
  expect(enrollment.policy()).toBe("automatic");
  expect(f.manager.enrollmentStatus()).toMatchObject({ policy: "automatic" });
  expect(await restored()).toBe("automatic");
  // A sign-in that is already trusted has nothing to add.
  expect(await enrollment.canTrust(verified!)).toBe(false);
  await expect(enrollment.trustSignIn(verified!, "approval")).rejects.toMatchObject({
    status: 409,
  });
  const google = {
    type: "google" as const,
    id: "b".repeat(64),
    trusted: false,
    pin: { type: "google" as const, id: "b".repeat(64), addedAt: 1 },
  };
  expect(await enrollment.canTrust(google)).toBe(true);
  await f.manager.trustSignIn(google, "native-app");
  // A second passkey verifies under the key its request offers, which anyone could have made:
  // it is trusted only as the relay lists it for this account.
  const second = passkeyAuthenticator();
  const registered = opaque();
  const { publicKey } = (await enrollment.verifyProof(
    registrationProof(second, registered),
    registered,
  ))!.pin as { publicKey: string };
  const signed = opaque();
  const offered = (await enrollment.verifyProof(
    assertionProof(second, signed),
    signed,
    publicKey,
  ))!;
  expect(offered).toMatchObject({ type: "passkey", id: second.id, trusted: false });
  expect(await enrollment.canTrust(offered)).toBe(false);
  const credentials = vi.fn<NonNullable<AccountBrowserPort["credentials"]>>();
  (f.browser as AccountBrowserPort).credentials = credentials;
  credentials.mockResolvedValueOnce({
    google: [],
    passkeys: [{ id: second.id, publicKey: "other" }],
  });
  expect(await enrollment.canTrust(offered)).toBe(false);
  credentials.mockRejectedValueOnce(new Error("relay unavailable"));
  expect(await enrollment.canTrust(offered)).toBe(false);
  // Removed from the account between the hold and the approval: nothing is pinned.
  credentials.mockResolvedValueOnce({ google: [], passkeys: [] });
  await expect(enrollment.trustSignIn(offered, "approval")).rejects.toMatchObject({ status: 409 });
  credentials.mockResolvedValue({ google: [], passkeys: [{ id: second.id, publicKey }] });
  await enrollment.trustSignIn(offered, "approval");
  delete (f.browser as AccountBrowserPort).credentials;
  expect(f.manager.enrollmentStatus().trustedSignIns).toEqual([
    { type: "passkey", id: device.id, addedAt: expect.any(Number), source: "link-page" },
    { type: "google", id: google.id, addedAt: 1, source: "native-app" },
    { type: "passkey", id: second.id, addedAt: expect.any(Number), source: "approval" },
  ]);
  // Trusting the same sign-in again replaces its pin rather than adding one.
  await f.manager.trustSignIn(google, "approval");
  expect(f.manager.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([
    device.id,
    second.id,
    google.id,
  ]);
  await f.manager.removeTrustedSignIn(second.id);
  // An id this gateway never pinned is declined in advance; one that is no id at all is refused.
  await f.manager.removeTrustedSignIn("c".repeat(64));
  await expect(f.manager.removeTrustedSignIn("not an id")).rejects.toMatchObject({
    status: 400,
  });
  await f.manager.removeTrustedSignIn(device.id);
  expect(f.manager.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([google.id]);
  await f.manager.unlink();
  expect(f.manager.enrollmentStatus()).toEqual({ policy: "ask", trustedSignIns: [] });
  await expect(f.manager.removeTrustedSignIn(google.id)).rejects.toMatchObject({ status: 409 });
});

test("sign-in checks use this installation's relay, Android origins and Google audiences only", async () => {
  const f = await fixture();
  const device = passkeyAuthenticator();
  const android = `android:apk-key-hash:${opaque()}`;
  const spki = vi.fn(() => "e".repeat(64));
  const google = vi.fn(() => undefined);
  const linked = new GatewayAccountLink({ ...f.options, spkiFingerprint: spki, google });
  await linked.initialize();
  const nonce = opaque();
  const enrollment = () => linked.pairingIdentity()?.enrollment;
  expect(enrollment()).toBeUndefined();
  await linked.completeSignup({
    accountId: f.accountId,
    nonce,
    proof: registrationProof(device, nonce),
    signal: new AbortController().signal,
  });
  expect(linked.verifiedAccountId()).toBe(f.accountId);
  expect(enrollment()!.spkiFingerprint()).toBe("e".repeat(64));
  const fromApp = opaque();
  expect(await enrollment()!.verifyProof(assertionProof(device, fromApp, android), fromApp)).toBe(
    undefined,
  );
  f.env.OMNESIS_CLOUD_RELAY_PASSKEY_ANDROID_ORIGINS = ` ${android}, https://phish.example.test `;
  expect(
    await enrollment()!.verifyProof(assertionProof(device, fromApp, android), fromApp),
  ).toMatchObject({ trusted: true });
  const googleProof = { type: "google" as const, idToken: "x", salt: opaque() };
  expect(await enrollment()!.verifyProof(googleProof, nonce)).toBeUndefined();
  expect(google).toHaveBeenCalledOnce();
  // Without an injected provider the audiences come from local configuration, never the relay.
  const local = new GatewayAccountLink(f.options);
  await local.initialize();
  const proofs = local.pairingIdentity()!.enrollment;
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID = "client-a.example, client-b.example";
  f.env.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID = "android.example";
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID = "web.example";
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  // A signup with no proof, or one for another request, pins nothing.
  for (const proof of [undefined, registrationProof(device, opaque())]) {
    const fresh = new GatewayAccountLink({
      ...f.options,
      metadataFile: join(directory, `signup-${randomUUID()}.json`),
    });
    await fresh.completeSignup({
      accountId: f.accountId,
      nonce,
      ...(proof ? { proof } : {}),
      signal: new AbortController().signal,
    });
    expect(fresh.enrollmentStatus().trustedSignIns).toEqual([]);
  }
});

test("refresh drops pins the account no longer lists and never adds one", async () => {
  const f = await fixture();
  const device = passkeyAuthenticator();
  f.browser.redeem.mockImplementationOnce(((pending: AccountBrowserPending) =>
    Promise.resolve({
      identityToken: "verified-role-proof",
      identity: { issuer: origin + "/_relay/account", subject: f.accountId, expiresAt: 1 },
      signInProof: registrationProof(device, pending.nonce),
    })) as never);
  // Without a credential listing the pins stay as they are.
  await f.manager.refresh();
  await f.link();
  await f.manager.refresh();
  const google = "b".repeat(64);
  await f.manager.trustSignIn(
    {
      type: "google",
      id: google,
      trusted: false,
      pin: { type: "google", id: google, addedAt: 1 },
    },
    "approval",
  );
  const { publicKey } = JSON.parse(await readFile(f.options.metadataFile, "utf8"))
    .trustedSignIns[0] as { publicKey: string };
  const credentials = vi.fn<NonNullable<AccountBrowserPort["credentials"]>>();
  const listed = new GatewayAccountLink({
    ...f.options,
    browser: { ...f.browser, credentials },
  });
  await listed.initialize();
  const pins = () => listed.enrollmentStatus().trustedSignIns.map(({ id }) => id);
  credentials.mockResolvedValueOnce(undefined);
  await listed.refresh();
  expect(pins()).toEqual([device.id, google]);
  const pinned = { id: device.id, publicKey };
  credentials.mockResolvedValueOnce({ google: [google, "d".repeat(64)], passkeys: [pinned] });
  await listed.refresh();
  expect(pins()).toEqual([device.id, google]);
  credentials.mockResolvedValueOnce({
    google: [],
    passkeys: [pinned, { id: "other", publicKey }],
  });
  await listed.refresh();
  expect(pins()).toEqual([device.id]);
  // The same credential id under another key is not the passkey that was pinned.
  credentials.mockResolvedValueOnce({
    google: [google],
    passkeys: [{ id: device.id, publicKey: "replaced" }],
  });
  await listed.refresh();
  expect(pins()).toEqual([]);
  const saved = new GatewayAccountLink(f.options);
  await saved.initialize();
  expect(saved.enrollmentStatus().trustedSignIns).toEqual([]);
  // With nothing pinned there is nothing to ask the relay.
  await listed.refresh();
  expect(credentials).toHaveBeenCalledTimes(4);
  expect(listed.status().lastError).toBeUndefined();
});

const AUDIENCE = "client.example.apps.googleusercontent.com";
const SUBJECT = "fictional-google-subject";
const googleDigest = (subject = SUBJECT) =>
  identityDigest({ issuer: "https://accounts.google.com", subject, expiresAt: 1 });
let googleKey: CryptoKey;
let googleKeys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  googleKey = pair.privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "1", alg: "RS256" };
  googleKeys = createLocalJWKSet({ keys: [jwk] });
});
type Listed = { id: string; publicKey: string; endorsement?: SignInProof };
/** A real passkey, with the public key the relay lists for it. */
async function passkeyDevice() {
  const authenticator = passkeyAuthenticator(),
    nonce = opaque();
  const registered = await new GatewaySignInVerifier({
    google: () => undefined,
    relayOrigin: () => origin,
    passkeyOrigins: () => [],
    trusted: () => [],
  }).verify(registrationProof(authenticator, nonce), nonce);
  const { publicKey } = registered!.pin as { publicKey: string };
  return { authenticator, id: authenticator.id, publicKey };
}
type PasskeyDevice = Awaited<ReturnType<typeof passkeyDevice>>;
const vouchedNonce = (passkey: Listed) => passkeyEndorsementNonce(passkey.id, passkey.publicKey);
/** Google's signature over a token that names the passkey it vouches for. */
async function googleVouch(passkey: Listed, subject = SUBJECT): Promise<SignInProof> {
  const salt = opaque(),
    issuedAt = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ nonce: googleProofNonce(salt, vouchedNonce(passkey)) })
    .setProtectedHeader({ alg: "RS256", kid: "1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(googleKey);
  return { type: "google", salt, idToken };
}
/** One passkey's signature over the passkey it vouches for. */
const passkeyVouch = (by: PasskeyDevice, passkey: Listed): SignInProof =>
  assertionProof(by.authenticator, vouchedNonce(passkey));

/** A linked gateway that trusts one Google sign-in and reads the account's sign-ins from the relay. */
async function endorsing() {
  const f = await fixture();
  const credentials = vi.fn<NonNullable<AccountBrowserPort["credentials"]>>();
  const options = {
    ...f.options,
    browser: { ...f.browser, credentials },
    google: () => googleIdentityProvider(AUDIENCE, googleKeys, { authorizedParties: [AUDIENCE] }),
    signInSyncIntervalMs: 0,
  };
  const manager = new GatewayAccountLink(options);
  await manager.initialize();
  await manager.completeSignup({
    accountId: f.accountId,
    nonce: opaque(),
    signal: new AbortController().signal,
  });
  const google = googleDigest();
  await manager.trustSignIn(
    { type: "google", id: google, trusted: false, pin: { type: "google", id: google, addedAt: 1 } },
    "link-page",
  );
  return {
    ...f,
    options,
    manager,
    credentials,
    google,
    list: (...passkeys: Listed[]) => credentials.mockResolvedValue({ google: [google], passkeys }),
    pins: () => manager.enrollmentStatus().trustedSignIns.map(({ id, source }) => [id, source]),
    saved: async () =>
      JSON.parse(await readFile(f.options.metadataFile, "utf8")) as {
        declinedPasskeys?: string[];
        declinedGoogle?: string[];
        withdrawnSignIns?: string[];
        trustedSignIns: { id: string }[];
      },
  };
}

test("a listed passkey is pinned once a sign-in pinned here vouched for it, and a chain is followed", async () => {
  const f = await endorsing();
  const first = await passkeyDevice(),
    second = await passkeyDevice(),
    unvouched = await passkeyDevice();
  // Google vouched for the first passkey, which vouched for the second. The second is listed
  // first, so it can only be pinned once the first has been.
  f.list(
    { id: second.id, publicKey: second.publicKey, endorsement: passkeyVouch(first, second) },
    { id: unvouched.id, publicKey: unvouched.publicKey },
    { id: first.id, publicKey: first.publicKey, endorsement: await googleVouch(first) },
  );
  await f.manager.refresh();
  expect(f.manager.status().lastError).toBeUndefined();
  expect(f.pins()).toEqual([
    [f.google, "link-page"],
    [first.id, "endorsed"],
    [second.id, "endorsed"],
  ]);
  expect(f.manager.enrollmentStatus().trustedSignIns[1]).toEqual({
    type: "passkey",
    id: first.id,
    addedAt: expect.any(Number),
    source: "endorsed",
  });
  // Pinning on a vouching sign-in is not the owner declining anything.
  expect((await f.saved()).declinedPasskeys).toEqual([]);
  // The pinned key is what later verifies that passkey's sign-ins, with no key offered.
  const enrollment = f.manager.pairingIdentity()!.enrollment,
    nonce = opaque();
  expect(
    await enrollment.verifyProof(assertionProof(second.authenticator, nonce), nonce),
  ).toMatchObject({ type: "passkey", id: second.id, trusted: true });
  // Another refresh has nothing to add, and the pins survive a restart.
  await f.manager.refresh();
  expect(f.pins()).toHaveLength(3);
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([
    f.google,
    first.id,
    second.id,
  ]);
});

test("the relay's list alone, or a vouching this gateway can't check for itself, pins nothing", async () => {
  const f = await endorsing();
  const added = await passkeyDevice(),
    unpinned = await passkeyDevice(),
    other = await passkeyDevice();
  const listed = { id: added.id, publicKey: added.publicKey };
  const registration = registrationProof(unpinned.authenticator, vouchedNonce(listed));
  for (const passkey of [
    // No sign-in vouched for it at all.
    listed,
    // A Google account this gateway never trusted.
    { ...listed, endorsement: await googleVouch(listed, "fictional-other-subject") },
    // A passkey this gateway never pinned, even when the proof offers its key.
    { ...listed, endorsement: passkeyVouch(unpinned, listed) },
    {
      ...listed,
      endorsement: { ...passkeyVouch(unpinned, listed), credentialPublicKey: unpinned.publicKey },
    },
    // A registration carries no signature from an existing sign-in.
    { ...listed, endorsement: registration },
    // A passkey can't vouch for itself.
    { ...listed, endorsement: passkeyVouch(added, listed) },
    // A genuine vouching, moved onto another public key or another id.
    { id: added.id, publicKey: other.publicKey, endorsement: await googleVouch(listed) },
    { id: other.id, publicKey: added.publicKey, endorsement: await googleVouch(listed) },
    // Not a sign-in proof.
    { ...listed, endorsement: { type: "relay-says-so" } as unknown as SignInProof },
  ]) {
    f.list(passkey);
    await f.manager.refresh();
    expect(f.manager.status().lastError).toBeUndefined();
    expect(f.pins()).toEqual([[f.google, "link-page"]]);
    expect((await f.saved()).declinedPasskeys).toEqual([]);
  }
  // The same passkey with a vouching that does verify is pinned.
  f.list({ ...listed, endorsement: await googleVouch(listed) });
  await f.manager.refresh();
  expect(f.pins()).toEqual([
    [f.google, "link-page"],
    [added.id, "endorsed"],
  ]);
});

test("a passkey pin the owner removed is not pinned again by a refresh, a restart or the relay relisting it", async () => {
  const f = await endorsing();
  const added = await passkeyDevice();
  const listed = {
    id: added.id,
    publicKey: added.publicKey,
    endorsement: await googleVouch(added),
  };
  f.list(listed);
  await f.manager.refresh();
  expect(f.pins()).toHaveLength(2);
  expect((await f.saved()).declinedPasskeys).toEqual([]);
  await f.manager.removeTrustedSignIn(added.id);
  for (let index = 0; index < 2; index++) {
    await f.manager.refresh();
    expect(f.pins()).toEqual([[f.google, "link-page"]]);
    expect((await f.saved()).declinedPasskeys).toEqual([added.id]);
  }
  // The choice survives a restart.
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  await restored.refresh();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  // The relay cannot undo the removal by no longer listing the passkey and then listing it again.
  f.list();
  await restored.refresh();
  expect((await f.saved()).declinedPasskeys).toEqual([added.id]);
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  for (const relisted of [listed, { ...listed, endorsement: await googleVouch(added) }]) {
    f.list(relisted);
    await restored.refresh();
    expect(restored.status().lastError).toBeUndefined();
    expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
    expect((await f.saved()).declinedPasskeys).toEqual([added.id]);
  }
  // Nor does a sign-in with that passkey fetch its way back in.
  const nonce = opaque();
  const verified = await restored
    .pairingIdentity()!
    .enrollment.verifyProof(assertionProof(added.authenticator, nonce), nonce, added.publicKey);
  expect(verified).toMatchObject({ type: "passkey", id: added.id, trusted: false });
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);

  // Approving a device that signed in with it is the owner's own decision: it pins the passkey
  // and the decline is forgotten.
  await restored.trustSignIn(verified!, "approval");
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [],
    trustedSignIns: [{ id: f.google }, { id: added.id, source: "approval" }],
  });
  // Once the account stops listing it, it is withdrawn instead: listed again, it stays out.
  f.list();
  await restored.refresh();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  f.list(listed);
  await restored.refresh();
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [],
    withdrawnSignIns: [signInDigest({ type: "passkey", id: added.id, publicKey: added.publicKey })],
    trustedSignIns: [{ id: f.google }],
  });
});

test("removing a pin declines it whatever pinned it, a passkey and a Google account each in its own list", async () => {
  const f = await endorsing();
  const approved = await passkeyDevice(),
    other = "1".repeat(64);
  const listed = {
    id: approved.id,
    publicKey: approved.publicKey,
    endorsement: await googleVouch(approved),
  };
  f.credentials.mockResolvedValue({ google: [f.google, other], passkeys: [listed] });
  await f.manager.trustSignIn(
    { type: "google", id: other, trusted: false, pin: { type: "google", id: other, addedAt: 1 } },
    "approval",
  );
  // Pinned by approving a device, before any refresh could have pinned it on the vouching.
  await f.manager.trustSignIn(
    {
      type: "passkey",
      id: approved.id,
      trusted: false,
      pin: { type: "passkey", id: approved.id, publicKey: approved.publicKey, addedAt: 1 },
    },
    "approval",
  );
  expect(f.pins()).toEqual([
    [f.google, "link-page"],
    [other, "approval"],
    [approved.id, "approval"],
  ]);
  await f.manager.removeTrustedSignIn(other);
  expect(await f.saved()).toMatchObject({ declinedPasskeys: [], declinedGoogle: [other] });
  await f.manager.removeTrustedSignIn(approved.id);
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [approved.id],
    declinedGoogle: [other],
  });
  // Removing it again declines it once, not twice.
  await f.manager.removeTrustedSignIn(approved.id);
  expect((await f.saved()).declinedPasskeys).toEqual([approved.id]);
  // The vouching the relay still lists does not bring it back.
  await f.manager.refresh();
  expect(f.manager.status().lastError).toBeUndefined();
  expect(f.pins()).toEqual([[f.google, "link-page"]]);
  // Removing it twice over time keeps one decline per removal, newest last.
  await f.manager.trustSignIn(
    {
      type: "passkey",
      id: approved.id,
      trusted: false,
      pin: { type: "passkey", id: approved.id, publicKey: approved.publicKey, addedAt: 1 },
    },
    "approval",
  );
  expect((await f.saved()).declinedPasskeys).toEqual([]);
  await f.manager.removeTrustedSignIn(approved.id);
  expect((await f.saved()).declinedPasskeys).toEqual([approved.id]);
});

test("a pin the account stops listing is withdrawn: listed again, the same evidence never pins it, only an approval does", async () => {
  const f = await endorsing();
  const added = await passkeyDevice(),
    replacement = await passkeyDevice();
  const endorsement = await googleVouch(added),
    listed = { id: added.id, publicKey: added.publicKey, endorsement };
  const name = signInDigest({ type: "passkey", id: added.id, publicKey: added.publicKey });
  f.list(listed);
  await f.manager.refresh();
  expect(f.pins()).toHaveLength(2);
  // The same id under another key is neither the pinned passkey nor the one vouched for.
  f.list({ id: added.id, publicKey: replacement.publicKey, endorsement });
  await f.manager.refresh();
  expect(f.pins()).toEqual([[f.google, "link-page"]]);
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [],
    withdrawnSignIns: [name],
    trustedSignIns: [{ id: f.google }],
  });
  // Back as it was, with the endorsement that pinned it: still out, across a restart too.
  f.list(listed);
  await f.manager.refresh();
  expect(f.pins()).toEqual([[f.google, "link-page"]]);
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  await restored.refresh();
  expect(restored.status().lastError).toBeUndefined();
  expect((await f.saved()).trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  // A device that signs in with it is held, and approving it is what brings it back.
  const nonce = opaque();
  const verified = await restored
    .pairingIdentity()!
    .enrollment.verifyProof(assertionProof(added.authenticator, nonce), nonce, added.publicKey);
  expect(verified).toMatchObject({ id: added.id, trusted: false });
  await restored.trustSignIn(verified!, "approval");
  expect(await f.saved()).toMatchObject({
    withdrawnSignIns: [],
    trustedSignIns: [{ id: f.google }, { id: added.id, source: "approval" }],
  });
  // Withdrawals are kept to 256, the oldest forgotten first.
  const many = Array.from({ length: 300 }, () => opaque());
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({ ...(await f.saved()), withdrawnSignIns: many.slice(0, 256) }) + "\n",
    { mode: 0o600 },
  );
  const full = new GatewayAccountLink(f.options);
  await full.initialize();
  f.list();
  await full.refresh();
  const kept = (await f.saved()).withdrawnSignIns!;
  expect(kept).toHaveLength(256);
  expect(kept.at(-1)).toBe(name);
  expect(kept[0]).toBe(many[1]);
});

test("one passkey leaving as another arrives in the same refresh saves both changes", async () => {
  const f = await endorsing();
  const first = await passkeyDevice(),
    second = await passkeyDevice();
  const listed = async (device: PasskeyDevice) => ({
    id: device.id,
    publicKey: device.publicKey,
    endorsement: await googleVouch(device),
  });
  f.list(await listed(first));
  await f.manager.refresh();
  expect((await f.saved()).trustedSignIns.map(({ id }) => id)).toEqual([f.google, first.id]);
  f.list(await listed(second));
  await f.manager.refresh();
  expect(f.manager.status().lastError).toBeUndefined();
  expect((await f.saved()).trustedSignIns.map(({ id }) => id)).toEqual([f.google, second.id]);
  expect(f.pins()).toEqual([
    [f.google, "link-page"],
    [second.id, "endorsed"],
  ]);
  // A refresh that changes nothing writes nothing.
  const before = await readFile(f.options.metadataFile, "utf8");
  await f.manager.refresh();
  expect(await readFile(f.options.metadataFile, "utf8")).toBe(before);
});

test("the declined passkeys stop at 256, forgetting the oldest first", async () => {
  const f = await endorsing();
  const old = Array.from({ length: 256 }, (_, index) => `fictional-passkey-${index}`);
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({ ...(await f.saved()), declinedPasskeys: old }) + "\n",
    { mode: 0o600 },
  );
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.status()).toMatchObject({ linked: true, lastError: undefined });
  const added = await passkeyDevice();
  const listed = {
    id: added.id,
    publicKey: added.publicKey,
    endorsement: await googleVouch(added),
  };
  f.list(listed);
  await restored.refresh();
  expect((await f.saved()).trustedSignIns.map(({ id }) => id)).toEqual([f.google, added.id]);
  // Pinning is not declining, so the list is untouched until the owner removes the pin.
  expect((await f.saved()).declinedPasskeys).toEqual(old);
  await restored.removeTrustedSignIn(added.id);
  const saved = await f.saved();
  expect(saved.declinedPasskeys).toHaveLength(256);
  expect(saved.declinedPasskeys).toEqual([...old.slice(1), added.id]);
  await restored.refresh();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  // More than the limit is not a record this gateway wrote.
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({ ...saved, declinedPasskeys: [...saved.declinedPasskeys!, "one-too-many"] }) +
      "\n",
    { mode: 0o600 },
  );
  const refused = new GatewayAccountLink(f.options);
  await refused.initialize();
  expect(refused.verifiedAccountId()).toBeUndefined();
});

test("endorsed passkeys never take a gateway past 32 pinned sign-ins", async () => {
  const f = await endorsing();
  const others = Array.from({ length: 31 }, (_, index) => index.toString(16).padStart(64, "0"));
  for (const id of others)
    await f.manager.trustSignIn(
      { type: "google", id, trusted: false, pin: { type: "google", id, addedAt: 1 } },
      "approval",
    );
  expect(f.pins()).toHaveLength(32);
  const first = await passkeyDevice(),
    second = await passkeyDevice();
  const passkeys = [
    { id: first.id, publicKey: first.publicKey, endorsement: await googleVouch(first) },
    { id: second.id, publicKey: second.publicKey, endorsement: await googleVouch(second) },
  ];
  f.credentials.mockResolvedValue({ google: [f.google, ...others], passkeys });
  await f.manager.refresh();
  expect(f.manager.status().lastError).toBeUndefined();
  expect(f.pins()).toHaveLength(32);
  expect((await f.saved()).declinedPasskeys).toEqual([]);
  // One free place pins one passkey, and no more.
  await f.manager.removeTrustedSignIn(others[0]!);
  await f.manager.refresh();
  expect(f.pins()).toHaveLength(32);
  expect(f.pins().at(-1)).toEqual([first.id, "endorsed"]);
  // The owner removed a Google pin to make room, which declines no passkey.
  expect((await f.saved()).declinedPasskeys).toEqual([]);
});

test("a sign-in with a passkey added moments ago fetches its vouching first, and a failed fetch leaves it untrusted", async () => {
  const f = await endorsing();
  const added = await passkeyDevice(),
    unvouched = await passkeyDevice();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  const signIn = async (device: PasskeyDevice) => {
    const nonce = opaque();
    return enrollment.verifyProof(
      assertionProof(device.authenticator, nonce),
      nonce,
      device.publicKey,
    );
  };
  const listed = [
    { id: added.id, publicKey: added.publicKey, endorsement: await googleVouch(added) },
    { id: unvouched.id, publicKey: unvouched.publicKey },
  ];
  // The relay can't be reached: the sign-in still verifies, and is held for a person.
  f.credentials.mockRejectedValueOnce(new Error("relay unavailable"));
  expect(await signIn(added)).toMatchObject({ id: added.id, trusted: false });
  expect(f.credentials).toHaveBeenCalledOnce();
  expect(f.pins()).toHaveLength(1);
  // Reachable: the vouching is fetched, checked and pinned before the answer.
  f.list(...listed);
  expect(await signIn(added)).toMatchObject({ id: added.id, trusted: true });
  expect(f.credentials).toHaveBeenCalledTimes(2);
  expect(f.pins()).toEqual([
    [f.google, "link-page"],
    [added.id, "endorsed"],
  ]);
  // Once pinned it needs no fetch.
  expect(await signIn(added)).toMatchObject({ trusted: true });
  expect(f.credentials).toHaveBeenCalledTimes(2);
  // A listed passkey nobody vouched for stays untrusted after the fetch.
  expect(await signIn(unvouched)).toMatchObject({ id: unvouched.id, trusted: false });
  expect(f.credentials).toHaveBeenCalledTimes(3);
  // Nothing is fetched for a proof that does not verify.
  const nonce = opaque();
  expect(
    await enrollment.verifyProof(assertionProof(added.authenticator, opaque()), nonce),
  ).toBeUndefined();
  expect(f.credentials).toHaveBeenCalledTimes(3);
  // A Google account this gateway has not pinned is looked up too, and stays untrusted when
  // no pinned passkey countersigned it.
  const stranger = await googleVouch(listed[0]!, "fictional-other-subject");
  expect(await enrollment.verifyProof(stranger, vouchedNonce(listed[0]!))).toMatchObject({
    type: "google",
    trusted: false,
  });
  expect(f.credentials).toHaveBeenCalledTimes(4);
});

/** A passkey's own signature over the sign-ins its account had when it was added. */
function countersignature(
  by: PasskeyDevice,
  signIns: readonly AccountSignIn[],
  account = "a".repeat(64),
): PasskeyCountersignature {
  const names = signIns.map(signInDigest);
  return {
    proof: assertionProof(by.authenticator, passkeyCountersignatureNonce(account, names)),
    signIns: names,
  };
}
const googleSignInOf = (id: string): AccountSignIn => ({ type: "google", id });
const passkeySignInOf = (device: { id: string; publicKey: string }): AccountSignIn => ({
  type: "passkey",
  id: device.id,
  publicKey: device.publicKey,
});
/** A Google sign-in for an enrollment, as a device would send it. */
async function googleSignIn(subject: string, nonce: string): Promise<SignInProof> {
  const salt = opaque(),
    issuedAt = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ nonce: googleProofNonce(salt, nonce) })
    .setProtectedHeader({ alg: "RS256", kid: "1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(googleKey);
  return { type: "google", salt, idToken };
}

/**
 * A gateway linked by signing in with a passkey: the account was created with Google and the
 * passkey added later, so the passkey is the only sign-in this gateway saw for itself.
 */
async function passkeyLinked(signInSyncIntervalMs = 0) {
  const f = await fixture();
  const credentials = vi.fn<NonNullable<AccountBrowserPort["credentials"]>>();
  const options = {
    ...f.options,
    browser: { ...f.browser, credentials },
    google: () => googleIdentityProvider(AUDIENCE, googleKeys, { authorizedParties: [AUDIENCE] }),
    signInSyncIntervalMs,
  };
  const manager = new GatewayAccountLink(options);
  await manager.initialize();
  const passkey = await passkeyDevice(),
    nonce = opaque();
  await manager.completeSignup({
    accountId: f.accountId,
    nonce,
    proof: assertionProof(passkey.authenticator, nonce),
    credentialPublicKey: passkey.publicKey,
    signal: new AbortController().signal,
  });
  const google = googleDigest();
  const enrollment = manager.pairingIdentity()!.enrollment;
  return {
    ...f,
    options,
    manager,
    credentials,
    passkey,
    google,
    listedPasskey: { id: passkey.id, publicKey: passkey.publicKey },
    /** The gateway's passkey, countersigning exactly `signIns`. */
    countersigned: (...signIns: AccountSignIn[]) => ({
      id: passkey.id,
      publicKey: passkey.publicKey,
      countersignature: countersignature(passkey, signIns),
    }),
    pins: () => manager.enrollmentStatus().trustedSignIns.map(({ id, source }) => [id, source]),
    saved: async () =>
      JSON.parse(await readFile(f.options.metadataFile, "utf8")) as {
        declinedPasskeys: string[];
        declinedGoogle: string[];
        withdrawnSignIns: string[];
        trustedSignIns: { id: string; source: string }[];
      },
    /** A device's Google sign-in, checked as the enrollment routes check it. */
    googleSignIn: async (subject = SUBJECT) => {
      const nonce = opaque();
      return enrollment.verifyProof(await googleSignIn(subject, nonce), nonce, undefined);
    },
  };
}

test("a gateway linked with a passkey trusts the Google account and passkeys that passkey countersigned, when the account still lists them", async () => {
  const f = await passkeyLinked();
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  const older = await passkeyDevice(),
    unsigned = await passkeyDevice();
  const stranger = googleDigest("fictional-other-subject");
  const olderListed = { id: older.id, publicKey: older.publicKey };
  // Before anything is fetched, a Google sign-in is checked against what the relay lists now.
  f.credentials.mockResolvedValue({
    google: [f.google, stranger],
    passkeys: [
      f.countersigned(googleSignInOf(f.google), passkeySignInOf(older)),
      olderListed,
      { id: unsigned.id, publicKey: unsigned.publicKey },
    ],
  });
  expect(await f.googleSignIn()).toMatchObject({ type: "google", id: f.google, trusted: true });
  expect(f.credentials).toHaveBeenCalledOnce();
  expect(f.pins()).toEqual([
    [f.passkey.id, "link-page"],
    [f.google, "countersigned"],
    [older.id, "countersigned"],
  ]);
  // The other passkey's sign-ins are trusted with the key the countersignature named.
  const nonce = opaque();
  expect(
    await f.manager
      .pairingIdentity()!
      .enrollment.verifyProof(assertionProof(older.authenticator, nonce), nonce),
  ).toMatchObject({ id: older.id, trusted: true });
  // Listed is not countersigned: the other Google account and the other passkey stay untrusted.
  expect(await f.googleSignIn("fictional-other-subject")).toMatchObject({ trusted: false });
  expect(f.pins()).toHaveLength(3);
  // The pins survive a restart.
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([
    f.passkey.id,
    f.google,
    older.id,
  ]);
});

test("a sign-in removed from the account stays out when a later compromised relay lists it again with the evidence that pinned it", async () => {
  const f = await passkeyLinked();
  const genuine = f.countersigned(googleSignInOf(f.google));
  f.credentials.mockResolvedValue({ google: [f.google], passkeys: [genuine] });
  await f.manager.refresh();
  expect(f.pins()).toEqual([
    [f.passkey.id, "link-page"],
    [f.google, "countersigned"],
  ]);
  // The owner removes Google from the account; the gateway sees it gone at its next sync.
  f.credentials.mockResolvedValue({ google: [], passkeys: [f.listedPasskey] });
  await f.manager.refresh();
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  expect(await f.saved()).toMatchObject({
    withdrawnSignIns: [signInDigest(googleSignInOf(f.google))],
    declinedGoogle: [],
  });
  // The relay is then compromised: it lists Google again with the countersignature it kept, and
  // whoever holds that Google account signs in. The sign-in fetches the evidence and is held.
  f.credentials.mockResolvedValue({ google: [f.google], passkeys: [genuine] });
  expect(await f.googleSignIn()).toMatchObject({ id: f.google, trusted: false });
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  // A restart, or a fresh countersignature naming it, changes nothing.
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [f.countersigned(googleSignInOf(f.google))],
  });
  await restored.refresh();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.passkey.id]);
  // Only the owner approving a device that signed in with it brings it back.
  const verified = await f.googleSignIn();
  await f.manager.trustSignIn(verified!, "approval");
  expect(await f.saved()).toMatchObject({
    withdrawnSignIns: [],
    trustedSignIns: [{ id: f.passkey.id }, { id: f.google, source: "approval" }],
  });
});

test("a sign-in a pinned passkey countersigned but the account no longer lists is withdrawn before it is ever pinned", async () => {
  const f = await passkeyLinked();
  const older = await passkeyDevice();
  // The account dropped Google and the older passkey before this gateway first synced.
  f.credentials.mockResolvedValue({
    google: [],
    passkeys: [f.countersigned(googleSignInOf(f.google), passkeySignInOf(older))],
  });
  await f.manager.refresh();
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  expect(new Set((await f.saved()).withdrawnSignIns)).toEqual(
    new Set([signInDigest(googleSignInOf(f.google)), signInDigest(passkeySignInOf(older))]),
  );
  // Listed again later, neither is pinned.
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [
      f.countersigned(googleSignInOf(f.google), passkeySignInOf(older)),
      { id: older.id, publicKey: older.publicKey },
    ],
  });
  await f.manager.refresh();
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
});

test("trust follows countersignatures and endorsements in both directions, as far as the evidence goes", async () => {
  const f = await passkeyLinked();
  // The account: Google, then the gateway's passkey (countersigning Google), then a third passkey
  // that Google vouched for, which countersigned an older passkey of its own.
  const third = await passkeyDevice(),
    fourth = await passkeyDevice();
  const fourthListed = { id: fourth.id, publicKey: fourth.publicKey };
  const thirdListed = { id: third.id, publicKey: third.publicKey };
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [
      {
        ...thirdListed,
        endorsement: await googleVouch(thirdListed),
        countersignature: countersignature(third, [passkeySignInOf(fourth)]),
      },
      fourthListed,
      f.countersigned(googleSignInOf(f.google)),
    ],
  });
  await f.manager.refresh();
  expect(f.manager.status().lastError).toBeUndefined();
  expect(f.pins()).toEqual([
    [f.passkey.id, "link-page"],
    [f.google, "countersigned"],
    [third.id, "endorsed"],
    [fourth.id, "countersigned"],
  ]);
});

test("the reverse of an endorsement, the relay's list, or a countersignature it altered or moved trusts nothing", async () => {
  const f = await passkeyLinked();
  const other = await passkeyDevice(),
    stranger = googleDigest("fictional-other-subject");
  const otherListed = { id: other.id, publicKey: other.publicKey };
  const genuine = countersignature(f.passkey, [googleSignInOf(f.google)]);
  const strangerName = signInDigest(googleSignInOf(stranger));
  const cases: NonNullable<Awaited<ReturnType<NonNullable<AccountBrowserPort["credentials"]>>>>[] =
    [
      // The account was created with Google, and Google vouched for this passkey when it was
      // added. That proves only that the Google account's holder named this passkey, which anyone
      // with any Google account can do for a passkey they saw listed: it says nothing about
      // Google from the passkey's side.
      {
        google: [f.google],
        passkeys: [{ ...f.listedPasskey, endorsement: await googleVouch(f.listedPasskey) }],
      },
      // The relay withholds the countersignature, or lists sign-ins with none.
      { google: [f.google, stranger], passkeys: [f.listedPasskey, otherListed] },
      // It adds a Google account to the signed list, or swaps one in.
      {
        google: [f.google, stranger],
        passkeys: [
          {
            ...f.listedPasskey,
            countersignature: { ...genuine, signIns: [...genuine.signIns, strangerName] },
          },
        ],
      },
      {
        google: [f.google, stranger],
        passkeys: [
          { ...f.listedPasskey, countersignature: { ...genuine, signIns: [strangerName] } },
        ],
      },
      // It replays this passkey's countersignature from another account.
      {
        google: [f.google],
        passkeys: [
          {
            ...f.listedPasskey,
            countersignature: countersignature(
              f.passkey,
              [googleSignInOf(f.google)],
              "b".repeat(64),
            ),
          },
        ],
      },
      // A passkey this gateway never pinned countersigns, under its own entry or this one's.
      {
        google: [f.google, stranger],
        passkeys: [
          f.listedPasskey,
          {
            ...otherListed,
            countersignature: countersignature(other, [googleSignInOf(stranger)]),
          },
        ],
      },
      {
        google: [f.google, stranger],
        passkeys: [
          {
            ...f.listedPasskey,
            countersignature: countersignature(other, [googleSignInOf(stranger)]),
          },
        ],
      },
      // Not a countersignature at all.
      {
        google: [f.google],
        passkeys: [
          {
            ...f.listedPasskey,
            countersignature: { proof: genuine.proof } as unknown as PasskeyCountersignature,
          },
        ],
      },
    ];
  for (const listed of cases) {
    f.credentials.mockResolvedValue(listed);
    await f.manager.refresh();
    expect(f.manager.status().lastError).toBeUndefined();
    expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
    // And a device that signs in with either Google account is held for a person.
    expect(await f.googleSignIn()).toMatchObject({ trusted: false });
    expect(await f.googleSignIn("fictional-other-subject")).toMatchObject({ trusted: false });
  }
  // Nothing in all that withdrew anything: no countersignature this gateway could check named a
  // sign-in the account didn't list.
  expect((await f.saved()).withdrawnSignIns).toEqual([]);
  // The same listing with the genuine countersignature pins the Google account it names.
  f.credentials.mockResolvedValue({
    google: [f.google, stranger],
    passkeys: [{ ...f.listedPasskey, countersignature: genuine }],
  });
  expect(await f.googleSignIn()).toMatchObject({ trusted: true });
  expect(f.pins()).toEqual([
    [f.passkey.id, "link-page"],
    [f.google, "countersigned"],
  ]);
});

test("a Google account or passkey the owner removed here is not pinned again by a countersignature, only by approving a device", async () => {
  const f = await passkeyLinked();
  const older = await passkeyDevice();
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [
      f.countersigned(googleSignInOf(f.google), passkeySignInOf(older)),
      { id: older.id, publicKey: older.publicKey },
    ],
  });
  await f.manager.refresh();
  expect(f.pins()).toHaveLength(3);
  await f.manager.removeTrustedSignIn(f.google);
  await f.manager.removeTrustedSignIn(older.id);
  expect(await f.saved()).toMatchObject({
    declinedGoogle: [f.google],
    declinedPasskeys: [older.id],
    withdrawnSignIns: [],
  });
  for (let index = 0; index < 2; index++) {
    await f.manager.refresh();
    expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  }
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  await restored.refresh();
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.passkey.id]);
  const verified = await f.googleSignIn();
  expect(verified).toMatchObject({ type: "google", id: f.google, trusted: false });
  // Approving a device that signed in with it is the owner's decision, and lifts the decline.
  await f.manager.trustSignIn(verified!, "approval");
  expect(await f.saved()).toMatchObject({
    declinedGoogle: [],
    declinedPasskeys: [older.id],
    trustedSignIns: [{ id: f.passkey.id }, { id: f.google, source: "approval" }],
  });
});

test("linking the same account again keeps what was declined and withdrawn, and another account starts afresh", async () => {
  const f = await passkeyLinked();
  const older = await passkeyDevice(),
    removed = await passkeyDevice();
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [
      f.countersigned(googleSignInOf(f.google), passkeySignInOf(older)),
      { id: older.id, publicKey: older.publicKey },
    ],
  });
  await f.manager.refresh();
  // The owner declines Google here; the account withdraws the older passkey.
  await f.manager.removeTrustedSignIn(f.google);
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [f.countersigned(googleSignInOf(f.google), passkeySignInOf(older))],
  });
  await f.manager.refresh();
  const refusals = {
    declinedGoogle: [f.google],
    withdrawnSignIns: [signInDigest(passkeySignInOf(older))],
  };
  expect(await f.saved()).toMatchObject(refusals);
  // Linked to the same account again, with the same passkey or with another one.
  for (const device of [f.passkey, removed]) {
    const nonce = opaque();
    await f.manager.completeSignup({
      accountId: f.accountId,
      nonce,
      proof: assertionProof(device.authenticator, nonce),
      credentialPublicKey: device.publicKey,
      signal: new AbortController().signal,
    });
    expect(await f.saved()).toMatchObject(refusals);
  }
  // Linking with a sign-in it had refused is the owner's choice, like approving it.
  const nonce = opaque();
  await f.manager.completeSignup({
    accountId: f.accountId,
    nonce,
    proof: assertionProof(older.authenticator, nonce),
    credentialPublicKey: older.publicKey,
    signal: new AbortController().signal,
  });
  expect(await f.saved()).toMatchObject({ declinedGoogle: [f.google], withdrawnSignIns: [] });
  // Another account has none of this account's refusals.
  await f.manager.completeSignup({
    accountId: "c".repeat(64),
    nonce,
    signal: new AbortController().signal,
  });
  expect(await f.saved()).toMatchObject({
    declinedGoogle: [],
    declinedPasskeys: [],
    withdrawnSignIns: [],
  });
});

test("the owner can decline in advance a sign-in this gateway never trusted, and no evidence pins it then", async () => {
  const f = await passkeyLinked();
  const older = await passkeyDevice();
  // By the ids another gateway lists: a Google subject digest, which could also be a passkey id,
  // and a passkey id.
  await f.manager.removeTrustedSignIn(f.google);
  await f.manager.removeTrustedSignIn(older.id);
  // Declining again changes nothing.
  await f.manager.removeTrustedSignIn(older.id);
  expect(await f.saved()).toMatchObject({
    declinedGoogle: [f.google],
    declinedPasskeys: [f.google, older.id],
    trustedSignIns: [{ id: f.passkey.id }],
  });
  for (const invalid of ["", "not an id", "x".repeat(2049)])
    await expect(f.manager.removeTrustedSignIn(invalid)).rejects.toMatchObject({ status: 400 });
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [
      f.countersigned(googleSignInOf(f.google), passkeySignInOf(older)),
      { id: older.id, publicKey: older.publicKey },
    ],
  });
  await f.manager.refresh();
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  expect(await f.googleSignIn()).toMatchObject({ trusted: false });
});

test("two listing entries under one passkey id are checked each on its own", async () => {
  const f = await passkeyLinked();
  const added = await passkeyDevice(),
    impostor = await passkeyDevice();
  const endorsement = await googleVouch({ id: added.id, publicKey: added.publicKey });
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [
      // The same id under another key, with the same endorsement: it fails, and that verdict
      // must not stand for the genuine entry after it.
      { id: added.id, publicKey: impostor.publicKey, endorsement },
      { id: added.id, publicKey: added.publicKey, endorsement },
      f.countersigned(googleSignInOf(f.google)),
    ],
  });
  await f.manager.refresh();
  expect(f.manager.enrollmentStatus().trustedSignIns).toContainEqual(
    expect.objectContaining({ id: added.id, source: "endorsed" }),
  );
  const nonce = opaque();
  expect(
    await f.manager
      .pairingIdentity()!
      .enrollment.verifyProof(assertionProof(added.authenticator, nonce), nonce),
  ).toMatchObject({ id: added.id, trusted: true });
});

test("sign-ins fetch evidence one at a time and no more often than the interval, and each proof is verified once per fetch", async () => {
  const f = await passkeyLinked(60_000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.credentials.mockImplementation(async () => {
    await held;
    return { google: [f.google], passkeys: [f.listedPasskey] };
  });
  // Several untrusted sign-ins at once share one fetch.
  const signIns = Promise.all([f.googleSignIn(), f.googleSignIn(), f.googleSignIn()]);
  await vi.waitFor(() => expect(f.credentials).toHaveBeenCalledOnce());
  release();
  for (const result of await signIns) expect(result).toMatchObject({ trusted: false });
  expect(f.credentials).toHaveBeenCalledOnce();
  // Within the interval a sign-in fetches nothing; a refresh, which the owner or the hourly
  // timer starts, always does.
  expect(await f.googleSignIn()).toMatchObject({ trusted: false });
  expect(f.credentials).toHaveBeenCalledOnce();
  await f.manager.refresh();
  expect(f.credentials).toHaveBeenCalledTimes(2);

  // Within one fetch, an endorsement is verified once however many passes the fetch takes, and
  // one whose claimed signer isn't pinned is not verified at all.
  const linked = await passkeyLinked();
  const added = await passkeyDevice(),
    stranger = await passkeyDevice(),
    chained = await passkeyDevice();
  const addedListed = { id: added.id, publicKey: added.publicKey };
  const strangerListed = { id: stranger.id, publicKey: stranger.publicKey };
  const verify = vi.spyOn(GatewaySignInVerifier.prototype, "verifyEndorsement");
  linked.credentials.mockResolvedValue({
    google: [linked.google],
    passkeys: [
      // Google's endorsement is checked only once Google is pinned, on a later pass; a forged one
      // keeps failing, but is verified once.
      { ...addedListed, endorsement: await googleVouch(addedListed, "fictional-other-subject") },
      // Claimed by a passkey that is never pinned: never verified.
      { ...strangerListed, endorsement: passkeyVouch(chained, strangerListed) },
      { id: chained.id, publicKey: chained.publicKey },
      linked.countersigned(googleSignInOf(linked.google)),
    ],
  });
  await linked.manager.refresh();
  expect(linked.pins()).toEqual([
    [linked.passkey.id, "link-page"],
    [linked.google, "countersigned"],
  ]);
  expect(verify).not.toHaveBeenCalled();
  // Once pinned, the Google account vouches for one passkey that chains to another, over several
  // passes; and its token naming another passkey is placed on a third entry, where it fails.
  const misplaced = await passkeyDevice();
  linked.credentials.mockResolvedValue({
    google: [linked.google],
    passkeys: [
      {
        id: misplaced.id,
        publicKey: misplaced.publicKey,
        endorsement: await googleVouch(addedListed),
      },
      { ...addedListed, endorsement: await googleVouch(addedListed) },
      { ...strangerListed, endorsement: passkeyVouch(chained, strangerListed) },
      linked.countersigned(googleSignInOf(linked.google), passkeySignInOf(chained)),
      { id: chained.id, publicKey: chained.publicKey },
    ],
  });
  await linked.manager.refresh();
  const verifiedFor = (id: string) =>
    verify.mock.calls.filter(([, passkey]) => passkey.id === id).length;
  expect(verifiedFor(misplaced.id)).toBe(1);
  expect(verifiedFor(added.id)).toBe(1);
  expect(verifiedFor(stranger.id)).toBe(1);
  verify.mockRestore();
  expect(linked.pins()).toEqual([
    [linked.passkey.id, "link-page"],
    [linked.google, "countersigned"],
    [added.id, "endorsed"],
    [chained.id, "countersigned"],
    [stranger.id, "endorsed"],
  ]);
});

test("an account link saved before declined passkeys existed still loads, and an unknown key is dropped, not refused", async () => {
  const f = await endorsing();
  // Nor before declined Google accounts existed.
  const { declinedPasskeys, declinedGoogle, ...older } = await f.saved();
  expect(declinedPasskeys).toEqual([]);
  expect(declinedGoogle).toEqual([]);
  await writeFile(f.options.metadataFile, JSON.stringify(older) + "\n", { mode: 0o600 });
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.status()).toMatchObject({ linked: true, lastError: undefined });
  expect(restored.verifiedAccountId()).toBe(f.accountId);
  expect(restored.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  const added = await passkeyDevice();
  f.list({ id: added.id, publicKey: added.publicKey, endorsement: await googleVouch(added) });
  await restored.refresh();
  expect(restored.status().lastError).toBeUndefined();
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [],
    trustedSignIns: [{ id: f.google }, { id: added.id }],
  });
  await restored.removeTrustedSignIn(added.id);
  expect((await f.saved()).declinedPasskeys).toEqual([added.id]);
  // A field this version does not know, from a later one or from a short-lived earlier format
  // that kept `endorsedPasskeys`, is dropped rather than refused: going back a version keeps the
  // link, and such a field never adds a pin.
  for (const stray of [{ endorsedPasskeys: [added.id] }, { laterField: { trust: [added.id] } }]) {
    await writeFile(f.options.metadataFile, JSON.stringify({ ...older, ...stray }) + "\n", {
      mode: 0o600,
    });
    const tolerant = new GatewayAccountLink(f.options);
    await tolerant.initialize();
    expect(tolerant.status()).toMatchObject({ linked: true, lastError: undefined });
    expect(tolerant.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.google]);
  }
  // A field it knows, with a value it can't accept, is still refused as corrupt.
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({ ...older, withdrawnSignIns: ["not-a-digest"] }) + "\n",
    { mode: 0o600 },
  );
  const refused = new GatewayAccountLink(f.options);
  await refused.initialize();
  expect(refused.status()).toMatchObject({ linked: false, lastError: "account-link-failed" });
  expect(refused.verifiedAccountId()).toBeUndefined();
});

test("forgetting a deleted account leaves the gateway as if it never had one, without asking the relay", async () => {
  const f = await fixture();
  await f.link();
  await f.manager.setEnrollmentPolicy("ask");
  expect(f.manager.status()).toMatchObject({ activated: true, linked: true });
  const pending = await f.manager.start({ requestOrigin: gatewayOrigin });
  f.browser.cancel.mockClear();
  await f.manager.forget();
  expect(f.manager.status()).toMatchObject({
    activated: false,
    linked: false,
    canLink: true,
    canUnlink: false,
    pendingUnlink: false,
    lastError: undefined,
  });
  expect(f.manager.accountModeActivated()).toBe(false);
  expect(f.manager.verifiedAccountId()).toBeUndefined();
  expect(f.manager.pairingIdentity()).toBeUndefined();
  expect(f.manager.enrollmentStatus()).toEqual({ policy: "ask", trustedSignIns: [] });
  // The account is gone on the relay, so there is nothing to unlink there.
  expect(f.browser.unlink).not.toHaveBeenCalled();
  expect(f.browser.cancel).toHaveBeenCalledOnce();
  await expect(stat(f.options.metadataFile)).rejects.toMatchObject({ code: "ENOENT" });
  // A sign-in that was under way belongs to the old link and finishes nothing.
  const operation = f.operations.at(-1)!;
  await expect(
    f.manager.callback({
      url: `${operation.callbackUrl}?operationId=${operation.operationId}&state=${operation.browserState}&result=${opaque()}`,
      cookie: pending.cookie.split(";")[0],
    }),
  ).rejects.toMatchObject({ code: "account-link-failed" });
  const restarted = new GatewayAccountLink(f.options);
  await restarted.initialize();
  expect(restarted.accountModeActivated()).toBe(false);
  // It can be linked again, to whichever account its owner signs in to.
  await f.manager.forget();
  expect(await f.link()).toMatchObject({ redirectUrl: gatewayOrigin + "/portal/settings/account" });
  expect(f.manager.status()).toMatchObject({ activated: true, linked: true });
});
