// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { GatewayAccountLink } from "./gateway-account-link.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { GatewaySignInVerifier, type TrustedSignIn } from "./gateway-sign-in-proof.js";
import {
  OFFICIAL_ANDROID_PASSKEY_ORIGINS,
  OFFICIAL_GOOGLE_BROWSER_TRUST,
} from "./google-browser-trust.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { accountId as identityDigest, googleIdentityProvider } from "./identity.js";
import {
  gatewayPasskeyChallenge,
  gatewayPasskeyPinBinding,
  googleProofNonce,
  passkeyCountersignatureNonce,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  signInDigest,
  signInProofNonce,
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
    declinedPasskeys: [],
    declinedGoogle: [],
    withdrawnSignIns: [],
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

/** What a sign-in made on a link operation commits to: the gateway's nonce under the link purpose. */
const linkNonce = (nonce: string) => signInProofNonce("gateway-link", nonce);
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
      signInProof: registrationProof(device, linkNonce(pending.nonce)),
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
    // The link page's pin is the relay's word; nothing joins until the owner confirms one here.
    confirmationNeeded: true,
    trustedSignIns: [
      {
        type: "passkey",
        id: device.id,
        addedAt: expect.any(Number),
        source: "link-page",
        confirmed: false,
      },
    ],
    confirmedSignIns: [],
  });
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  expect(enrollment.policy()).toBe("automatic");
  expect(enrollment.spkiFingerprint()).toBeUndefined();
  expect(enrollment.challenges.consume(enrollment.challenges.issue().challenge)).toBe(true);
  // TM-01: the pinned key verifies the same passkey's later sign-in on a relay page, but a relay
  // page could have chosen its challenge, so it is not trusted.
  const nonce = opaque();
  const verified = await enrollment.verifyProof(assertionProof(device, nonce), nonce);
  expect(verified).toMatchObject({
    type: "passkey",
    id: device.id,
    trusted: false,
    channel: "relay-page",
  });
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
  // A relay page could have made it, so approving it confirms nothing.
  expect(await enrollment.canTrust(verified!)).toBe(false);
  await expect(enrollment.trustSignIn(verified!)).rejects.toMatchObject({ status: 409 });
  const credentials = vi.fn<NonNullable<AccountBrowserPort["credentials"]>>();
  (f.browser as AccountBrowserPort).credentials = credentials;
  // A Google token an official app presented can be confirmed, when the account lists it.
  const google = {
    type: "google" as const,
    id: "b".repeat(64),
    trusted: false,
    channel: "native-google" as const,
    pin: { type: "google" as const, id: "b".repeat(64), addedAt: 1 },
  };
  credentials.mockResolvedValue({ google: [], passkeys: [] });
  expect(await enrollment.canTrust(google)).toBe(false);
  credentials.mockResolvedValue({ accountId: "c".repeat(64), google: [google.id], passkeys: [] });
  expect(await enrollment.canTrust(google)).toBe(false);
  credentials.mockResolvedValue({ accountId: f.accountId, google: [google.id], passkeys: [] });
  expect(await enrollment.canTrust({ ...google, channel: "web-google" })).toBe(false);
  expect(await enrollment.canTrust({ ...google, trusted: true })).toBe(false);
  expect(await enrollment.canTrust(google)).toBe(true);
  await f.manager.trustSignIn(google);
  // A passkey from the Android app verifies under the key its request offers, which anyone could
  // have made: it can be confirmed only as the relay lists it for this account.
  const android = OFFICIAL_ANDROID_PASSKEY_ORIGINS[0]!;
  const second = passkeyAuthenticator();
  const registered = opaque();
  const { publicKey } = (await enrollment.verifyProof(
    registrationProof(second, registered),
    registered,
  ))!.pin as { publicKey: string };
  const signed = opaque();
  const offered = (await enrollment.verifyProof(
    assertionProof(second, signed, android),
    signed,
    publicKey,
  ))!;
  expect(offered).toMatchObject({
    type: "passkey",
    id: second.id,
    trusted: false,
    channel: "android-app",
  });
  expect(await enrollment.canTrust(offered)).toBe(false);
  credentials.mockResolvedValueOnce({
    google: [],
    passkeys: [{ id: second.id, publicKey: "other" }],
  });
  expect(await enrollment.canTrust(offered)).toBe(false);
  credentials.mockRejectedValueOnce(new Error("relay unavailable"));
  expect(await enrollment.canTrust(offered)).toBe(false);
  // Removed from the account between the hold and the approval: nothing is confirmed.
  credentials.mockResolvedValueOnce({ google: [], passkeys: [] });
  await expect(enrollment.trustSignIn(offered)).rejects.toMatchObject({ status: 409 });
  credentials.mockResolvedValue({ google: [google.id], passkeys: [{ id: second.id, publicKey }] });
  await enrollment.trustSignIn(offered);
  expect(f.manager.confirmedSignIns()).toEqual([
    { type: "google", id: google.id, at: expect.any(Number), via: "native-google-approval" },
    {
      type: "passkey",
      id: second.id,
      publicKey,
      counter: 0,
      at: expect.any(Number),
      via: "android-app",
    },
  ]);
  expect(f.manager.enrollmentStatus()).toMatchObject({ confirmationNeeded: false });
  // Confirmed, its next sign-in in the app joins; the same passkey on a relay page still does not.
  const again = opaque();
  expect(await enrollment.verifyProof(assertionProof(second, again, android), again)).toMatchObject(
    { trusted: true, channel: "android-app" },
  );
  expect(await enrollment.verifyProof(assertionProof(second, again), again)).toMatchObject({
    trusted: false,
  });
  // Confirming the same sign-in again replaces its confirmation rather than adding one.
  await f.manager.trustSignIn(google);
  expect(f.manager.confirmedSignIns().map(({ id }) => id)).toEqual([second.id, google.id]);
  delete (f.browser as AccountBrowserPort).credentials;
  await f.manager.removeTrustedSignIn(second.id);
  // An id this gateway never pinned is declined in advance; one that is no id at all is refused.
  await f.manager.removeTrustedSignIn("c".repeat(64));
  await expect(f.manager.removeTrustedSignIn("not an id")).rejects.toMatchObject({
    status: 400,
  });
  await f.manager.removeTrustedSignIn(device.id);
  expect(f.manager.enrollmentStatus().trustedSignIns).toEqual([]);
  expect(f.manager.confirmedSignIns().map(({ id }) => id)).toEqual([google.id]);
  await f.manager.unlink();
  expect(f.manager.enrollmentStatus()).toEqual({
    policy: "ask",
    confirmationNeeded: false,
    trustedSignIns: [],
    confirmedSignIns: [],
  });
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
    proof: registrationProof(device, linkNonce(nonce)),
    signal: new AbortController().signal,
  });
  expect(linked.verifiedAccountId()).toBe(f.accountId);
  expect(enrollment()!.spkiFingerprint()).toBe("e".repeat(64));
  const fromApp = opaque();
  expect(await enrollment()!.verifyProof(assertionProof(device, fromApp, android), fromApp)).toBe(
    undefined,
  );
  f.env.OMNESIS_CLOUD_RELAY_PASSKEY_ANDROID_ORIGINS = ` ${android}, https://phish.example.test `;
  // Made in the app, but with a passkey only the link page pinned: verified, not yet trusted.
  expect(
    await enrollment()!.verifyProof(assertionProof(device, fromApp, android), fromApp),
  ).toMatchObject({ trusted: false, channel: "android-app" });
  // The same pinned passkey's sign-in, made on a link operation whose nonce is this enrollment's,
  // is no enrollment proof: whoever started that operation chose the nonce.
  expect(
    await enrollment()!.verifyProof(assertionProof(device, linkNonce(fromApp), android), fromApp),
  ).toBeUndefined();
  const googleProof = { type: "google" as const, idToken: "x", salt: opaque() };
  expect(await enrollment()!.verifyProof(googleProof, nonce)).toBeUndefined();
  expect(google).toHaveBeenCalledOnce();
  // Without an injected provider the audiences come from local configuration, never the relay.
  const local = new GatewayAccountLink(f.options);
  await local.initialize();
  const proofs = local.pairingIdentity()!.enrollment;
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  // With no trusted Google client at all, no Google proof is checked.
  const untrusted = new GatewayAccountLink({
    ...f.options,
    googleTrust: () => ({ deviceClientIds: [], deviceAuthorizedParties: [] }),
  });
  await untrusted.initialize();
  expect(
    await untrusted.pairingIdentity()!.enrollment.verifyProof(googleProof, nonce),
  ).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID = "client-a.example, client-b.example";
  f.env.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID = "android.example";
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID = "web.example";
  expect(await proofs.verifyProof(googleProof, nonce)).toBeUndefined();
  // A signup with no proof, one for another request, or one made to enroll a device under the
  // same nonce pins nothing.
  for (const proof of [
    undefined,
    registrationProof(device, linkNonce(opaque())),
    registrationProof(device, nonce),
  ]) {
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
      signInProof: registrationProof(device, linkNonce(pending.nonce)),
    })) as never);
  // Without a credential listing the pins stay as they are.
  await f.manager.refresh();
  await f.link();
  await f.manager.refresh();
  const google = "b".repeat(64);
  await pinInRecord(f.manager, f.options.metadataFile, {
    type: "google",
    id: google,
    addedAt: 1,
    source: "approval",
  });
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
/** The official Android app's client, which presents its tokens for the web client. */
const ANDROID_APP = OFFICIAL_GOOGLE_BROWSER_TRUST.nativeClients!.android[0]!;
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
  }).verify(registrationProof(authenticator, nonce), "device-enrollment", nonce);
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
  };
  const manager = new GatewayAccountLink(options);
  await manager.initialize();
  await manager.completeSignup({
    accountId: f.accountId,
    nonce: opaque(),
    signal: new AbortController().signal,
  });
  // Linked with Google: the link page pinned that Google account.
  const google = googleDigest();
  await writeFile(
    options.metadataFile,
    JSON.stringify({
      ...JSON.parse(await readFile(options.metadataFile, "utf8")),
      trustedSignIns: [{ type: "google", id: google, addedAt: 1, source: "link-page" }],
    }) + "\n",
    { mode: 0o600 },
  );
  await manager.initialize();
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
    confirmed: false,
  });
  // Pinning on a vouching sign-in is not the owner declining anything.
  expect((await f.saved()).declinedPasskeys).toEqual([]);
  // TM-02: the pinned key verifies that passkey's sign-ins with no key offered, but the relay's
  // evidence is only a suggestion: they are not trusted.
  const enrollment = f.manager.pairingIdentity()!.enrollment,
    nonce = opaque();
  expect(
    await enrollment.verifyProof(assertionProof(second.authenticator, nonce), nonce),
  ).toMatchObject({ type: "passkey", id: second.id, trusted: false });
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

  // Approving a device that signed in with it in the Android app is the owner's own decision: it
  // confirms the passkey and the decline is forgotten. A relay page's sign-in confirms nothing.
  expect(await restored.canTrust(verified!)).toBe(false);
  const fromApp = opaque();
  const inApp = await restored
    .pairingIdentity()!
    .enrollment.verifyProof(
      assertionProof(added.authenticator, fromApp, OFFICIAL_ANDROID_PASSKEY_ORIGINS[0]),
      fromApp,
      added.publicKey,
    );
  await restored.trustSignIn(inApp!);
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [],
    trustedSignIns: [{ id: f.google }],
    confirmedSignIns: [{ id: added.id, via: "android-app" }],
  });
  // Once the account stops listing it, it is withdrawn instead: listed again, it stays out.
  f.list();
  await restored.refresh();
  expect(restored.confirmedSignIns()).toEqual([]);
  f.list(listed);
  await restored.refresh();
  expect(await f.saved()).toMatchObject({
    declinedPasskeys: [],
    withdrawnSignIns: [signInDigest({ type: "passkey", id: added.id, publicKey: added.publicKey })],
    trustedSignIns: [{ id: f.google }],
    confirmedSignIns: [],
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
  await pinInRecord(f.manager, f.options.metadataFile, {
    type: "google",
    id: other,
    addedAt: 1,
    source: "approval",
  });
  // Pinned by approving a device, before any refresh could have pinned it on the vouching.
  await pinInRecord(f.manager, f.options.metadataFile, {
    type: "passkey",
    id: approved.id,
    publicKey: approved.publicKey,
    addedAt: 1,
    source: "approval",
  });
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
  // Removing it again after it came back keeps one decline, not two.
  await pinInRecord(f.manager, f.options.metadataFile, {
    type: "passkey",
    id: approved.id,
    publicKey: approved.publicKey,
    addedAt: 1,
    source: "approval",
  });
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
  // A device that signs in with it in the Android app is held, and approving it is what brings it
  // back, as a confirmation.
  const nonce = opaque();
  const verified = await restored
    .pairingIdentity()!
    .enrollment.verifyProof(
      assertionProof(added.authenticator, nonce, OFFICIAL_ANDROID_PASSKEY_ORIGINS[0]),
      nonce,
      added.publicKey,
    );
  expect(verified).toMatchObject({ id: added.id, trusted: false });
  await restored.trustSignIn(verified!);
  expect(await f.saved()).toMatchObject({
    withdrawnSignIns: [],
    trustedSignIns: [{ id: f.google }],
    confirmedSignIns: [{ id: added.id }],
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
    await pinInRecord(f.manager, f.options.metadataFile, {
      type: "google",
      id: id,
      addedAt: 1,
      source: "approval",
    });
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

test("TM-02: a passkey the relay lists with an endorsement is a suggestion; its sign-ins fetch nothing and are never trusted", async () => {
  const f = await endorsing();
  const added = await passkeyDevice(),
    unvouched = await passkeyDevice();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  const signIn = async (device: PasskeyDevice, from?: string) => {
    const nonce = opaque();
    return enrollment.verifyProof(
      assertionProof(device.authenticator, nonce, from),
      nonce,
      device.publicKey,
    );
  };
  // An endorsement made on a relay page, which a compromised relay can mint or keep.
  f.list(
    { id: added.id, publicKey: added.publicKey, endorsement: await googleVouch(added) },
    { id: unvouched.id, publicKey: unvouched.publicKey },
  );
  expect(await signIn(added)).toMatchObject({ id: added.id, trusted: false });
  expect(f.credentials).not.toHaveBeenCalled();
  await f.manager.refresh();
  expect(f.pins()).toEqual([
    [f.google, "link-page"],
    [added.id, "endorsed"],
  ]);
  // Pinned on that evidence, it is still no confirmation, on a relay page or in the app.
  expect(await signIn(added)).toMatchObject({ trusted: false });
  expect(await signIn(added, OFFICIAL_ANDROID_PASSKEY_ORIGINS[0])).toMatchObject({
    trusted: false,
    channel: "android-app",
  });
  expect(await signIn(unvouched)).toMatchObject({ id: unvouched.id, trusted: false });
  expect(f.manager.enrollmentStatus()).toMatchObject({ confirmationNeeded: true });
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
async function googleSignIn(subject: string, nonce: string, azp?: string): Promise<SignInProof> {
  const salt = opaque(),
    issuedAt = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    nonce: googleProofNonce(salt, nonce),
    ...(azp ? { azp } : {}),
  })
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
async function passkeyLinked() {
  const f = await fixture();
  const credentials = vi.fn<NonNullable<AccountBrowserPort["credentials"]>>();
  const options = {
    ...f.options,
    browser: { ...f.browser, credentials },
    google: () =>
      googleIdentityProvider(AUDIENCE, googleKeys, { authorizedParties: [AUDIENCE, ANDROID_APP] }),
  };
  const manager = new GatewayAccountLink(options);
  await manager.initialize();
  const passkey = await passkeyDevice(),
    nonce = opaque();
  await manager.completeSignup({
    accountId: f.accountId,
    nonce,
    proof: assertionProof(passkey.authenticator, linkNonce(nonce)),
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
    /**
     * A device's Google sign-in, checked as the enrollment routes check it: on a web page, or in
     * the official Android app, whose client presents the token.
     */
    googleSignIn: async (subject = SUBJECT, from: "web" | "app" = "web") => {
      const nonce = opaque();
      return enrollment.verifyProof(
        await googleSignIn(subject, nonce, from === "app" ? ANDROID_APP : undefined),
        nonce,
        undefined,
      );
    },
  };
}

test("TM-02: a gateway linked with a passkey suggests the sign-ins that passkey countersigned, and trusts none of them", async () => {
  const f = await passkeyLinked();
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  const older = await passkeyDevice(),
    unsigned = await passkeyDevice();
  const stranger = googleDigest("fictional-other-subject");
  const olderListed = { id: older.id, publicKey: older.publicKey };
  f.credentials.mockResolvedValue({
    google: [f.google, stranger],
    passkeys: [
      f.countersigned(googleSignInOf(f.google), passkeySignInOf(older)),
      olderListed,
      { id: unsigned.id, publicKey: unsigned.publicKey },
    ],
  });
  await f.manager.refresh();
  expect(f.pins()).toEqual([
    [f.passkey.id, "link-page"],
    [f.google, "countersigned"],
    [older.id, "countersigned"],
  ]);
  // The relay keeps the countersignature, so it could have made one: what it names is only a
  // suggestion. Neither the Google account nor the other passkey joins anything on it.
  expect(await f.googleSignIn()).toMatchObject({ type: "google", id: f.google, trusted: false });
  expect(await f.googleSignIn(SUBJECT, "app")).toMatchObject({ trusted: false });
  const nonce = opaque();
  expect(
    await f.manager
      .pairingIdentity()!
      .enrollment.verifyProof(assertionProof(older.authenticator, nonce), nonce),
  ).toMatchObject({ id: older.id, trusted: false });
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
  // Only the owner approving a device that signed in with it in an app brings it back.
  const verified = await f.googleSignIn(SUBJECT, "app");
  expect(verified).toMatchObject({ channel: "native-google", trusted: false });
  await f.manager.trustSignIn(verified!);
  expect(await f.saved()).toMatchObject({
    withdrawnSignIns: [],
    trustedSignIns: [{ id: f.passkey.id }],
    confirmedSignIns: [{ id: f.google, via: "native-google-approval" }],
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
  // The same listing with the genuine countersignature suggests the Google account it names,
  // which still joins nothing until the owner confirms it.
  f.credentials.mockResolvedValue({
    google: [f.google, stranger],
    passkeys: [{ ...f.listedPasskey, countersignature: genuine }],
  });
  await f.manager.refresh();
  expect(await f.googleSignIn()).toMatchObject({ trusted: false });
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
  const verified = await f.googleSignIn(SUBJECT, "app");
  expect(verified).toMatchObject({ type: "google", id: f.google, trusted: false });
  // Approving a device that signed in with it is the owner's decision, and lifts the decline.
  await f.manager.trustSignIn(verified!);
  expect(await f.saved()).toMatchObject({
    declinedGoogle: [],
    declinedPasskeys: [older.id],
    trustedSignIns: [{ id: f.passkey.id }],
    confirmedSignIns: [{ id: f.google }],
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
  // The owner declines Google here, and in advance a passkey this gateway never trusted; the
  // account withdraws the older passkey.
  await f.manager.removeTrustedSignIn(f.google);
  await f.manager.removeTrustedSignIn(removed.id);
  f.credentials.mockResolvedValue({
    google: [f.google],
    passkeys: [f.countersigned(googleSignInOf(f.google), passkeySignInOf(older))],
  });
  await f.manager.refresh();
  const refusals = {
    declinedGoogle: [f.google],
    declinedPasskeys: [removed.id],
    withdrawnSignIns: [signInDigest(passkeySignInOf(older))],
  };
  expect(await f.saved()).toMatchObject(refusals);
  // Linked to the same account again, with the same passkey or with another one.
  for (const device of [f.passkey, await passkeyDevice()]) {
    const nonce = opaque();
    await f.manager.completeSignup({
      accountId: f.accountId,
      nonce,
      proof: assertionProof(device.authenticator, linkNonce(nonce)),
      credentialPublicKey: device.publicKey,
      signal: new AbortController().signal,
    });
    expect(await f.saved()).toMatchObject(refusals);
  }
  // Linking with a sign-in it had refused is the owner's choice, like approving it.
  const nonce = opaque();
  for (const device of [older, removed]) {
    const linking = opaque();
    await f.manager.completeSignup({
      accountId: f.accountId,
      nonce: linking,
      proof: assertionProof(device.authenticator, linkNonce(linking)),
      credentialPublicKey: device.publicKey,
      signal: new AbortController().signal,
    });
  }
  expect(await f.saved()).toMatchObject({
    declinedGoogle: [f.google],
    declinedPasskeys: [],
    withdrawnSignIns: [],
  });
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

test("ask and the owner's refusals survive linking again, unlinking and a lost account; the pins do not", async () => {
  const f = await passkeyLinked();
  const relink = async (manager: GatewayAccountLink, accountId = f.accountId) => {
    const nonce = opaque();
    await manager.completeSignup({
      accountId,
      nonce,
      proof: assertionProof(f.passkey.authenticator, linkNonce(nonce)),
      credentialPublicKey: f.passkey.publicKey,
      signal: new AbortController().signal,
    });
  };
  await f.manager.setEnrollmentPolicy("ask");
  await f.manager.removeTrustedSignIn(f.google);
  const choices = { enrollmentPolicy: "ask", declinedGoogle: [f.google] };
  // Linking the same account again, as reconnecting does.
  await relink(f.manager);
  expect(f.manager.enrollmentPolicy()).toBe("ask");
  expect(await f.saved()).toMatchObject({ linked: true, ...choices });

  // Unlinking drops the link and its pins and keeps the choices, across a restart.
  await f.manager.unlink();
  const unlinked = await f.saved();
  expect(unlinked).toMatchObject({ linked: false, accountId: f.accountId, ...choices });
  expect(unlinked).not.toHaveProperty("trustedSignIns");
  const restarted = new GatewayAccountLink(f.options);
  await restarted.initialize();
  expect(restarted.accountModeActivated()).toBe(true);
  await relink(restarted);
  expect(restarted.enrollmentPolicy()).toBe("ask");
  expect(await f.saved()).toMatchObject({ linked: true, ...choices });
  expect(restarted.enrollmentStatus().trustedSignIns.map(({ id }) => id)).toEqual([f.passkey.id]);

  // Told the account is gone, the gateway leaves it as if it never had one, but keeps the choices
  // in case the same account comes back.
  await restarted.forget();
  expect(restarted.status()).toMatchObject({ activated: false, linked: false });
  expect(restarted.enrollmentStatus()).toEqual({
    policy: "ask",
    confirmationNeeded: false,
    trustedSignIns: [],
    confirmedSignIns: [],
  });
  const forgotten = await f.saved();
  expect(forgotten).toMatchObject({ linked: false, dormant: true, ...choices });
  expect(forgotten).not.toHaveProperty("trustedSignIns");
  const dormant = new GatewayAccountLink(f.options);
  await dormant.initialize();
  expect(dormant.accountModeActivated()).toBe(false);
  expect(dormant.status()).toMatchObject({ activated: false, linked: false, lastError: undefined });
  await relink(dormant);
  expect(dormant.status()).toMatchObject({ activated: true, linked: true });
  expect(await f.saved()).toMatchObject({ linked: true, ...choices });
  expect(await f.saved()).not.toHaveProperty("dormant");

  // Another account keeps the gateway's policy, but none of this account's refusals.
  await dormant.forget();
  await relink(dormant, "c".repeat(64));
  expect(dormant.enrollmentPolicy()).toBe("ask");
  expect(await f.saved()).toMatchObject({
    enrollmentPolicy: "ask",
    declinedGoogle: [],
    declinedPasskeys: [],
    withdrawnSignIns: [],
  });
});

test("an old link record without the kept choices still reads, unlinks and forgets", async () => {
  const f = await fixture();
  await mkdir(dirname(f.options.metadataFile), { recursive: true });
  await writeFile(f.options.metadataFile, JSON.stringify({ version: 1, linked: false }), {
    mode: 0o600,
  });
  const old = new GatewayAccountLink(f.options);
  await old.initialize();
  expect(old.status()).toMatchObject({ activated: true, linked: false, lastError: undefined });
  // With nothing chosen there is nothing to keep, so forgetting leaves no file behind.
  await old.forget();
  await expect(stat(f.options.metadataFile)).rejects.toMatchObject({ code: "ENOENT" });
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
  ).toMatchObject({ id: added.id, pin: { publicKey: added.publicKey } });
});

test("a sign-in asks the relay nothing, refreshes fetch one at a time, and each proof is verified once per fetch", async () => {
  const f = await passkeyLinked();
  f.credentials.mockResolvedValue({ google: [f.google], passkeys: [f.listedPasskey] });
  // Evidence never makes a sign-in trusted, so a sign-in has no reason to fetch it: untrusted
  // requests can't make the gateway call the relay.
  for (const result of await Promise.all([f.googleSignIn(), f.googleSignIn()]))
    expect(result).toMatchObject({ trusted: false });
  expect(f.credentials).not.toHaveBeenCalled();
  // Refreshes that overlap share one fetch.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.credentials.mockImplementationOnce(async () => {
    await held;
    return { google: [f.google], passkeys: [f.listedPasskey] };
  });
  const both = Promise.all([f.manager.refresh(), f.manager.refresh()]);
  await vi.waitFor(() => expect(f.credentials).toHaveBeenCalledOnce());
  release();
  await both;
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
  expect(f.manager.enrollmentStatus()).toEqual({
    policy: "ask",
    confirmationNeeded: false,
    trustedSignIns: [],
    confirmedSignIns: [],
  });
  // The account is gone on the relay, so there is nothing to unlink there.
  expect(f.browser.unlink).not.toHaveBeenCalled();
  expect(f.browser.cancel).toHaveBeenCalledOnce();
  // Only the owner's choice of ask is kept, for whichever account the gateway links next.
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).toEqual({
    version: 1,
    linked: false,
    dormant: true,
    accountId: f.accountId,
    enrollmentPolicy: "ask",
    declinedPasskeys: [],
    declinedGoogle: [],
    withdrawnSignIns: [],
  });
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
  expect(f.manager.enrollmentPolicy()).toBe("ask");
});

test("the gateway derives its own origin and vouches only for its hosted name under the relay", async () => {
  const f = await fixture();
  const own = `https://${hostedGatewayHostname(f.gatewayId, "relay.example.test")}`;
  // Nothing saved yet: no origin to vouch for.
  expect(f.manager.gatewayOrigin()).toBeUndefined();
  f.env.OMNESIS_PUBLIC_BASE_URL = own;
  expect(f.manager.gatewayOrigin()).toBe(own);
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = `${own}:8443`;
  expect(f.manager.gatewayOrigin()).toBe(`${own}:8443`);
  // An origin the relay returned for this gateway that isn't its own name is never vouched for.
  for (const chosen of [
    origin,
    `https://${hostedGatewayHostname(randomUUID(), "relay.example.test")}`,
    gatewayOrigin,
  ]) {
    f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = chosen;
    expect(f.manager.gatewayOrigin()).toBeUndefined();
  }
});

test("confirmed sign-ins belong to the link, fail closed when unreadable and go with their pin", async () => {
  const f = await fixture();
  expect(f.manager.confirmedSignIns()).toEqual([]);
  await f.link();
  const device = passkeyAuthenticator();
  const confirmed = {
    type: "passkey",
    id: device.id,
    publicKey: device.publicKey,
    counter: 3,
    at: 1,
    via: "gateway-origin",
  };
  const saved = JSON.parse(await readFile(f.options.metadataFile, "utf8"));
  expect(saved.confirmedSignIns).toEqual([]);
  // An entry this version can't read (a later version's) is dropped, not trusted and not fatal.
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({
      ...saved,
      confirmedSignIns: [confirmed, { ...confirmed, id: "later", via: "later-way" }, "garbage"],
    }) + "\n",
    { mode: 0o600 },
  );
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.status()).toMatchObject({ linked: true, lastError: undefined });
  expect(restored.confirmedSignIns()).toEqual([confirmed]);
  // Other changes keep it.
  await restored.setEnrollmentPolicy("ask");
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8")).confirmedSignIns).toEqual([
    confirmed,
  ]);
  // A version that predates the field drops it when it saves: nothing is confirmed then.
  const { confirmedSignIns: _dropped, ...older } = JSON.parse(
    await readFile(f.options.metadataFile, "utf8"),
  );
  await writeFile(f.options.metadataFile, JSON.stringify(older) + "\n", { mode: 0o600 });
  const rolledBack = new GatewayAccountLink(f.options);
  await rolledBack.initialize();
  expect(rolledBack.confirmedSignIns()).toEqual([]);
  // Removing the sign-in removes its confirmation too.
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({ ...older, confirmedSignIns: [confirmed] }) + "\n",
    { mode: 0o600 },
  );
  const removing = new GatewayAccountLink(f.options);
  await removing.initialize();
  await removing.removeTrustedSignIn(device.id);
  expect(removing.confirmedSignIns()).toEqual([]);
  // A new link is confirmed afresh, and an unlinked gateway has none.
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({ ...older, confirmedSignIns: [confirmed] }) + "\n",
    { mode: 0o600 },
  );
  const relinking = new GatewayAccountLink(f.options);
  await relinking.initialize();
  expect(relinking.confirmedSignIns()).toHaveLength(1);
  await relinking.unlink();
  expect(relinking.confirmedSignIns()).toEqual([]);
});

test("the official Android app's passkey origins are compiled in", async () => {
  const f = await fixture();
  const device = passkeyAuthenticator();
  f.browser.redeem.mockImplementationOnce(((pending: AccountBrowserPending) =>
    Promise.resolve({
      identityToken: "verified-role-proof",
      identity: { issuer: origin + "/_relay/account", subject: f.accountId, expiresAt: 1 },
      signInProof: registrationProof(device, linkNonce(pending.nonce)),
    })) as never);
  await f.link();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  for (const app of OFFICIAL_ANDROID_PASSKEY_ORIGINS) {
    const nonce = opaque();
    // Verified as made in the app; trusted only once the owner confirms that passkey.
    expect(await enrollment.verifyProof(assertionProof(device, nonce, app), nonce)).toMatchObject({
      id: device.id,
      trusted: false,
      channel: "android-app",
    });
  }
  // An app origin that is neither compiled in nor configured locally is refused.
  const nonce = opaque();
  const unknown = `android:apk-key-hash:${opaque()}`;
  expect(await enrollment.verifyProof(assertionProof(device, nonce, unknown), nonce)).toBe(
    undefined,
  );
  f.env.OMNESIS_CLOUD_RELAY_PASSKEY_ANDROID_ORIGINS = `${unknown}, not-an-origin`;
  expect(await enrollment.verifyProof(assertionProof(device, nonce, unknown), nonce)).toMatchObject(
    { channel: "android-app" },
  );
  expect(await enrollment.verifyProof(assertionProof(device, nonce), nonce)).toMatchObject({
    channel: "relay-page",
  });
});
const ROGUE = "e".repeat(64),
  SECOND_ROGUE = "9".repeat(64);
test("a certificate incident holds every new device until the owner acknowledges it, across restarts and whatever the relay lists", async () => {
  const f = await passkeyLinked();
  expect(f.manager.enrollmentPolicy()).toBe("automatic");
  expect(f.manager.incidentHold()).toBeUndefined();
  expect(f.manager.gatewayOriginAssertionsRefused()).toBe(false);
  vi.useFakeTimers({ now: Date.UTC(2028, 0, 2), toFake: ["Date"] });
  // Anything that isn't a certificate fingerprint is ignored.
  expect(await f.manager.holdForCertificateIncident(["not-a-digest"])).toBe(false);
  expect(await f.manager.holdForCertificateIncident([ROGUE, ROGUE])).toBe(true);
  expect(f.manager.enrollmentPolicy()).toBe("ask");
  expect(f.manager.pairingIdentity()!.enrollment.policy()).toBe("ask");
  expect(f.manager.gatewayOriginAssertionsRefused()).toBe(true);
  expect(f.manager.incidentHold()).toEqual({
    since: "2028-01-02T00:00:00.000Z",
    certificates: [ROGUE],
  });
  // The owner's own choice is untouched, and saving it doesn't lift the hold.
  await f.manager.setEnrollmentPolicy("automatic");
  expect(f.manager.enrollmentPolicy()).toBe("ask");
  expect(await f.saved()).toMatchObject({
    enrollmentPolicy: "automatic",
    incidentHold: { since: Date.UTC(2028, 0, 2) / 1000, certificates: [ROGUE] },
  });
  // The same certificate again changes nothing; another one joins the same hold.
  vi.setSystemTime(Date.UTC(2028, 0, 3));
  expect(await f.manager.holdForCertificateIncident([ROGUE])).toBe(false);
  expect(await f.manager.holdForCertificateIncident([ROGUE, SECOND_ROGUE])).toBe(true);
  expect(f.manager.incidentHold()).toEqual({
    since: "2028-01-02T00:00:00.000Z",
    certificates: [ROGUE, SECOND_ROGUE],
  });

  // The relay's listing changes and the gateway saves the change: the hold stays.
  f.credentials.mockResolvedValue({ google: [], passkeys: [] });
  await f.manager.refresh();
  expect(f.pins()).toEqual([]);
  expect(await f.saved()).toMatchObject({ incidentHold: { certificates: [ROGUE, SECOND_ROGUE] } });

  // A restart reads it back.
  const restarted = new GatewayAccountLink(f.options);
  await restarted.initialize();
  expect(restarted.enrollmentPolicy()).toBe("ask");
  expect(restarted.gatewayOriginAssertionsRefused()).toBe(true);

  // Unlinking, linking again and the relay saying the account is gone all keep it.
  await restarted.unlink();
  expect(await f.saved()).toMatchObject({
    linked: false,
    incidentHold: { certificates: [ROGUE, SECOND_ROGUE] },
  });
  const nonce = opaque();
  await restarted.completeSignup({
    accountId: f.accountId,
    nonce,
    proof: assertionProof(f.passkey.authenticator, linkNonce(nonce)),
    credentialPublicKey: f.passkey.publicKey,
    signal: new AbortController().signal,
  });
  expect(restarted.enrollmentPolicy()).toBe("ask");
  await restarted.forget();
  expect(await f.saved()).toMatchObject({
    dormant: true,
    incidentHold: { certificates: [ROGUE, SECOND_ROGUE] },
  });
  await restarted.completeSignup({
    accountId: "c".repeat(64),
    nonce,
    signal: new AbortController().signal,
  });
  expect(restarted.enrollmentPolicy()).toBe("ask");

  // Only the owner's acknowledgement lifts it, and the owner's choice applies again.
  await restarted.acknowledgeIncidentHold();
  expect(restarted.enrollmentPolicy()).toBe("automatic");
  expect(restarted.incidentHold()).toBeUndefined();
  expect(restarted.gatewayOriginAssertionsRefused()).toBe(false);
  const acknowledged = await f.saved();
  expect(acknowledged).not.toHaveProperty("incidentHold");
  expect(acknowledged).toMatchObject({ acknowledgedIncidents: [ROGUE, SECOND_ROGUE] });
  // Acknowledging with nothing held is a no-op.
  await restarted.acknowledgeIncidentHold();
  // The monitor reporting the same certificates again after a restart doesn't hold again.
  const again = new GatewayAccountLink(f.options);
  await again.initialize();
  expect(await again.holdForCertificateIncident([ROGUE, SECOND_ROGUE])).toBe(false);
  expect(again.enrollmentPolicy()).toBe("automatic");
  // A new certificate does, and acknowledging it keeps the earlier ones acknowledged once each.
  const third = "8".repeat(64);
  expect(await again.holdForCertificateIncident([ROGUE, third])).toBe(true);
  expect(again.incidentHold()!.certificates).toEqual([third]);
  await again.acknowledgeIncidentHold();
  expect(await f.saved()).toHaveProperty("acknowledgedIncidents", [ROGUE, SECOND_ROGUE, third]);
});

test("a gateway with no account saves a hold without turning account mode on, and forgetting keeps it", async () => {
  const f = await fixture();
  expect(await f.manager.holdForCertificateIncident([ROGUE])).toBe(true);
  expect(f.manager.accountModeActivated()).toBe(false);
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).toMatchObject({
    version: 1,
    linked: false,
    dormant: true,
    incidentHold: { certificates: [ROGUE] },
  });
  const restarted = new GatewayAccountLink(f.options);
  await restarted.initialize();
  expect(restarted.accountModeActivated()).toBe(false);
  expect(restarted.enrollmentPolicy()).toBe("ask");
  // Forgetting an account keeps it.
  await restarted.forget();
  expect(await stat(f.options.metadataFile)).toBeDefined();
  // With only acknowledged certificates left, forgetting still keeps the file.
  await restarted.acknowledgeIncidentHold();
  await restarted.forget();
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).toMatchObject({
    dormant: true,
    acknowledgedIncidents: [ROGUE],
  });
});

