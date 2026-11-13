// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  localIdentityProvider,
  googlePairingNonce,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  signDeviceTranscript,
  EnrollmentChallenges,
  type GatewayEnrollment,
  type VerifiedSignIn,
} from "@omnesis/cloud-relay";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_PUSH_CLAIM } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice, listDevices } from "../../data/repositories/DeviceRepository.js";
import {
  createToken,
  listDeviceIdsWithActiveScope,
} from "../../data/repositories/TokenRepository.js";
import { PairingNotifier } from "../../push/pairing-notifier.js";
import { PushBroadcaster } from "../../push/broadcast.js";
import {
  enqueueNotification,
  leaseNotificationWakes,
  settleNotificationWake,
} from "../../push/queue.js";
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
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
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

/** What a device does: ask for a challenge, then answer it with the request. */
async function submit(server: ReturnType<typeof app>, body: object, base = "/devices/google") {
  const { challenge } = (await (await post(server, `${base}/challenge`, {})).json()) as {
    challenge: string;
  };
  return post(server, `${base}/request`, { ...body, challenge });
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
  const pending = await submit(server, value);
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
    const response = await submit(server, body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = await response.text();
    expect(text).not.toContain("sensitive-invalid-token");
    expect(text).not.toContain(value.secret);
  }
  expect((await submit(server, value)).status).toBe(200);
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

test("Google configuration is absent when optional configuration or cloud relay is disabled", async () => {
  const unconfigured = createServer(db, path);
  expect((await unconfigured.request("/devices/google/config")).status).toBe(404);
  expect((await post(unconfigured, "/devices/google/request", await request())).status).toBe(404);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
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
  // `__Host-` keeps a sibling under the same parent domain from planting the
  // state: the browser accepts it only from this origin, at `Path=/`, with no
  // `Domain`.
  const setCookie = flow.response.headers.get("set-cookie")!;
  expect(setCookie.startsWith("__Host-omnesis-google-login=")).toBe(true);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/;", "Max-Age=300"])
    expect(setCookie).toContain(flag);
  expect(setCookie.toLowerCase()).not.toContain("domain=");
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
  const state = flow.cookie.slice(flow.cookie.indexOf("=") + 1);
  for (const cookie of [
    undefined,
    `${flow.cookie}; ${flow.cookie}`,
    flow.cookie + "x",
    "unrelated=value",
    // The old `__Secure-` name could be set by a sibling subdomain; it is not read.
    `__Secure-omnesis-google-login=${state}`,
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

test("attack: a sign-in state cookie planted by a sibling site cannot complete Google sign-in", async () => {
  // The attacker starts a browser sign-in on the owner's gateway and keeps
  // the state it was handed. A page on another gateway under the same parent
  // domain then plants that state in the owner's browser as a parent-domain
  // cookie (`__Secure-omnesis-google-login=<state>; Domain=relay.example.test`),
  // which the browser then sends back without its Domain. Only a `__Host-`
  // cookie, which no sibling can set, may bind the callback to a browser.
  const server = webApp();
  const before = db.prepare("SELECT count(*) AS n FROM devices").get();
  const flow = await webBegin(server);
  const state = flow.cookie.slice(flow.cookie.indexOf("=") + 1);
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        id_token: await webToken(flow.url.searchParams.get("nonce")!),
        token_type: "Bearer",
      }),
    ),
  );
  vi.stubGlobal("fetch", transport);
  const planted = await server.request(flow.callback.href, {
    headers: { cookie: `__Secure-omnesis-google-login=${state}` },
  });
  expect(planted.status).toBe(302);
  expect(planted.headers.get("location")).toBe("/portal/?googlePairing=failed");
  expect(transport).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual(before);
  const poll = await post(server, "/devices/google/poll", {
    requestId: flow.value.requestId,
    secret: flow.value.secret,
  });
  expect(await poll.json()).not.toMatchObject({ status: "pending" });
});

test("request and polling burst limits are separate and apply before approval work", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const server = app();
  const value = await request();
  // The challenge and the request it answers each count; a repeated request is answered as before.
  expect((await submit(server, value)).status).toBe(200);
  for (let index = 0; index < 8; index++)
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
    const response = await submit(server, value);
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
    const response = await submit(gateway, input);
    expect(response.status).toBe(200);
    const { pairingComparisonCode } = await import("@omnesis/cloud-relay");
    const reply = (await response.json()) as { verificationCode: string; codeNonce: string };
    expect(reply.verificationCode).toBe(
      pairingComparisonCode({
        ...input,
        gatewayFingerprint: "b".repeat(64),
        codeNonce: reply.codeNonce,
      }),
    );
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
  expect((await submit(server, first)).status).toBe(200);
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
  expect((await submit(server, await request())).status).toBe(403);
  expect((await submit(server, await request("another-fictional-owner"))).status).toBe(200);
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
  const pending = submit(server, value);
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
    headers: { cookie: `__Host-omnesis-google-login=${state}` },
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
    authorizationOrigin: () => "https://relay.example.test",
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
  ).toMatchObject({
    clientId: "managed-device-client",
    webSignIn: true,
    authorizationRelayOrigin: "https://relay.example.test",
  });
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

test("neutral account browser enrollment uses host-bound callbacks and trusted approval; unlink cannot reactivate legacy Google", async () => {
  let operation: import("@omnesis/cloud-relay").AccountBrowserPending | undefined,
    linked = true;
  const broker: import("@omnesis/cloud-relay").AccountBrowserPort = {
    available: () => true,
    authorizationOrigin: () => "https://relay.example.test",
    refresh: () => Promise.resolve(),
    cancel: () => {},
    unlink: () => Promise.resolve(),
    verifyEnrollment: (token, nonce) => identity.verify(token, nonce),
    callbackUrl: (origin) => Promise.resolve(origin + "/devices/account/callback"),
    begin: (input) =>
      Promise.resolve(
        (operation = {
          ...input,
          operationId: randomUUID(),
          authorizeUrl: "https://relay.example.test/_relay/v3/account-browser/begin?ticket=opaque",
          redemptionSecret: "private-capability",
          issuedAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          relayOrigin: "https://relay.example.test",
          owner: {
            ownerAccountId: "a".repeat(64),
            gatewayId: randomUUID(),
            publicOrigin: "https://direct.example.test",
            ownerPublicKey: "synthetic",
            tlsSpkiFingerprint: "a".repeat(64),
          },
        }),
      ),
    redeem: async (pending) => ({
      identity: { issuer, subject, expiresAt: 4_000_000_000 },
      identityToken: await new SignJWT({ nonce: pending.nonce })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setSubject(subject)
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key),
    }),
  };
  const unused = () => Promise.reject(new Error("Unused management operation"));
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
    cloudRelayManagement: {
      status: unused,
      configure: unused,
      enable: unused,
      disable: unused,
      reconnect: unused,
      renew: unused,
      accountModeActivated: () => true,
      accountPairingIdentity: () =>
        linked
          ? {
              identity,
              ownerAccountId,
              configurationKey: "neutral-account",
              enrollment: {
                policy: () => "ask",
                spkiFingerprint: () => undefined,
                challenges: new EnrollmentChallenges(),
                verifyProof: async () => undefined,
                canTrust: async () => false,
                trustSignIn: async () => {},
              },
            }
          : undefined,
      managedAccountBrowser: () => broker,
    },
  });
  const config = await (
    await server.request("https://direct.example.test/devices/google/config")
  ).json();
  expect(config).toMatchObject({
    accountSignIn: true,
    webSignIn: true,
    authorizationRelayOrigin: "https://relay.example.test",
  });
  const value = {
    requestId: randomUUID(),
    name: "Fictional account browser",
    secret: randomBytes(32).toString("hex"),
  };
  const authorize = (base: string) =>
    server.request(`https://direct.example.test/devices/${base}/authorize`, {
      method: "POST",
      headers: { Origin: "https://direct.example.test", "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  expect((await authorize("google")).status).toBe(404);
  const start = await authorize("account");
  expect(start.status).toBe(200);
  expect(start.headers.get("set-cookie")).toContain("__Host-omnesis-account-login=");
  expect(start.headers.get("set-cookie")).toContain("Path=/;");
  const mismatched = await server.request("https://direct.example.test/devices/google/callback");
  expect(mismatched.headers.get("location")).toBe("/portal/?googlePairing=failed");
  const callbackUrl = `https://direct.example.test/devices/account/callback?operationId=${operation!.operationId}&state=${operation!.browserState}&result=${"r".repeat(43)}`;
  const callback = await server.request(callbackUrl, {
    headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`/portal/?googlePairing=${value.requestId}`);
  expect(
    (
      await post(server, "/devices/account/poll", {
        requestId: value.requestId,
        secret: value.secret,
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await post(server, "/devices/account/poll", {
        requestId: value.requestId,
        secret: value.secret,
      })
    ).json(),
  ).toMatchObject({ status: "pending" });
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: value.requestId, approve: true },
        reader,
      )
    ).status,
  ).toBe(403);
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
  expect(
    await (
      await post(server, "/devices/account/poll", {
        requestId: value.requestId,
        secret: value.secret,
      })
    ).json(),
  ).toMatchObject({ status: "approved" });
  linked = false;
  expect((await server.request("/devices/account/config")).status).toBe(404);
  expect((await server.request("/devices/google/config")).status).toBe(404);
});

