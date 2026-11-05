// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import {
  runGoogleRelayLogin,
  runGoogleDevicePairing,
  confirmGatewayCode,
} from "./google-commands.js";
import * as pairing from "./google-device-pairing.js";
import * as desktop from "./google-desktop.js";
import { accountId } from "./identity.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import type { authorizeGoogleDesktop } from "./google-desktop.js";

const owner = {
  issuer: "https://accounts.google.com",
  subject: "fictional-owner",
  expiresAt: 4_000_000_000,
};
const credentials = {
  identity: owner,
  idToken: "fictional-signed-id-token",
  refreshToken: "fictional-refresh",
};
const { terminal } = vi.hoisted(() => ({ terminal: { question: vi.fn(), close: vi.fn() } }));
vi.mock("node:readline/promises", () => ({ createInterface: () => terminal }));
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const vectors = JSON.parse(
  await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
) as {
  gateway: { gatewayId: string; publicOrigin: string; certificate: string };
};
let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-google-command-"));
  env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(dir, "session.json"),
    OMNESIS_CONFIG_DIR: join(dir, "client-state"),
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: join(dir, "credentials.json"),
    OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: "fictional-desktop-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-gateway-client",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: vectors.gateway.gatewayId,
    OMNESIS_PUBLIC_BASE_URL: vectors.gateway.publicOrigin,
    OMNESIS_TLS_CERT: join(dir, "certificate.pem"),
  };
  await writeFile(env.OMNESIS_TLS_CERT!, vectors.gateway.certificate);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  terminal.question.mockReset();
  terminal.close.mockReset();
  vi.unstubAllGlobals();
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stdout, stdoutTty],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
});
const session = () =>
  Response.json({
    token: "relay-test-session",
    accountId: accountId(owner),
    expiresAt: 4_000_000_000,
  });

test("desktop login uses a fresh private nonce and persists only independently established credentials", async () => {
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => credentials);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => session());
  await runGoogleRelayLogin("google-login", env, { authorize, fetch });
  const request = authorize.mock.calls[0]![0];
  expect(request.clientId).toBe("fictional-desktop-client");
  expect(request.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(request.offline).toBe(true);
  expect(request.clientSecret).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(await readFile(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE!, "utf8")),
  ).toMatchObject({ accountId: accountId(owner), refreshToken: "fictional-refresh" });
  expect((await stat(env.OMNESIS_CLOUD_RELAY_SESSION_FILE!)).mode & 0o777).toBe(0o600);
});

test("desktop command defaults use the system authorization driver and direct relay transport", async () => {
  vi.spyOn(desktop, "authorizeGoogleDesktop").mockResolvedValue(credentials);
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/login") ? session() : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", transport);
  await runGoogleRelayLogin("register-gateway", env);
  expect(desktop.authorizeGoogleDesktop).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(2);
});

test("gateway registration signs the exact certificate and route using its dedicated desktop audience", async () => {
  const secretFile = join(dir, "installed-client.json");
  await writeFile(
    secretFile,
    JSON.stringify({
      installed: {
        client_id: "fictional-gateway-client",
        client_secret: "fictional-desktop-secret",
      },
    }),
  );
  env.OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE = secretFile;
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => credentials);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith("/login")) return session();
    expect(String(url)).toBe("https://relay.example.test/_relay/v2/gateway");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ authorization: "Bearer relay-test-session" });
    expect(init!.redirect).toBe("error");
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({ ...vectors.gateway, identityToken: credentials.idToken });
    expect(init!.body).not.toContain("fictional-desktop-secret");
    return new Response(null, { status: 204 });
  });
  await runGoogleRelayLogin("register-gateway", env, { authorize, fetch });
  expect(authorize).toHaveBeenCalledExactlyOnceWith({
    clientId: "fictional-gateway-client",
    offline: true,
    clientSecret: "fictional-desktop-secret",
    nonce: gatewayBindingNonce(vectors.gateway),
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await readFile(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE!, "utf8")).not.toContain(
    "fictional-desktop-secret",
  );
});