test("a hold on a link file this version can't read applies at once and leaves the file alone", async () => {
  const f = await fixture();
  await mkdir(dirname(f.options.metadataFile), { recursive: true });
  await writeFile(f.options.metadataFile, "unreadable");
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(await restored.holdForCertificateIncident([ROGUE])).toBe(true);
  expect(restored.enrollmentPolicy()).toBe("ask");
  expect(await readFile(f.options.metadataFile, "utf8")).toBe("unreadable");
  await restored.acknowledgeIncidentHold();
  expect(restored.incidentHold()).toBeUndefined();
  expect(await readFile(f.options.metadataFile, "utf8")).toBe("unreadable");
  // Writing the file again, as unlinking does, carries the hold state with it from then on.
  await restored.holdForCertificateIncident([SECOND_ROGUE]);
  await restored.unlink();
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).toMatchObject({
    incidentHold: { certificates: [SECOND_ROGUE] },
    acknowledgedIncidents: [ROGUE],
  });
  await restored.acknowledgeIncidentHold();
  expect(JSON.parse(await readFile(f.options.metadataFile, "utf8"))).not.toHaveProperty(
    "incidentHold",
  );
});

test("an acknowledgement that can't be saved leaves the hold on", async () => {
  const f = await fixture();
  await f.link();
  await f.manager.holdForCertificateIncident([ROGUE]);
  filesystem.afterMkdir = () => Promise.reject(new Error("disk full"));
  await expect(f.manager.acknowledgeIncidentHold()).rejects.toThrow("disk full");
  expect(f.manager.enrollmentPolicy()).toBe("ask");
  expect(f.manager.incidentHold()!.certificates).toEqual([ROGUE]);
  filesystem.afterMkdir = undefined;
  // At most 64 certificates are named, the newest kept.
  const many = Array.from({ length: 70 }, (_, index) => index.toString(16).padStart(64, "0"));
  await f.manager.holdForCertificateIncident(many);
  expect(f.manager.incidentHold()!.certificates).toEqual(many.slice(-64));
  await f.manager.acknowledgeIncidentHold();
  const saved = JSON.parse(await readFile(f.options.metadataFile, "utf8")) as {
    acknowledgedIncidents: string[];
  };
  expect(saved.acknowledgedIncidents).toEqual(many.slice(-64));
});