test("a verified public enrollment reaches the notification hook through the gateway runtime exactly once", async () => {
  const onCloudPairingRequest = vi.fn();
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
    onCloudPairingRequest,
  });
  const value = await request();
  expect((await submit(server, value)).status).toBe(200);
  expect((await submit(server, value)).status).toBe(200);
  expect(onCloudPairingRequest).toHaveBeenCalledOnce();
  expect(onCloudPairingRequest.mock.calls[0]![0]).toMatchObject({ requestId: value.requestId });
});

test("verified enrollment delivers a private reminder only to an updated administrator, without minting a device grant", async () => {
  const updated = createDevice(db, {
    name: "Fictional updated phone",
    kind: "ios",
    capabilities: { pairingNotifications: true },
  });
  const ordinary = createDevice(db, {
    name: "Fictional ordinary phone",
    kind: "ios",
    capabilities: { pairingNotifications: true },
  });
  const legacy = createDevice(db, { name: "Fictional legacy phone", kind: "ios" });
  const administrator = createToken(db, updated.id, [SCOPE_ADMIN, SCOPE_PUSH_CLAIM]).token;
  const readOnly = createToken(db, ordinary.id, [SCOPE_READ, SCOPE_PUSH_CLAIM]).token;
  const older = createToken(db, legacy.id, [SCOPE_ADMIN, SCOPE_PUSH_CLAIM]).token;
  const devices = () =>
    listDevices(db).map((device) => ({ ...device, pushTransport: "socket" as const }));
  const wake = vi.fn(() => true);
  const publisher = new PushBroadcaster({
    queue: {
      enqueueNotification: async (input) => enqueueNotification(db, input),
      leaseNotificationWakes: async (input) => leaseNotificationWakes(db, input),
      settleNotificationWake: async (input) => settleNotificationWake(db, input),
    },
    listDevices: devices,
    apnsClient: null,
    fcmClient: null,
    relayClient: { wake: vi.fn() },
    socket: { isConnected: () => true, sendEventToDevice: wake },
  });
  const notifier = new PairingNotifier(publisher, devices, () =>
    listDeviceIdsWithActiveScope(db, SCOPE_ADMIN),
  );
  let notified = Promise.resolve();
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
    onCloudPairingRequest: (value) => {
      notified = notifier.notify(value);
    },
  });
  const before = db.prepare("SELECT COUNT(*) AS count FROM tokens").get();
  const value = await request();
  const response = await submit(server, value);
  expect(await response.json()).toMatchObject({ status: "pending" });
  await notified;
  expect(wake).toHaveBeenCalledExactlyOnceWith(
    updated.id,
    expect.objectContaining({ type: "push.available", payload: {} }),
  );
  const claim = await server.request("/notifications/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${administrator}`,
      "X-Omnesis-Pairing-Notifications": "1",
    },
    body: "{}",
  });
  expect(claim.status).toBe(200);
  const content = await claim.json();
  expect(content).toMatchObject({
    kind: "device-pairing",
    targetId: "pairing",
    route: { kind: "device-pairing" },
  });
  expect(JSON.stringify(content)).not.toContain(value.secret);
  expect(JSON.stringify(content)).not.toContain(value.name);
  expect(
    (await post(server, "/notifications/confirm", { id: content.id }, administrator)).status,
  ).toBe(200);
  const another = await request();
  expect((await submit(server, another)).status).toBe(200);
  await notified;
  // A downgraded app can claim before sending another hello. The header, not stale registry metadata, gates new kinds.
  expect((await post(server, "/notifications/claim", {}, administrator)).status).toBe(204);
  expect((await post(server, "/notifications/claim", {}, readOnly)).status).toBe(204);
  expect((await post(server, "/notifications/claim", {}, older)).status).toBe(204);
  expect(db.prepare("SELECT COUNT(*) AS count FROM tokens").get()).toEqual(before);
  const stillPending = await post(server, "/devices/google/poll", {
    requestId: value.requestId,
    secret: value.secret,
  });
  expect(await stillPending.json()).toMatchObject({ status: "pending" });
});