test("gateway registration publishes only a canonical public leaf from a full-chain or CRLF certificate file", async () => {
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => credentials);
  for (const input of [
    vectors.gateway.certificate.replaceAll("\n", "\r\n"),
    vectors.gateway.certificate + vectors.gateway.certificate,
    vectors.gateway.certificate +
      "\n-----BEGIN PRIVATE KEY-----\nfictional-sensitive-material\n-----END PRIVATE KEY-----\n",
  ]) {
    await writeFile(env.OMNESIS_TLS_CERT!, input);
    await runGoogleRelayLogin("register-gateway", env, {
      authorize,
      fetch: async (url, init) => {
        if (String(url).endsWith("/login")) return session();
        const body = JSON.parse(init!.body as string);
        expect(body.certificate).toBe(vectors.gateway.certificate);
        expect(init!.body).not.toContain("PRIVATE KEY");
        expect(init!.body).not.toContain("fictional-sensitive-material");
        return new Response(null, { status: 204 });
      },
    });
  }
});

test("hostname ownership or registration refusal never saves a reusable Google credential", async () => {
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => credentials);
  await expect(
    runGoogleRelayLogin("register-gateway", env, {
      authorize,
      fetch: async (url) =>
        String(url).endsWith("/login") ? session() : new Response("sensitive", { status: 403 }),
    }),
  ).rejects.toThrow("registration refused");
  await expect(stat(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("invalid domains, missing native registration and mismatched downloaded web credentials fail before sign-in", async () => {
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => credentials);
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    runGoogleRelayLogin(
      "register-gateway",
      { ...env, OMNESIS_PUBLIC_BASE_URL: "http://gateway.example.test" },
      { authorize, fetch },
    ),
  ).rejects.toThrow();
  await expect(
    runGoogleRelayLogin(
      "google-login",
      { ...env, OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: undefined },
      { authorize, fetch },
    ),
  ).rejects.toThrow();
  const file = join(dir, "web-client.json");
  await writeFile(
    file,
    JSON.stringify({ web: { client_id: "fictional-web-client", client_secret: "backend-secret" } }),
  );
  await expect(
    runGoogleRelayLogin(
      "google-login",
      { ...env, OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: file },
      { authorize, fetch },
    ),
  ).rejects.toThrow();
  expect(authorize).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("terminal key confirmation requires a real interactive comparison and always closes readline", async () => {
  const value = {
    gatewayUrl: "https://gateway.example.test",
    verificationCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
  };
  for (const [input, output] of [
    [false, true],
    [true, false],
  ]) {
    Object.defineProperty(process.stdin, "isTTY", { value: input, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: output, configurable: true });
    await expect(confirmGatewayCode(value)).rejects.toThrow("interactive terminal");
  }
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal.question
    .mockResolvedValueOnce(" aaaa-bbbb-cccc-dddd-eeee \n")
    .mockResolvedValueOnce("wrong")
    .mockRejectedValueOnce(new Error("Cancelled"));
  expect(await confirmGatewayCode(value)).toBe(true);
  expect(await confirmGatewayCode(value)).toBe(false);
  await expect(confirmGatewayCode(value)).rejects.toThrow("Cancelled");
  expect(terminal.close).toHaveBeenCalledTimes(3);
});

test("pair-device writes its verified device credential privately and only after the comparison gate succeeds", async () => {
  const result = {
    gatewayUrl: vectors.gateway.publicOrigin,
    gatewayFingerprint: "a".repeat(64),
    gatewayCertificate: vectors.gateway.certificate,
    token: "fictional-device-token",
    kind: "collector" as const,
    deviceId: vectors.gateway.gatewayId,
    scopes: ["write:all"],
  };
  const confirm = vi.fn(async () => true);
  const pair = vi.spyOn(pairing, "pairGoogleDevice").mockResolvedValue(result);
  const deviceFile = join(dir, "paired", "device.json");
  const deviceEnv = {
    ...env,
    OMNESIS_CLOUD_RELAY_DEVICE_FILE: deviceFile,
    OMNESIS_CLOUD_RELAY_DEVICE_KIND: "collector",
    OMNESIS_CLOUD_RELAY_DEVICE_NAME: " Fictional collector ",
  };
  await writeFile(join(dir, "token"), "gateway-admin-token\n");
  await runGoogleDevicePairing(deviceEnv, { confirm });
  expect(await readFile(join(dir, "token"), "utf8")).toBe("gateway-admin-token\n");
  expect(pair).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "collector", name: "Fictional collector", confirm }),
  );
  expect(JSON.parse(await readFile(deviceFile, "utf8"))).toEqual(result);
  expect((await stat(deviceFile)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "paired"))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(env.OMNESIS_CONFIG_DIR!, "collector-token"), "utf8")).toContain(
    result.token,
  );
  const secretFile = join(dir, "desktop-client.json");
  await writeFile(
    secretFile,
    JSON.stringify({
      installed: { client_id: "fictional-desktop-client", client_secret: "fictional-secret" },
    }),
  );
  pair.mockRejectedValueOnce(new Error("Comparison failed"));
  const failedFile = join(dir, "unpaired.json");
  await expect(
    runGoogleDevicePairing(
      {
        ...deviceEnv,
        OMNESIS_CLOUD_RELAY_DEVICE_FILE: failedFile,
        OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: secretFile,
      },
      { pair: pairing.pairGoogleDevice },
    ),
  ).rejects.toThrow("Comparison failed");
  expect(pair).toHaveBeenLastCalledWith(
    expect.objectContaining({ clientSecret: "fictional-secret", confirm: confirmGatewayCode }),
  );
  await expect(stat(failedFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("Google registration attests the separate public SNI certificate while retaining the direct certificate file", async () => {
  const publicFile = join(dir, "public-sni.pem");
  await writeFile(publicFile, vectors.gateway.certificate);
  await writeFile(env.OMNESIS_TLS_CERT!, "fictional-direct-certificate-is-not-the-public-identity");
  const authorize = vi.fn<typeof authorizeGoogleDesktop>(async () => credentials);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith("/login")) return session();
    expect(JSON.parse(init!.body as string).certificate).toBe(vectors.gateway.certificate);
    return new Response(null, { status: 204 });
  });
  await runGoogleRelayLogin(
    "register-gateway",
    {
      ...env,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: env.OMNESIS_PUBLIC_BASE_URL,
      OMNESIS_PUBLIC_BASE_URL: "https://direct.example.test",
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
      OMNESIS_ACME_CERT_FILE: publicFile,
    },
    { authorize, fetch },
  );
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ nonce: gatewayBindingNonce(vectors.gateway) }),
  );
  expect(await readFile(env.OMNESIS_TLS_CERT!, "utf8")).toBe(
    "fictional-direct-certificate-is-not-the-public-identity",
  );
});

