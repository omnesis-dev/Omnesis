// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localIdentityProvider, googlePairingNonce } from "@omnesis/cloud-relay";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const issuer = "omnesis-local-test",
  subject = "fictional-owner";
const ownerAccountId = createHash("sha256")
  .update(JSON.stringify([issuer, subject]))
  .digest("hex");
let db: Database.Database;
let dir: string;
let path: string;
let admin: string;
let reader: string;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID", "fictional-google-client");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN", undefined);
  vi.stubEnv("OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT", "");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID", undefined);
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE", undefined);
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE", undefined);
  dir = mkdtempSync(join(tmpdir(), "omnesis-google-routes-"));
  path = join(dir, "gateway.sqlite");
  db = createDatabase(path);
  admin = createToken(db, createDevice(db, { name: "Fictional admin", kind: "cli" }).id, [
    SCOPE_ADMIN,
  ]).token;
  reader = createToken(db, createDevice(db, { name: "Fictional reader", kind: "cli" }).id, [
    SCOPE_READ,
  ]).token;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const app = () =>
  createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
  });
async function request(otherSubject = subject) {
  const fields = {
    requestId: randomUUID(),
    kind: "ios" as const,
    name: "Fictional phone",
    secret: randomBytes(32).toString("hex"),
  };
  const identityToken = await new SignJWT({ nonce: googlePairingNonce(fields) })
    .setIssuer(issuer)
    .setSubject(otherSubject)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
  return { ...fields, identityToken };
}
function post(server: ReturnType<typeof app>, route: string, body: unknown, token?: string) {
  return server.request(route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("public Google pairing request bodies are bounded before parsing or identity verification", async () => {
  const server = app();
  for (const route of ["/devices/google/request", "/devices/google/poll"]) {
    const response = await server.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fictionalSecret: "x".repeat(20_001) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Google pairing request body too large",
      code: "PAYLOAD_TOO_LARGE",
    });
  }
});

test("Google login awaits explicit gateway owner approval and a normal device pairing exchange", async () => {
  const server = app();
  const value = await request();
  const before = db.prepare("SELECT count(*) AS n FROM devices").get();
  const pending = await post(server, "/devices/google/request", value);
  expect(pending.status).toBe(200);
  expect(pending.headers.get("cache-control")).toBe("no-store");
  const body = (await pending.json()) as {
    status: string;
    verificationCode: string;
    pairingCode?: string;
  };
  expect(body.status).toBe("pending");
  expect(body.pairingCode).toBeUndefined();
  expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual(before);
  for (const token of [undefined, reader]) {
    expect(
      (
        await server.request("/admin/cloud-pairing/requests", {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        })
      ).status,
    ).toBe(token ? 403 : 401);
    expect(
      (
        await post(
          server,
          "/admin/cloud-pairing/decision",
          { requestId: value.requestId, approve: true },
          token,
        )
      ).status,
    ).toBe(token ? 403 : 401);
  }
  const visible = await server.request("/admin/cloud-pairing/requests", {
    headers: { authorization: `Bearer ${admin}` },
  });
  const text = await visible.text();
  expect(text).toContain(body.verificationCode);
  expect(text).not.toContain(value.secret);
  expect(text).not.toContain(value.identityToken);
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: value.requestId, approve: true },
        admin,
      )
    ).status,
  ).toBe(200);
  const approved = await post(server, "/devices/google/poll", {
    requestId: value.requestId,
    secret: value.secret,
  });
  const result = (await approved.json()) as { status: string; pairingCode: string };
  expect(result.status).toBe("approved");
  expect(result.pairingCode).toEqual(expect.any(String));
  // Issuing an approval code creates no device until the client performs the existing exchange.
  expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual(before);
  const paired = await post(server, "/devices/pair", { pairingCode: result.pairingCode });
  expect(paired.status).toBe(200);
  expect(await paired.json()).toMatchObject({ token: expect.any(String) });
  expect(
    (await post(server, "/devices/pair", { pairingCode: result.pairingCode })).status,
  ).not.toBe(200);
});

