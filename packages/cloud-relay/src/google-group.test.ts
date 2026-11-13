// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsecuredJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { FakeGoogle } from "../test/fake-google.js";
import { googleFixture } from "./google-fixture.js";
import {
  GoogleGroupUnavailable,
  loadGoogleGroupMembership,
  verifiedGoogleEmail,
} from "./google-group.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  options: { joinUrl?: string; now?: () => number; fetch?: typeof fetch } = {},
) {
  const google = await FakeGoogle.start();
  cleanup.push(() => google.close());
  const directory = await mkdtemp(join(tmpdir(), "omnesis-google-group-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, "service-account.json");
  await writeFile(credentialsFile, JSON.stringify(google.serviceAccountKey()), { mode: 0o600 });
  const fetch = googleFixture(`${google.url}/`, "127.0.0.1", true)!.fetch;
  const membership = await loadGoogleGroupMembership({
    group: " Testers@Example.com ",
    credentialsFile,
    joinUrl: options.joinUrl,
    fetch: options.fetch ?? fetch,
    now: options.now,
  });
  return { google, membership, credentialsFile, directory, fetch };
}

test("a direct member is found with one token and one group lookup for many checks", async () => {
  const f = await fixture();
  f.google.members.add("maya.reeves@example.com");
  expect(await f.membership.isMember("  Maya.Reeves@Example.com ")).toBe(true);
  expect(await f.membership.isMember("maya.reeves@example.com")).toBe(true);
  expect(f.google.tokensIssued).toBe(1);
  expect(f.google.requests).toEqual([
    "POST /token",
    "GET /v1/groups:lookup?groupKey.id=testers%40example.com",
    "GET /v1/groups/fixture01/memberships:lookup?memberKey.id=maya.reeves%40example.com",
    "GET /v1/groups/fixture01/memberships:lookup?memberKey.id=maya.reeves%40example.com",
  ]);
});

test("a member of a nested group is found by the transitive check, with its query encoded", async () => {
  const f = await fixture();
  f.google.nested.add("o'neil+beta@example.com");
  expect(await f.membership.isMember("o'neil+beta@example.com")).toBe(true);
  expect(f.google.requests.slice(-2)).toEqual([
    "GET /v1/groups/fixture01/memberships:lookup?memberKey.id=o%27neil%2Bbeta%40example.com",
    "GET /v1/groups/fixture01/memberships:checkTransitiveMembership?query=member_key_id%20%3D%3D%20%27o%5C%27neil%2Bbeta%40example.com%27",
  ]);
  expect(await f.membership.isMember("jamie.lopez@example.com")).toBe(false);
});

test("an edition without the transitive check admits direct members only and stops asking for an hour", async () => {
  let now = Date.now();
  const f = await fixture({ now: () => now });
  f.google.members.add("maya.reeves@example.com");
  f.google.nested.add("david.lin@example.com");
  f.google.failures.nested = 403;
  expect(await f.membership.isMember("david.lin@example.com")).toBe(false);
  expect(await f.membership.isMember("david.lin@example.com")).toBe(false);
  expect(await f.membership.isMember("maya.reeves@example.com")).toBe(true);
  const nestedCalls = () =>
    f.google.requests.filter((value) => value.includes("checkTransitiveMembership")).length;
  expect(nestedCalls()).toBe(1);
  now += 3_600_001;
  delete f.google.failures.nested;
  expect(await f.membership.isMember("david.lin@example.com")).toBe(true);
  expect(nestedCalls()).toBe(2);
});

test("the access token is reused until shortly before it expires, and a rejected one is replaced", async () => {
  let now = Date.now();
  const f = await fixture({ now: () => now });
  f.google.members.add("maya.reeves@example.com");
  await f.membership.isMember("maya.reeves@example.com");
  now += 3_500_000;
  await f.membership.isMember("maya.reeves@example.com");
  expect(f.google.tokensIssued).toBe(1);
  // Google says 3599 seconds; the relay renews a minute early.
  now += 40_000;
  await f.membership.isMember("maya.reeves@example.com");
  expect(f.google.tokensIssued).toBe(2);
  // The group's resource name was looked up once all along.
  expect(f.google.requests.filter((value) => value.includes("groups:lookup"))).toHaveLength(1);

  f.google.failures.lookup = 401;
  await expect(f.membership.isMember("maya.reeves@example.com")).rejects.toBeInstanceOf(
    GoogleGroupUnavailable,
  );
  delete f.google.failures.lookup;
  await f.membership.isMember("maya.reeves@example.com");
  expect(f.google.tokensIssued).toBe(3);
});

test("concurrent checks share one token request and one group lookup", async () => {
  const f = await fixture();
  f.google.members.add("maya.reeves@example.com");
  expect(
    await Promise.all([1, 2, 3].map(() => f.membership.isMember("maya.reeves@example.com"))),
  ).toEqual([true, true, true]);
  expect(f.google.tokensIssued).toBe(1);
  expect(f.google.requests.filter((value) => value.includes("groups:lookup"))).toHaveLength(1);
});

test("every failure is an error that names no address, and a failed lookup is not cached", async () => {
  const f = await fixture();
  f.google.members.add("maya.reeves@example.com");
  for (const [step, status] of [
    ["token", 500],
    ["group", 404],
    ["group", 403],
    ["lookup", 500],
    ["lookup", 403],
    ["nested", 500],
  ] as const) {
    f.google.failures[step] = status;
    const error = await f.membership.isMember("jamie.lopez@example.com").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleGroupUnavailable);
    expect(String((error as Error).message)).toContain(`HTTP ${status}`);
    expect(String((error as Error).message)).not.toContain("jamie");
    delete f.google.failures[step];
  }
  expect(await f.membership.isMember("maya.reeves@example.com")).toBe(true);
  await f.google.close();
  const offline = await f.membership.isMember("maya.reeves@example.com").catch((e: unknown) => e);
  expect(offline).toBeInstanceOf(GoogleGroupUnavailable);
  expect((offline as Error).message).not.toContain("maya");
});

test("an oversized or malformed answer is a failure, not a verdict", async () => {
  let body = "";
  const f = await fixture({
    fetch: async (input, init) =>
      String(input).includes("/token")
        ? f.fetch(input, init)
        : new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  });
  for (body of ["x".repeat(70_000), "not json", JSON.stringify({ name: "elsewhere/1" })])
    await expect(f.membership.isMember("maya.reeves@example.com")).rejects.toBeInstanceOf(
      GoogleGroupUnavailable,
    );
});

test("a nested check answering something else is a failure, not a verdict", async () => {
  const f = await fixture({
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("checkTransitiveMembership")) return Response.json({ hasMembership: "yes" });
      return f.fetch(input, init);
    },
  });
  await expect(f.membership.isMember("jamie.lopez@example.com")).rejects.toThrow(
    "nested membership check failed with an unexpected response",
  );
});