test("normal clients need only deployment's public desktop ID; local paths, service, kind and name default privately", async () => {
  const result = {
    gatewayUrl: vectors.gateway.publicOrigin,
    gatewayFingerprint: "a".repeat(64),
    gatewayCertificate: vectors.gateway.certificate,
    token: "client-test-token",
    kind: "cli" as const,
    deviceId: vectors.gateway.gatewayId,
    scopes: ["read:all"],
  };
  const pair = vi.fn(async () => result),
    confirm = vi.fn(async () => true);
  await expect(
    runGoogleDevicePairing({ OMNESIS_CONFIG_DIR: dir }, { pair, confirm }),
  ).rejects.toMatchObject({ code: "GOOGLE_DESKTOP_UNAVAILABLE" });
  expect(pair).not.toHaveBeenCalled();
  await runGoogleDevicePairing(
    { OMNESIS_CONFIG_DIR: dir, OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: "operator-desktop" },
    { pair, confirm },
  );
  expect(pair).toHaveBeenCalledWith(
    expect.objectContaining({
      relayUrl: "https://relay.omnesis.app",
      sessionFile: join(dir, "cloud-relay", "client-session.json"),
      clientId: "operator-desktop",
      clientSecret: undefined,
      kind: "cli",
      name: "Omnesis CLI",
    }),
  );
  expect(JSON.parse(await readFile(join(dir, "cloud-relay", "cli-device.json"), "utf8"))).toEqual(
    result,
  );
  expect(await readFile(join(dir, "token"), "utf8")).toBe(result.token + "\n");
  expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
});
test("CLI Google pairing refuses an unrelated admin token before OAuth and fences manual replacement during pairing", async () => {
  const { mkdir } = await import("node:fs/promises");
  const config = {
    OMNESIS_CONFIG_DIR: dir,
    OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: "operator-desktop",
  };
  const file = join(dir, "cloud-relay", "cli-device.json"),
    tokenFile = join(dir, "token");
  await mkdir(join(dir, "cloud-relay"), { recursive: true });
  await writeFile(tokenFile, "admin-test-token\n");
  const result = {
    gatewayUrl: vectors.gateway.publicOrigin,
    gatewayFingerprint: "a".repeat(64),
    gatewayCertificate: vectors.gateway.certificate,
    token: "new-client-token",
    kind: "cli" as const,
    deviceId: vectors.gateway.gatewayId,
    scopes: ["read:all"],
  };
  const pair = vi.fn(async () => result),
    confirm = vi.fn(async () => true);
  await expect(runGoogleDevicePairing(config, { pair, confirm })).rejects.toMatchObject({
    code: "CLOUD_CLIENT_TOKEN_COLLISION",
  });
  await writeFile(tokenFile, "");
  await expect(runGoogleDevicePairing(config, { pair, confirm })).rejects.toMatchObject({
    code: "CLOUD_CLIENT_TOKEN_COLLISION",
  });
  await rm(tokenFile);
  const { symlink } = await import("node:fs/promises");
  await symlink(join(dir, "missing-token-target"), tokenFile);
  await expect(runGoogleDevicePairing(config, { pair, confirm })).rejects.toMatchObject({
    code: "CLOUD_CLIENT_TOKEN_COLLISION",
  });
  await rm(tokenFile);
  await writeFile(tokenFile, "admin-test-token\n");
  await writeFile(file, JSON.stringify({ ...result, token: "admin-test-token" }));
  await expect(runGoogleDevicePairing(config, { pair, confirm })).rejects.toMatchObject({
    code: "CLOUD_CLIENT_TOKEN_COLLISION",
  });
  expect(pair).not.toHaveBeenCalled();
  expect(await readFile(tokenFile, "utf8")).toBe("admin-test-token\n");
  await rm(tokenFile);
  pair.mockImplementationOnce(async () => {
    await writeFile(tokenFile, "manual-new-token\n");
    return result;
  });
  await expect(runGoogleDevicePairing(config, { pair, confirm })).rejects.toMatchObject({
    code: "CLOUD_CLIENT_TOKEN_COLLISION",
  });
  expect(JSON.parse(await readFile(file, "utf8")).token).toBe("admin-test-token");
  expect(await readFile(tokenFile, "utf8")).toBe("manual-new-token\n");
});