test("invalid identity, account, request data and polling secret disclose no credentials", async () => {
  const server = app();
  const value = await request();
  for (const body of [
    { ...value, identityToken: "sensitive-invalid-token" },
    await request("fictional-other"),
    { ...value, secret: "wrong" },
    { ...value, scopes: ["admin"] },
  ]) {
    const response = await post(server, "/devices/google/request", body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = await response.text();
    expect(text).not.toContain("sensitive-invalid-token");
    expect(text).not.toContain(value.secret);
  }
  expect((await post(server, "/devices/google/request", value)).status).toBe(200);
  expect(
    (
      await post(server, "/devices/google/poll", {
        requestId: value.requestId,
        secret: "b".repeat(64),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: value.requestId, approve: false },
        admin,
      )
    ).status,
  ).toBe(200);
  expect(
    await (
      await post(server, "/devices/google/poll", {
        requestId: value.requestId,
        secret: value.secret,
      })
    ).json(),
  ).toMatchObject({ status: "denied" });
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: value.requestId, approve: true },
        admin,
      )
    ).status,
  ).toBe(409);
});

test("Google configuration is absent when optional configuration or experimental mode is off", async () => {
  const unconfigured = createServer(db, path);
  expect((await unconfigured.request("/devices/google/config")).status).toBe(404);
  expect((await post(unconfigured, "/devices/google/request", await request())).status).toBe(404);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  const disabled = app();
  expect((await disabled.request("/devices/google/config")).status).toBe(404);
  expect((await post(disabled, "/devices/google/request", await request())).status).toBe(404);
});

function webApp() {
  const secretFile = join(dir, "fictional-web-secret.json");
  writeFileSync(
    secretFile,
    JSON.stringify({
      web: { client_id: "fictional-web-client", client_secret: "fictional-web-backend-secret" },
    }),
  );
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID", "fictional-web-client");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE", secretFile);
  return createServer(db, path, {
    publicBaseUrl: "https://gateway.example.test",
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
  });
}
async function webBegin(server: ReturnType<typeof app>) {
  const value = {
    requestId: randomUUID(),
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
  };
  const response = await server.request("/devices/google/authorize", {
    method: "POST",
    headers: { origin: "https://gateway.example.test", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
  const url = new URL(authorizationUrl);
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "fictional-authorization-code",
  }).toString();
  return {
    value,
    response,
    url,
    callback,
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
  };
}
async function webToken(nonce: string, owner = subject) {
  return new SignJWT({ nonce })
    .setIssuer(issuer)
    .setSubject(owner)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
}

test("public Google configuration contains only safe setup values, with independent web and native enablement", async () => {
  const server = webApp();
  const response = await server.request("/devices/google/config");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const publicConfig = await response.text();
  expect(JSON.parse(publicConfig)).toEqual({
    clientId: "fictional-web-client",
    gatewayFingerprint: "a".repeat(64),
    webSignIn: true,
    webOrigin: "https://gateway.example.test",
  });
  expect(publicConfig).not.toContain(ownerAccountId);
  expect(publicConfig).not.toContain("fictional-web-backend-secret");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID", undefined);
  const native = app();
  expect(await (await native.request("/devices/google/config")).json()).toMatchObject({
    clientId: "fictional-google-client",
    webSignIn: false,
  });
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID", undefined);
  expect(await (await app().request("/devices/google/config")).json()).toMatchObject({
    clientId: "",
    webSignIn: false,
  });
});

test("browser Google sign-in uses a private state cookie and creates only an owner-approval request", async () => {
  const server = webApp();
  const before = db.prepare("SELECT count(*) AS n FROM devices").get();
  const flow = await webBegin(server);
  expect(flow.url.origin).toBe("https://accounts.google.com");
  expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/devices/google", "Max-Age=300"])
    expect(flow.response.headers.get("set-cookie")).toContain(flag);
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        id_token: await webToken(flow.url.searchParams.get("nonce")!),
        token_type: "Bearer",
      }),
    ),
  );
  vi.stubGlobal("fetch", transport);
  const result = await server.request(flow.callback.href, { headers: { cookie: flow.cookie } });
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe(`/portal/?googlePairing=${flow.value.requestId}`);
  expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual(before);
  const pending = await post(server, "/devices/google/poll", {
    requestId: flow.value.requestId,
    secret: flow.value.secret,
  });
  expect(await pending.json()).toMatchObject({ status: "pending" });
  const replay = await server.request(flow.callback.href, { headers: { cookie: flow.cookie } });
  expect(replay.headers.get("location")).toBe("/portal/?googlePairing=failed");
  expect(transport).toHaveBeenCalledOnce();
  expect((transport.mock.calls[0]![1]!.body as URLSearchParams).get("client_secret")).toBe(
    "fictional-web-backend-secret",
  );
});

