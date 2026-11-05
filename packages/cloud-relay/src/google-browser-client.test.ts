// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHash,
  verify,
  X509Certificate,
} from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { ManagedGoogleBrowser } from "./google-browser-client.js";
import { googleBrowserStartTranscript } from "./google-browser-contract.js";
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "google-browser-client-"));
  directories.push(directory);
  const owner = generateKeyPairSync("ed25519"),
    ownerPath = join(directory, "owner.key");
  await writeFile(ownerPath, owner.privateKey.export({ type: "pkcs8", format: "pem" }));
  const tls = tlsFiles(directory, "direct.example.test");
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerPath,
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
    OMNESIS_PUBLIC_BASE_URL: "https://direct.example.test",
    OMNESIS_TLS_CERT: tls.certFile,
    OMNESIS_TLS_KEY: tls.keyFile,
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "owner-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "device-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "android-presenter",
  };
  let start: any,
    issuedAt: number | undefined,
    fail = "",
    calls = 0;
  const tokenKey = randomBytes(32);
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    calls++;
    const path = new URL(String(url)).pathname;
    if (fail === path) return new Response("refused", { status: 403 });
    if (path.endsWith("config"))
      return Response.json({
        protocol: "omnesis-google-browser-v1",
        ownerLinkClientId: "owner-client",
        deviceEnrollmentClientId: "device-client",
        deviceClientIds: ["device-client"],
        deviceAuthorizedParties: ["device-client", "android-presenter"],
      });
    if (path.endsWith("start")) {
      start = JSON.parse(String(init!.body));
      return Response.json({
        protocol: start.protocol,
        operationId: start.operationId,
        authorizeUrl: "https://relay.example.test/_relay/v2/google/browser/begin?ticket=opaque",
        expiresAt: start.expiresAt,
        clientId: start.purpose === "owner-link" ? "owner-client" : "device-client",
      });
    }
    return Response.json({
      clientId: "device-client",
      idToken: await new SignJWT({ nonce: start.nonce })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("https://accounts.google.com")
        .setSubject("fictional-owner")
        .setAudience("device-client")
        .setIssuedAt(issuedAt ?? start.issuedAt)
        .setExpirationTime("5m")
        .sign(tokenKey),
    });
  });
  const register = vi.fn(async () => ({
    token: "owner-test-session",
    accountId: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
  }));
  const options = {
    env: (): NodeJS.ProcessEnv => env,
    fetch: transport,
    register,
    callbackOrigins: () => ({ origins: [env.OMNESIS_PUBLIC_BASE_URL] }),
    identity: (audience: string) => ({
      verify: async (token: string, nonce?: string) => {
        const { payload } = await jwtVerify(token, tokenKey, {
          audience,
          issuer: "https://accounts.google.com",
        });
        if (payload.nonce !== nonce) throw new Error("nonce refused");
        return { issuer: payload.iss!, subject: payload.sub!, expiresAt: payload.exp! };
      },
    }),
  };
  const client = new ManagedGoogleBrowser(options);
  return {
    client,
    options,
    env,
    owner,
    transport,
    register,
    get start() {
      return start;
    },
    set issuedAt(value: number) {
      issuedAt = value;
    },
    set fail(value: string) {
      fail = value;
    },
    get calls() {
      return calls;
    },
  };
}
const input = {
  purpose: "device-enrollment" as const,
  nonce: "n".repeat(43),
  callbackUrl: "https://direct.example.test/devices/google/callback",
  browserState: "s".repeat(43),
};
test("managed OAuth signs the full operation while only a secret hash leaves the gateway, then verifies the original Google JWT", async () => {
  const f = await fixture();
  expect(f.client.clientId("device-enrollment")).toBeUndefined();
  await Promise.all([f.client.refresh(), f.client.refresh()]);
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.client.clientId("owner-link")).toBe("owner-client");
  expect(f.client.deviceIdentity()).toEqual({
    clientIds: ["device-client"],
    authorizedParties: ["device-client", "android-presenter"],
  });
  expect(await f.client.callbackUrl("https://direct.example.test", "owner-link")).toContain(
    "/admin/cloud-relay/google/callback",
  );
  expect(await f.client.callbackUrl("https://direct.example.test", "device-enrollment")).toBe(
    input.callbackUrl,
  );
  const pending = await f.client.begin(input);
  const { ownerSignature, ...unsigned } = f.start;
  expect(unsigned.redemptionSha256).toBe(
    createHash("sha256").update(pending.redemptionSecret).digest("hex"),
  );
  expect(JSON.stringify(unsigned)).not.toContain(pending.redemptionSecret);
  expect(
    verify(
      null,
      googleBrowserStartTranscript(
        {
          relayOrigin: f.env.OMNESIS_CLOUD_RELAY_URL,
          accountId: "a".repeat(64),
          gatewayId: f.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
          publicOrigin: f.env.OMNESIS_PUBLIC_BASE_URL,
          tlsSpkiFingerprint: tlsSpkiFingerprint(
            new X509Certificate(await readFile(f.env.OMNESIS_TLS_CERT)).raw,
          ),
        },
        unsigned,
      ),
      f.owner.publicKey,
      Buffer.from(ownerSignature, "base64url"),
    ),
  ).toBe(true);
  expect((await f.client.redeem(pending, "r".repeat(43))).identity.subject).toBe("fictional-owner");
  expect(f.transport.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  expect(f.register).toHaveBeenCalledTimes(2);
});
test("capability discovery is optional, bounded, refreshable and does not contact an unconfigured service", async () => {
  const transport = vi.fn<typeof fetch>();
  const off = new ManagedGoogleBrowser({ env: () => ({}), fetch: transport });
  await off.refresh();
  expect(transport).not.toHaveBeenCalled();
  expect(off.deviceIdentity()).toBeUndefined();
  const f = await fixture();
  for (const status of [404, 503]) {
    f.transport.mockResolvedValueOnce(new Response(null, { status }));
    await f.client.refresh();
    expect(f.client.deviceIdentity()).toBeUndefined();
    await expect(f.client.begin(input)).rejects.toThrow("unavailable");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
  }
  f.transport.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(f.client.refresh()).rejects.toThrow("unavailable");
  await f.client.refresh();
  expect(f.client.deviceIdentity()).toBeDefined();
});
test("refused responses, altered audience/destination and preexisting identity proofs never complete managed OAuth", async () => {
  const f = await fixture();
  await f.client.refresh();
  f.fail = "/_relay/v2/google/browser/start";
  await expect(f.client.begin(input)).rejects.toThrow("refused");
  f.fail = "";
  for (const url of [
    "https://evil.example.test/_relay/v2/google/browser/begin",
    "https://relay.example.test/wrong",
    "https://relay.example.test/_relay/v2/google/browser/begin#secret",
  ]) {
    f.transport.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      return Response.json({
        protocol: body.protocol,
        operationId: body.operationId,
        authorizeUrl: url,
        expiresAt: body.expiresAt,
        clientId: "device-client",
      });
    });
    await expect(f.client.begin(input)).rejects.toThrow();
  }
  const pending = await f.client.begin(input);
  f.fail = "/_relay/v2/google/browser/redeem";
  await expect(f.client.redeem(pending, "r".repeat(43))).rejects.toThrow("refused");
  f.fail = "";
  f.issuedAt = pending.issuedAt - 61;
  await expect(f.client.redeem(pending, "r".repeat(43))).rejects.toThrow("predates");
  const before = f.calls;
  await expect(f.client.redeem({ ...pending, expiresAt: 1 }, "r".repeat(43))).rejects.toThrow(
    "expired",
  );
  expect(f.calls).toBe(before);
  const abort = new AbortController();
  abort.abort();
  await expect(f.client.begin({ ...input, signal: abort.signal })).rejects.toThrow();
});

