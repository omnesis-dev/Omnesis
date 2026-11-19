// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { accountRuntimeConfiguration } from "./account-runtime-configuration.js";
import { localIdentityProvider } from "./identity.js";
import { invitePublicKeyValue, signInvite } from "./invites.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-account-runtime-"));
  dirs.push(dir);
  return { dir, database: join(dir, "relay.db"), origin: "https://relay.example.test" };
}
test("a relay without a public origin has no account services and refuses their settings", async () => {
  const f = await fixture();
  expect(
    await accountRuntimeConfiguration({
      origin: undefined,
      database: "/does-not-exist/state.db",
      env: {},
    }),
  ).toBeUndefined();
  for (const setting of [
    "OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE",
    "OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL",
    "OMNESIS_CLOUD_RELAY_SIGNUP_POLICY",
    "OMNESIS_CLOUD_RELAY_INVITE_KEYS",
  ])
    await expect(
      accountRuntimeConfiguration({
        ...f,
        origin: undefined,
        env: { [setting]: "/does-not-exist" },
      }),
    ).rejects.toThrow("public HTTPS");
  for (const origin of ["", " ", "http://foreign.example.test"])
    await expect(accountRuntimeConfiguration({ ...f, origin, env: {} })).rejects.toThrow();
});
test("account identity authority persists independently, with optional private app associations and native Google verification", async () => {
  const f = await fixture(),
    nativeGoogleIdentity = localIdentityProvider(randomBytes(32), "127.0.0.1"),
    env = {};
  const first = (await accountRuntimeConfiguration({ ...f, env, nativeGoogleIdentity }))!;
  expect(first.nativeGoogleIdentity).toBe(nativeGoogleIdentity);
  expect(first.associations).toBeUndefined();
  const key = join(f.dir, "account-authority.pem"),
    bytes = await readFile(key);
  if (process.platform !== "win32") {
    expect((await stat(key)).mode & 0o777).toBe(0o600);
  }
  const second = (await accountRuntimeConfiguration({ ...f, env }))!;
  expect(second.enrollmentAuthority!.jwks()).toEqual(first.enrollmentAuthority!.jwks());
  expect(await readFile(key)).toEqual(bytes);
  const associations = join(f.dir, "apps.json");
  await writeFile(
    associations,
    JSON.stringify({ apple: ["ABCDEFGHIJ.dev.example.phone"], android: [] }),
    { mode: 0o600 },
  );
  const explicit = join(f.dir, "separate-account-key.pem");
  const configured = (await accountRuntimeConfiguration({
    ...f,
    env: {
      ...env,
      OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: explicit,
      OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE: associations,
    },
  }))!;
  expect(configured.associations!.androidOrigins()).toEqual([]);
  expect(configured.enrollmentAuthority!.jwks()).not.toEqual(first.enrollmentAuthority!.jwks());
  await writeFile(associations, JSON.stringify({ apple: ["invalid-application"], android: [] }));
  await expect(
    accountRuntimeConfiguration({
      ...f,
      env: { ...env, OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE: associations },
    }),
  ).rejects.toThrow();
  await expect(
    accountRuntimeConfiguration({
      ...f,
      env: { ...env, OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: " " },
    }),
  ).rejects.toThrow();
});

test("a short connect address is absent unless set, and an invalid one stops startup naming the setting", async () => {
  const f = await fixture(),
    env = {};
  expect(await accountRuntimeConfiguration({ ...f, env })).not.toHaveProperty("connectShortUrl");
  expect(
    (await accountRuntimeConfiguration({
      ...f,
      env: { ...env, OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL: "https://front.example.test/connect" },
    }))!.connectShortUrl,
  ).toBe("https://front.example.test/connect");
  for (const value of [
    "",
    "front.example.test/connect",
    "http://front.example.test/connect",
    "https://name:secret@front.example.test/connect",
    "https://front.example.test/connect?next=1",
    "https://front.example.test/connect#top",
  ])
    await expect(
      accountRuntimeConfiguration({
        ...f,
        env: { ...env, OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL: value },
      }),
    ).rejects.toThrow("OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL must be an https URL");
});

test("invite keys make sign-up invite-only; without them it is closed unless chosen open", async () => {
  const f = await fixture(),
    first = generateKeyPairSync("ed25519"),
    second = generateKeyPairSync("ed25519"),
    key = invitePublicKeyValue(first.publicKey),
    other = invitePublicKeyValue(second.publicKey);
  const signup = async (env: NodeJS.ProcessEnv) =>
    (await accountRuntimeConfiguration({ ...f, env }))!.signup!;
  expect(await signup({})).toEqual({ policy: "closed" });
  expect(await signup({ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "open" })).toEqual({ policy: "open" });
  expect(await signup({ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "closed" })).toEqual({
    policy: "closed",
  });
  const invited = await signup({ OMNESIS_CLOUD_RELAY_INVITE_KEYS: ` ${key} , ${other}` });
  expect(invited.policy).toBe("invite");
  expect(invited.invites?.origin).toBe(f.origin);
  // Either key's invites are accepted, so a key can be replaced without ending the other's.
  const now = Math.floor(Date.now() / 1000);
  expect(
    await signup({
      OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "invite",
      OMNESIS_CLOUD_RELAY_INVITE_KEYS: key,
    }),
  ).toMatchObject({ policy: "invite" });
  for (const { privateKey } of [first, second])
    expect(
      invited.invites!.verify(signInvite(privateKey, { origin: f.origin, expiresAt: now + 60 })),
    ).toMatchObject({ expiresAt: now + 60 });
  await expect(signup({ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "invite" })).rejects.toThrow(
    "requires OMNESIS_CLOUD_RELAY_INVITE_KEYS",
  );
  for (const policy of ["open", "closed"])
    await expect(
      signup({ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: policy, OMNESIS_CLOUD_RELAY_INVITE_KEYS: key }),
    ).rejects.toThrow("requires the invite signup policy");
  for (const keys of ["not-a-key", `${key},`, Array.from({ length: 9 }, () => key).join(",")])
    await expect(signup({ OMNESIS_CLOUD_RELAY_INVITE_KEYS: keys })).rejects.toThrow(
      "OMNESIS_CLOUD_RELAY_INVITE_KEYS must list one to eight",
    );
  for (const policy of ["everyone", "allowlist", "invitation"])
    await expect(signup({ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: policy })).rejects.toThrow();
});

test("a setting of the retired allowlist or group gate stops startup naming it", async () => {
  const f = await fixture();
  for (const setting of [
    "OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE",
    "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP",
    "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE",
    "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL",
  ])
    for (const origin of [f.origin, undefined])
      await expect(
        accountRuntimeConfiguration({ ...f, origin, env: { [setting]: "/unused" } }),
      ).rejects.toThrow(`${setting} is no longer supported`);
});