/**
 * Pins sign-ins as an earlier version's approval did, straight into the saved record. Approving
 * now confirms instead; these pins are what an upgraded gateway still holds as suggestions.
 */
async function pinInRecord(
  manager: GatewayAccountLink,
  metadataFile: string,
  ...pins: TrustedSignIn[]
): Promise<void> {
  const saved = JSON.parse(await readFile(metadataFile, "utf8")) as {
    trustedSignIns: TrustedSignIn[];
  };
  await writeFile(
    metadataFile,
    JSON.stringify({
      ...saved,
      trustedSignIns: [
        ...saved.trustedSignIns.filter((value) => !pins.some((pin) => pin.id === value.id)),
        ...pins,
      ],
    }) + "\n",
    { mode: 0o600 },
  );
  await manager.initialize();
}

/** A linked gateway whose saved public origin is its own hosted name, with a readable listing. */
async function confirming() {
  const f = await endorsing();
  const own = `https://${hostedGatewayHostname(f.gatewayId, "relay.example.test")}`;
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = own;
  /** What the owner's browser sends after the passkey prompt on `from`. */
  const assert = (
    device: PasskeyDevice,
    ceremony: { challenge: string; webauthnChallenge: string; binding: string },
    options: { from?: string; counter?: number } = {},
  ) => ({
    type: "gateway-passkey" as const,
    challenge: ceremony.challenge,
    credential: device.authenticator.authentication(
      options.from && options.from !== own
        ? gatewayPasskeyChallenge("pin-passkey", options.from, ceremony.challenge, ceremony.binding)
        : ceremony.webauthnChallenge,
      "dXNlcg",
      options.counter ?? 0,
      options.from ?? own,
    ),
  });
  return { ...f, own, assert };
}