test("default local callback configuration, owner-key path and transport remain usable without optional adapters", async () => {
  const f = await fixture();
  const local = new ManagedGoogleBrowser({ ...f.options, callbackOrigins: undefined });
  expect(await local.callbackUrl("https://direct.example.test", "owner-link")).toContain(
    "/admin/cloud-relay/google/callback",
  );
  expect(await local.callbackUrl("https://localhost:7600", "device-enrollment")).toBe(
    "https://localhost:7600/devices/google/callback",
  );
  const cert = f.env.OMNESIS_TLS_CERT;
  const withoutCert = { ...f.env, OMNESIS_TLS_CERT: undefined, OMNESIS_GATEWAY_PORT: "443" };
  const configuredOnly = new ManagedGoogleBrowser({
    ...f.options,
    callbackOrigins: undefined,
    env: () => withoutCert,
  });
  expect(await configuredOnly.callbackUrl("https://direct.example.test", "device-enrollment")).toBe(
    input.callbackUrl,
  );
  await expect(configuredOnly.callbackUrl("https://localhost", "owner-link")).rejects.toThrow();
  expect(cert).toBeTruthy();
  vi.stubGlobal("fetch", f.transport);
  const defaultTransport = new ManagedGoogleBrowser({ ...f.options, fetch: undefined });
  const { copyFile } = await import("node:fs/promises");
  await copyFile(
    f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
    `${f.env.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`,
  );
  const originalOwner = f.env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE;
  f.options.env = () => ({ ...f.env, OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: undefined });
  const defaultOwner = new ManagedGoogleBrowser({ ...f.options, fetch: undefined });
  const signal = new AbortController().signal;
  await defaultTransport.refresh(signal);
  const pending = await defaultOwner.begin({ ...input, signal });
  expect((await defaultOwner.redeem(pending, "r".repeat(43), signal)).identity.subject).toBe(
    "fictional-owner",
  );
  expect(originalOwner).toBeTruthy();
});
test("a genuine Google-signed JWT is independently checked by the default verifier, and a late proof cannot outlive local state", async () => {
  const f = await fixture();
  const { generateKeyPair, exportJWK } = await import("jose");
  const keys = await generateKeyPair("RS256");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        keys: [
          { ...(await exportJWK(keys.publicKey)), kid: "fixture-google", alg: "RS256", use: "sig" },
        ],
      }),
    ),
  );
  const client = new ManagedGoogleBrowser({ ...f.options, identity: undefined });
  const pending = await client.begin(input);
  const token = await new SignJWT({ nonce: pending.nonce })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-google" })
    .setIssuer("https://accounts.google.com")
    .setSubject("fictional-owner")
    .setAudience(pending.clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  f.transport.mockResolvedValueOnce(Response.json({ idToken: token, clientId: pending.clientId }));
  expect((await client.redeem(pending, "r".repeat(43))).identity.subject).toBe("fictional-owner");
  const late = new ManagedGoogleBrowser({
    ...f.options,
    identity: (audience) => ({
      verify: async (proof, nonce) => {
        const verified = await f.options.identity(audience).verify(proof, nonce);
        vi.spyOn(Date, "now").mockReturnValue((pending.expiresAt + 1) * 1000);
        return verified;
      },
    }),
  });
  await expect(late.redeem(pending, "r".repeat(43))).rejects.toThrow("expired");
});