function enrollmentServer(options: {
  trusted: boolean;
  spki?: string | undefined;
  gatewayPasskey?: { rpId: string; origin: string };
}) {
  const spki = "spki" in options ? options.spki : "c".repeat(64);
  const signIn: VerifiedSignIn = {
    type: "google",
    id: "fictional-sign-in",
    trusted: options.trusted,
    channel: "web-google",
    pin: { id: "fictional-sign-in" } as VerifiedSignIn["pin"],
  };
  const enrollment: GatewayEnrollment = {
    policy: () => "automatic",
    spkiFingerprint: () => spki,
    challenges: new EnrollmentChallenges(),
    verifyProof: vi.fn(async () => signIn),
    canTrust: vi.fn(async (value: VerifiedSignIn) => !value.trusted),
    trustSignIn: vi.fn(async () => {}),
    verifyGatewayPasskey: vi.fn(async () => signIn),
    gatewayPasskey: () => options.gatewayPasskey,
  };
  const unused = () => Promise.reject(new Error("Unused management operation"));
  const server = createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudIdentity: { identity, ownerAccountId },
    cloudTlsSpkiFingerprintSha256: () => spki,
    cloudRelayManagement: {
      status: unused,
      configure: unused,
      enable: unused,
      disable: unused,
      reconnect: unused,
      renew: unused,
      accountModeActivated: () => true,
      accountPairingIdentity: () => ({
        identity,
        ownerAccountId,
        configurationKey: "neutral-account",
        enrollment,
      }),
    },
  });
  return { server, enrollment, spki: spki ?? "" };
}
async function signedRequest(
  server: ReturnType<typeof app>,
  spki: string,
  extra: Record<string, unknown> = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const devicePublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const challenged = await post(server, "/devices/account/challenge", {});
  expect(challenged.status).toBe(200);
  expect(challenged.headers.get("cache-control")).toBe("no-store");
  const { challenge } = (await challenged.json()) as { challenge: string };
  const fields = {
    requestId: randomUUID(),
    kind: "ios" as const,
    name: "Fictional phone",
    secret: randomBytes(32).toString("hex"),
  };
  const signature = signDeviceTranscript(
    privateKey,
    enrollmentSignatureTranscript({
      ...fields,
      gatewaySpkiFingerprint: spki,
      challenge,
      devicePublicKey,
    }),
  );
  const identityToken = await new SignJWT({
    nonce: enrollmentNonce({ ...fields, devicePublicKey }),
  })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
  const body = {
    ...fields,
    identityToken,
    deviceKey: { publicKey: devicePublicKey, challenge, signature },
    proof: { type: "google", idToken: "header.payload.signature", salt: "s".repeat(43) },
    ...extra,
  };
  return { body, response: await post(server, "/devices/account/request", body) };
}