test("the owner confirms a listed passkey on the gateway's own page, and nowhere else", async () => {
  const f = await confirming();
  const owner = await passkeyDevice();
  f.list({ id: owner.id, publicKey: owner.publicKey });
  const ceremony = f.manager.passkeyConfirmation();
  expect(ceremony).toEqual({
    purpose: "pin-passkey",
    rpId: "relay.example.test",
    origin: f.own,
    challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    binding: gatewayPasskeyPinBinding({ gatewayId: f.gatewayId, accountId: f.accountId }),
    webauthnChallenge: gatewayPasskeyChallenge(
      "pin-passkey",
      f.own,
      ceremony.challenge,
      gatewayPasskeyPinBinding({ gatewayId: f.gatewayId, accountId: f.accountId }),
    ),
    expiresAt: expect.any(Number),
  });
  expect(f.manager.enrollmentStatus()).toMatchObject({ confirmOrigin: f.own });
  await f.manager.confirmPasskey(f.assert(owner, ceremony, { counter: 4 }));
  expect(f.manager.confirmedSignIns()).toEqual([
    {
      type: "passkey",
      id: owner.id,
      publicKey: owner.publicKey,
      counter: 4,
      at: expect.any(Number),
      via: "gateway-origin",
    },
  ]);
  expect(f.manager.enrollmentStatus().confirmedSignIns).toEqual([
    { type: "passkey", id: owner.id, at: expect.any(Number), via: "gateway-origin" },
  ]);
  // Its challenge was spent.
  await expect(
    f.manager.confirmPasskey(f.assert(owner, ceremony, { counter: 5 })),
  ).rejects.toMatchObject({ status: 409, code: "passkey-not-confirmed" });
  // A counter that went backwards is a cloned authenticator or a replay.
  const again = f.manager.passkeyConfirmation();
  await expect(
    f.manager.confirmPasskey(f.assert(owner, again, { counter: 3 })),
  ).rejects.toMatchObject({ status: 403, code: "passkey-not-confirmed" });
  // In the official Android app it is confirmed as made there.
  const app = f.manager.passkeyConfirmation();
  await f.manager.confirmPasskey(
    f.assert(owner, app, { from: OFFICIAL_ANDROID_PASSKEY_ORIGINS[0], counter: 9 }),
  );
  expect(f.manager.confirmedSignIns()).toEqual([
    expect.objectContaining({ id: owner.id, counter: 9, via: "android-app" }),
  ]);
  // Survives a restart.
  const restored = new GatewayAccountLink(f.options);
  await restored.initialize();
  expect(restored.confirmedSignIns()).toHaveLength(1);
});

