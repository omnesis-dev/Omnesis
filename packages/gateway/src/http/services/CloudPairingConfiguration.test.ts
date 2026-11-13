// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as relay from "@omnesis/cloud-relay";
import {
  cloudPairingIdentity,
  cloudPairingIdentitySource,
  webGooglePairingConfiguration,
} from "./CloudPairingConfiguration.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-google-config-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const owner = "a".repeat(64);
test("optional configuration supports web-only sign-in and explicit owner binding", () => {
  expect(cloudPairingIdentity({})).toBeUndefined();
  expect(
    cloudPairingIdentity({ OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-web-client" }),
  ).toBeUndefined();
  const provided = {
    ownerAccountId: owner,
    identity: { verify: async () => ({ issuer: "fictional", subject: "fictional", expiresAt: 1 }) },
  };
  expect(cloudPairingIdentity({}, provided)).toBe(provided);
  expect(
    cloudPairingIdentity({
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: owner,
    })?.ownerAccountId,
  ).toBe(owner);
  expect(
    cloudPairingIdentity({
      OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-web-client, fictional-ios-client",
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: owner,
    })?.ownerAccountId,
  ).toBe(owner);
  expect(() =>
    cloudPairingIdentity({
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: "invalid",
    }),
  ).toThrow();
});
test("gateway registration credentials supply the owner identity without exposing their token", async () => {
  const path = join(directory, "google-credentials.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, accountId: owner, idToken: "fictional-private-id-token" }),
  );
  const config = cloudPairingIdentity({
    OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-mobile-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: path,
  });
  expect(config?.ownerAccountId).toBe(owner);
  expect(JSON.stringify(config)).not.toContain("fictional-private-id-token");
  expect(
    cloudPairingIdentity({
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: "b".repeat(64),
      OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: join(directory, "absent"),
    })?.ownerAccountId,
  ).toBe("b".repeat(64));
});
test("private configuration rejects missing, malformed, oversized and invalid owner files without leaking their contents", async () => {
  const path = join(directory, "private-config.json");
  const env = {
    OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: path,
  };
  expect(() => cloudPairingIdentity(env)).toThrow("Invalid private Google configuration file");
  for (const content of ["malformed fictional-secret", "x".repeat(65_537)]) {
    await writeFile(path, content);
    expect(() => cloudPairingIdentity(env)).toThrow("Invalid private Google configuration file");
  }
  await writeFile(path, JSON.stringify({ accountId: "invalid" }));
  expect(() => cloudPairingIdentity(env)).toThrow();
  const data = JSON.stringify({ accountId: owner });
  await writeFile(path, data.padEnd(65_536, " "));
  expect(cloudPairingIdentity(env)?.ownerAccountId).toBe(owner);
});
test("the backend web secret is optional and must match its configured public client identifier", async () => {
  const path = join(directory, "web-secret.json");
  const env = {
    OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: path,
  };
  expect(webGooglePairingConfiguration({}, "https://gateway.example.test")).toBeUndefined();
  expect(
    webGooglePairingConfiguration(
      { OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client" },
      "https://gateway.example.test",
    ),
  ).toBeUndefined();
  expect(webGooglePairingConfiguration(env)).toBeUndefined();
  await writeFile(
    path,
    JSON.stringify({
      web: { client_id: "fictional-web-client", client_secret: "fictional-secret" },
    }),
  );
  expect(webGooglePairingConfiguration(env, "https://gateway.example.test")).toEqual({
    clientId: "fictional-web-client",
    clientSecret: "fictional-secret",
    publicBaseUrl: "https://gateway.example.test",
  });
  await writeFile(
    path,
    JSON.stringify({ web: { client_id: "wrong-client", client_secret: "fictional-secret" } }),
  );
  expect(() => webGooglePairingConfiguration(env, "https://gateway.example.test")).toThrow(
    /web OAuth credential file/,
  );
});

test("Android hybrid Google tokens require both the configured web audience and an explicitly trusted Android presenter", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: "fictional-android-key", alg: "RS256" }],
  });
  const original = relay.googleIdentityProvider;
  vi.spyOn(relay, "googleIdentityProvider").mockImplementation((audiences, _keys, options) =>
    original(audiences, keys, options),
  );
  const config = cloudPairingIdentity({
    OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID:
      "fictional-android-client, fictional-other-android-client",
    OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: owner,
  })!;
  const signed = (audience: string, presenter: string) =>
    new SignJWT({ azp: presenter })
      .setProtectedHeader({ alg: "RS256", kid: "fictional-android-key" })
      .setAudience(audience)
      .setIssuer("https://accounts.google.com")
      .setSubject("fictional-android-owner")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  expect(
    await config.identity.verify(await signed("fictional-web-client", "fictional-android-client")),
  ).toMatchObject({ subject: "fictional-android-owner" });
  expect(
    await config.identity.verify(
      await signed("fictional-web-client", "fictional-other-android-client"),
    ),
  ).toMatchObject({ subject: "fictional-android-owner" });
  await expect(
    config.identity.verify(await signed("fictional-android-client", "fictional-android-client")),
  ).rejects.toThrow();
  await expect(
    config.identity.verify(await signed("fictional-web-client", "unconfigured-android-client")),
  ).rejects.toThrow();
});