test("account config advertises automatic enrollment with the gateway SPKI only when both are available", async () => {
  const { server, spki } = enrollmentServer({ trusted: true });
  expect(await (await server.request("/devices/account/config")).json()).toMatchObject({
    accountSignIn: true,
    automaticEnrollment: true,
    gatewaySpkiFingerprint: spki,
  });
  const withoutSpki = enrollmentServer({ trusted: true, spki: undefined }).server;
  const config = await (await withoutSpki.request("/devices/account/config")).json();
  expect(config).toMatchObject({ accountSignIn: true });
  expect(config).not.toHaveProperty("automaticEnrollment");
  expect(config).not.toHaveProperty("gatewaySpkiFingerprint");
});

test("a gateway with an origin of its own advertises passkey sign-in there and hands out its ceremony", async () => {
  const where = { rpId: "relay.example.test", origin: "https://g-abcdefgh.relay.example.test" };
  const { server, spki } = enrollmentServer({ trusted: true, gatewayPasskey: where });
  expect(await (await server.request("/devices/account/config")).json()).toMatchObject({
    gatewayPasskey: where,
  });
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fields = {
    requestId: randomUUID(),
    kind: "portal",
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
    devicePublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
  const options = await post(server, "/devices/account/passkey/options", fields);
  expect(options.status).toBe(200);
  expect(options.headers.get("cache-control")).toBe("no-store");
  const ceremony = await options.json();
  expect(ceremony).toMatchObject({
    purpose: "device-enrollment",
    ...where,
    challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    binding: enrollmentNonce(fields as Parameters<typeof enrollmentNonce>[0]),
  });
  for (const body of [{}, { ...fields, extra: true }, { ...fields, devicePublicKey: "short" }])
    expect((await post(server, "/devices/account/passkey/options", body)).status).toBe(400);
  // Google-only pairing routes have no such ceremony.
  expect((await post(server, "/devices/google/passkey/options", fields)).status).toBe(404);
  // It spends the same allowance as the gateway's other pairing calls.
  for (let index = 1; index < 10; index++)
    expect((await post(server, "/devices/account/passkey/options", fields)).status).toBe(200);
  expect((await post(server, "/devices/account/passkey/options", fields)).status).toBe(429);
  // Without an origin of its own, none is offered.
  const plain = enrollmentServer({ trusted: true }).server;
  expect(await (await plain.request("/devices/account/config")).json()).not.toHaveProperty(
    "gatewayPasskey",
  );
  expect((await post(plain, "/devices/account/passkey/options", fields)).status).toBe(404);
  void spki;
});

test("a trusted sign-in with a signed device key joins at once; the challenge is one-use", async () => {
  const { server, enrollment, spki } = enrollmentServer({ trusted: true });
  const { body, response } = await signedRequest(server, spki);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "approved",
    pairingCode: expect.any(String),
  });
  expect(enrollment.verifyProof).toHaveBeenCalledOnce();
  // A replayed challenge is refused outright.
  const replay = await post(server, "/devices/account/request", {
    ...body,
    requestId: randomUUID(),
  });
  expect(replay.status).toBe(409);
  // requireApproval holds even a trusted sign-in for a person.
  const held = await signedRequest(server, spki, { requireApproval: true });
  expect(await held.response.json()).toMatchObject({ status: "pending" });
});

