// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { createServer, Server } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as core from "@omnesis/core";
import { fixture, echoGateway, localToken, tlsFiles } from "../test/support.js";
import { loginRelay, runRelayCommand, startRelayDaemon } from "./runtime.js";
import { readRelaySession, startGatewayCloudTunnel } from "./gateway-integration.js";
import { connectOrigin } from "./network.js";
import * as googleCommands from "./google-commands.js";
import * as relayIdentity from "./identity.js";
import { RelayAccounts } from "./accounts.js";

vi.mock("node:fs/promises", { spy: true });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-cloud-runtime-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([dir]);
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
});

test.each(["session", "mock-identity", "tls", "invitation", "identity-token"])(
  "Windows runtime refuses unsafe %s private input before opening state or sending credentials",
  async (kind) => {
    const env = await daemonEnv();
    delete env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    const tokenFile = join(dir, "identity-token");
    await writeFile(tokenFile, "invented-private-id-token");
    let deniedPath = env.OMNESIS_CLOUD_RELAY_KEY_FILE!;
    if (kind === "mock-identity") {
      env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE = join(dir, "mock-key");
      deniedPath = env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    } else if (kind === "tls") {
      const tls = tlsFiles(dir);
      env.OMNESIS_CLOUD_RELAY_TLS_CERT_FILE = tls.certFile;
      env.OMNESIS_CLOUD_RELAY_TLS_KEY_FILE = tls.keyFile;
      deniedPath = tls.keyFile;
    } else if (kind === "identity-token") {
      deniedPath = tokenFile;
    }
    const actual = await vi.importActual<typeof files>("node:fs/promises");
    const refused = Object.assign(new Error("Invented unsafe private input"), { code: "EPRIVATE" });
    const held = vi
      .spyOn(core, "readWindowsPrivateFile")
      .mockImplementation(async (path, limit) => {
        expect(limit).toBe(65_536);
        if (path === deniedPath) throw refused;
        return actual.readFile(path);
      });
    vi.mocked(files.readFile).mockImplementation((...args: Parameters<typeof files.readFile>) => {
      if (args[0] === deniedPath) throw new Error("Invented unprotected private read");
      return actual.readFile(...args);
    });
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      const operation =
        kind === "invitation"
          ? runRelayCommand("issue-invite", {
              ...env,
              OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: join(dir, "invitation.json"),
              OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
              OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
            })
          : kind === "identity-token"
            ? loginRelay({
                relayUrl: "https://relay.example.test",
                idTokenFile: tokenFile,
                sessionFile: join(dir, "login.json"),
              })
            : startRelayDaemon(env);
      await expect(operation).rejects.toBe(refused);
      expect(held).toHaveBeenCalledWith(deniedPath, 65_536);
      expect(transport).not.toHaveBeenCalled();
      await expect(actual.stat(env.OMNESIS_CLOUD_RELAY_DB!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(actual.stat(join(dir, "invitation.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(actual.stat(join(dir, "login.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      vi.unstubAllGlobals();
    }
  },
);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function grantPublicFixtureRead(path: string): Promise<void> {
  await core.execWindowsJob(join(process.env.SystemRoot!, "System32", "icacls.exe"), [
    path,
    "/grant",
    "*S-1-1-0:(R)",
    "/Q",
  ]);
}

test
  .skipIf(process.platform !== "win32")
  .each(["session", "mock-identity", "invitation", "identity-token"])(
  "Windows native reader refuses a public read grant on %s private input",
  async (kind) => {
    const env = await daemonEnv();
    const tokenFile = join(dir, "identity-token");
    await writeFile(tokenFile, "invented-private-id-token");
    const deniedPath =
      kind === "mock-identity"
        ? env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE!
        : kind === "identity-token"
          ? tokenFile
          : env.OMNESIS_CLOUD_RELAY_KEY_FILE!;
    const previous = await readFile(deniedPath);
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    try {
      await grantPublicFixtureRead(deniedPath);
      expect(core.inspectWindowsPrivatePathSync(deniedPath, "file").private).toBe(false);
      const operation =
        kind === "invitation"
          ? runRelayCommand("issue-invite", {
              ...env,
              OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: join(dir, "invitation.json"),
              OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
              OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
            })
          : kind === "identity-token"
            ? loginRelay({
                relayUrl: "https://relay.example.test",
                idTokenFile: tokenFile,
                sessionFile: join(dir, "login.json"),
              })
            : startRelayDaemon(env);
      await expect(operation).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(transport).not.toHaveBeenCalled();
      expect(await readFile(deniedPath)).toEqual(previous);
      await expect(files.stat(env.OMNESIS_CLOUD_RELAY_DB!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(files.stat(join(dir, "invitation.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(files.stat(join(dir, "login.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      core.ensurePrivateFileSync(deniedPath);
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows accepts a public relay certificate and refuses a public private-key file",
  async () => {
    const env = await daemonEnv();
    const tls = tlsFiles(dir);
    env.OMNESIS_CLOUD_RELAY_TLS_CERT_FILE = tls.certFile;
    env.OMNESIS_CLOUD_RELAY_TLS_KEY_FILE = tls.keyFile;
    let daemon: Awaited<ReturnType<typeof startRelayDaemon>> | undefined;
    try {
      await grantPublicFixtureRead(tls.certFile);
      expect(core.inspectWindowsPrivatePathSync(tls.certFile, "file").private).toBe(false);
      daemon = await startRelayDaemon(env);
      expect(daemon.url).toMatch(/^https:/);
      await daemon.close();
      daemon = undefined;
      const previous = await readFile(tls.keyFile, "utf8");
      await grantPublicFixtureRead(tls.keyFile);
      await expect(startRelayDaemon(env)).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(await readFile(tls.keyFile, "utf8")).toBe(previous);
    } finally {
      try {
        core.ensurePrivateFileSync(tls.keyFile);
      } finally {
        await daemon?.close();
      }
    }
  },
);

async function daemonEnv(): Promise<NodeJS.ProcessEnv> {
  const key = join(dir, "session-key");
  const mock = join(dir, "mock-key");
  await writeFile(key, randomBytes(32));
  await writeFile(mock, randomBytes(32));
  return {
    OMNESIS_CLOUD_RELAY_KEY_FILE: key,
    OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE: mock,
    OMNESIS_CLOUD_RELAY_DB: join(dir, "state", "accounts.sqlite"),
    OMNESIS_CLOUD_RELAY_PORT: "0",
  };
}

describe("local daemon and credential files", () => {
  test("routing accepts configured web, mobile and gateway Google audiences, including web-only and gateway-only setup", async () => {
    const env = await daemonEnv();
    delete env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "fictional-runtime-key", alg: "RS256" }],
    });
    const original = relayIdentity.googleIdentityProvider;
    vi.spyOn(relayIdentity, "googleIdentityProvider").mockImplementation(
      (audience, _keys, options) => original(audience, keys, options),
    );
    const signed = (audience: string, presenter = audience) =>
      new SignJWT({ azp: presenter })
        .setProtectedHeader({ alg: "RS256", kid: "fictional-runtime-key" })
        .setIssuer("https://accounts.google.com")
        .setSubject("fictional-routing-owner")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
    for (const configuration of [
      {
        OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-mobile, fictional-web",
        OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web",
        OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-desktop",
        OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID:
          "fictional-android, fictional-android-preview",
        accepted: ["fictional-mobile", "fictional-web", "fictional-desktop"],
      },
      { OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web", accepted: ["fictional-web"] },
      {
        OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-desktop",
        OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID:
          "fictional-android, fictional-android-preview",
        accepted: ["fictional-desktop"],
      },
    ]) {
      const { accepted, ...settings } = configuration;
      const daemon = await startRelayDaemon({
        ...env,
        ...settings,
        OMNESIS_CLOUD_RELAY_LEGACY_ROUTES: "1",
      });
      try {
        for (const audience of [...accepted, "fictional-untrusted-client"]) {
          const response = await fetch(`${daemon.url}/_relay/v1/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idToken: await signed(audience) }),
          });
          expect(response.status, audience).toBe(accepted.includes(audience) ? 200 : 401);
        }
        for (const presenter of [
          "fictional-android",
          "fictional-android-preview",
          "untrusted-native",
        ]) {
          const response = await fetch(`${daemon.url}/_relay/v1/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idToken: await signed(accepted[0]!, presenter) }),
          });
          const known =
            "OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID" in settings &&
            presenter !== "untrusted-native";
          expect(response.status, presenter).toBe(known ? 200 : 401);
        }
        const wrongAudience = await fetch(`${daemon.url}/_relay/v1/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken: await signed("fictional-android") }),
        });
        expect(wrongAudience.status).toBe(401);
      } finally {
        await daemon.close();
      }
    }
  });
  test("saved Google device files configure pinned transport while credentials stay with native callers", async () => {
    const f = await fixture();
    const gateway = await echoGateway();
    const file = join(dir, "paired-device.json");
    const value = {
      gatewayUrl: f.gatewayUrl,
      gatewayFingerprint: gateway.fingerprint,
      gatewayCertificate: gateway.certificate.replace(/\r?\n/g, "\r\n"),
      token: "fixture-token",
      deviceId: randomUUID(),
      kind: "cli",
      scopes: ["read"],
    };
    await writeFile(file, JSON.stringify(value));
    let client: Awaited<ReturnType<typeof runRelayCommand>>;
    try {
      await f.tunnel(gateway.url);
      client = await runRelayCommand("client", {
        OMNESIS_CLOUD_RELAY_DEVICE_FILE: file,
        OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
        OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1",
        OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP: "127.0.0.1",
      });
      const requestsBefore = gateway.requests.length;
      expect((await fetch(`${client!.url}/api/status`)).status).toBe(403);
      expect(
        (
          await fetch(`${client!.url}/api/status`, {
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(403);
      expect(gateway.requests.length).toBe(requestsBefore);
      expect(
        await (
          await fetch(`${client!.url}/api/status`, {
            headers: { authorization: "Bearer fixture-token" },
          })
        ).json(),
      ).toMatchObject({ authorization: "Bearer fixture-token" });
      expect(JSON.stringify(gateway.requests)).not.toContain("another-gateway-token");
    } finally {
      if (client) await client.close();
      await f.close();
      await gateway.close();
    }
    for (const invalid of [
      { ...value, gatewayFingerprint: "a".repeat(64) },
      { ...value, gatewayUrl: "https://different.example.test" },
      { ...value, gatewayCertificate: gateway.certificate + gateway.certificate },
      { ...value, token: "token\r\nInjected: value" },
      { ...value, kind: "portal" },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await expect(
        runRelayCommand("client", {
          OMNESIS_CLOUD_RELAY_DEVICE_FILE: file,
          OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
        }),
      ).rejects.toThrow();
    }
    await writeFile(file, "x".repeat(65_537));
    await expect(
      runRelayCommand("client", { OMNESIS_CLOUD_RELAY_DEVICE_FILE: file }),
    ).rejects.toThrow("too large");
  });

  test("dispatches interactive device pairing without starting a relay or adapter", async () => {
    const pair = vi.spyOn(googleCommands, "runAccountDevicePairing").mockResolvedValue();
    const env = { OMNESIS_CLOUD_RELAY_DEVICE_KIND: "collector" };
    expect(await runRelayCommand("pair-device", env)).toBeUndefined();
    expect(pair).toHaveBeenCalledExactlyOnceWith(env);
  });
  test("optional Google browser discovery reads matching backend credentials and serves only its control page", async () => {
    const env = await daemonEnv();
    delete env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    const secretFile = join(dir, "fictional-web-secret.json");
    await writeFile(
      secretFile,
      JSON.stringify({
        web: { client_id: "fictional-web-client", client_secret: "fictional-backend-secret" },
      }),
    );
    const configured = {
      ...env,
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: secretFile,
      OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
    };
    const relay = await startRelayDaemon(configured);
    try {
      const response = await fetch(`${relay.url}/_relay/web`, { redirect: "manual" });
      expect(response.headers.get("location")).toBe("/_relay/account");
      const begin = await fetch(`${relay.url}/_relay/web/start`, {
        method: "POST",
        headers: { origin: "https://relay.example.test" },
        redirect: "manual",
      });
      expect(new URL(begin.headers.get("location")!).searchParams.get("client_id")).toBe(
        "fictional-web-client",
      );
      expect((await fetch(`${relay.url}/documents`)).status).toBe(404);
    } finally {
      await relay.close();
    }
    await expect(
      startRelayDaemon({
        ...configured,
        OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-web-client",
      }),
    ).rejects.toThrow("separate desktop");
    await expect(
      startRelayDaemon({
        ...configured,
        OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "http://relay.example.test",
      }),
    ).rejects.toThrow();
    for (const content of [
      "malformed JSON fictional-private-secret",
      JSON.stringify({
        web: { client_id: "other-client", client_secret: "fictional-private-secret" },
      }),
    ]) {
      await writeFile(secretFile, content);
      await expect(startRelayDaemon(configured)).rejects.toThrow(/web OAuth credential file/);
    }
  });

  test("a synthetic loopback relay may send its Google sign-in to a loopback fixture", async () => {
    const env = await daemonEnv();
    delete env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    const secretFile = join(dir, "fixture-web-secret.json");
    await writeFile(
      secretFile,
      JSON.stringify({
        web: { client_id: "fictional-web-client", client_secret: "fictional-backend-secret" },
      }),
    );
    const configured = {
      ...env,
      OMNESIS_SYNTHETIC: "1",
      OMNESIS_CLOUD_RELAY_GOOGLE_FIXTURE_URL: "http://127.0.0.1:9",
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: secretFile,
      OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
    };
    const relay = await startRelayDaemon(configured);
    try {
      const begin = await fetch(`${relay.url}/_relay/web/start`, {
        method: "POST",
        headers: { origin: "https://relay.example.test" },
        redirect: "manual",
      });
      expect(begin.headers.get("location")).toMatch(
        /^http:\/\/127\.0\.0\.1:9\/o\/oauth2\/v2\/auth\?/,
      );
    } finally {
      await relay.close();
    }
    await expect(startRelayDaemon({ ...configured, OMNESIS_SYNTHETIC: undefined })).rejects.toThrow(
      "synthetic relay on a loopback listener",
    );
  });

  test("invalid web secrets fail before database creation and constructor failures close their database", async () => {
    const env = await daemonEnv();
    const secretFile = join(dir, "blank-web-secret.json");
    await writeFile(
      secretFile,
      JSON.stringify({ web: { client_id: "fictional-web-client", client_secret: "  " } }),
    );
    await expect(
      startRelayDaemon({
        ...env,
        OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE: undefined,
        OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
        OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: secretFile,
        OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
      }),
    ).rejects.toThrow(/web OAuth credential file/);
    await expect(stat(env.OMNESIS_CLOUD_RELAY_DB!)).rejects.toMatchObject({ code: "ENOENT" });
    const closed = vi.spyOn(RelayAccounts.prototype, "close");
    await expect(
      startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_MAX_STREAMS: "715827883" }),
    ).rejects.toThrow("Tunnel limits");
    expect(closed).toHaveBeenCalledOnce();
    const restarted = await startRelayDaemon(env);
    await restarted.close();
  });

  test("browser discovery remains absent when web configuration is incomplete and cannot mix real Google with mock identity", async () => {
    const env = await daemonEnv();
    await expect(
      startRelayDaemon({
        ...env,
        OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
      }),
    ).rejects.toThrow("never both");
    delete env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    const relay = await startRelayDaemon({
      ...env,
      OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: "fictional-web-client",
    });
    try {
      expect((await fetch(`${relay.url}/_relay/web`)).status).toBe(404);
    } finally {
      await relay.close();
    }
  });
  test("serves verified HTTPS and refuses a second listener on an occupied port", async () => {
    const env = await daemonEnv();
    const files = tlsFiles(dir);
    const relay = await startRelayDaemon({
      ...env,
      OMNESIS_CLOUD_RELAY_TLS_CERT_FILE: files.certFile,
      OMNESIS_CLOUD_RELAY_TLS_KEY_FILE: files.keyFile,
    });
    try {
      const ca = await readFile(files.certFile, "utf8");
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`${relay.url}/healthz`, { ca }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      const socket = await connectOrigin(new URL(relay.url), ca);
      socket.destroy();
      await expect(connectOrigin(new URL(relay.url))).rejects.toThrow();
      await expect(
        startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_PORT: new URL(relay.url).port }),
      ).rejects.toThrow("EADDRINUSE");
    } finally {
      await relay.close();
    }
  });

  test("supports IPv6 loopback with bracketed client URLs", async () => {
    const env = await daemonEnv();
    const relay = await startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_BIND: "::1" });
    try {
      expect(relay.url).toMatch(/^http:\/\/\[::1\]:/);
      expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
    } finally {
      await relay.close();
    }
  });
  test("runs a loopback daemon, exchanges signed mock identity, and saves private credentials atomically", async () => {
    const env: NodeJS.ProcessEnv = {
      ...(await daemonEnv()),
      OMNESIS_CLOUD_RELAY_LEGACY_ROUTES: "1",
    };
    const relay = await startRelayDaemon(env);
    try {
      expect(await (await fetch(`${relay.url}/healthz`)).json()).toEqual({ ok: true, protocol: 2 });
      if (process.platform !== "win32") {
        expect((await stat(env.OMNESIS_CLOUD_RELAY_DB!)).mode & 0o777).toBe(0o600);
      }
      const tokenFile = join(dir, "id-token");
      const sessionFile = join(dir, "client", "session.json");
      await writeFile(
        tokenFile,
        await localToken(await readFile(env.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE!)),
      );
      await loginRelay({ relayUrl: relay.url, idTokenFile: tokenFile, sessionFile });
      if (process.platform !== "win32") {
        expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
      }
      const first = await readRelaySession(sessionFile);
      expect(first).toMatch(/^ey/);
      expect(
        await runRelayCommand("login", {
          OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
          OMNESIS_CLOUD_RELAY_URL: relay.url,
          OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
          OMNESIS_CLOUD_RELAY_ID_TOKEN_FILE: tokenFile,
        }),
      ).toBeUndefined();
      expect(await readRelaySession(sessionFile)).toMatch(/^ey/);
      const client = await runRelayCommand("client", {
        OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
        OMNESIS_CLOUD_RELAY_URL: relay.url,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
        OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
        OMNESIS_CLOUD_RELAY_GATEWAY_URL: "https://localhost:1",
        OMNESIS_CLOUD_RELAY_GATEWAY_FINGERPRINT: "a".repeat(64),
      });
      try {
        expect((await fetch(`${client!.url}/api/status`)).status).toBe(502);
      } finally {
        await client!.close();
      }
      await writeFile(tokenFile, "invalid");
      await expect(
        loginRelay({ relayUrl: relay.url, idTokenFile: tokenFile, sessionFile }),
      ).rejects.toThrow("401");
      expect(await readRelaySession(sessionFile)).toMatch(/^ey/);
      await expect(readRelaySession(join(dir, "missing"))).rejects.toThrow();
      await writeFile(sessionFile, "{}");
      await expect(readRelaySession(sessionFile)).rejects.toThrow();
      await writeFile(sessionFile, "bad json");
      await expect(readRelaySession(sessionFile)).rejects.toThrow();
    } finally {
      await relay.close();
    }
  });

  test("a client can use a QR-established pin and custom CA without Google or a relay session file", async () => {
    const f = await fixture();
    const gateway = await echoGateway();
    const caFile = join(dir, "gateway-ca.pem");
    await writeFile(caFile, gateway.certificate);
    let client: Awaited<ReturnType<typeof runRelayCommand>>;
    try {
      await f.tunnel(gateway.url);
      client = await runRelayCommand("client", {
        OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
        OMNESIS_CLOUD_RELAY_GATEWAY_URL: f.gatewayUrl,
        OMNESIS_CLOUD_RELAY_GATEWAY_FINGERPRINT: gateway.fingerprint,
        OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE: caFile,
        OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP: "127.0.0.1",
      });
      expect(
        (
          await fetch(`${client!.url}/api/status`, {
            headers: { authorization: "Bearer fixture-token" },
          })
        ).status,
      ).toBe(200);
    } finally {
      await client?.close();
      await f.close();
      await gateway.close();
    }
  });

  test("rejects incomplete, insecure, ambiguous and invalid daemon configuration", async () => {
    const env = await daemonEnv();
    await expect(startRelayDaemon({})).rejects.toThrow();
    await expect(startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_PORT: "65536" })).rejects.toThrow();
    await expect(
      startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_TLS_CERT_FILE: "missing" }),
    ).rejects.toThrow("both");
    await expect(
      startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_TLS_KEY_FILE: "missing" }),
    ).rejects.toThrow("both");
    await expect(startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_BIND: "0.0.0.0" })).rejects.toThrow(
      "TLS",
    );
    await expect(
      startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional" }),
    ).rejects.toThrow("never both");
    const withoutMock = { ...env };
    delete withoutMock.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
    for (const [legacy, status] of [
      [undefined, 404],
      ["0", 404],
      ["1", 503],
    ] as const) {
      const keyOnly = await startRelayDaemon({
        ...withoutMock,
        OMNESIS_CLOUD_RELAY_LEGACY_ROUTES: legacy,
      });
      try {
        expect(
          (
            await fetch(`${keyOnly.url}/_relay/v1/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(status);
      } finally {
        await keyOnly.close();
      }
    }
    await expect(
      startRelayDaemon({ ...withoutMock, OMNESIS_CLOUD_RELAY_LEGACY_ROUTES: "yes" }),
    ).rejects.toThrow();
    const google = await runRelayCommand("serve", {
      ...withoutMock,
      OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-client",
    });
    await google!.close();
    const invalidBind = {
      ...env,
      OMNESIS_CLOUD_RELAY_BIND: "192.0.2.1",
      OMNESIS_CLOUD_RELAY_TLS_CERT_FILE: "missing",
      OMNESIS_CLOUD_RELAY_TLS_KEY_FILE: "missing",
    };
    await expect(startRelayDaemon(invalidBind)).rejects.toThrow("loopback");
    await expect(
      runRelayCommand("unknown", {
        OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
        OMNESIS_CLOUD_RELAY_URL: "http://127.0.0.1",
        OMNESIS_CLOUD_RELAY_SESSION_FILE: "unused",
      }),
    ).rejects.toThrow("Usage");
    await expect(runRelayCommand("client", {})).rejects.toThrow();
  });

  test("data listener failure closes the control listener and leaves the account database reusable", async () => {
    const env = await daemonEnv();
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    try {
      await expect(
        startRelayDaemon({
          ...env,
          OMNESIS_CLOUD_RELAY_DATA_PORT: String(
            (occupied.address() as import("node:net").AddressInfo).port,
          ),
        }),
      ).rejects.toThrow("EADDRINUSE");
      const restarted = await startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_DATA_PORT: "0" });
      expect(restarted.dataPort).toBeGreaterThan(0);
      await restarted.close();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  test("chooses the production data-port default without binding a fixed test port", async () => {
    const env = await daemonEnv();
    const original = Server.prototype.listen;
    const requested: unknown[] = [];
    // Translate requested fixed ports into ephemeral listeners so this test
    // never touches another process's configured service ports.
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: any[]
    ) {
      requested.push(args[0]);
      if (args[0] === 8787 || args[0] === 8789) args[0] = 0;
      return Reflect.apply(original, this, args);
    });
    let relay: Awaited<ReturnType<typeof startRelayDaemon>> | undefined;
    try {
      delete env.OMNESIS_CLOUD_RELAY_PORT;
      relay = await startRelayDaemon(env);
      expect(requested).toEqual([8787, 8789]);
    } finally {
      await relay?.close();
      listen.mockRestore();
    }
  });

  test("normal client IDs and gateway attestation IDs must be separate and cannot coexist with mock credentials", async () => {
    const env = await daemonEnv();
    await expect(
      startRelayDaemon({
        ...env,
        OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID: "fictional-android",
      }),
    ).rejects.toThrow("never both");
    await expect(
      startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "desktop" }),
    ).rejects.toThrow("never both");
    const google = {
      ...env,
      OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: "fictional-web, fictional-mobile",
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-desktop",
    };
    await expect(
      startRelayDaemon({
        ...google,
        OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-mobile",
      }),
    ).rejects.toThrow("separate");
    await expect(
      startRelayDaemon({
        ...google,
        OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID: "fictional-desktop",
      }),
    ).rejects.toThrow("separate");
    const relay = await startRelayDaemon(google);
    await relay.close();
  });

  test("gateway integration is opt-in, requires complete configuration and respects the feature gate", async () => {
    expect(startGatewayCloudTunnel("https://localhost:1", {})).toBeUndefined();
    // A relay URL without a gateway ID chooses a service for portal setup; it starts nothing.
    expect(
      startGatewayCloudTunnel("https://localhost:1", {
        OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
        OMNESIS_CLOUD_RELAY_URL: "http://127.0.0.1:1",
      }),
    ).toBeUndefined();
    expect(() =>
      startGatewayCloudTunnel("https://localhost:1", {
        OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
        OMNESIS_CLOUD_RELAY_URL: "http://127.0.0.1:1",
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
      }),
    ).toThrow("session file");
    const f = await fixture();
    const path = join(dir, "session.json");
    await writeFile(path, JSON.stringify(f.session));
    const env = {
      OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
      OMNESIS_CLOUD_RELAY_URL: f.url,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
      OMNESIS_CLOUD_RELAY_SESSION_FILE: path,
    };
    try {
      const tunnel = startGatewayCloudTunnel("https://localhost:1", env);
      expect(tunnel).toBeDefined();
      tunnel!.stop();
      vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
      expect(
        startGatewayCloudTunnel("https://localhost:1", {
          ...env,
          OMNESIS_CLOUD_RELAY_ENABLED: "0",
        }),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

test("explicit Google commands dispatch to their interactive flow", async () => {
  const run = vi.spyOn(googleCommands, "runGoogleRelayLogin").mockResolvedValue(undefined);
  for (const command of ["google-login", "register-gateway"] as const) {
    const env = { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test" };
    expect(await runRelayCommand(command, env)).toBeUndefined();
    expect(run).toHaveBeenLastCalledWith(command, env);
  }
});

test("private metrics expose live aggregates separately and listener conflicts drain owned resources", async () => {
  const env = await daemonEnv();
  env.OMNESIS_CLOUD_RELAY_METRICS_PORT = "0";
  const daemon = await startRelayDaemon(env);
  try {
    expect(daemon.metricsPort).toBeGreaterThan(0);
    expect((await fetch(daemon.url + "/metrics")).status).toBe(404);
    const body = await (await fetch(`http://127.0.0.1:${daemon.metricsPort}/metrics`)).text();
    expect(body).toContain("cloud_relay_online_gateways 0\n");
    expect(body).toContain('route="other"');
    await expect(
      startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_METRICS_PORT: String(daemon.metricsPort) }),
    ).rejects.toThrow("EADDRINUSE");
  } finally {
    await daemon.close();
  }
});

test("metrics shutdown failure still closes the control listener and account database", async () => {
  const metrics = await import("./metrics-server.js");
  vi.spyOn(metrics, "startRelayMetricsServer").mockResolvedValue({
    port: 12345,
    close: () => Promise.reject(new Error("fixture metrics shutdown failure")),
  });
  const close = vi.spyOn(RelayAccounts.prototype, "close");
  const daemon = await startRelayDaemon({
    ...(await daemonEnv()),
    OMNESIS_CLOUD_RELAY_METRICS_PORT: "0",
  });
  await expect(daemon.close()).rejects.toThrow("fixture metrics shutdown failure");
  expect(close).toHaveBeenCalledOnce();
  await expect(fetch(daemon.url + "/healthz")).rejects.toThrow();
});