test("Google web pairing uses its explicitly separate cloud origin without changing the existing public issuer", async () => {
  const path = join(directory, "web-secret.json");
  await writeFile(
    path,
    JSON.stringify({
      web: { client_id: "fictional-web-client", client_secret: "fictional-secret" },
    }),
  );
  const env = {
    OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: path,
    OMNESIS_PUBLIC_BASE_URL: "https://existing.example.org",
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://opaque-relay.example.net",
  };
  expect(webGooglePairingConfiguration(env, "https://existing.example.org")?.publicBaseUrl).toBe(
    "https://opaque-relay.example.net",
  );
  expect(webGooglePairingConfiguration(env)?.publicBaseUrl).toBe(
    "https://opaque-relay.example.net",
  );
  expect(env.OMNESIS_PUBLIC_BASE_URL).toBe("https://existing.example.org");
  expect(() =>
    webGooglePairingConfiguration({
      ...env,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "http://insecure.example",
    }),
  ).toThrow();
});

test("managed verified Google ownership takes effect without restarting or adopting stale identity", async () => {
  const { cloudPairingIdentitySource } = await import("./CloudPairingConfiguration.js");
  let current: string | undefined;
  const source = cloudPairingIdentitySource(
    { OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-client" },
    () => current,
  );
  expect(source()).toBeUndefined();
  expect(source()).toBeUndefined();
  current = owner;
  const first = source();
  expect(first?.ownerAccountId).toBe(owner);
  expect(source()).toBe(first);
  current = "b".repeat(64);
  expect(source()?.ownerAccountId).toBe(current);
  expect(source()).not.toBe(first);
  current = undefined;
  expect(source()).toBeUndefined();
  const staticSource = cloudPairingIdentitySource(
    {
      OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-client",
      OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT: owner,
    },
    () => undefined,
  );
  expect(staticSource()?.ownerAccountId).toBe(owner);
  const invalid = cloudPairingIdentitySource(
    { OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-client" },
    () => "invalid",
  );
  expect(() => invalid()).toThrow();
});

test("managed service audience and Android presenter discovery works without per-user Google IDs and refreshes verifier policy", () => {
  let managed: { clientIds: string[]; authorizedParties: string[] } | undefined;
  const source = cloudPairingIdentitySource(
    {},
    () => "a".repeat(64),
    () => managed,
  );
  expect(source()).toBeUndefined();
  managed = {
    clientIds: ["managed-web", "managed-native"],
    authorizedParties: ["managed-web", "managed-native", "android-presenter"],
  };
  const first = source()!;
  expect(first.ownerAccountId).toBe("a".repeat(64));
  expect(first.configurationKey).toBe(
    JSON.stringify([managed.clientIds, managed.authorizedParties]),
  );
  expect(source()).toBe(first);
  managed = { clientIds: ["new-native"], authorizedParties: ["new-native"] };
  expect(source()).not.toBe(first);
  managed = undefined;
  expect(source()).toBeUndefined();
});