test("a failure that is not an error object still fails the check without naming anyone", async () => {
  const f = await fixture({
    fetch: () => Promise.reject("offline" as unknown as Error),
  });
  await expect(f.membership.isMember("maya.reeves@example.com")).rejects.toThrow(
    "token request failed with a network error",
  );
});

test("without a test transport the relay calls google's own endpoints", async () => {
  const google = await FakeGoogle.start();
  cleanup.push(() => google.close());
  const directory = await mkdtemp(join(tmpdir(), "omnesis-google-group-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, "service-account.json");
  await writeFile(credentialsFile, JSON.stringify(google.serviceAccountKey()));
  const called: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    called.push(String(input));
    return new Response("", { status: 503 });
  });
  const membership = await loadGoogleGroupMembership({
    group: "testers@example.com",
    credentialsFile,
  });
  await expect(membership.isMember("maya.reeves@example.com")).rejects.toBeInstanceOf(
    GoogleGroupUnavailable,
  );
  expect(called).toEqual(["https://oauth2.googleapis.com/token"]);
});

test("a key without a key id still signs its token request", async () => {
  const f = await fixture();
  const { private_key_id: _, ...key } = f.google.serviceAccountKey();
  await writeFile(f.credentialsFile, JSON.stringify(key));
  const membership = await loadGoogleGroupMembership({
    group: "testers@example.com",
    credentialsFile: f.credentialsFile,
    fetch: f.fetch,
  });
  f.google.members.add("maya.reeves@example.com");
  expect(await membership.isMember("maya.reeves@example.com")).toBe(true);
});