test("TM-01: a relay page, another gateway's page or a relay-chosen origin cannot confirm a passkey", async () => {
  const f = await confirming();
  const owner = await passkeyDevice();
  f.list({ id: owner.id, publicKey: owner.publicKey });
  // The page the relay serves, and a sibling gateway's page under the same relay domain.
  for (const from of [
    origin,
    `https://${hostedGatewayHostname(randomUUID(), "relay.example.test")}`,
  ]) {
    await expect(
      f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation(), { from })),
    ).rejects.toMatchObject({ status: 403, code: "passkey-not-confirmed" });
  }
  // A public origin the relay chose for this gateway (here its own host) leaves no origin to
  // confirm on at all.
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = origin;
  expect(() => f.manager.passkeyConfirmation()).toThrow(
    expect.objectContaining({ status: 409, code: "passkey-origin-unavailable" }),
  );
  expect(f.manager.enrollmentStatus()).not.toHaveProperty("confirmOrigin");
  expect(f.manager.confirmedSignIns()).toEqual([]);
});

test("a passkey is confirmed only against the key the account lists for it, for this account", async () => {
  const f = await confirming();
  const owner = await passkeyDevice(),
    relayOwn = await passkeyDevice();
  // A relay that lists its own key under the owner's credential id only makes it fail.
  f.list({ id: owner.id, publicKey: relayOwn.publicKey });
  await expect(
    f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation())),
  ).rejects.toMatchObject({ status: 403 });
  // A passkey the account does not list can't be confirmed.
  f.list({ id: relayOwn.id, publicKey: relayOwn.publicKey });
  await expect(
    f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation())),
  ).rejects.toMatchObject({ status: 403 });
  // A listing for another account, or none at all, confirms nothing.
  f.credentials.mockResolvedValueOnce({
    accountId: "b".repeat(64),
    google: [],
    passkeys: [{ id: owner.id, publicKey: owner.publicKey }],
  });
  await expect(
    f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation())),
  ).rejects.toMatchObject({ status: 503, code: "account-unavailable" });
  f.credentials.mockRejectedValueOnce(new Error("offline"));
  await expect(
    f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation())),
  ).rejects.toMatchObject({ status: 503 });
  // A malformed proof, or one for a challenge this gateway never issued, is refused unread.
  await expect(f.manager.confirmPasskey({ type: "passkey" })).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    f.manager.confirmPasskey(
      f.assert(owner, { ...f.manager.passkeyConfirmation(), challenge: opaque() }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.credentials).toHaveBeenCalledTimes(4);
  f.credentials.mockResolvedValue({
    accountId: f.accountId,
    google: [f.google],
    passkeys: [{ id: owner.id, publicKey: owner.publicKey }],
  });
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation()));
  expect(f.manager.confirmedSignIns()).toHaveLength(1);
});