test("browser initiation and callbacks reject cross-site attempts, lost or ambiguous cookies, and substituted Google identity", async () => {
  const server = webApp();
  const value = { requestId: randomUUID(), name: "Fictional browser", secret: "a".repeat(64) };
  for (const origin of [undefined, "https://attacker.example.test"]) {
    const response = await server.request("/devices/google/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(value),
    });
    expect(response.status).toBe(403);
  }
  const flow = await webBegin(server);
  const transport = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", transport);
  for (const cookie of [
    undefined,
    `${flow.cookie}; ${flow.cookie}`,
    flow.cookie + "x",
    "unrelated=value",
  ]) {
    const response = await server.request(flow.callback.href, {
      headers: cookie ? { cookie } : {},
    });
    expect(response.headers.get("location")).toBe("/portal/?googlePairing=failed");
  }
  expect(transport).not.toHaveBeenCalled();
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        id_token: await webToken(flow.url.searchParams.get("nonce")!, "fictional-other-owner"),
        token_type: "Bearer",
      }),
    ),
  );
  expect(
    (await server.request(flow.callback.href, { headers: { cookie: flow.cookie } })).headers.get(
      "location",
    ),
  ).toBe("/portal/?googlePairing=failed");
  expect(
    (
      await post(server, "/devices/google/poll", {
        requestId: flow.value.requestId,
        secret: flow.value.secret,
      })
    ).status,
  ).toBe(404);
});

test("request and polling burst limits are separate and apply before approval work", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const server = app();
  const value = await request();
  for (let index = 0; index < 10; index++)
    expect((await post(server, "/devices/google/request", value)).status).toBe(200);
  expect((await post(server, "/devices/google/request", value)).status).toBe(429);
  for (let index = 0; index < 120; index++)
    expect(
      (
        await post(server, "/devices/google/poll", {
          requestId: value.requestId,
          secret: value.secret,
        })
      ).status,
    ).toBe(200);
  expect(
    (
      await post(server, "/devices/google/poll", {
        requestId: value.requestId,
        secret: value.secret,
      })
    ).status,
  ).toBe(429);
  const web = webApp();
  for (let index = 0; index < 10; index++) await webBegin(web);
  const limited = await web.request("/devices/google/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://gateway.example.test" },
    body: JSON.stringify({
      requestId: randomUUID(),
      name: "Fictional browser",
      secret: "b".repeat(64),
    }),
  });
  expect(limited.status).toBe(429);
});

test("identity provider errors preserve only safe known statuses and disclose no backend details", async () => {
  const value = await request();
  for (const [failure, expected] of [
    [null, 401],
    ["fictional-private-error", 401],
    [{}, 401],
    [{ status: "403", message: "fictional-private-error" }, 401],
    [{ status: 500 }, 401],
    [{ status: 429 }, 429],
  ] as const) {
    const server = createServer(db, path, {
      tlsFingerprintSha256: "a".repeat(64),
      cloudIdentity: {
        ownerAccountId,
        identity: {
          verify: async () => {
            throw failure;
          },
        },
      },
    });
    const response = await post(server, "/devices/google/request", value);
    expect(response.status).toBe(expected);
    const body = await response.text();
    expect(body).toContain("Cloud pairing request refused");
    expect(body).not.toContain("fictional-private-error");
  }
});

