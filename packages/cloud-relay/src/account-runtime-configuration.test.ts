// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { accountRuntimeConfiguration } from "./account-runtime-configuration.js";
import { localIdentityProvider } from "./identity.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-account-runtime-"));
  dirs.push(dir);
  return { dir, database: join(dir, "relay.db"), origin: "https://relay.example.test" };
}
test("account services do no filesystem work unless the independent cloud flag is enabled", async () => {
  for (const value of [undefined, "0", "true"])
    expect(
      await accountRuntimeConfiguration({
        env: {
          OMNESIS_CLOUD_RELAY_ENABLED: value,
          OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: "/does-not-exist",
        },
        database: "/does-not-exist/state.db",
      }),
    ).toBeUndefined();
  const f = await fixture();
  expect(
    await accountRuntimeConfiguration({
      origin: undefined,
      database: "/does-not-exist/state.db",
      env: { OMNESIS_CLOUD_RELAY_ENABLED: "1" },
    }),
  ).toBeUndefined();
  for (const setting of [
    "OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE",
    "OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL",
  ])
    await expect(
      accountRuntimeConfiguration({
        ...f,
        origin: undefined,
        env: { OMNESIS_CLOUD_RELAY_ENABLED: "1", [setting]: "/does-not-exist" },
      }),
    ).rejects.toThrow("public HTTPS");
  for (const origin of ["", " ", "http://foreign.example.test"])
    await expect(
      accountRuntimeConfiguration({
        ...f,
        origin,
        env: { OMNESIS_CLOUD_RELAY_ENABLED: "1" },
      }),
    ).rejects.toThrow();
});
test("account identity authority persists independently, with optional private app associations and native Google verification", async () => {
  const f = await fixture(),
    nativeGoogleIdentity = localIdentityProvider(randomBytes(32), "127.0.0.1"),
    env = { OMNESIS_CLOUD_RELAY_ENABLED: "1" };
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
    env = { OMNESIS_CLOUD_RELAY_ENABLED: "1" };
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
  // Without the feature flag the setting is not even read.
  expect(
    await accountRuntimeConfiguration({
      ...f,
      env: { OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL: "not an address" },
    }),
  ).toBeUndefined();
});

test("the signup policy defaults to invitation, and an allowlist needs its file", async () => {
  const f = await fixture(),
    env = { OMNESIS_CLOUD_RELAY_ENABLED: "1" };
  expect((await accountRuntimeConfiguration({ ...f, env }))!.signup).toEqual({
    policy: "invitation",
    allowlistFile: undefined,
  });
  expect(
    (await accountRuntimeConfiguration({
      ...f,
      env: {
        ...env,
        OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "allowlist",
        OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE: join(f.dir, "allowlist.json"),
      },
    }))!.signup,
  ).toEqual({ policy: "allowlist", allowlistFile: join(f.dir, "allowlist.json") });
  expect(
    (await accountRuntimeConfiguration({
      ...f,
      env: { ...env, OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "open" },
    }))!.signup?.policy,
  ).toBe("open");
  await expect(
    accountRuntimeConfiguration({
      ...f,
      env: { ...env, OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "allowlist" },
    }),
  ).rejects.toThrow("ALLOWLIST_FILE");
  await expect(
    accountRuntimeConfiguration({
      ...f,
      env: { ...env, OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "everyone" },
    }),
  ).rejects.toThrow();
  await expect(
    accountRuntimeConfiguration({
      ...f,
      origin: undefined,
      env: { ...env, OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "open" },
    }),
  ).rejects.toThrow("public HTTPS origin");
  // Without the opt-in, a signup setting changes nothing and reads nothing.
  expect(
    await accountRuntimeConfiguration({
      ...f,
      env: { OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "open" },
    }),
  ).toBeUndefined();
});

test("a google group is optional, needs its key and the allowlist policy, and is checked at startup", async () => {
  const f = await fixture(),
    { FakeGoogle } = await import("../test/fake-google.js"),
    google = await FakeGoogle.start();
  try {
    const credentials = join(f.dir, "service-account.json");
    await writeFile(credentials, JSON.stringify(google.serviceAccountKey()), { mode: 0o600 });
    const env = {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "allowlist",
      OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP: "testers@example.com",
      OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE: credentials,
      OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL: "https://groups.example.com/g/testers",
    };
    // The group alone may stand for the allowlist, and the link is kept for the refusal page.
    const signup = (await accountRuntimeConfiguration({ ...f, env }))!.signup!;
    expect(signup).toMatchObject({ policy: "allowlist", allowlistFile: undefined });
    expect(signup.googleGroup?.joinUrl).toBe("https://groups.example.com/g/testers");
    // Nothing was asked of Google to start.
    expect(google.requests).toEqual([]);
    const { OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL: _, ...withoutLink } = env;
    expect(
      (await accountRuntimeConfiguration({ ...f, env: withoutLink }))!.signup!.googleGroup?.joinUrl,
    ).toBeUndefined();
    for (const [change, message] of [
      [{ OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE: undefined }, "requires"],
      [
        { OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE: join(f.dir, "missing.json") },
        "service account JSON key",
      ],
      [{ OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL: "http://groups.example.com/" }, "https"],
      [{ OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP: "testers" }, "group's email address"],
      [{ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "open" }, "allowlist signup policy"],
      [{ OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: undefined }, "allowlist signup policy"],
      [
        { OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP: undefined },
        "require OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP",
      ],
    ] as const)
      await expect(
        accountRuntimeConfiguration({ ...f, env: { ...env, ...change } }),
      ).rejects.toThrow(message);
    // Unset, nothing changes.
    expect(
      (await accountRuntimeConfiguration({ ...f, env: { OMNESIS_CLOUD_RELAY_ENABLED: "1" } }))!
        .signup,
    ).not.toHaveProperty("googleGroup");
    await expect(accountRuntimeConfiguration({ ...f, origin: undefined, env })).rejects.toThrow(
      "public HTTPS origin",
    );
  } finally {
    await google.close();
  }
});
