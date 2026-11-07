// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { GatewayGoogleWeb } from "./google-gateway-web.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { accountId } from "./identity.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gateway-web-google-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
const callback = "https://gateway.example.test/admin/cloud-relay/google/callback";
async function fixture(patch: NodeJS.ProcessEnv = {}) {
  const tls = tlsFiles(directory, "gateway.example.test"),
    secretFile = join(directory, "google-web.json"),
    metadataFile = join(directory, "link.json");
  await writeFile(
    secretFile,
    JSON.stringify({
      web: {
        client_id: "dedicated-gateway-web",
        client_secret: "private-backend-only-secret",
        redirect_uris: [callback],
      },
    }),
  );
  const env = {
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: "dedicated-gateway-web",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: secretFile,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL: callback,
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session"),
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: join(directory, "owner"),
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: join(directory, "credentials"),
    OMNESIS_TLS_CERT: tls.certFile,
    OMNESIS_TLS_KEY: tls.keyFile,
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    ...patch,
  };
  const identity = {
    issuer: "https://accounts.google.com",
    subject: "fixture-owner",
    expiresAt: 4000000000,
  };
  const nonce = gatewayBindingNonce({
    gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
    publicOrigin: env.OMNESIS_PUBLIC_BASE_URL,
    certificate: await readFile(tls.certFile, "utf8"),
  });
  const verify = vi.fn(async (_token: string, expected?: string) => {
    expect(expected).toBe(nonce);
    return identity;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).includes("oauth2.googleapis.com")
      ? Response.json({
          token_type: "Bearer",
          id_token: "private-fresh-id-token",
          refresh_token: "not-retained",
        })
      : new Response(null, { status: 204 }),
  );
  const register = vi.fn(async () => ({
    token: "owner-test-session",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  }));
  const options = { env: () => env, metadataFile, identity: { verify }, fetch, register };
  const service = new GatewayGoogleWeb(options);
  await service.initialize();
  return { service, env, identity, verify, fetch, register, metadataFile, secretFile, options };
}
function response(start: { authorizeUrl: string; cookie: string }) {
  const state = new URL(start.authorizeUrl).searchParams.get("state")!;
  return {
    url: `${callback}?state=${state}&code=fixture-code`,
    cookie: start.cookie.split(";")[0],
  };
}
test("dedicated browser PKCE link binds Google token to current TLS and stores only verified owner metadata", async () => {
  const f = await fixture();
  expect(f.service.status()).toMatchObject({
    configured: true,
    linked: false,
    linkOrigin: "https://gateway.example.test",
  });
  const ordinaryCredentials = JSON.stringify({
    clientId: "ordinary-desktop",
    refreshToken: "private-ordinary-refresh",
  });
  await writeFile(f.env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE, ordinaryCredentials);
  const start = await f.service.start({ requestOrigin: "https://gateway.example.test" }),
    url = new URL(start.authorizeUrl);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  expect(JSON.stringify(start)).not.toContain("private-backend");
  expect(await f.service.callback(response(start))).toMatchObject({
    redirectUrl: "https://gateway.example.test/portal/settings/relay",
    cookie: expect.stringContaining("Max-Age=0"),
  });
  expect(f.service.status().linked).toBe(true);
  expect(f.service.verifiedOwnerAccountId()).toBe(accountId(f.identity));
  expect(f.fetch).toHaveBeenLastCalledWith(
    new URL("https://relay.example.test/_relay/v2/key/google-link"),
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer owner-test-session" }),
      body: JSON.stringify({ identityToken: "private-fresh-id-token" }),
    }),
  );
  expect(await readFile(f.metadataFile, "utf8")).not.toMatch(/id-token|private-|not-retained/);
  expect(await readFile(f.env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE, "utf8")).toBe(
    ordinaryCredentials,
  );
  const restored = new GatewayGoogleWeb(f.options);
  await restored.initialize();
  expect(restored.status().linked).toBe(true);
  await restored.unlink();
  expect(restored.status().linked).toBe(false);
  expect(restored.verifiedOwnerAccountId()).toBe(accountId(f.identity));
  expect(f.fetch).toHaveBeenLastCalledWith(
    expect.any(URL),
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(JSON.stringify(restored.status())).not.toMatch(/private-|token|\.json/);
});
test("optional and malformed Google setup never prevents independent relay management", async () => {
  for (const env of [{}, { OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: "partial" }]) {
    const service = new GatewayGoogleWeb({
      env: () => env,
      metadataFile: join(directory, "absent"),
    });
    await service.initialize();
    expect(service.status().configured).toBe(false);
    await expect(
      service.start({ requestOrigin: "https://gateway.example.test" }),
    ).rejects.toMatchObject({ code: "google-unavailable" });
    await expect(service.callback({ url: callback })).rejects.toMatchObject({
      code: "google-unavailable",
    });
  }
  for (const patch of [
    { OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL: "https://gateway.example.test/wrong" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL: callback + "?x=1" },
    { OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "dedicated-gateway-web" },
  ]) {
    const f = await fixture(patch);
    expect(f.service.status()).toMatchObject({
      configured: false,
      lastError: "google-unavailable",
    });
  }
  const f = await fixture();
  await writeFile(
    f.secretFile,
    JSON.stringify({
      web: { client_id: "dedicated-gateway-web", client_secret: "x", redirect_uris: [] },
    }),
  );
  await f.service.initialize();
  expect(f.service.status().configured).toBe(false);
  await writeFile(f.secretFile, "malformed");
  await f.service.initialize();
  expect(f.service.status().configured).toBe(false);
});
test("wrong initiating origin, cookie ambiguity, state replay, stale certificate and expired authorization cannot link", async () => {
  const f = await fixture();
  await expect(
    f.service.start({ requestOrigin: "https://direct.example.test" }),
  ).rejects.toMatchObject({ code: "google-unavailable" });
  for (const patch of [
    { cookie: undefined },
    { cookie: "unrelated=x" },
    { url: callback + "?state=a&state=b&code=c" },
    { url: "x".repeat(16385) },
  ]) {
    const start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
    await f.service.callback({ ...response(start), ...patch });
    expect(f.service.status().lastError).toBe("google-link-failed");
  }
  const start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  const info = response(start);
  await f.service.callback({ ...info, cookie: `${info.cookie};${info.cookie}` });
  expect(f.register).not.toHaveBeenCalled();
  await f.service.callback(info);
  expect(f.register).toHaveBeenCalledOnce();
  await f.service.callback(info);
  expect(f.register).toHaveBeenCalledOnce();
  const rotating = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  tlsFiles(directory, "gateway.example.test");
  await f.service.callback(response(rotating));
  expect(f.register).toHaveBeenCalledOnce();
  const expired = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
  await f.service.callback(response(expired));
  clock.mockRestore();
  expect(f.register).toHaveBeenCalledOnce();
});
test("bounded admission reserves slots before certificate reads and expired pending authorizations release capacity", async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      f.service.start({ requestOrigin: "https://gateway.example.test" }),
    ),
  );
  expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(16);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
  await expect(
    f.service.start({ requestOrigin: "https://gateway.example.test" }),
  ).resolves.toHaveProperty("authorizeUrl");
  clock.mockRestore();
  f.service.cancel();
  await expect(
    f.service.start({ requestOrigin: "https://gateway.example.test" }),
  ).resolves.toHaveProperty("authorizeUrl");
});
test("cancel aborts in-flight token exchange and unlink cannot race a callback alias mutation", async () => {
  const f = await fixture(),
    start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  let release!: () => void, signal: AbortSignal | undefined;
  f.fetch.mockImplementationOnce(async (_url, init) => {
    signal = init!.signal!;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({ token_type: "Bearer", id_token: "private-fresh-id-token" });
  });
  const operation = f.service.callback(response(start));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(f.service.unlink()).rejects.toMatchObject({ code: "operation-in-progress" });
  await expect(f.service.callback(response(start))).rejects.toMatchObject({
    code: "operation-in-progress",
  });
  f.service.cancel();
  expect(signal!.aborted).toBe(true);
  release();
  await operation;
  expect(f.register).not.toHaveBeenCalled();
  expect(f.service.status().linked).toBe(false);
});
test("remote refusal, changed TLS during Google exchange and persistence errors remain sanitized", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => {
    tlsFiles(directory, "gateway.example.test");
    return Response.json({ token_type: "Bearer", id_token: "private-fresh-id-token" });
  });
  const start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  await f.service.callback(response(start));
  expect(f.register).not.toHaveBeenCalled();
  f.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(f.service.unlink()).rejects.toMatchObject({ code: "google-link-failed" });
  expect(f.service.status().lastError).toBe("google-link-failed");
  const g = await fixture({ OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: undefined });
  const fresh = await g.service.start({ requestOrigin: "https://gateway.example.test" });
  vi.stubGlobal("fetch", g.fetch);
  const noFetch = new GatewayGoogleWeb({ ...g.options, fetch: undefined });
  await noFetch.initialize();
  const operation = await noFetch.start({ requestOrigin: "https://gateway.example.test" });
  await noFetch.callback(response(operation));
  expect(noFetch.status().linked).toBe(true);
  await writeFile(g.metadataFile, "invalid");
  await g.service.initialize();
  expect(g.service.status().configured).toBe(false);
  expect(fresh).toHaveProperty("cookie");
});
test("default verifier and raw owner registration stay optional and fail closed without configured private ownership", async () => {
  const f = await fixture();
  const service = new GatewayGoogleWeb({ ...f.options, identity: undefined, register: undefined });
  await service.initialize();
  expect(service.status().configured).toBe(true);
  await expect(service.unlink()).rejects.toMatchObject({ code: "google-link-failed" });
});