test("cloud pairing uses the public SNI certificate getter while the default direct leaf remains independent", async () => {
  for (const value of ["b".repeat(64), () => "b".repeat(64)]) {
    const gateway = createServer(db, path, {
      tlsFingerprintSha256: "a".repeat(64),
      cloudTlsFingerprintSha256: value,
      cloudIdentity: { identity, ownerAccountId },
    });
    expect(await (await gateway.request("/devices/google/config")).json()).toMatchObject({
      gatewayFingerprint: "b".repeat(64),
    });
    const input = await request();
    const response = await gateway.request("/devices/google/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const { googlePairingVerificationCode } = await import("@omnesis/cloud-relay");
    expect(await response.json()).toMatchObject({
      verificationCode: googlePairingVerificationCode(input, "b".repeat(64)),
    });
  }
});

test("Google authorize callback is fixed to separate cloud origin while direct MCP metadata keeps its primary issuer", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN", "https://opaque-relay.example.net");
  const server = webApp();
  expect(await (await server.request("/devices/google/config")).json()).toMatchObject({
    webOrigin: "https://opaque-relay.example.net",
  });
  expect(
    await (
      await server.request("https://gateway.example.test/.well-known/oauth-authorization-server")
    ).json(),
  ).toMatchObject({ issuer: "https://gateway.example.test" });
  const value = {
    requestId: randomUUID(),
    name: "Synthetic cloud browser",
    secret: randomBytes(32).toString("hex"),
  };
  const wrong = await server.request("/devices/google/authorize", {
    method: "POST",
    headers: { origin: "https://gateway.example.test", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(wrong.status).toBe(403);
  const response = await server.request("/devices/google/authorize", {
    method: "POST",
    headers: { origin: "https://opaque-relay.example.net", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(200);
  const url = new URL((await response.json()).authorizationUrl);
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://opaque-relay.example.net/devices/google/callback",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id_token: await webToken(url.searchParams.get("nonce")!),
        token_type: "Bearer",
      }),
    ),
  );
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "synthetic-code",
  }).toString();
  expect(
    (
      await server.request(callback.href, {
        headers: { cookie: response.headers.get("set-cookie")!.split(";")[0]! },
      })
    ).headers.get("location"),
  ).toBe(`/portal/?googlePairing=${value.requestId}`);
});

test("a verified managed Google link activates pairing without restart and isolates owner changes", async () => {
  let owner: string | undefined;
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentitySource: () => (owner ? { identity, ownerAccountId: owner } : undefined),
  });
  expect((await server.request("/devices/google/config")).status).toBe(404);
  owner = ownerAccountId;
  expect((await server.request("/devices/google/config")).status).toBe(200);
  const first = await request();
  expect((await post(server, "/devices/google/request", first)).status).toBe(200);
  const list = () =>
    server.request("/admin/cloud-pairing/requests", {
      headers: { authorization: `Bearer ${admin}` },
    });
  expect((await (await list()).json()).items).toHaveLength(1);
  owner = createHash("sha256")
    .update(JSON.stringify([issuer, "another-fictional-owner"]))
    .digest("hex");
  expect((await (await list()).json()).items).toEqual([]);
  expect(
    (
      await post(server, "/devices/google/poll", {
        requestId: first.requestId,
        secret: first.secret,
      })
    ).status,
  ).toBe(404);
  expect((await post(server, "/devices/google/request", await request())).status).toBe(403);
  expect(
    (await post(server, "/devices/google/request", await request("another-fictional-owner")))
      .status,
  ).toBe(200);
  owner = undefined;
  expect((await server.request("/devices/google/config")).status).toBe(404);
  owner = ownerAccountId;
  expect((await (await list()).json()).items).toEqual([]);
});

test("an owner change during identity verification cannot return an old enrollment request", async () => {
  let owner = ownerAccountId;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = {
    verify: async (token: string, nonce?: string) => {
      enter();
      await released;
      return identity.verify(token, nonce);
    },
  };
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentitySource: () => ({ identity: provider, ownerAccountId: owner }),
  });
  const value = await request();
  const pending = post(server, "/devices/google/request", value);
  await entered;
  owner = "b".repeat(64);
  release();
  expect((await pending).status).toBe(409);
  const visible = await server.request("/admin/cloud-pairing/requests", {
    headers: { authorization: `Bearer ${admin}` },
  });
  expect((await visible.json()).items).toEqual([]);
});