test("an untrusted sign-in is held, listed as trustable, and approving with trustSignIn pins it", async () => {
  const { server, enrollment, spki } = enrollmentServer({ trusted: false });
  const { body, response } = await signedRequest(server, spki);
  expect(await response.json()).toMatchObject({ status: "pending" });
  const listed = await (
    await server.request("/admin/cloud-pairing/requests", {
      headers: { authorization: `Bearer ${admin}` },
    })
  ).json();
  expect(listed.items).toEqual([
    expect.objectContaining({ requestId: body.requestId, signIn: "google", canTrustSignIn: true }),
  ]);
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: body.requestId, approve: true, trustSignIn: "yes" },
        admin,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: body.requestId, approve: true, trustSignIn: true },
        admin,
      )
    ).status,
  ).toBe(200);
  expect(enrollment.trustSignIn).toHaveBeenCalledOnce();
  const second = await signedRequest(server, spki);
  expect(
    (
      await post(
        server,
        "/admin/cloud-pairing/decision",
        { requestId: second.body.requestId, approve: true, trustSignIn: false },
        admin,
      )
    ).status,
  ).toBe(200);
  expect(enrollment.trustSignIn).toHaveBeenCalledOnce();
});

test("every pairing route issues challenges, and they share the pairing burst limit", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // A locally configured Google identity has no sign-in enrollment; its requests still answer a challenge.
  const server = app();
  const seen = new Set<string>();
  for (let index = 0; index < 10; index++) {
    const response = await post(
      server,
      index % 2 ? "/devices/account/challenge" : "/devices/google/challenge",
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { challenge: string; expiresAt: number };
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(body).sort()).toEqual(["challenge", "expiresAt"]);
    seen.add(body.challenge);
  }
  expect(seen.size).toBe(10);
  expect((await post(server, "/devices/google/challenge", {})).status).toBe(429);
  expect((await post(server, "/devices/google/request", await request())).status).toBe(429);
});

test("a request without the gateway's challenge is refused, and the code shown to the approver is the one the device derives", async () => {
  const server = app();
  const value = await request();
  expect((await post(server, "/devices/google/request", value)).status).toBe(409);
  const { challenge } = (await (await post(server, "/devices/google/challenge", {})).json()) as {
    challenge: string;
  };
  const response = await post(server, "/devices/google/request", { ...value, challenge });
  expect(response.status).toBe(200);
  const reply = (await response.json()) as { verificationCode: string; codeNonce: string };
  const { pairingCodeCommitment, pairingComparisonCode } = await import("@omnesis/cloud-relay");
  // The device checks the revealed nonce against the challenge it was given first.
  expect(pairingCodeCommitment(reply.codeNonce)).toBe(challenge);
  const derived = pairingComparisonCode({
    ...value,
    gatewayFingerprint: "a".repeat(64),
    codeNonce: reply.codeNonce,
  });
  expect(derived).toMatch(/^[0-9]{3} [0-9]{3}$/);
  expect(reply.verificationCode).toBe(derived);
  const listed = (await (
    await server.request("/admin/cloud-pairing/requests", {
      headers: { authorization: `Bearer ${admin}` },
    })
  ).json()) as { items: Array<Record<string, unknown>> };
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toMatchObject({ requestId: value.requestId, verificationCode: derived });
  expect(listed.items[0]).not.toHaveProperty("codeNonce");
  // The spent challenge cannot be answered by another request.
  expect(
    (await post(server, "/devices/google/request", { ...(await request()), challenge })).status,
  ).toBe(409);
});