test("previously verified discovery can be removed after Google web configuration is disabled", async () => {
  const f = await fixture();
  await writeFile(
    f.metadataFile,
    JSON.stringify({ linked: true, accountId: accountId(f.identity) }),
  );
  const service = new GatewayGoogleWeb({
    ...f.options,
    env: () => ({
      ...f.env,
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL: undefined,
    }),
  });
  await service.initialize();
  expect(service.status()).toMatchObject({
    configured: false,
    linked: true,
    canLink: false,
    canUnlink: true,
  });
  expect(service.verifiedOwnerAccountId()).toBe(accountId(f.identity));
  await service.unlink();
  expect(service.status().linked).toBe(false);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ method: "DELETE" }),
  );
});

async function managedFixture() {
  const f = await fixture({
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "managed-owner-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "managed-device-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "managed-device-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "managed-device-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: undefined,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: undefined,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL: undefined,
  });
  const { generateKeyPairSync } = await import("node:crypto");
  const { SignJWT } = await import("jose");
  await writeFile(
    f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  let latest: { nonce: string; operationId: string; expiresAt: number; browserState: string };
  f.fetch.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/config"))
      return Response.json({
        protocol: "omnesis-google-browser-v1",
        ownerLinkClientId: "managed-owner-client",
        deviceEnrollmentClientId: "managed-device-client",
        deviceClientIds: ["managed-device-client"],
        deviceAuthorizedParties: ["managed-device-client"],
      });
    if (path.endsWith("/start")) {
      latest = JSON.parse(String(init!.body));
      return Response.json({
        protocol: "omnesis-google-browser-v1",
        operationId: latest.operationId,
        expiresAt: latest.expiresAt,
        clientId: "managed-owner-client",
        authorizeUrl: "https://relay.example.test/_relay/v2/google/browser/begin?ticket=opaque",
      });
    }
    if (path.endsWith("/redeem"))
      return Response.json({
        clientId: "managed-owner-client",
        idToken: await new SignJWT({ nonce: latest.nonce })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(f.identity.subject)
          .setIssuer(f.identity.issuer)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(new Uint8Array(32)),
      });
    return new Response(null, { status: 204 });
  });
  await f.service.refreshManaged();
  return {
    ...f,
    callback(start: { cookie: string }, origin = "https://gateway.example.test") {
      const state = start.cookie.split(";")[0]!.split("=")[1];
      return {
        url: `${origin}/admin/cloud-relay/google/callback?state=${state}&brokerResult=${"r".repeat(43)}`,
        cookie: start.cookie,
      };
    },
  };
}
test("managed linking uses the installation broker without gateway OAuth secrets or another portal login", async () => {
  const f = await managedFixture();
  expect(f.service.status()).toMatchObject({ configured: true, canLink: true });
  expect(f.service.status().linkOrigin).toBeUndefined();
  expect(f.service.managedBrowser().deviceIdentity()?.clientIds).toEqual(["managed-device-client"]);
  const start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  expect(start.authorizeUrl).toContain("relay.example.test/_relay/v2/google/browser/begin");
  expect(start.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  const result = await f.service.callback(f.callback(start));
  expect(result.redirectUrl).toBe("https://gateway.example.test/portal/settings/relay");
  expect(f.service.status()).toMatchObject({ linked: true, lastError: undefined });
  expect(f.service.verifiedOwnerAccountId()).toBe(accountId(f.identity));
  expect(JSON.parse(await readFile(f.metadataFile, "utf8"))).toEqual({
    linked: true,
    accountId: accountId(f.identity),
  });
  expect(f.verify).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls.some(([url]) => String(url).includes("oauth2.googleapis.com"))).toBe(
    false,
  );
  await expect(f.service.callback(f.callback(start))).rejects.toMatchObject({
    code: "google-link-failed",
  });
  await f.service.unlink();
  expect(f.service.status().linked).toBe(false);
});
test("managed linking rejects cross-browser callbacks, substituted destinations, stale binding and canceled redemption", async () => {
  const f = await managedFixture();
  await expect(f.service.start({ requestOrigin: "https://evil.example.test" })).rejects.toThrow();
  const start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  await expect(f.service.callback({ ...f.callback(start), cookie: "" })).rejects.toMatchObject({
    code: "google-link-failed",
  });
  await expect(
    f.service.callback(f.callback(start, "https://evil.example.test")),
  ).rejects.toMatchObject({ code: "google-link-failed" });
  const changed = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  const old = f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID;
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = randomUUID();
  await f.service.callback(f.callback(changed));
  expect(f.service.status()).toMatchObject({ linked: false, lastError: "google-link-failed" });
  expect(f.verify).not.toHaveBeenCalled();
  f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = old;
  const late = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  let release!: () => void;
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/redeem"))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return transport(url, init);
  });
  const completing = f.service.callback(f.callback(late));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(f.service.unlink()).rejects.toMatchObject({ code: "operation-in-progress" });
  await expect(f.service.callback(f.callback(late))).rejects.toMatchObject({
    code: "operation-in-progress",
  });
  f.service.cancel();
  release();
  await completing;
  expect(f.service.status().linked).toBe(false);
  expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/google-link"))).toHaveLength(
    0,
  );
});