test("managed browser origin changes invalidate old OAuth state and unavailable web configuration fails closed", async () => {
  const secretFile = join(dir, "dynamic-web.json");
  writeFileSync(
    secretFile,
    JSON.stringify({
      web: { client_id: "fictional-web-client", client_secret: "fictional-backend-secret" },
    }),
  );
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID", "fictional-web-client");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE", secretFile);
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN", "https://stale.example.test");
  let origin: string | undefined = "https://first.example.test";
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentitySource: () => ({ identity, ownerAccountId }),
    cloudPairingPublicOrigin: () => origin,
  });
  expect((await (await server.request("/devices/google/config")).json()).webOrigin).toBe(origin);
  const begin = await server.request("/devices/google/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      requestId: randomUUID(),
      name: "Fictional browser",
      secret: "b".repeat(64),
    }),
  });
  expect(begin.status).toBe(200);
  const authorization = new URL((await begin.json()).authorizationUrl);
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}/devices/google/callback`);
  const state = authorization.searchParams.get("state")!;
  origin = "https://second.example.test";
  expect((await (await server.request("/devices/google/config")).json()).webOrigin).toBe(origin);
  const callback = await server.request(`/devices/google/callback?state=${state}&code=unused`, {
    headers: { cookie: `__Secure-omnesis-google-login=${state}` },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toContain("googlePairing=failed");
  origin = undefined;
  expect((await (await server.request("/devices/google/config")).json()).webSignIn).toBe(false);
  const unavailable = await server.request("/devices/google/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://second.example.test" },
    body: JSON.stringify({
      requestId: randomUUID(),
      name: "Fictional browser",
      secret: "b".repeat(64),
    }),
  });
  expect(unavailable.status).toBe(404);
});

test("managed portal enrollment returns to its direct origin without local OAuth setup and cannot bypass owner approval", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID", undefined);
  let operation: import("@omnesis/cloud-relay").GoogleBrowserPending;
  const broker: import("@omnesis/cloud-relay").GoogleBrowserPort = {
    clientId: () => "managed-device-client",
    deviceIdentity: () => undefined,
    callbackUrl: async (origin) => {
      if (origin !== "https://direct.example.test") throw new Error("Unconfigured callback");
      return `${origin}/devices/google/callback`;
    },
    begin: vi.fn(
      async (input) =>
        (operation = {
          ...input,
          operationId: randomUUID(),
          authorizeUrl: "https://relay.example.test/_relay/v2/google/browser/begin?ticket=opaque",
          redemptionSecret: "backend-only-secret",
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          issuedAt: Math.floor(Date.now() / 1000),
          clientId: "managed-device-client",
        }),
    ),
    redeem: vi.fn(async (pending) => ({
      identity: { issuer, subject, expiresAt: 4_000_000_000 },
      idToken: await new SignJWT({ nonce: pending.nonce })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setSubject(subject)
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key),
    })),
  };
  const unavailable = async () => {
    throw new Error("Unused management operation");
  };
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
    cloudRelayManagement: {
      status: unavailable,
      configure: unavailable,
      enable: unavailable,
      disable: unavailable,
      reconnect: unavailable,
      renew: unavailable,
      managedGoogleBrowser: () => broker,
    },
  });
  expect(
    await (await server.request("https://direct.example.test/devices/google/config")).json(),
  ).toMatchObject({ clientId: "managed-device-client", webSignIn: true });
  const value = {
    requestId: randomUUID(),
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
  };
  const start = await server.request("https://direct.example.test/devices/google/authorize", {
    method: "POST",
    headers: { Origin: "https://direct.example.test", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(start.status).toBe(200);
  expect(await start.json()).toEqual({
    authorizationUrl: "https://relay.example.test/_relay/v2/google/browser/begin?ticket=opaque",
  });
  const cookie = start.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  expect(cookie).not.toContain("backend-only-secret");
  const before = db.prepare("SELECT count(*) AS n FROM devices").get();
  const callback = `https://direct.example.test/devices/google/callback?state=${operation!.browserState}&brokerResult=${"r".repeat(43)}`;
  const wrongBrowser = await server.request(callback);
  expect(wrongBrowser.headers.get("location")).toBe("/portal/?googlePairing=failed");
  expect(broker.redeem).not.toHaveBeenCalled();
  const completed = await server.request(callback, { headers: { Cookie: cookie } });
  expect(completed.headers.get("location")).toBe(`/portal/?googlePairing=${value.requestId}`);
  expect(
    await (
      await post(server, "/devices/google/poll", {
        requestId: value.requestId,
        secret: value.secret,
      })
    ).json(),
  ).toMatchObject({ status: "pending" });
  expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual(before);
  const unknown = await server.request("https://unknown.example.test/devices/google/authorize", {
    method: "POST",
    headers: { Origin: "https://unknown.example.test", "content-type": "application/json" },
    body: JSON.stringify({ ...value, requestId: randomUUID() }),
  });
  expect(unknown.status).toBeGreaterThanOrEqual(400);
});