test("an address that is not one is not a member and asks Google nothing", async () => {
  const f = await fixture();
  for (const value of ["", "no-at-sign", "two words@example.com", "line\nbreak@example.com"])
    expect(await f.membership.isMember(value)).toBe(false);
  expect(f.google.requests).toEqual([]);
});

test("startup refuses a missing or invalid key, a bad group address and a join link that is not https", async () => {
  const f = await fixture({ joinUrl: "https://groups.example.com/g/testers" });
  expect(f.membership.joinUrl).toBe("https://groups.example.com/g/testers");
  const write = async (value: unknown) => {
    const file = join(f.directory, `${Math.random()}.json`);
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const key = f.google.serviceAccountKey();
  for (const credentialsFile of [
    join(f.directory, "missing.json"),
    await write("not json"),
    await write({ ...key, type: "authorized_user" }),
    await write({
      ...key,
      private_key: "not a key",
    }),
    await write({ ...key, client_email: "not an address" }),
  ])
    await expect(
      loadGoogleGroupMembership({ group: "testers@example.com", credentialsFile }),
    ).rejects.toThrow("OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE");
  await expect(
    loadGoogleGroupMembership({ group: "testers", credentialsFile: f.credentialsFile }),
  ).rejects.toThrow("OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP must");
  for (const joinUrl of [
    "http://groups.example.com/g/testers",
    "not a url",
    "https://user:secret@groups.example.com/",
  ])
    await expect(
      loadGoogleGroupMembership({
        group: "testers@example.com",
        credentialsFile: f.credentialsFile,
        joinUrl,
      }),
    ).rejects.toThrow("OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL");
});

test("only an email google verified is used, normalized as google compares it", () => {
  const token = (claims: Record<string, unknown>) => new UnsecuredJWT(claims).encode();
  expect(
    verifiedGoogleEmail(token({ email: " Maya.Reeves@Example.com", email_verified: true })),
  ).toBe("maya.reeves@example.com");
  for (const claims of [
    { email: "maya.reeves@example.com", email_verified: false },
    { email: "maya.reeves@example.com", email_verified: "true" },
    { email: "maya.reeves@example.com" },
    { email_verified: true },
    { email: 42, email_verified: true },
  ])
    expect(verifiedGoogleEmail(token(claims))).toBeUndefined();
  expect(verifiedGoogleEmail("not-a-token")).toBeUndefined();
});

test("the google fixture is only for a synthetic loopback relay and serves only google's api origins", async () => {
  expect(googleFixture(undefined, "0.0.0.0", false)).toBeUndefined();
  for (const [value, bind, synthetic] of [
    ["http://127.0.0.1:9/", "0.0.0.0", true],
    ["http://127.0.0.1:9/", "127.0.0.1", false],
    ["https://google.example.com/", "127.0.0.1", true],
    ["http://127.0.0.1:9/prefix", "127.0.0.1", true],
  ] as const)
    expect(() => googleFixture(value, bind, synthetic)).toThrow();
  const fixture = googleFixture("http://127.0.0.1:9/", "::1", true)!;
  expect(fixture.authorizationEndpoint).toBe("http://127.0.0.1:9/o/oauth2/v2/auth");
  expect(() => fixture.fetch("https://example.com/token")).toThrow("serves only");
  expect(() => fixture.fetch(new URL("https://example.com/token"))).toThrow("serves only");
  expect(() => fixture.fetch(new Request("https://oauth2.googleapis.com/token"))).toThrow(
    "takes a URL",
  );
});