test("managed browser admission, expiry and optional-service failure remain bounded independently of local OAuth", async () => {
  const advanced = await fixture();
  await advanced.service.refreshManaged();
  expect(advanced.fetch).not.toHaveBeenCalled();
  const unavailable = new GatewayGoogleWeb({
    env: () => ({
      ...advanced.env,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "managed-owner-client",
    }),
    metadataFile: join(directory, "unconfigured-link"),
    fetch: vi.fn(async () => {
      throw new Error("Provider unavailable");
    }),
  });
  await unavailable.refreshManaged();
  expect(unavailable.status()).toMatchObject({
    configured: false,
    lastError: "google-unavailable",
  });
  const f = await managedFixture();
  for (let i = 0; i < 16; i++)
    await f.service.start({ requestOrigin: "https://gateway.example.test" });
  await expect(
    f.service.start({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "operation-in-progress" });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
  await expect(
    f.service.start({ requestOrigin: "https://gateway.example.test" }),
  ).resolves.toHaveProperty("authorizeUrl");
  await expect(f.service.callback({ url: "x".repeat(16_385) })).rejects.toMatchObject({
    code: "google-link-failed",
  });
  await expect(f.service.callback({ url: callback })).rejects.toMatchObject({
    code: "google-link-failed",
  });
});
test("a binding changed while managed Google proof was being redeemed cannot update the directory", async () => {
  const f = await managedFixture();
  const start = await f.service.start({ requestOrigin: "https://gateway.example.test" });
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const response = await transport(url, init);
    if (String(url).endsWith("/redeem")) f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID = randomUUID();
    return response;
  });
  await f.service.callback(f.callback(start));
  expect(f.service.status()).toMatchObject({ linked: false, lastError: "google-link-failed" });
  expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith("/google-link"))).toBe(false);
});