test("lifecycle cancellation rejects late operations even when an underlying transport ignores abort", async () => {
  const f = await fixture();
  await f.client.refresh();
  const original = f.transport.getMockImplementation()!;
  let release!: () => void;
  f.transport.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/start"))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(url, init);
  });
  const pending = f.client.begin(input);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.client.cancel();
  release();
  await expect(pending).rejects.toThrow();
  f.transport.mockImplementation(original);
  expect((await f.client.begin(input)).operationId).toMatch(/^[a-f0-9-]{36}$/);
});

test("a configured relay cannot enable managed sign-in or choose audiences without independent installation trust", async () => {
  const f = await fixture();
  const unpinned = {
    ...f.env,
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: undefined,
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: undefined,
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: undefined,
  };
  const off = new ManagedGoogleBrowser({ ...f.options, env: () => unpinned });
  await off.refresh();
  expect(off.clientId("owner-link")).toBeUndefined();
  expect(off.deviceIdentity()).toBeUndefined();
  await expect(off.begin(input)).rejects.toThrow("unavailable");
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  f.transport.mockResolvedValueOnce(
    Response.json({
      protocol: "omnesis-google-browser-v1",
      ownerLinkClientId: "attacker-owner",
      deviceEnrollmentClientId: "attacker-device",
      deviceClientIds: ["attacker-device"],
      deviceAuthorizedParties: ["attacker-device"],
    }),
  );
  await expect(f.client.refresh()).rejects.toThrow("trusted deployment audiences");
  expect(f.client.clientId("device-enrollment")).toBeUndefined();
  expect(f.register).not.toHaveBeenCalled();
});

test("native-only capability discovery stays constrained and tampered or stale pending audiences never redeem", async () => {
  const f = await fixture();
  const native = new ManagedGoogleBrowser({
    ...f.options,
    env: () => ({
      ...f.env,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "device-client",
    }),
  });
  f.transport.mockResolvedValueOnce(
    Response.json({
      protocol: "omnesis-google-browser-v1",
      deviceClientIds: ["device-client"],
      deviceAuthorizedParties: ["device-client"],
    }),
  );
  await native.refresh();
  expect(native.clientId("device-enrollment")).toBeUndefined();
  expect(native.deviceIdentity()).toEqual({
    clientIds: ["device-client"],
    authorizedParties: ["device-client"],
  });
  const pending = await f.client.begin(input);
  const calls = f.calls;
  for (const forged of [
    { ...pending, clientId: "attacker-client" },
    { ...pending, purpose: "owner-link" as const },
  ]) {
    await expect(f.client.redeem(forged, "r".repeat(43))).rejects.toThrow(
      "audience is not trusted",
    );
  }
  f.options.env = () => ({
    ...f.env,
    OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: undefined,
  });
  await expect(f.client.redeem(pending, "r".repeat(43))).rejects.toThrow("audience is not trusted");
  await expect(f.client.refresh()).rejects.toThrow("trusted deployment audiences");
  expect(f.calls).toBe(calls);
});