test("a separate process publishing a fresh admin credential cannot be clobbered by CLI Google pairing", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readdir } = await import("node:fs/promises");
  const original = core.writeSecretTextFileSync;
  const tokenFile = join(dir, "token");
  vi.spyOn(core, "writeSecretTextFileSync").mockImplementation((file, value, options) => {
    const result = original(file, value, options);
    if (file.includes(".cloud-client-token-"))
      execFileSync(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'concurrent-admin\\n', {flag:'wx',mode:0o600})",
        tokenFile,
      ]);
    return result;
  });
  const result = {
    gatewayUrl: vectors.gateway.publicOrigin,
    gatewayFingerprint: "a".repeat(64),
    gatewayCertificate: vectors.gateway.certificate,
    token: "new-client-token",
    kind: "cli" as const,
    deviceId: vectors.gateway.gatewayId,
    scopes: ["read:all"],
  };
  await expect(
    runGoogleDevicePairing(
      { OMNESIS_CONFIG_DIR: dir, OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: "operator-desktop" },
      { pair: async () => result },
    ),
  ).rejects.toMatchObject({ code: "CLOUD_CLIENT_TOKEN_COLLISION" });
  expect(await readFile(tokenFile, "utf8")).toBe("concurrent-admin\n");
  expect((await readdir(dir)).filter((name) => name.startsWith(".cloud-client-token-"))).toEqual(
    [],
  );
});