test("confirming lifts the owner's decline, and the account withdrawing a passkey drops its confirmation", async () => {
  const f = await confirming();
  const owner = await passkeyDevice();
  f.list({ id: owner.id, publicKey: owner.publicKey });
  await f.manager.removeTrustedSignIn(owner.id);
  expect((await f.saved()).declinedPasskeys).toEqual([owner.id]);
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation(), { counter: 1 }));
  expect((await f.saved()).declinedPasskeys).toEqual([]);
  // While the account lists it, a sync keeps it.
  await f.manager.refresh();
  expect(f.manager.confirmedSignIns()).toHaveLength(1);
  expect(f.manager.enrollmentStatus().trustedSignIns).toEqual([
    expect.objectContaining({ id: f.google, confirmed: false }),
  ]);
  // The account stops listing it: its confirmation goes, and it is remembered as withdrawn.
  // That happens even with no pin left to sync for.
  await f.manager.removeTrustedSignIn(f.google);
  f.credentials.mockResolvedValue({ google: [], passkeys: [] });
  await f.manager.refresh();
  expect(f.manager.confirmedSignIns()).toEqual([]);
  const withdrawn = signInDigest({ type: "passkey", id: owner.id, publicKey: owner.publicKey });
  expect((await f.saved()).withdrawnSignIns).toContain(withdrawn);
  // Confirming it again, once listed, is the owner's own act and clears the withdrawal.
  f.list({ id: owner.id, publicKey: owner.publicKey });
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation(), { counter: 2 }));
  expect((await f.saved()).withdrawnSignIns).not.toContain(withdrawn);
});

test("an unlinked gateway can't start or finish a confirmation", async () => {
  const f = await fixture();
  expect(() => f.manager.passkeyConfirmation()).toThrow(
    expect.objectContaining({ status: 409, code: "configuration-invalid" }),
  );
  await expect(f.manager.confirmPasskey({})).rejects.toMatchObject({ status: 409 });
});

test("TM-01 (certificate incident): while a rogue certificate may exist for the gateway's name, no passkey is confirmed on its page", async () => {
  const f = await confirming();
  const owner = await passkeyDevice();
  f.list({ id: owner.id, publicKey: owner.publicKey });
  // A ceremony issued before the monitor saw the rogue certificate.
  const ceremony = f.manager.passkeyConfirmation();
  expect(await f.manager.holdForCertificateIncident([ROGUE])).toBe(true);
  // Whoever holds that certificate can serve a page on the gateway's own name.
  await expect(f.manager.confirmPasskey(f.assert(owner, ceremony))).rejects.toMatchObject({
    status: 403,
    code: "passkey-not-confirmed",
  });
  expect(() => f.manager.passkeyConfirmation()).toThrow(
    expect.objectContaining({ status: 409, code: "passkey-origin-unavailable" }),
  );
  expect(f.manager.gatewayOrigin()).toBeUndefined();
  expect(f.manager.enrollmentStatus()).not.toHaveProperty("confirmOrigin");
  expect(f.manager.confirmedSignIns()).toEqual([]);
  // Once the owner acknowledges it, the gateway's page counts again.
  await f.manager.acknowledgeIncidentHold();
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation()));
  expect(f.manager.confirmedSignIns()).toHaveLength(1);
});

test("a device's passkey sign-in on the gateway's page uses the confirmed, pinned or listed key, and only a confirmed one is trusted", async () => {
  const f = await confirming();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  expect(enrollment.gatewayPasskey!()).toEqual({ rpId: "relay.example.test", origin: f.own });
  const signIn = (device: PasskeyDevice, options: { from?: string; counter?: number } = {}) => {
    const challenge = opaque(),
      nonce = opaque(),
      from = options.from ?? f.own;
    return enrollment.verifyGatewayPasskey!(
      {
        type: "gateway-passkey",
        challenge,
        credential: device.authenticator.authentication(
          gatewayPasskeyChallenge("device-enrollment", from, challenge, nonce),
          "dXNlcg",
          options.counter ?? 0,
          from,
        ) as never,
      },
      challenge,
      nonce,
    );
  };
  const confirmed = await passkeyDevice(),
    listed = await passkeyDevice(),
    stranger = await passkeyDevice();
  f.list(
    { id: confirmed.id, publicKey: confirmed.publicKey },
    { id: listed.id, publicKey: listed.publicKey },
  );
  await f.manager.confirmPasskey(
    f.assert(confirmed, f.manager.passkeyConfirmation(), { counter: 2 }),
  );
  // Confirmed: trusted, and its counter moves on with each use.
  expect(await signIn(confirmed, { counter: 5 })).toMatchObject({
    id: confirmed.id,
    trusted: true,
    channel: "gateway-origin",
  });
  expect(f.manager.confirmedSignIns()).toEqual([expect.objectContaining({ counter: 5 })]);
  expect(await signIn(confirmed, { counter: 5 })).toBeUndefined();
  // With a second confirmed passkey, only the one used moves on; a failed save is not fatal.
  await f.manager.confirmPasskey(f.assert(listed, f.manager.passkeyConfirmation(), { counter: 1 }));
  expect(await signIn(confirmed, { counter: 6 })).toMatchObject({ trusted: true });
  expect(
    f.manager.confirmedSignIns().map((value) => (value.type === "passkey" ? value.counter : -1)),
  ).toEqual([6, 1]);
  const save = vi
    .spyOn(GatewayAccountLink.prototype as unknown as { save(): Promise<void> }, "save")
    .mockRejectedValueOnce(new Error("disk full"));
  expect(await signIn(confirmed, { counter: 7 })).toMatchObject({ trusted: true });
  save.mockRestore();
  // Listed again as unconfirmed for the next checks.
  await f.manager.removeTrustedSignIn(listed.id);
  // Listed only: verified, so it can be held for the owner, but not trusted.
  expect(await signIn(listed)).toMatchObject({ id: listed.id, trusted: false });
  // Pinned but not confirmed: verified with the pinned key, and held like a listed one.
  const pinnedOnly = await passkeyDevice();
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({
      ...(await f.saved()),
      trustedSignIns: [
        {
          type: "passkey",
          id: pinnedOnly.id,
          publicKey: pinnedOnly.publicKey,
          addedAt: 1,
          source: "link-page",
        },
      ],
    }) + "\n",
    { mode: 0o600 },
  );
  await f.manager.initialize();
  expect(await signIn(pinnedOnly)).toMatchObject({ id: pinnedOnly.id, trusted: false });
  // Not listed, made on the relay's page, or listed for another account: nothing.
  expect(await signIn(stranger)).toBeUndefined();
  expect(await signIn(listed, { from: origin })).toBeUndefined();
  f.credentials.mockResolvedValueOnce({
    accountId: "b".repeat(64),
    google: [],
    passkeys: [{ id: listed.id, publicKey: listed.publicKey }],
  });
  expect(await signIn(listed)).toBeUndefined();
  f.credentials.mockResolvedValueOnce({
    accountId: f.accountId,
    google: [],
    passkeys: [{ id: listed.id, publicKey: listed.publicKey }],
  });
  expect(await signIn(listed)).toMatchObject({ trusted: false });
  f.credentials.mockRejectedValueOnce(new Error("offline"));
  expect(await signIn(listed)).toBeUndefined();
  // Without an origin of its own the gateway offers no ceremony.
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = origin;
  expect(enrollment.gatewayPasskey!()).toBeUndefined();
  // Unlinked, nothing verifies.
  await f.manager.unlink();
  expect(await signIn(confirmed)).toBeUndefined();
});

test("TM-01 (certificate incident, join): while a rogue certificate may exist for the gateway's name, a passkey sign-in on its page joins nothing", async () => {
  const f = await confirming();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  const owner = await passkeyDevice();
  f.list({ id: owner.id, publicKey: owner.publicKey });
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation()));
  expect(await f.manager.holdForCertificateIncident([ROGUE])).toBe(true);
  expect(enrollment.gatewayPasskey!()).toBeUndefined();
  const challenge = opaque(),
    nonce = opaque();
  // Made on the gateway's name, which whoever holds that certificate can serve.
  expect(
    await enrollment.verifyGatewayPasskey!(
      {
        type: "gateway-passkey",
        challenge,
        credential: owner.authenticator.authentication(
          gatewayPasskeyChallenge("device-enrollment", f.own, challenge, nonce),
          "dXNlcg",
          1,
          f.own,
        ) as never,
      },
      challenge,
      nonce,
    ),
  ).toBeUndefined();
});

test("TM-01 (approval): only a passkey confirmed here approves a held request, once, on the gateway's page", async () => {
  const f = await confirming();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  const owner = await passkeyDevice(),
    listedOnly = await passkeyDevice();
  f.list(
    { id: owner.id, publicKey: owner.publicKey },
    { id: listedOnly.id, publicKey: listedOnly.publicKey },
  );
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation(), { counter: 1 }));
  const binding = opaque();
  const approve = (
    device: PasskeyDevice,
    ceremony: { challenge: string; webauthnChallenge: string },
    options: { from?: string; counter?: number } = {},
  ) =>
    enrollment.verifyApproval!(
      {
        type: "gateway-passkey",
        challenge: ceremony.challenge,
        credential: device.authenticator.authentication(
          options.from
            ? gatewayPasskeyChallenge("approve-request", options.from, ceremony.challenge, binding)
            : ceremony.webauthnChallenge,
          "dXNlcg",
          options.counter ?? 0,
          options.from ?? f.own,
        ),
      },
      binding,
    );
  const ceremony = enrollment.approvalCeremony!(binding)!;
  expect(ceremony).toMatchObject({ purpose: "approve-request", origin: f.own, binding });
  // A passkey the relay lists but the owner never confirmed here.
  expect(await approve(listedOnly, ceremony)).toBe(false);
  // Spent by that attempt.
  expect(await approve(owner, ceremony, { counter: 2 })).toBe(false);
  expect(await approve(owner, enrollment.approvalCeremony!(binding)!, { from: origin })).toBe(
    false,
  );
  expect(await approve(owner, enrollment.approvalCeremony!(opaque())!)).toBe(false);
  expect(await enrollment.verifyApproval!({ type: "passkey" }, binding)).toBe(false);
  expect(await approve(owner, enrollment.approvalCeremony!(binding)!, { counter: 3 })).toBe(true);
  expect(f.manager.confirmedSignIns()).toEqual([expect.objectContaining({ counter: 3 })]);
  // A synced passkey that always presents 0 keeps working once it was confirmed at 0.
  await writeFile(
    f.options.metadataFile,
    JSON.stringify({
      ...(await f.saved()),
      confirmedSignIns: [{ ...f.manager.confirmedSignIns()[0], counter: 0 }],
    }) + "\n",
    { mode: 0o600 },
  );
  await f.manager.initialize();
  expect(await approve(owner, enrollment.approvalCeremony!(binding)!)).toBe(true);
  // Without an origin of its own there is no approval page, and unlinked nothing approves.
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = origin;
  expect(enrollment.approvalCeremony!(binding)).toBeUndefined();
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN = f.own;
  const last = enrollment.approvalCeremony!(binding)!;
  await f.manager.unlink();
  expect(await approve(owner, last, { counter: 9 })).toBe(false);
});

test("TM-01 (certificate incident, approval): while a rogue certificate may exist for the gateway's name, no held request is approved on its page", async () => {
  const f = await confirming();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  const owner = await passkeyDevice();
  f.list({ id: owner.id, publicKey: owner.publicKey });
  await f.manager.confirmPasskey(f.assert(owner, f.manager.passkeyConfirmation()));
  const binding = opaque();
  // A ceremony issued before the monitor saw the rogue certificate.
  const early = enrollment.approvalCeremony!(binding)!;
  expect(await f.manager.holdForCertificateIncident([ROGUE])).toBe(true);
  expect(enrollment.approvalCeremony!(binding)).toBeUndefined();
  expect(
    await enrollment.verifyApproval!(
      {
        type: "gateway-passkey",
        challenge: early.challenge,
        credential: owner.authenticator.authentication(early.webauthnChallenge, "dXNlcg", 5, f.own),
      },
      binding,
    ),
  ).toBe(false);
});

test("a Google account confirmed by approving an app's sign-in joins from the app afterwards, never from a web page", async () => {
  const f = await passkeyLinked();
  f.credentials.mockResolvedValue({
    accountId: f.accountId,
    google: [f.google],
    passkeys: [f.listedPasskey],
  });
  const fromApp = await f.googleSignIn(SUBJECT, "app");
  expect(fromApp).toMatchObject({ channel: "native-google", trusted: false });
  await f.manager.trustSignIn(fromApp!);
  expect(await f.googleSignIn(SUBJECT, "app")).toMatchObject({ trusted: true });
  // The same Google account on a web page (the relay's, or any other) is still only held.
  expect(await f.googleSignIn()).toMatchObject({ channel: "web-google", trusted: false });
  // A different account from the app is not this confirmation.
  expect(await f.googleSignIn("fictional-other-subject", "app")).toMatchObject({ trusted: false });
});

test("TM-07: a listing for another account changes nothing on a refresh", async () => {
  const f = await passkeyLinked();
  const older = await passkeyDevice();
  f.credentials.mockResolvedValue({
    accountId: "b".repeat(64),
    google: [f.google],
    passkeys: [f.countersigned(googleSignInOf(f.google), passkeySignInOf(older))],
  });
  await f.manager.refresh();
  expect(f.manager.status().lastError).toBeUndefined();
  // Not even a withdrawal: the link's own passkey, missing from that listing, stays.
  expect(f.pins()).toEqual([[f.passkey.id, "link-page"]]);
  expect((await f.saved()).withdrawnSignIns).toEqual([]);
});

test("approving a held sign-in made on the gateway's own page confirms that passkey there", async () => {
  const f = await confirming();
  const enrollment = f.manager.pairingIdentity()!.enrollment;
  const listed = await passkeyDevice();
  f.list({ id: listed.id, publicKey: listed.publicKey });
  const challenge = opaque(),
    nonce = opaque();
  const held = await enrollment.verifyGatewayPasskey!(
    {
      type: "gateway-passkey",
      challenge,
      credential: listed.authenticator.authentication(
        gatewayPasskeyChallenge("device-enrollment", f.own, challenge, nonce),
        "dXNlcg",
        0,
        f.own,
      ) as never,
    },
    challenge,
    nonce,
  );
  expect(held).toMatchObject({ trusted: false, channel: "gateway-origin" });
  expect(await enrollment.canTrust(held!)).toBe(true);
  await enrollment.trustSignIn(held!);
  expect(f.manager.confirmedSignIns()).toEqual([
    expect.objectContaining({ id: listed.id, via: "gateway-origin", counter: 0 }),
  ]);
});
