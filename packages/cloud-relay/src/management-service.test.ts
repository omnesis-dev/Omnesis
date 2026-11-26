// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { markedFileError } from "../test/private-operation-fixture.js";
import { tlsFiles } from "../test/support.js";
import { expiredCertificate } from "../test/expired-certificate.js";
import { fakeSignupRelay } from "../test/fake-signup-relay.js";
import { brokerCall, brokerHarness, brokerOwner } from "../test/dns-broker-owner.js";
import { GatewayGoogleWeb } from "./google-gateway-web.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import {
  GatewayCloudRelayManagement,
  type CloudRelayManagerOptions,
} from "./management-service.js";
import { CloudRelayManagementFailure } from "./management.js";
import { HostedNameTaken } from "./relay-configuration.js";
import { googleBrowserTrust } from "./google-browser-trust.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { signInvite } from "./invites.js";
import { GatewayAccountLink } from "./gateway-account-link.js";
import { GatewayUnregistered, readOrCreateGatewayOwnerKey } from "./gateway-key-client.js";
import * as privateCredentials from "./google-credentials.js";
import { readGatewayTlsPrivateKey } from "./gateway-private-key.js";

let directory: string, manager: GatewayCloudRelayManagement | undefined;
/** Requests no test answered; any one fails the test, even when the gateway swallows the error. */
let unanswered: string[] = [];
/**
 * The network a test sees unless it answers a request itself: the relay has no managed Google
 * browser client and offers no account sign-in, and every other request is refused. No test reaches a real service, whether
 * through the gateway's `fetch` or the global one.
 */
const offline: typeof fetch = (request) => {
  const url = request instanceof Request ? request.url : String(request);
  if (url.includes("/_relay/v2/google/browser/config") || url.includes("/_relay/v3/account-keys"))
    return Promise.resolve(new Response(null, { status: 404 }));
  unanswered.push(url);
  return Promise.reject(new Error(`No test answers ${url}`));
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-management-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
  unanswered = [];
  vi.stubGlobal("fetch", offline);
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
  expect(unanswered).toEqual([]);
});
function fixture(overrides: Partial<CloudRelayManagerOptions> = {}) {
  const close = vi.fn(async () => {}),
    renew = vi.fn(async () => true),
    stop = vi.fn();
  const register = vi.fn(async () => ({
    token: "private-session",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  }));
  const discover = vi.fn(async (_url: string, gatewayId: string) => ({
    protocol: 2 as const,
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    invitationRequired: false,
    dnsChallenges: true,
  }));
  const prepare = vi.fn(async (value: { gatewayId: string }) => ({
    gatewayId: value.gatewayId,
    accountId: "a".repeat(64),
  }));
  const options = {
    configDir: directory,
    gatewayUrl: () => "https://localhost:12345",
    fetch: vi.fn<typeof fetch>(offline),
    activate: vi.fn(async () => {}),
    directCertificateCoversHostname: () => false,
    directIdentity: () => ({
      id: "direct" as const,
      names: ["localhost"],
      kind: "self-signed" as const,
      state: "valid" as const,
      pinPolicy: "existing-device-policy" as const,
    }),
    discover,
    prepare,
    register,
    probe: vi.fn(async () => true),
    controller: vi.fn(async () => ({
      cleanupFailure: () => undefined,
      close,
      renew,
      fingerprintSha256: () => "b".repeat(64),
      spkiFingerprintSha256: () => "c".repeat(64),
    })),
    startTunnel: vi.fn(() => ({
      stop,
      close: async () => {},
      cleanupFailure: () => undefined,
      status: () => ({ state: "online" as const }),
      online: async () => {},
    })) as unknown as CloudRelayManagerOptions["startTunnel"],
    ...overrides,
    // The monitor is on by default; only the test that opts in may reach a CT provider.
    env: {
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
      ...(overrides.env ?? { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test" }),
    },
  };
  return { options, close, renew, stop, register, discover, prepare };
}
async function idle() {
  await vi.waitFor(async () => {
    const status = await manager!.status();
    expect(status.can.reconnect || status.enrollment.state === "failed").toBe(true);
  });
}
const input = { relayUrl: "https://relay.example.test", termsAccepted: true };
/** What a gateway that registered with the relay before keeps saying so. */
async function registeredEarlier() {
  await writeFile(join(directory, "cloud-relay/registered.json"), JSON.stringify({ version: 1 }));
}
async function pendingRelease(createdAt = Date.now()) {
  const root = join(directory, "cloud-relay"),
    file = join(root, "release.json"),
    sessionFile = join(root, "session.json");
  const bytes = JSON.stringify({
    version: 1,
    relayUrl: "https://relay.example.test",
    gatewayId: "33333333-3333-4333-8333-333333333333",
    publicOrigin: "https://gateway.example.test",
    sessionFile,
    ownerKeyFile: join(root, "owner.key"),
    certificateFile: join(root, "public.pem"),
    privateKeyFile: join(root, "public.key"),
    createdAt,
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await core.atomicWriteFile(sessionFile, "{}", { mode: 0o600 });
  await core.atomicWriteFile(file, bytes, { mode: 0o600 });
  return { file, sessionFile, bytes };
}

test("close joins an owned release journal read and prevents cleanup after shutdown", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const pending = await pendingRelease(Date.now() - 31 * 86400_000);
  let entered!: () => void, finish!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = privateCredentials.readPrivateJson;
  const read = vi.spyOn(privateCredentials, "readPrivateJson").mockImplementation(async (path) => {
    if (path === pending.file) {
      entered();
      await gate;
    }
    return original(path);
  });
  let closing: Promise<void> | undefined;
  let release: Promise<void> | undefined;
  try {
    manager.start();
    await reading;
    release = (manager as unknown as { releasing?: Promise<void> }).releasing;
    let closed = false;
    closing = manager.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(await readFile(pending.file, "utf8")).toBe(pending.bytes);
    expect(await readFile(pending.sessionFile, "utf8")).toBe("{}");
    expect(f.register).not.toHaveBeenCalled();
    const calls = read.mock.calls.length;
    manager.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(calls);
    await rm(directory, { recursive: true });
  } finally {
    finish();
    await release;
    await closing;
  }
});

test("close aborts a held remote release and waits for its owned completion", async () => {
  let entered!: () => void, finish!: () => void;
  const registered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const drain = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let signal: AbortSignal | undefined;
  const register = vi.fn<NonNullable<CloudRelayManagerOptions["register"]>>(async (options) => {
    signal = options.signal;
    entered();
    await drain;
    signal?.throwIfAborted();
    throw new Error("Invented release was not acknowledged");
  });
  const f = fixture({ register });
  manager = await GatewayCloudRelayManagement.open(f.options);
  const pending = await pendingRelease();
  let closing: Promise<void> | undefined;
  let release: Promise<void> | undefined;
  try {
    manager.start();
    release = (manager as unknown as { releasing?: Promise<void> }).releasing;
    await Promise.race([
      registered,
      release!.then(() => {
        throw new Error("Release completed before registration began");
      }),
    ]);
    let closed = false;
    closing = manager.close().then(() => {
      closed = true;
    });
    expect(signal?.aborted).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(await readFile(pending.file, "utf8")).toBe(pending.bytes);
    expect(await readFile(pending.sessionFile, "utf8")).toBe("{}");
    expect(register).toHaveBeenCalledOnce();
  } finally {
    finish();
    await release;
    await closing;
  }
});
test.each(["EACCES", "EPRIVATE", "malformed"])(
  "pending-release journal %s failure preserves the barrier to another registration",
  async (failure) => {
    const f = fixture();
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure(input);
    const releaseFile = join(directory, "cloud-relay", "release.json");
    const pending =
      failure === "malformed"
        ? '{"version":1}'
        : JSON.stringify({
            version: 1,
            relayUrl: "https://relay.example.test",
            gatewayId: "22222222-2222-4222-8222-222222222222",
            publicOrigin: "https://gateway.example.test",
            sessionFile: join(directory, "cloud-relay", "session.json"),
            ownerKeyFile: join(directory, "cloud-relay", "owner.key"),
            certificateFile: join(directory, "cloud-relay", "public.pem"),
            privateKeyFile: join(directory, "cloud-relay", "public.key"),
            createdAt: Date.now(),
          });
    await core.atomicWriteFile(releaseFile, pending, { mode: 0o600 });
    const read = privateCredentials.readPrivateJson;
    if (failure !== "malformed") {
      vi.spyOn(privateCredentials, "readPrivateJson").mockImplementation(async (path) => {
        if (path === releaseFile)
          throw Object.assign(new Error("Invented release journal refusal"), { code: failure });
        return read(path);
      });
    }
    // start() also reads the journal in a background task: refusal must be handled there.
    manager.start();
    await expect(manager.enable()).rejects.toMatchObject({ code: "relay-unreachable" });
    expect(await readFile(releaseFile, "utf8")).toBe(pending);
    expect(f.register).not.toHaveBeenCalled();
    expect(await manager.status()).toMatchObject({ enabled: false });
  },
);
test("unconfigured status and close create no files, network, owner keys or background jobs", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(await manager.status()).toMatchObject({
    enabled: false,
    configured: false,
    enrollment: { state: "unconfigured" },
    tunnel: { state: "disabled" },
    identities: [{ id: "direct" }, { id: "cloud", state: "unconfigured" }],
  });
  expect(manager.isExposing()).toBe(false);
  expect(manager.hasSavedConfiguration()).toBe(false);
  expect(manager.publicOrigin()).toBeUndefined();
  expect(manager.fingerprintSha256()).toBeUndefined();
  expect(manager.spkiFingerprintSha256()).toBeUndefined();
  await manager.disable();
  manager.start();
  await manager.close();
  expect(await readdir(directory)).toEqual([]);
  expect(f.discover).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  for (const operation of [
    () => manager!.enable(),
    () => manager!.renew(),
    () => manager!.reconnect(),
  ])
    await expect(operation()).rejects.toBeInstanceOf(CloudRelayManagementFailure);
});
test("connect and configure default to the operator's ACME directory, and show Let's Encrypt terms only for Let's Encrypt", async () => {
  const letsEncrypt = fixture();
  manager = await GatewayCloudRelayManagement.open(letsEncrypt.options);
  expect((await manager.status()).config).toMatchObject({
    acmeDirectoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
    acmeTermsUrl: "https://letsencrypt.org/repository/",
  });
  expect((await manager.configure(input)).config).toMatchObject({
    acmeDirectoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
    acmeTermsUrl: "https://letsencrypt.org/repository/",
  });
  await manager.close();
  await rm(join(directory, "cloud-relay"), { recursive: true, force: true });

  const privateCa = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/acme/directory",
    },
  });
  manager = await GatewayCloudRelayManagement.open(privateCa.options);
  const unconfigured = await manager.status();
  expect(unconfigured.config.acmeDirectoryUrl).toBe("https://ca.example.test/acme/directory");
  expect(unconfigured.config.acmeTermsUrl).toBeUndefined();
  const configured = await manager.configure(input);
  expect(configured.config.acmeDirectoryUrl).toBe("https://ca.example.test/acme/directory");
  expect(configured.config.acmeTermsUrl).toBeUndefined();
  // A directory named by the request still wins.
  await manager.close();
  await rm(join(directory, "cloud-relay"), { recursive: true, force: true });
  manager = await GatewayCloudRelayManagement.open(privateCa.options);
  expect(
    (
      await manager.configure({
        ...input,
        acmeDirectoryUrl: "https://other-ca.example.test/directory",
      })
    ).config.acmeDirectoryUrl,
  ).toBe("https://other-ca.example.test/directory");
});
test("configure assigns a stable gateway, explicitly enables actual enrollment and reports independent public/direct identities", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const saved = await manager.configure(input);
  expect(saved).toMatchObject({
    configured: true,
    enabled: false,
    enrollment: { state: "pending" },
  });
  // Until the relay registers it, the address is reserved and offered nowhere.
  expect(saved.publicOrigin).toBeUndefined();
  expect(saved.publicMcp.url).toBeUndefined();
  expect(manager.publicOrigin()).toBeUndefined();
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.register).not.toHaveBeenCalled();
  const certificate = await readFile(tlsFiles(directory).certFile, "utf8");
  await writeFile(join(directory, "cloud-relay/public.pem"), certificate);
  await manager.enable({ invitation: "private-invitation" });
  await idle();
  expect(await manager.status()).toMatchObject({
    enabled: true,
    publicOrigin: "https://gateway.example.test",
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    publicMcp: { ready: true, url: "https://gateway.example.test/mcp" },
    certificate: { state: "bootstrap" },
  });
  expect(f.register).toHaveBeenCalledOnce();
  expect(f.renew).toHaveBeenCalledOnce();
  expect(JSON.stringify(await manager.status())).not.toMatch(
    /private-invitation|private-session|owner.key|public.pem|acme-account/,
  );
  expect(manager.fingerprintSha256()).toBe("b".repeat(64));
  expect(manager.spkiFingerprintSha256()).toBe("c".repeat(64));
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "operation-in-progress" });
  await manager.renew();
  await idle();
  await manager.reconnect();
  await idle();
  await manager.disable();
  expect(f.stop).toHaveBeenCalled();
  expect(f.close).toHaveBeenCalled();
  const second = await manager.configure({ ...input, termsAccepted: false });
  expect(second.gatewayId).toBe(saved.gatewayId);
  await expect(manager.enable()).rejects.toMatchObject({ code: "ca-terms-required" });
  expect(
    JSON.parse(await readFile(join(f.options.configDir, "cloud-relay/invitation.json"), "utf8")),
  ).toEqual({ enrollmentToken: "private-invitation" });
});
test("private persisted configuration resumes only when listener explicitly starts, and disable persists across restart", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(f.register).toHaveBeenCalledOnce();
  manager.start();
  await idle();
  expect(f.register).toHaveBeenCalledTimes(2);
  await manager.disable();
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  expect((await manager.status()).enabled).toBe(false);
  expect(f.register).toHaveBeenCalledTimes(2);
});
test("invalid transport, metadata failures, origin absence, identity changes and invalid invitation fail with only safe codes", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  for (const value of [
    { relayUrl: "http://public.test" },
    { ...input, publicOrigin: "http://gateway.test" },
    { ...input, acmeDirectoryUrl: "https://u:secret@ca.test/a" },
    { ...input, acmeDirectoryUrl: "https://ca.test/a#x" },
  ])
    await expect(manager.configure(value)).rejects.toMatchObject({ code: "configuration-invalid" });
  f.discover.mockRejectedValueOnce(new Error("private-provider-error"));
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "relay-unreachable" });
  f.discover.mockResolvedValueOnce({
    protocol: 2,
    gatewayId: "x",
    publicOrigin: undefined,
    invitationRequired: true,
    dnsChallenges: false,
  } as never);
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "hostname-required" });
  await manager.configure({
    ...input,
    publicOrigin: "https://custom.example.test",
    acmeDirectoryUrl: "https://ca.example.test/directory",
  });
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "configuration-invalid" });
  for (const invitation of ["", "a".repeat(4097)])
    await expect(manager.enable({ invitation })).rejects.toMatchObject({
      code: "configuration-invalid",
    });
});
test("a new gateway redraws its id when the relay reports its hosted name taken, at most five draws", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  f.discover.mockRejectedValue(new HostedNameTaken("taken"));
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "relay-unreachable" });
  const refused = f.discover.mock.calls.map(([, gatewayId]) => gatewayId);
  expect(new Set(refused).size).toBe(5);
  expect(manager.hasSavedConfiguration()).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();

  f.discover.mockReset();
  f.discover.mockRejectedValueOnce(new HostedNameTaken("taken"));
  f.discover.mockRejectedValueOnce(new HostedNameTaken("taken"));
  f.discover.mockImplementation(async (_url, gatewayId) => ({
    protocol: 2 as const,
    gatewayId,
    publicOrigin: `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}`,
    invitationRequired: false,
    dnsChallenges: true,
  }));
  const status = await manager.configure(input);
  const drawn = f.discover.mock.calls.map(([, gatewayId]) => gatewayId);
  expect(new Set([...refused, ...drawn]).size).toBe(8);
  expect(status.gatewayId).toBe(drawn[2]);
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      gatewayId: drawn[2],
      publicOrigin: `https://${hostedGatewayHostname(drawn[2]!, "relay.example.test")}`,
    }),
  );

  // An identity already saved is never replaced behind the operator's back.
  f.discover.mockReset();
  f.discover.mockRejectedValue(new HostedNameTaken("taken"));
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "relay-unreachable" });
  expect(f.discover).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    drawn[2],
    expect.anything(),
    expect.anything(),
  );
});
test("enrollment failures are sanitized; valid enrollment with failed renewal retains its existing certificate metadata", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  f.register.mockRejectedValueOnce(new Error("private-secret-file-path"));
  await manager.enable();
  await idle();
  expect((await manager.status()).enrollment).toEqual({
    state: "failed",
    error: "enrollment-refused",
  });
  f.renew.mockRejectedValueOnce(new Error("private-dns-token"));
  await manager.reconnect();
  await idle();
  expect((await manager.status()).certificate).toMatchObject({
    state: "failed",
    lastError: "certificate-renewal-failed",
  });
  expect(JSON.stringify(await manager.status())).not.toMatch(/private-/);
});
test("disable aborts in-flight enrollment and no tunnel or renewal starts after cancellation", async () => {
  const f = fixture();
  let release!: () => void;
  f.register.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { token: "secret", accountId: "a".repeat(64), expiresAt: 4000000000 };
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(manager.renew()).rejects.toMatchObject({ code: "operation-in-progress" });
  expect(manager.isExposing()).toBe(true);
  const closing = manager.disable();
  expect(manager.isExposing()).toBe(true);
  await expect(manager.enable()).rejects.toMatchObject({ code: "operation-in-progress" });
  release();
  await closing;
  expect(manager.isExposing()).toBe(false);
  expect(f.options.startTunnel).not.toHaveBeenCalled();
  expect(f.renew).not.toHaveBeenCalled();
  expect((await manager.status()).enabled).toBe(false);
});
test("malformed private configuration fails closed rather than minting another identity", async () => {
  const f = fixture();
  await writeFile(join(directory, "cloud-relay"), "invalid");
  await expect(
    GatewayCloudRelayManagement.open(f.options).then((opened) => {
      manager = opened;
      return opened;
    }),
  ).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(await readFile(join(directory, "cloud-relay"), "utf8")).toBe("invalid");
  expect(await readdir(directory)).toEqual(["cloud-relay"]);
});
test("existing environment gateway identity is adopted without preparing a second owner or changing TLS paths", async () => {
  const tls = tlsFiles(directory),
    gatewayId = "26435b2c-768a-4ce8-ae85-72ade9c2d529";
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
      OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
      OMNESIS_TLS_CERT: tls.certFile,
      OMNESIS_TLS_KEY: tls.keyFile,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "legacy-session"),
    },
    controller: undefined,
    stopLegacy: vi.fn(async () => {}),
    probe: undefined,
  });
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("/_relay/v3/account-keys")
      ? new Response(null, { status: 404 })
      : Response.json({ resource: "https://gateway.example.test/mcp" }),
  );
  vi.stubGlobal("fetch", transport);
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(manager.hasSavedConfiguration()).toBe(true);
  expect(manager.managesPublicCertificate()).toBe(false);
  manager.start();
  await idle();
  expect((await manager.status()).gatewayId).toBe(gatewayId);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  await manager.disable();
  expect(f.options.stopLegacy).toHaveBeenCalled();
  await manager.configure({ ...input, acmeDirectoryUrl: "https://ca.example.test/directory" });
  expect(f.prepare).not.toHaveBeenCalled();
  expect((await manager.status()).gatewayId).toBe(gatewayId);
  expect(JSON.stringify(await manager.status())).not.toContain("legacy-session");
});
test("public invitation policy requests an invitation only before first enrollment and persists it privately", async () => {
  const f = fixture();
  f.discover.mockImplementation(async (_url, gatewayId) => ({
    protocol: 2,
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    invitationRequired: true,
    dnsChallenges: true,
  }));
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await expect(manager.enable()).rejects.toMatchObject({ code: "invitation-required" });
  await manager.enable({ invitation: "secret-invitation" });
  await idle();
  await manager.disable();
  await manager.enable();
  await idle();
  await manager.disable();
  await writeFile(
    join(directory, "cloud-relay/session.json"),
    JSON.stringify({ authentication: "gateway-key-v2" }),
  );
  await manager.enable();
  await idle();
});
test("preparation is serialized and reconfiguration defaults terms to explicit unaccepted", async () => {
  const f = fixture();
  let release!: () => void;
  f.prepare.mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gatewayId: value.gatewayId, accountId: "a".repeat(64) };
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  const preparing = manager.configure({ relayUrl: input.relayUrl });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "operation-in-progress" });
  // No configuration is visible until the owner identity preparation succeeds.
  await expect(manager.enable()).rejects.toMatchObject({ code: "operation-in-progress" });
  release();
  await preparing;
  expect((await manager.status()).config.termsAccepted).toBe(false);
  expect(manager.managesPublicCertificate()).toBe(true);
});
test("hourly refresh keeps a fresh certificate and retries a failed endpoint without exposing endpoint errors", async () => {
  const f = fixture({ probe: undefined });
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ resource: "https://gateway.example.test/mcp" }))
    .mockResolvedValueOnce(Response.json(null))
    .mockResolvedValueOnce(Response.json({ resource: "https://wrong.test/mcp" }));
  vi.stubGlobal("fetch", transport);
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  f.renew.mockResolvedValue(false);
  await manager.enable();
  await idle();
  expect((await manager.status()).publicMcp.ready).toBe(false);
  await manager.renew();
  await idle();
  expect((await manager.status()).publicMcp.ready).toBe(true);
  await manager.renew();
  await idle();
  expect((await manager.status()).publicMcp.ready).toBe(false);
  await manager.renew();
  await idle();
  expect((await manager.status()).publicMcp.ready).toBe(false);
  transport.mockRejectedValueOnce(new Error("private-endpoint-details"));
  await manager.renew();
  await idle();
  // Still being looked at again, so not reported as an error yet, and never with its details.
  expect((await manager.status()).publicMcp).toMatchObject({ ready: false });
  expect(JSON.stringify(await manager.status())).not.toContain("private-endpoint-details");
  expect((await manager.status()).certificate.lastError).toBeUndefined();
});
test("manager registration forwards the configuration scope to the real encrypted TLS key reader", async () => {
  const configDir = await realpath(directory);
  await core.ensureInstallRootKey({ backend: "file", configDir });
  await core.primeSecretFileKeyCache({ backend: "file", configDir });
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const register = vi.fn<NonNullable<CloudRelayManagerOptions["register"]>>(async (options) => {
    // The unchanged production reader refuses an encrypted key if this scope is missing.
    expect(
      (await readGatewayTlsPrivateKey(options.privateKeyFile, options.configDir)) === pem,
    ).toBe(true);
    return {
      token: "fictional-registration-session",
      accountId: "a".repeat(64),
      expiresAt: 4000000000,
    };
  });
  const f = fixture({
    configDir,
    register,
    controller: async (env) => {
      const path = env.OMNESIS_ACME_KEY_FILE;
      if (!path) throw new Error("The fixture public TLS key path was not selected");
      await core.writeSecretTextFile(path, pem, { configDir });
      expect(core.isEncryptedSecretFile(await readFile(path, "utf8"))).toBe(true);
      return {
        renew: async () => true,
        close: async () => {},
        cleanupFailure: () => undefined,
        fingerprintSha256: () => "b".repeat(64),
        spkiFingerprintSha256: () => "c".repeat(64),
      };
    },
  });
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  try {
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure(input);
    await manager.enable();
    await idle();
    expect((await manager.status()).enrollment.state).toBe("enrolled");
    expect(register).toHaveBeenCalledOnce();
  } finally {
    await manager?.close();
    manager = undefined;
    core.clearSecretFileKeyCacheForTests();
    vi.unstubAllEnvs();
  }
});

test("a missing certificate controller fails managed setup without starting a tunnel", async () => {
  const f = fixture({ controller: vi.fn(async () => undefined) });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  expect((await manager.status()).enrollment).toEqual({
    state: "failed",
    error: "enrollment-refused",
  });
  expect(f.options.startTunnel).not.toHaveBeenCalled();
});
test("Google delegate remains independently optional and never bypasses configured gateway enrollment", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(manager.verifiedGoogleOwnerAccountId()).toBeUndefined();
  await expect(
    manager.googleLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "configuration-invalid" });
  await expect(manager.googleUnlink()).rejects.toMatchObject({ code: "configuration-invalid" });
  await manager.configure(input);
  await manager.enable();
  await idle();
  await expect(
    manager.googleLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "google-unavailable" });
  await expect(
    manager.googleCallback({
      url: "https://gateway.example.test/admin/cloud-relay/google/callback",
    }),
  ).rejects.toMatchObject({ code: "google-unavailable" });
  // Google configuration is not needed to remove a previously established directory alias.
  const transport = vi.mocked(f.options.fetch);
  transport.mockClear();
  transport.mockImplementation(async () => new Response(null, { status: 204 }));
  await manager.googleUnlink();
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    "https://relay.example.test/_relay/v2/key/google-link",
  ]);
  expect((await manager.status()).enabled).toBe(true);
});
test("disabled restart restores the existing hostname-specific context without renewal, and wrong-host material fails closed", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  const files = tlsFiles(directory, "gateway.example.test");
  await writeFile(join(directory, "cloud-relay/public.pem"), await readFile(files.certFile));
  await writeFile(join(directory, "cloud-relay/public.key"), await readFile(files.keyFile));
  await registeredEarlier();
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(f.options.activate).toHaveBeenCalledWith(
    expect.objectContaining({ hostname: "gateway.example.test" }),
    expect.any(AbortSignal),
  );
  expect(manager.fingerprintSha256()).toMatch(/^[a-f0-9]{64}$/);
  expect(manager.spkiFingerprintSha256()).toMatch(/^[a-f0-9]{64}$/);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.renew).not.toHaveBeenCalled();
  await manager.close();
  tlsFiles(directory, "different.example.test");
  await writeFile(join(directory, "cloud-relay/public.pem"), await readFile(files.certFile));
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(manager.fingerprintSha256()).toBeUndefined();
  expect((await manager.status()).certificate.lastError).toBe("certificate-setup-failed");
});
test("legacy ACME adoption retains its explicit certificate identity, enrollment source and terms flag", async () => {
  const files = tlsFiles(directory, "gateway.example.test"),
    f = fixture({
      env: {
        OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: "26435b2c-768a-4ce8-ae85-72ade9c2d529",
        OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://gateway.example.test",
        OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "legacy-session"),
        OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
        OMNESIS_ACME_TERMS_ACCEPTED: "1",
        OMNESIS_ACME_CERT_FILE: files.certFile,
        OMNESIS_ACME_KEY_FILE: files.keyFile,
      },
    });
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await idle();
  expect(manager.managesPublicCertificate()).toBe(true);
  expect(f.register).toHaveBeenCalledWith(
    expect.objectContaining({ certificateFile: files.certFile, privateKeyFile: files.keyFile }),
  );
  await manager.disable();
  await manager.enable({ invitation: "fixture-legacy-invitation" });
  await idle();
  expect(
    JSON.parse(await readFile(join(f.options.configDir, "cloud-relay/invitation.json"), "utf8")),
  ).toEqual({ enrollmentToken: "fixture-legacy-invitation" });
});
test("configuration updates serialize against enable and active renewal timer executes only while enabled", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  let release!: () => void;
  f.prepare.mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gatewayId: value.gatewayId, accountId: "a".repeat(64) };
  });
  const update = manager.configure(input);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(manager.enable()).rejects.toMatchObject({ code: "operation-in-progress" });
  release();
  await update;
  vi.useFakeTimers();
  try {
    await manager.enable();
    await idle();
    const calls = f.register.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3600_000);
    await idle();
    expect(f.register).toHaveBeenCalledTimes(calls + 1);
    await manager.disable();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(f.register).toHaveBeenCalledTimes(calls + 1);
  } finally {
    vi.useRealTimers();
  }
});
test("an address that was not reachable at the first check is checked again shortly after", async () => {
  const probe = vi
    .fn<(origin: string, signal: AbortSignal) => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("not yet"))
    .mockResolvedValue(true);
  const f = fixture({ probe, probeRetryMs: 1 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  const registrations = f.register.mock.calls.length;
  await vi.waitFor(async () =>
    expect((await manager!.status()).publicMcp).toMatchObject({ ready: true }),
  );
  expect((await manager.status()).publicMcp.lastError).toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(3);
  // Only the address was looked at again: the gateway did not register a second time.
  expect(f.register).toHaveBeenCalledTimes(registrations);
});
/**
 * A tunnel the relay accepts only when the test says so. The relay drops a public connection for a
 * gateway whose tunnel is not online, so the probe answers from the tunnel's state.
 */
function heldTunnel() {
  let state: "connecting" | "online" = "connecting";
  const waiting: Array<() => void> = [];
  const tunnel = {
    stop: vi.fn(),
    close: async () => {},
    cleanupFailure: () => undefined,
    status: () => ({ state }),
    online: vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (state === "online") return resolve();
          waiting.push(resolve);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    ),
  };
  return {
    startTunnel: vi.fn(() => tunnel) as unknown as CloudRelayManagerOptions["startTunnel"],
    tunnel,
    probe: vi.fn(async () => state === "online"),
    goOnline() {
      state = "online";
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}
test("the public address is looked at once the tunnel is online, not before", async () => {
  const held = heldTunnel();
  // No recheck comes to the rescue: only the first look can make the address ready.
  const f = fixture({ startTunnel: held.startTunnel, probe: held.probe, probeRetryMs: 3600_000 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  // The launch has reached its look at the address: it is waiting for the tunnel, or has probed.
  await vi.waitFor(() =>
    expect(held.tunnel.online.mock.calls.length + held.probe.mock.calls.length).toBeGreaterThan(0),
  );
  held.goOnline();
  await vi.waitFor(async () => expect((await manager!.status()).publicMcp.ready).toBe(true));
  expect(held.probe).toHaveBeenCalledOnce();
});
test("a tunnel that does not come online delays the first look by one recheck interval at most", async () => {
  const held = heldTunnel();
  const f = fixture({ startTunnel: held.startTunnel, probe: held.probe, probeRetryMs: 1 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await vi.waitFor(() => expect(held.probe).toHaveBeenCalledTimes(21));
  expect((await manager.status()).publicMcp).toMatchObject({
    ready: false,
    lastError: "public-endpoint-unreachable",
  });
});
test("rechecks of an unreachable address stop after a while and leave it to the hourly refresh", async () => {
  const probe = vi.fn(async () => false);
  const f = fixture({ probe, probeRetryMs: 1 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(21));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(probe).toHaveBeenCalledTimes(21);
  expect((await manager.status()).publicMcp).toMatchObject({
    ready: false,
    lastError: "public-endpoint-unreachable",
  });
});
test("a recheck that finishes after the relay was turned off changes nothing", async () => {
  let finish: (ready: boolean) => void = () => {};
  const probe = vi
    .fn<(origin: string, signal: AbortSignal) => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const f = fixture({ probe, probeRetryMs: 1 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  // While it is still being looked at, the page is told nothing is wrong.
  expect((await manager.status()).publicMcp.lastError).toBeUndefined();
  let disabled = false;
  const stopping = manager.disable().then(() => {
    disabled = true;
  });
  await vi.waitFor(() => expect(probe.mock.calls[1]?.[1].aborted).toBe(true));
  expect(disabled).toBe(false);
  finish(true);
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await manager.status()).publicMcp.ready).toBe(false);
  expect(probe).toHaveBeenCalledTimes(2);
});
test("legacy manual sessions can report missing certificate material without touching default TLS paths", async () => {
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "26435b2c-768a-4ce8-ae85-72ade9c2d529",
      OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "manual-session"),
    },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.status()).certificate.state).toBe("unconfigured");
});
test("adopted legacy ACME never treats omitted CA consent as accepted", async () => {
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "26435b2c-768a-4ce8-ae85-72ade9c2d529",
      OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.test/directory",
    },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.status()).config.termsAccepted).toBe(false);
  await manager.disable();
  await expect(manager.enable()).rejects.toMatchObject({ code: "ca-terms-required" });
});
test("Google management capabilities require a prepared enabled enrollment and unlink requires an existing gateway configuration", async () => {
  const { GatewayGoogleWeb } = await import("./google-gateway-web.js");
  vi.spyOn(GatewayGoogleWeb.prototype, "status").mockReturnValue({
    configured: true,
    linked: true,
    canLink: true,
    canUnlink: true,
    linkOrigin: "https://gateway.example.test",
    lastError: undefined,
  });
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.status()).google).toMatchObject({ canLink: false, canUnlink: false });
  await manager.configure(input);
  expect((await manager.status()).google).toMatchObject({ canLink: false, canUnlink: true });
  await manager.enable();
  await idle();
  expect((await manager.status()).google).toMatchObject({ canLink: true, canUnlink: true });
});

test("private persistence failure cannot leave an explicitly disabled tunnel running or publish an uncommitted enable/configuration", async () => {
  const store = await import("./google-credentials.js"),
    f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const save = vi.spyOn(store, "savePrivateJson");
  save.mockRejectedValueOnce(new Error("synthetic disk failure"));
  await expect(manager.configure(input)).rejects.toThrow("synthetic disk failure");
  expect(manager.hasSavedConfiguration()).toBe(false);
  expect(manager.isExposing()).toBe(false);
  await manager.configure(input);
  save.mockRejectedValueOnce(new Error("synthetic disk failure"));
  await expect(manager.enable()).rejects.toThrow("synthetic disk failure");
  expect(manager.isExposing()).toBe(false);
  expect(f.register).not.toHaveBeenCalled();
  await manager.enable();
  await idle();
  expect(manager.isExposing()).toBe(true);
  save.mockRejectedValueOnce(new Error("synthetic disk failure"));
  await expect(manager.disable()).rejects.toThrow("synthetic disk failure");
  expect(f.stop).toHaveBeenCalled();
  expect(f.close).toHaveBeenCalled();
  expect(manager.isExposing()).toBe(false);
  expect((await manager.status()).enabled).toBe(false);
});

test("fresh public SNI identities reject default certificate names, aliases and wildcard coverage before key preparation", async () => {
  const { X509Certificate } = await import("node:crypto");
  for (const [names, publicOrigin] of [
    ["direct.example.test", "https://direct.example.test"],
    ["direct.example.test,DNS:alias.example.test", "https://alias.example.test"],
    ["*.example.test", "https://gateway.example.test"],
  ]) {
    const certificate = new X509Certificate(await readFile(tlsFiles(directory, names).certFile));
    const f = fixture({
      directCertificateCoversHostname: (hostname) => certificate.checkHost(hostname) !== undefined,
    });
    manager = await GatewayCloudRelayManagement.open(f.options);
    await expect(manager.configure({ ...input, publicOrigin })).rejects.toMatchObject({
      code: "hostname-conflict",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.options.activate).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    await manager.close();
    manager = undefined;
  }
});
test("default certificate changes between preparation and enable or restart cannot create a colliding public identity", async () => {
  let conflicts = false;
  const f = fixture({ directCertificateCoversHostname: () => conflicts });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  conflicts = true;
  await expect(manager.enable()).rejects.toMatchObject({ code: "hostname-conflict" });
  expect(f.register).not.toHaveBeenCalled();
  const files = tlsFiles(directory, "gateway.example.test");
  await writeFile(join(directory, "cloud-relay/public.pem"), await readFile(files.certFile));
  await writeFile(join(directory, "cloud-relay/public.key"), await readFile(files.keyFile));
  await registeredEarlier();
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(f.options.activate).not.toHaveBeenCalled();
  expect((await manager.status()).certificate.lastError).toBe("certificate-setup-failed");
  conflicts = false;
  await manager.enable();
  await idle();
  await manager.close();
  conflicts = true;
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await idle();
  expect((await manager.status()).enrollment).toMatchObject({
    state: "failed",
    error: "hostname-conflict",
  });
});
test("legacy same-listener TLS remains supported while legacy ACME cannot mint a distinct colliding public identity", async () => {
  const env = {
    OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "26435b2c-768a-4ce8-ae85-72ade9c2d529",
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
  };
  const f = fixture({
    env,
    directCertificateCoversHostname: () => true,
    controller: vi.fn(async () => undefined),
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await idle();
  expect((await manager.status()).enrollment.state).toBe("enrolled");
  await manager.close();
  manager = await GatewayCloudRelayManagement.open({
    ...f.options,
    env: {
      ...env,
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
      OMNESIS_ACME_TERMS_ACCEPTED: "1",
    },
  });
  manager.start();
  await idle();
  expect((await manager.status()).enrollment).toMatchObject({
    state: "failed",
    error: "hostname-conflict",
  });
});

test("portal cannot select the relay and rejection happens before discovery or owner-key creation", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await expect(manager.configure({ relayUrl: "https://other.example.test" })).rejects.toMatchObject(
    { status: 400, code: "relay-service-mismatch" },
  );
  expect(f.discover).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  await manager.configure({ relayUrl: "https://relay.example.test:443/", termsAccepted: true });
  expect(f.discover).toHaveBeenCalledWith(
    "https://relay.example.test",
    expect.any(String),
    expect.any(AbortSignal),
    f.options.fetch,
  );
});
test("new setup uses distribution default without a request URL and restart preserves the selected installation", async () => {
  // The distribution's relay brings the official DNS broker, answered here by one in memory.
  const broker = await brokerHarness({
    origin: "https://dns.omnesis.app",
    relayDomain: "relay.omnesis.app",
    fallback: offline,
  });
  const f = fixture({ env: {}, fetch: broker.fetch });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(await manager.status()).toMatchObject({
    serviceConfigured: true,
    config: { relayUrl: "https://relay.omnesis.app" },
  });
  const { gatewayId } = await manager.configure({ termsAccepted: true });
  expect(f.discover).toHaveBeenCalledWith(
    "https://relay.omnesis.app",
    gatewayId,
    expect.any(AbortSignal),
    f.options.fetch,
  );
  const name = `name:${hostedGatewayHostname(gatewayId!, "relay.omnesis.app")}`;
  expect(broker.calls).toEqual(["/_dns/v2/health", "/_dns/v2/challenge", "/_dns/v2/complete"]);
  expect(broker.store.values.get(name)).toMatchObject({ gatewayId });
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const restarted = await manager.configure({ termsAccepted: true });
  expect(restarted.config.relayUrl).toBe("https://relay.omnesis.app");
  expect(restarted.gatewayId).toBe(gatewayId);
  // The restarted gateway claims its name again, which the broker already binds to it.
  expect([...broker.store.values.keys()].filter((key) => key.startsWith("name:"))).toEqual([name]);
});
test("invalid operator service disables configuration with an actionable static failure", async () => {
  const f = fixture({ env: { OMNESIS_CLOUD_RELAY_URL: "invalid" } });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(await manager.status()).toMatchObject({
    serviceConfigured: false,
    can: { configure: false },
  });
  await expect(manager.configure({})).rejects.toMatchObject({
    status: 503,
    code: "relay-service-unavailable",
  });
  expect(f.discover).not.toHaveBeenCalled();
});

test("saved installation service survives restart but conflicting operator override cannot migrate its credentials", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const first = await manager.configure(input);
  await manager.close();
  manager = await GatewayCloudRelayManagement.open({
    ...f.options,
    env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0" },
  });
  expect((await manager.configure({ termsAccepted: true })).config.relayUrl).toBe(input.relayUrl);
  await manager.close();
  const changed = fixture({ env: { OMNESIS_CLOUD_RELAY_URL: "https://another.example.test" } });
  manager = await GatewayCloudRelayManagement.open(changed.options);
  expect(await manager.status()).toMatchObject({
    serviceConfigured: false,
    serviceError: "relay-service-mismatch",
    gatewayId: first.gatewayId,
    config: { relayUrl: input.relayUrl },
    can: { configure: false },
  });
  await expect(manager.configure({})).rejects.toMatchObject({
    status: 400,
    code: "relay-service-mismatch",
  });
  expect(changed.discover).not.toHaveBeenCalled();
  expect(changed.prepare).not.toHaveBeenCalled();
});

test("manager exposes only optional local recovery receipt health without keys, receipt contents or an authority-verification claim", async () => {
  const { prepareGatewayOwner, prepareGatewayRecoveryRequest } =
    await import("./gateway-key-client.js");
  const { createRecoveryAuthority, signRecoveryReceipt } = await import("./recovery-authority.js");
  const receiptFile = join(directory, "independent-receipt.json");
  const f = fixture({
    prepare: prepareGatewayOwner,
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE: receiptFile,
    },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.status()).recovery).toBeUndefined();
  const saved = await manager.configure(input);
  expect(saved.recovery).toEqual({ receipt: "missing" });
  const draft = await prepareGatewayRecoveryRequest({
    relayUrl: input.relayUrl,
    sessionFile: join(directory, "cloud-relay/session.json"),
    ownerKeyFile: join(directory, "cloud-relay/owner.key"),
    gatewayId: saved.gatewayId!,
    publicOrigin: "https://gateway.example.test",
  });
  const receipt = signRecoveryReceipt(
    {
      ...draft,
      keyId: "independent",
      relayDomain: "relay.example.test",
      recoveryEpoch: 1,
      issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    createRecoveryAuthority().privateKey,
  );
  await writeFile(receiptFile, JSON.stringify(receipt));
  const status = (await manager.status()).recovery;
  expect(status).toEqual({
    receipt: "present",
    expiresAt: new Date(receipt.payload.expiresAt * 1000).toISOString(),
  });
  expect(JSON.stringify(status)).not.toMatch(/verified|protected|PRIVATE|account|signature|\.json/);
  await writeFile(receiptFile, "malformed-private-fixture");
  expect((await manager.status()).recovery).toEqual({ receipt: "invalid" });
});

test("optional certificate observer starts after configuration readiness and shutdown drains cloud work even if observer close refuses", async () => {
  const observer = {
    cleanupFailure: () => undefined,
    start: vi.fn(),
    status: vi.fn(() => ({
      enabled: true,
      provider: "certspotter" as const,
      state: "pending" as const,
      incidents: [],
    })),
    close: vi.fn(async () => {}),
  };
  const f = fixture({ certificateMonitor: observer });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(observer.start).not.toHaveBeenCalled();
  manager.start();
  expect(observer.start).toHaveBeenCalledOnce();
  expect((await manager.configure(input)).certificateMonitor).toMatchObject({
    enabled: true,
    state: "pending",
  });
  await manager.enable();
  await idle();
  expect(observer.start).toHaveBeenCalledTimes(2);
  await manager.disable();
  expect(observer.close).not.toHaveBeenCalled();
  await manager.enable();
  await idle();
  const stopped = f.stop.mock.calls.length,
    closed = f.close.mock.calls.length;
  observer.close.mockRejectedValueOnce(new CloudRelayManagementFailure(503, "relay-unreachable"));
  const closing = manager.close();
  try {
    expect(manager.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ code: "relay-unreachable" });
    expect(f.stop).toHaveBeenCalledTimes(stopped + 1);
    expect(f.close).toHaveBeenCalledTimes(closed + 1);
  } finally {
    // Only the joined ordinary refusal releases the fixture. Any unconfirmed native
    // work must still prevent the suite teardown from deleting its files.
    if (core.ownedProcessCleanupReceipt(manager.cleanupFailure()) === undefined)
      manager = undefined;
  }
});

test("opted-in default observer sends nothing before setup or local public-key readiness, then initializes independently without portal polling", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  vi.stubGlobal("fetch", transport);
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
    },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  expect((await manager.status()).certificateMonitor?.state).toBe("pending");
  expect(transport).not.toHaveBeenCalled();
  await manager.configure(input);
  expect(transport).not.toHaveBeenCalled();
  await manager.enable();
  await idle();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  await vi.waitFor(async () =>
    expect((await manager!.status()).certificateMonitor?.state).toBe("observing"),
  );
  expect(String(transport.mock.calls[0][0])).toContain(
    "https://api.certspotter.com/v1/issuances?domain=gateway.example.test",
  );
});

test("a certificate for the public name with a key the gateway doesn't serve holds new devices until the owner acknowledges it, across a restart", async () => {
  const { X509Certificate } = await import("node:crypto");
  const { tlsSpkiFingerprint } = await import("./pinned-key.js");
  await mkdir(join(directory, "served"));
  await mkdir(join(directory, "rogue"));
  const served = await readFile(
    tlsFiles(join(directory, "served"), "gateway.example.test").certFile,
    "utf8",
  );
  const rogue = new X509Certificate(
    await readFile(tlsFiles(join(directory, "rogue"), "gateway.example.test").certFile),
  );
  const rogueFingerprint = rogue.fingerprint256.replaceAll(":", "").toLowerCase();
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([
        // The certificate the gateway serves, though not one it manages: no incident.
        { id: "1", cert_der: new X509Certificate(served).raw.toString("base64") },
        { id: "2", cert_der: rogue.raw.toString("base64") },
      ]),
    )
    .mockResolvedValue(Response.json([]));
  vi.stubGlobal("fetch", transport);
  const onIncidentHold = vi.fn();
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
    },
    publicSpkiFingerprint: () => tlsSpkiFingerprint(served),
    onIncidentHold,
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  const held = await vi.waitFor(async () => {
    const status = await manager!.status();
    expect(status.incidentHold).toBeDefined();
    return status;
  });
  expect(held.incidentHold!.certificates).toEqual([rogueFingerprint]);
  expect(held.certificateMonitor!.incidents.map((incident) => incident.providerEntryId)).toEqual([
    "2",
  ]);
  expect(held.deviceEnrollment!.policy).toBe("ask");
  expect(onIncidentHold).toHaveBeenCalledOnce();

  // After a restart the hold is read back, and the journal's report of the same certificate is
  // not news to anyone.
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await vi.waitFor(async () =>
    expect((await manager!.status()).certificateMonitor?.incidents).toHaveLength(1),
  );
  expect((await manager.status()).incidentHold!.certificates).toEqual([rogueFingerprint]);
  expect(onIncidentHold).toHaveBeenCalledOnce();

  const before = (await manager.status()).revision;
  const acknowledged = await manager.acknowledgeIncidentHold();
  expect(acknowledged).not.toHaveProperty("incidentHold");
  expect(acknowledged.revision).toBeGreaterThan(before);
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await vi.waitFor(async () =>
    expect((await manager!.status()).certificateMonitor?.incidents).toHaveLength(1),
  );
  expect(await manager.status()).not.toHaveProperty("incidentHold");
  expect(onIncidentHold).toHaveBeenCalledOnce();
});

test("managed Google capabilities are fetched only after enrollment and expose a server-only port without user OAuth setup", async () => {
  const capabilities = {
    protocol: "omnesis-google-browser-v1",
    ownerLinkClientId: "managed-owner-client",
    deviceEnrollmentClientId: "managed-device-client",
    deviceClientIds: ["managed-device-client"],
    deviceAuthorizedParties: ["managed-device-client", "managed-android"],
  };
  const transport = vi.fn<typeof fetch>(async () => Response.json(capabilities));
  const f = fixture({
    fetch: transport,
    env: { OMNESIS_CLOUD_RELAY_URL: input.relayUrl },
    googleTrust: () => ({
      ownerLinkClientId: "managed-owner-client",
      deviceEnrollmentClientId: "managed-device-client",
      deviceClientIds: ["managed-device-client"],
      deviceAuthorizedParties: ["managed-android"],
    }),
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(manager.managedGoogleBrowser()).toBeUndefined();
  expect(transport).not.toHaveBeenCalled();
  await manager.configure(input);
  expect(manager.managedGoogleBrowser()).toBeUndefined();
  expect(transport).not.toHaveBeenCalled();
  let release!: () => void;
  const register = f.register.getMockImplementation()!;
  f.register.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return register();
  });
  await manager.enable();
  expect(manager.managedGoogleBrowser()).toBeUndefined();
  release();
  await idle();
  expect(manager.managedGoogleBrowser()?.clientId("owner-link")).toBe("managed-owner-client");
  expect(manager.managedGoogleBrowser()?.deviceIdentity()).toEqual({
    clientIds: ["managed-device-client"],
    authorizedParties: ["managed-device-client", "managed-android"],
  });
  expect(await manager.status()).toMatchObject({
    google: { configured: true, canLink: true, linked: false },
  });
  // Google's capabilities are read once; the account sign-in probe is its own request.
  expect(
    transport.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/google/")),
  ).toEqual(["https://relay.example.test/_relay/v2/google/browser/config"]);
  await manager.disable();
  expect(manager.managedGoogleBrowser()).toBeUndefined();
});

test("disable during managed capability lookup cannot leave a late tunnel behind", async () => {
  let release!: () => void;
  const transport = vi.fn<typeof fetch>(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({
      protocol: "omnesis-google-browser-v1",
      deviceClientIds: [],
      deviceAuthorizedParties: [],
    });
  });
  const f = fixture({
    fetch: transport,
    env: { OMNESIS_CLOUD_RELAY_URL: input.relayUrl },
    googleTrust: () => ({
      ownerLinkClientId: "managed-owner-client",
      deviceClientIds: [],
      deviceAuthorizedParties: [],
    }),
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const disabling = manager.disable();
  await vi.waitFor(() => expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true));
  release();
  await disabling;
  expect(f.options.startTunnel).not.toHaveBeenCalled();
  expect(manager.managedGoogleBrowser()).toBeUndefined();
  expect(await manager.status()).toMatchObject({ enabled: false, tunnel: { state: "disabled" } });
});

test("the compiled-in official google clients enable managed sign-in with no google configuration", async () => {
  const official = googleBrowserTrust();
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      protocol: "omnesis-google-browser-v1",
      ownerLinkClientId: official.ownerLinkClientId,
      deviceEnrollmentClientId: official.deviceEnrollmentClientId,
      deviceClientIds: official.deviceClientIds,
      deviceAuthorizedParties: official.deviceAuthorizedParties,
    }),
  );
  const f = fixture({ fetch: transport, env: { OMNESIS_CLOUD_RELAY_URL: input.relayUrl } });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  expect(manager.managedGoogleBrowser()?.clientId("owner-link")).toBe(official.ownerLinkClientId);
  expect(manager.managedGoogleBrowser()?.clientId("device-enrollment")).toBe(
    official.deviceEnrollmentClientId,
  );
  expect(manager.managedGoogleBrowser()?.deviceIdentity()).toEqual({
    clientIds: official.deviceClientIds,
    authorizedParties: official.deviceAuthorizedParties,
  });
  expect(await manager.status()).toMatchObject({
    google: { configured: true, canLink: true, linked: false },
  });
});

test("an empty trust registry leaves Google unavailable without querying the relay or disrupting direct and relay operation", async () => {
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error("unconfigured Google must not query a service");
  });
  const googleCalls = () =>
    transport.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/google/"));
  const f = fixture({
    fetch: transport,
    googleTrust: () => ({ deviceClientIds: [], deviceAuthorizedParties: [] }),
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  expect(googleCalls()).toEqual([]);
  expect(await manager.status()).toMatchObject({
    enabled: true,
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    google: { configured: false, linked: false, canLink: false },
    identities: [{ id: "direct", state: "valid" }, { id: "cloud" }],
  });
  expect(manager.managedGoogleBrowser()?.deviceIdentity()).toBeUndefined();
  await expect(
    manager.googleLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "google-unavailable" });
  expect(googleCalls()).toEqual([]);
  expect(f.options.startTunnel).toHaveBeenCalledOnce();
});

test("relay-advertised OAuth IDs outside independent installation trust cannot enable linking or device identities", async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      protocol: "omnesis-google-browser-v1",
      ownerLinkClientId: "untrusted-owner",
      deviceEnrollmentClientId: "untrusted-device",
      deviceClientIds: ["untrusted-device"],
      deviceAuthorizedParties: ["untrusted-device"],
    }),
  );
  const f = fixture({
    fetch: transport,
    env: { OMNESIS_CLOUD_RELAY_URL: input.relayUrl },
    googleTrust: () => ({
      ownerLinkClientId: "trusted-owner",
      deviceEnrollmentClientId: "trusted-device",
      deviceClientIds: [],
      deviceAuthorizedParties: [],
    }),
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  expect(await manager.status()).toMatchObject({
    enabled: true,
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    google: { configured: false, canLink: false, lastError: "google-unavailable" },
  });
  expect(manager.managedGoogleBrowser()?.deviceIdentity()).toBeUndefined();
  await expect(
    manager.googleLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "google-unavailable" });
  expect(f.options.startTunnel).toHaveBeenCalledOnce();
  expect(f.register).toHaveBeenCalledOnce();
});

test("provider-independent account controls remain unavailable until configured and enrolled, then delegate without replacing gateway identities", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(manager.managedAccountBrowser()).toBeUndefined();
  expect(manager.accountModeActivated()).toBe(false);
  expect(manager.accountPairingIdentity()).toBeUndefined();
  expect(manager.verifiedAccountId()).toBeUndefined();
  await expect(
    manager.accountLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "configuration-invalid" });
  await expect(manager.accountUnlink()).rejects.toMatchObject({ code: "configuration-invalid" });
  await manager.configure({ termsAccepted: true });
  await expect(
    manager.accountLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "configuration-invalid" });
  await manager.enable();
  await idle();
  const before = await manager.status();
  expect(manager.managedAccountBrowser()?.available()).toBe(false);
  await expect(
    manager.accountLink({ requestOrigin: "https://gateway.example.test" }),
  ).rejects.toMatchObject({ code: "account-unavailable" });
  await expect(
    manager.accountCallback({
      url: "https://gateway.example.test/admin/cloud-relay/account/callback",
    }),
  ).rejects.toThrow();
  // Disconnecting turns remote access off; the gateway keeps its id and its addresses' identities.
  const unlinked = await manager.accountUnlink();
  expect(unlinked).toMatchObject({
    configured: true,
    enabled: false,
    enrollment: { state: "unconfigured" },
    tunnel: { state: "disabled" },
    account: { activated: false, linked: false },
  });
  expect(unlinked).not.toHaveProperty("notice");
  expect(manager.accountModeActivated()).toBe(false);
  expect(unlinked.gatewayId).toBe(before.gatewayId);
  expect(unlinked.identities![0]).toEqual(before.identities![0]);
});

test("account linking is offered only while the optional service is ready and the gateway enrollment is active", async () => {
  const authority = new AccountEnrollmentAuthority(
    "https://relay.example.test",
    generateKeyPairSync("ed25519").privateKey,
  );
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    },
    fetch: vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/_relay/v3/account-keys")
        ? Response.json(authority.jwks())
        : new Response(null, { status: 404 }),
    ),
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  expect((await manager.status()).account?.canLink).toBe(true);
  // Capability probes expire after a minute; certificate maintenance runs hourly.
  // An idle, healthy gateway must keep offering account linking between those jobs.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  try {
    expect((await manager.status()).account).toMatchObject({ configured: true, canLink: true });
  } finally {
    clock.mockRestore();
  }
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(f.options.controller!).mockImplementationOnce(async () => {
    await held;
    return {
      cleanupFailure: () => undefined,
      close: f.close,
      renew: f.renew,
      fingerprintSha256: () => "b".repeat(64),
      spkiFingerprintSha256: () => "c".repeat(64),
    };
  });
  const reconnect = await manager.reconnect();
  expect(reconnect.account?.canLink).toBe(false);
  release();
  await idle();
  expect((await manager.status()).account?.canLink).toBe(true);
  await manager.disable();
  expect((await manager.status()).account?.canLink).toBe(false);
});

/** A manager whose relay is the in-memory signup relay; the owner key exists as `prepare` makes it. */
async function connecting(
  relay = fakeSignupRelay(),
  overrides: Partial<CloudRelayManagerOptions> = {},
) {
  const f = fixture({
    configDir: await mkdtemp(join(directory, "connect-")),
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    },
    fetch: relay.fetch,
    prepare: vi.fn(async (value: { gatewayId: string; ownerKeyFile: string }) => {
      await readOrCreateGatewayOwnerKey(value.ownerKeyFile);
      return { gatewayId: value.gatewayId, accountId: "a".repeat(64) };
    }) as unknown as CloudRelayManagerOptions["prepare"],
    ...overrides,
  });
  return { ...f, relay };
}
async function settled(state: string) {
  await vi.waitFor(async () => expect((await manager!.status()).connect?.state).toBe(state), {
    timeout: 10_000,
  });
  return manager!.status();
}

test("connecting passes the person's choice to create an account or sign in on to the relay", async () => {
  for (const intent of ["create", "existing"] as const) {
    const f = await connecting();
    manager = await GatewayCloudRelayManagement.open(f.options);
    expect((await manager.connect({ termsAccepted: true, intent })).connect).toMatchObject({
      state: "waiting",
    });
    expect(f.relay.started()).toMatchObject({ intent });
    await manager.cancelConnect();
    await manager.close();
    manager = undefined;
  }
});

const fictionalInvite = signInvite(generateKeyPairSync("ed25519").privateKey, {
  origin: "https://relay.example.test",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
const inviteAnswer = (status: "valid" | "invalid" | "expired" | "used") => () =>
  Response.json(status === "valid" ? { status, expiresAt: 1_900_000_000 } : { status });

test("an invite is checked with the relay before anything else, then goes with the sign-up", async () => {
  const f = await connecting();
  f.relay.handle("/_relay/v3/signup/invite", inviteAnswer("valid"));
  manager = await GatewayCloudRelayManagement.open(f.options);
  const link = `https://relay.example.test/invite#${fictionalInvite}`;
  expect(
    (await manager.connect({ termsAccepted: true, intent: "create", invite: link })).connect,
  ).toMatchObject({ state: "waiting" });
  expect(f.relay.calls.indexOf("/_relay/v3/signup/invite")).toBeLessThan(
    f.relay.calls.indexOf("/_relay/v3/signup/start"),
  );
  expect(f.relay.started()).toMatchObject({ intent: "create", invite: fictionalInvite });
});

test("asked again while waiting for the sign-in, a connection carries on only when nothing changed, and starts again with a new choice or invite", async () => {
  const f = await connecting();
  f.relay.handle("/_relay/v3/signup/invite", inviteAnswer("valid"));
  manager = await GatewayCloudRelayManagement.open(f.options);
  const starts = () => f.relay.calls.filter((path) => path === "/_relay/v3/signup/start").length;
  const cancels = () => f.relay.calls.filter((path) => path === "/_relay/v3/signup/cancel").length;
  // Signing in to an account the owner has, then left waiting (the terminal was closed).
  const first = await manager.connect({ termsAccepted: true, intent: "existing" });
  expect(first.connect).toMatchObject({ state: "waiting", intent: "existing" });
  const gatewayId = first.gatewayId;
  // Asked again the same way, or with nothing new, it carries on with the same sign-in.
  for (const again of [{ intent: "existing" as const }, {}]) {
    const same = await manager.connect({ termsAccepted: true, ...again });
    expect(same.connect).toMatchObject({ code: first.connect!.code, intent: "existing" });
  }
  expect([starts(), cancels()]).toEqual([1, 0]);
  // Asked to create an account with an invite: the relay's sign-up is replaced by one that names
  // them, and the gateway keeps the name it reserved.
  const link = `https://relay.example.test/invite#${fictionalInvite}`;
  const created = await manager.connect({ termsAccepted: true, intent: "create", invite: link });
  expect(created.connect).toMatchObject({ state: "waiting", intent: "create" });
  expect(created.gatewayId).toBe(gatewayId);
  expect([starts(), cancels()]).toEqual([2, 1]);
  expect(f.relay.started()).toMatchObject({ intent: "create", invite: fictionalInvite });
  // Another invite starts again too; the same one carries on.
  const other = signInvite(generateKeyPairSync("ed25519").privateKey, {
    origin: "https://relay.example.test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await manager.connect({ termsAccepted: true, intent: "create", invite: link });
  expect(starts()).toBe(2);
  await manager.connect({ termsAccepted: true, intent: "create", invite: other });
  expect([starts(), cancels()]).toEqual([3, 2]);
  expect(f.relay.started()).toMatchObject({ intent: "create", invite: other });
  // The approval then says whether the account was new, against the choice now under way.
  f.relay.poll({ status: "approved", accountCreated: false });
  const done = await settled("done");
  expect(done.connect).toEqual({ state: "done", intent: "create", existingAccount: true });
});

for (const status of ["invalid", "expired", "used"] as const)
  test(`an ${status} invite stops connecting before this gateway claims anything`, async () => {
    const f = await connecting();
    f.relay.handle("/_relay/v3/signup/invite", inviteAnswer(status));
    manager = await GatewayCloudRelayManagement.open(f.options);
    await expect(
      manager.connect({ termsAccepted: true, intent: "create", invite: fictionalInvite }),
    ).rejects.toMatchObject({ code: `invite-${status}` });
    expect(f.relay.calls).toEqual(["/_relay/v3/signup/invite"]);
    expect((await manager.status()).connect).toBeUndefined();
    expect((await manager.status()).configured).toBe(false);
  });

test("a relay that can't check the invite now still gets it at sign-up, and refuses it there", async () => {
  const f = await connecting();
  f.relay.handle("/_relay/v3/signup/invite", () => new Response(null, { status: 503 }));
  f.relay.handle("/_relay/v3/signup/start", () =>
    Response.json({ error: "invite-used" }, { status: 403 }),
  );
  manager = await GatewayCloudRelayManagement.open(f.options);
  await expect(
    manager.connect({ termsAccepted: true, intent: "create", invite: fictionalInvite }),
  ).rejects.toMatchObject({ code: "invite-used" });
  expect(f.relay.calls).toContain("/_relay/v3/signup/start");
  expect((await manager.status()).connect).toBeUndefined();
});

test("without a relay to ask, the invite is not checked ahead", async () => {
  const f = await connecting(undefined, { env: { OMNESIS_SYNTHETIC: "1" } });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager
    .connect({ termsAccepted: true, intent: "create", invite: fictionalInvite })
    .catch(() => undefined);
  expect(f.relay.calls).not.toContain("/_relay/v3/signup/invite");
});

test(
  "connecting by sign-in configures, registers with the invitation and links the account it was promised",
  { timeout: 20_000 },
  async () => {
    const f = await connecting();
    f.relay.poll({ status: "pending" }, { status: "approved", credentialPublicKey: "offered-key" });
    manager = await GatewayCloudRelayManagement.open(f.options);
    await expect(manager.connect({ termsAccepted: false })).rejects.toMatchObject({
      code: "ca-terms-required",
    });
    const waiting = await manager.connect({ termsAccepted: true });
    expect(waiting.connect).toMatchObject({
      state: "waiting",
      connectUrl: "https://relay.example.test/_relay/connect",
      code: "ABCD-EF23",
    });
    // A connect that names no intent opens the sign-in view.
    expect(f.relay.started()).toMatchObject({ intent: "existing" });
    expect(waiting.connect).not.toHaveProperty("connectShortUrl");
    const done = await settled("done");
    expect(done).toMatchObject({ enabled: true, enrollment: { state: "enrolled" } });
    expect(manager.verifiedAccountId()).toBe(f.relay.accountId);
    expect(
      JSON.parse(await readFile(join(f.options.configDir, "cloud-relay/invitation.json"), "utf8")),
    ).toEqual({ enrollmentToken: "fictional-invitation" });
    // The new account's first passkey is pinned locally from the delivered proof.
    expect(done.deviceEnrollment).toMatchObject({
      policy: "automatic",
      trustedSignIns: [{ type: "passkey", id: f.relay.authenticator.id }],
    });
    expect(done.deviceEnrollment).not.toHaveProperty("chosen");
    expect(manager.accountPairingIdentity()?.enrollment.spkiFingerprint()).toBe("c".repeat(64));
    expect(manager.accountPairingIdentity()?.enrollment.policy()).toBe("automatic");
    const asking = await manager.setEnrollmentPolicy("ask");
    expect(asking.deviceEnrollment).toMatchObject({ policy: "ask" });
    const automatic = await manager.setEnrollmentPolicy("automatic");
    expect(automatic.deviceEnrollment).toMatchObject({ policy: "automatic" });
    const removed = await manager.removeTrustedSignIn(f.relay.authenticator.id);
    expect(removed.deviceEnrollment?.trustedSignIns).toEqual([]);
    // Removing it again keeps it declined; an id that is no id is refused.
    expect(
      (await manager.removeTrustedSignIn(f.relay.authenticator.id)).deviceEnrollment
        ?.trustedSignIns,
    ).toEqual([]);
    await expect(manager.removeTrustedSignIn("not an id")).rejects.toMatchObject({
      code: "configuration-invalid",
    });
    expect(removed.revision).toBeGreaterThan(automatic.revision);
    // Confirming a passkey goes to the account link, and the status after it is a new revision.
    const ceremony = { purpose: "pin-passkey" } as ReturnType<
      GatewayAccountLink["passkeyConfirmation"]
    >;
    const options = vi
      .spyOn(GatewayAccountLink.prototype, "passkeyConfirmationOptions")
      .mockResolvedValue(ceremony);
    const confirm = vi.spyOn(GatewayAccountLink.prototype, "confirmPasskey").mockResolvedValue();
    expect(await manager.passkeyConfirmation()).toBe(ceremony);
    const confirmed = await manager.confirmPasskey({ type: "gateway-passkey" });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ type: "gateway-passkey" });
    expect(confirmed.revision).toBeGreaterThan(removed.revision);
    options.mockRestore();
    confirm.mockRestore();
  },
);

test("an already enabled gateway connects without reconfiguring, after a pending poll and a failed one", async () => {
  const f = await connecting();
  f.relay.poll({ status: "unavailable" }, { status: "pending" }, { status: "approved" });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  const registered = f.register.mock.calls.length;
  vi.mocked(f.options.prepare!).mockClear();
  await manager.connect({ termsAccepted: true });
  // A second connect while one is under way reports it instead of starting another.
  const again = await manager.connect({ termsAccepted: true });
  expect(again.connect?.state).toBe("waiting");
  expect(f.relay.calls.filter((path) => path.endsWith("/signup/start"))).toHaveLength(1);
  await settled("done");
  expect(f.options.prepare).not.toHaveBeenCalled();
  expect(f.register.mock.calls.length).toBeGreaterThan(registered);
  expect(f.relay.calls.filter((path) => path.endsWith("/signup/poll")).length).toBeGreaterThan(2);
}, 20_000);

test("denials, expiry and an unreachable relay each end the connection with their reason", async () => {
  for (const reason of ["not-allowed", "capacity"] as const) {
    const f = await connecting();
    f.relay.poll({ status: "denied", reason });
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.connect({ termsAccepted: true });
    expect((await settled("failed")).connect).toEqual({
      state: "failed",
      intent: "existing",
      error: reason,
    });
    expect(f.register).not.toHaveBeenCalled();
    await manager.close();
  }
  const expired = await connecting(
    fakeSignupRelay({ startedExpiresAt: () => Math.floor(Date.now() / 1000) - 1 }),
  );
  manager = await GatewayCloudRelayManagement.open(expired.options);
  await manager.connect({ termsAccepted: true });
  expect((await settled("failed")).connect?.error).toBe("expired");
  expect(expired.relay.calls).not.toContain("/_relay/v3/signup/poll");
  await manager.close();

  const unreachable = await connecting();
  unreachable.relay.handle("/_relay/v3/signup/start", () => new Response(null, { status: 503 }));
  manager = await GatewayCloudRelayManagement.open(unreachable.options);
  await expect(manager.connect({ termsAccepted: true })).rejects.toMatchObject({
    code: "relay-unreachable",
  });
  expect((await manager.status()).connect).toBeUndefined();
});

test(
  "a refused registration, a refused enable and a link for another account never link the gateway",
  { timeout: 30_000 },
  async () => {
    const refused = await connecting();
    refused.relay.poll({ status: "approved" });
    refused.register.mockRejectedValue(new Error("Invitation refused"));
    manager = await GatewayCloudRelayManagement.open(refused.options);
    await manager.connect({ termsAccepted: true });
    expect((await settled("failed")).connect?.error).toBe("enrollment-refused");
    expect(refused.relay.calls).not.toContain("/_relay/v3/signup/link");
    // Once the relay admits the gateway, the old refusal no longer shows.
    refused.register.mockResolvedValue({ token: "t", accountId: "a".repeat(64), expiresAt: 1 });
    await manager.reconnect();
    await vi.waitFor(async () =>
      expect((await manager!.status()).enrollment.state).toBe("enrolled"),
    );
    expect((await manager.status()).connect).toBeUndefined();
    await manager.close();

    // The public hostname now overlaps the direct certificate, so enabling throws before enrollment.
    let overlaps = false;
    const conflict = await connecting(undefined, {
      directCertificateCoversHostname: () => overlaps,
    });
    conflict.relay.poll({ status: "unavailable" }, { status: "approved" });
    manager = await GatewayCloudRelayManagement.open(conflict.options);
    await manager.connect({ termsAccepted: true });
    overlaps = true;
    expect((await settled("failed")).connect?.error).toBe("enrollment-refused");
    expect((await manager.status()).enabled).toBe(false);
    await manager.close();

    const other = await connecting(fakeSignupRelay({ linkedAccountId: "e".repeat(64) }));
    other.relay.poll({ status: "approved" });
    manager = await GatewayCloudRelayManagement.open(other.options);
    await manager.connect({ termsAccepted: true });
    expect((await settled("failed")).connect?.error).toBe("account-link-failed");
    expect(manager.verifiedAccountId()).toBeUndefined();
    await manager.close();

    // The relay links a different account than the sign-in it approved.
    const switched = await connecting(fakeSignupRelay({ approvedAccountId: "e".repeat(64) }));
    switched.relay.poll({ status: "approved" });
    manager = await GatewayCloudRelayManagement.open(switched.options);
    await manager.connect({ termsAccepted: true });
    expect((await settled("failed")).connect?.error).toBe("account-link-failed");
    expect(switched.relay.calls).toContain("/_relay/v3/signup/link");
    expect(manager.verifiedAccountId()).toBeUndefined();
    await manager.close();

    const mismatch = await connecting();
    mismatch.relay.poll({ status: "approved" });
    mismatch.relay.handle("/_relay/v3/signup/link", () =>
      Response.json({ accountId: "f".repeat(64), identityToken: "not-a-token" }),
    );
    manager = await GatewayCloudRelayManagement.open(mismatch.options);
    await manager.connect({ termsAccepted: true });
    expect((await settled("failed")).connect?.error).toBe("account-link-failed");
  },
);

test("cancelling while waiting tells the relay and leaves nothing behind; cancelling idle is harmless", async () => {
  const f = await connecting(
    fakeSignupRelay({
      started: (reply) => ({ ...reply, connectShortUrl: "https://front.example.test/connect" }),
    }),
  );
  manager = await GatewayCloudRelayManagement.open(f.options);
  const idleCancel = await manager.cancelConnect();
  expect(idleCancel.connect).toBeUndefined();
  expect(f.relay.calls).not.toContain("/_relay/v3/signup/cancel");
  // A relay's short connect address reaches the status for display, and is never requested.
  expect((await manager.connect({ termsAccepted: true })).connect).toMatchObject({
    connectUrl: "https://relay.example.test/_relay/connect",
    connectShortUrl: "https://front.example.test/connect",
  });
  expect(f.relay.calls.every((path) => path.startsWith("/_relay/"))).toBe(true);
  const cancelled = await manager.cancelConnect();
  expect(cancelled.connect).toBeUndefined();
  expect(f.relay.calls).toContain("/_relay/v3/signup/cancel");
  // The background poll ends quietly instead of reporting a failure for the cancelled attempt.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect((await manager.status()).connect).toBeUndefined();
  expect(f.register).not.toHaveBeenCalled();
}, 20_000);

test("a gateway enrolled from its environment links through the installed key registration", async () => {
  const relay = fakeSignupRelay();
  relay.poll({ status: "approved" });
  const configDir = await mkdtemp(join(directory, "legacy-")),
    ownerKeyFile = join(configDir, "owner.key");
  await readOrCreateGatewayOwnerKey(ownerKeyFile);
  const f = fixture({
    configDir,
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://gateway.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: join(configDir, "session.json"),
      OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerKeyFile,
    },
    fetch: relay.fetch,
    controller: vi.fn(async () => undefined),
    register: undefined,
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await idle();
  expect((await manager.status()).enrollment.state).toBe("enrolled");
  await manager.connect({ termsAccepted: true });
  // The real registration reaches this relay, which has no key routes, so linking fails closed.
  expect((await settled("failed")).connect?.error).toBe("account-link-failed");
  expect(relay.calls).not.toContain("/_relay/v3/signup/link");
});
test("a registration that failed is tried again by itself, without waiting an hour", async () => {
  const f = fixture({ probeRetryMs: 1 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  f.register.mockRejectedValueOnce(new Error("Invalid gateway key challenge expiry"));
  await manager.enable();
  await vi.waitFor(async () => expect((await manager!.status()).enrollment.state).toBe("enrolled"));
  expect(f.register).toHaveBeenCalledTimes(2);
});
test("a registration the relay keeps refusing stops being retried after a while", async () => {
  const f = fixture({ probeRetryMs: 1 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  f.register.mockRejectedValue(new Error("refused"));
  await manager.enable();
  await vi.waitFor(() => expect(f.register).toHaveBeenCalledTimes(21));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.register).toHaveBeenCalledTimes(21);
  expect((await manager.status()).enrollment).toEqual({
    state: "failed",
    error: "enrollment-refused",
  });
});
test("connecting again after a registration that failed registers the gateway again", async () => {
  const f = await connecting();
  f.relay.poll({ status: "approved" });
  f.register.mockRejectedValueOnce(new Error("Invalid gateway key challenge expiry"));
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true });
  expect((await settled("failed")).connect?.error).toBe("enrollment-refused");
  // The relay is still turned on from the first attempt, and still not registered.
  expect(await manager.status()).toMatchObject({ enabled: true, enrollment: { state: "failed" } });
  f.relay.poll({ status: "approved" });
  await manager.connect({ termsAccepted: true });
  expect((await settled("done")).enrollment.state).toBe("enrolled");
});

/** What the manager handed the tunnel to call when the relay says it no longer has this gateway. */
function relayForgot(f: ReturnType<typeof fixture>): (removed?: boolean) => void {
  const start = f.options.startTunnel as unknown as { mock: { calls: unknown[][] } };
  return start.mock.calls.at(-1)![2] as (removed?: boolean) => void;
}
async function forgotten(notice: "account-deleted" | "gateway-removed" = "account-deleted") {
  await vi.waitFor(async () => expect((await manager!.status()).notice).toBe(notice), {
    timeout: 10_000,
  });
  return manager!.status();
}
const UNLINK = "/_relay/v3/account-browser/unlink";
/** What stays on a gateway that left its account: its id and what serves its paired devices. */
const RETAINED = [
  "acme-account.key",
  "management.json",
  "owner.key",
  "public.key",
  "public.pem",
  "registered.json",
];
/** A gateway connected by sign-in, with the files a real registration and certificate leave. */
async function connectedGateway(overrides: Partial<CloudRelayManagerOptions> = {}) {
  const f = await connecting(fakeSignupRelay(), overrides);
  f.relay.poll({ status: "approved" });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true });
  const connected = await settled("done");
  const relayDirectory = join(f.options.configDir, "cloud-relay");
  const tls = tlsFiles(f.options.configDir, "gateway.example.test");
  await writeFile(join(relayDirectory, "public.pem"), await readFile(tls.certFile));
  await writeFile(join(relayDirectory, "public.key"), await readFile(tls.keyFile));
  for (const name of ["session.json", "session.json.recovery.json", "acme-account.key"])
    await writeFile(join(relayDirectory, name), "fixture");
  return { ...f, connected, relayDirectory, tls };
}
/** No account, no registration, remote access off: what the portal's first-time screen is drawn from. */
const disconnected = {
  enabled: false,
  enrollment: { state: "unconfigured" },
  tunnel: { state: "disabled" },
  publicMcp: { ready: false },
  account: { activated: false, linked: false, canUnlink: false, pendingUnlink: false },
  deviceEnrollment: { policy: "ask", trustedSignIns: [] },
  can: { disable: false, reconnect: false, renew: false },
};
test(
  "a gateway whose account was deleted leaves it, keeps serving its paired devices, and connects to a new account at the same address",
  { timeout: 30_000 },
  async () => {
    const f = await connectedGateway({ probeRetryMs: 1 });
    const before = (await readdir(f.relayDirectory)).sort();
    expect(before).toEqual(
      [
        ...RETAINED,
        "account-link.json",
        "invitation.json",
        "session.json",
        "session.json.recovery.json",
      ].sort(),
    );

    // A relay that is down, refusing or misbehaving says nothing about the account: the link,
    // the registration and every file stay, and the gateway keeps trying.
    f.register.mockRejectedValueOnce(new Error("fetch failed"));
    await manager!.reconnect();
    await vi.waitFor(async () =>
      expect(await manager!.status()).toMatchObject({
        enabled: true,
        enrollment: { state: "enrolled" },
        account: { linked: true },
      }),
    );
    expect((await readdir(f.relayDirectory)).sort()).toEqual(before);
    expect(await manager!.status()).not.toHaveProperty("notice");

    // The relay answers the gateway's own keys that it has no registration for it.
    f.register.mockRejectedValueOnce(new GatewayUnregistered());
    await manager!.reconnect();
    const after = await forgotten();
    expect(after).toMatchObject(disconnected);
    expect(after.connect).toBeUndefined();
    expect(manager!.verifiedAccountId()).toBeUndefined();
    expect(manager!.accountPairingIdentity()).toBeUndefined();
    expect(manager!.accountModeActivated()).toBe(false);
    expect(manager!.isExposing()).toBe(false);
    expect(f.stop).toHaveBeenCalled();
    expect(f.close).toHaveBeenCalled();
    // Everything about the account and the registration is gone from disk...
    expect((await readdir(f.relayDirectory)).sort()).toEqual(RETAINED);
    // ...while the gateway keeps its id, address and the key its devices pinned.
    expect(after).toMatchObject({
      configured: true,
      gatewayId: f.connected.gatewayId,
      hostname: f.connected.hostname,
      certificate: { state: "bootstrap" },
    });
    expect(manager!.spkiFingerprintSha256()).toBe("c".repeat(64));
    // Nothing is tried again, and a late word from the old tunnel changes nothing.
    const registrations = f.register.mock.calls.length;
    relayForgot(f)();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.register).toHaveBeenCalledTimes(registrations);
    expect((await manager!.status()).revision).toBe(after.revision);

    // After a restart it still answers for its public name with that certificate, even once the
    // certificate has expired: nothing renews it while the gateway is not connected.
    await manager!.close();
    expiredCertificate({
      certificateFile: f.tls.certFile,
      privateKeyFile: f.tls.keyFile,
      outputFile: join(f.relayDirectory, "public.pem"),
    });
    const activate = f.options.activate as unknown as ReturnType<typeof vi.fn>;
    activate.mockClear();
    manager = await GatewayCloudRelayManagement.open(f.options);
    manager.start();
    expect(activate).toHaveBeenCalledExactlyOnceWith(
      {
        hostname: "gateway.example.test",
        cert: await readFile(join(f.relayDirectory, "public.pem"), "utf8"),
        key: await readFile(f.tls.keyFile, "utf8"),
      },
      expect.any(AbortSignal),
    );
    const restarted = await manager.status();
    expect(restarted).toMatchObject({ ...disconnected, certificate: { state: "expired" } });
    expect(restarted).not.toHaveProperty("notice");
    expect(restarted.certificate.lastError).toBeUndefined();
    expect(manager.spkiFingerprintSha256()).toMatch(/^[a-f0-9]{64}$/);
    expect(f.register).toHaveBeenCalledTimes(registrations);

    // Its owner connects it to another account: the same gateway, at the same address.
    f.relay.poll({ status: "approved" });
    const waiting = await manager.connect({ termsAccepted: true });
    expect(waiting).not.toHaveProperty("notice");
    expect(waiting.gatewayId).toBe(f.connected.gatewayId);
    const again = await settled("done");
    expect(again).toMatchObject({
      enabled: true,
      hostname: f.connected.hostname,
      enrollment: { state: "enrolled" },
      account: { linked: true },
    });
  },
);
test("a gateway unlinked on its account page leaves its account the same way, and says it was unlinked", async () => {
  const f = await connectedGateway({ probeRetryMs: 1 });
  // Found by its next registration, such as when it starts again after being offline.
  f.register.mockRejectedValueOnce(new GatewayUnregistered(true));
  await manager!.reconnect();
  const after = await forgotten("gateway-removed");
  expect(after).toMatchObject(disconnected);
  expect(after.connect).toBeUndefined();
  expect(manager!.verifiedAccountId()).toBeUndefined();
  expect(manager!.isExposing()).toBe(false);
  expect((await readdir(f.relayDirectory)).sort()).toEqual(RETAINED);
  // Nothing is tried again.
  const registrations = f.register.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.register).toHaveBeenCalledTimes(registrations);
  // Its owner connects it again from scratch, and the notice goes.
  f.relay.poll({ status: "approved" });
  expect(await manager!.connect({ termsAccepted: true })).not.toHaveProperty("notice");
  expect(await settled("done")).toMatchObject({ enabled: true, account: { linked: true } });
});
test("a running gateway's tunnel learning it was unlinked on its account page leaves the account at once", async () => {
  const f = await connectedGateway();
  relayForgot(f)(true);
  expect(await forgotten("gateway-removed")).toMatchObject(disconnected);
  expect(f.stop).toHaveBeenCalledOnce();
});
test("an answer that says the gateway was unlinked wins over one that could not say why, while leaving", async () => {
  const f = await connectedGateway();
  relayForgot(f)(false);
  relayForgot(f)(true);
  expect(await forgotten("gateway-removed")).toMatchObject(disconnected);
});
test("an answer that says the gateway was unlinked wins over one that could not say why, after leaving", async () => {
  const g = await connectedGateway();
  relayForgot(g)(false);
  await forgotten("account-deleted");
  relayForgot(g)(true);
  expect((await manager!.status()).notice).toBe("gateway-removed");
  // And never the other way round.
  relayForgot(g)(false);
  expect((await manager!.status()).notice).toBe("gateway-removed");
});
test("the tunnel learning that the relay forgot the gateway ends a connection under way, once", async () => {
  const f = await connecting();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  // A person had started connecting to an account when the answer arrived.
  expect((await manager.connect({ termsAccepted: true })).connect?.state).toBe("waiting");
  const forgot = relayForgot(f);
  forgot();
  forgot();
  expect(await forgotten()).toMatchObject(disconnected);
  expect(await manager.status()).not.toHaveProperty("connect");
  expect(f.stop).toHaveBeenCalledOnce();
});
test(
  "disconnecting a gateway takes it out of its account and off the relay, and it keeps what serves its paired devices",
  { timeout: 30_000 },
  async () => {
    const f = await connectedGateway();
    const released: unknown[] = [];
    f.relay.handle(UNLINK, (body) => {
      released.push(body);
      return Response.json({ ok: true });
    });
    const registrations = f.register.mock.calls.length;
    const after = await manager!.accountUnlink();
    expect(after).toMatchObject(disconnected);
    // The owner did this, so there is nothing to explain to them.
    expect(after).not.toHaveProperty("notice");
    expect(after.connect).toBeUndefined();
    expect(manager!.verifiedAccountId()).toBeUndefined();
    expect(f.stop).toHaveBeenCalled();
    // The relay was asked once, by this gateway's own key.
    expect(released).toEqual([{}]);
    expect(f.register).toHaveBeenCalledTimes(registrations + 1);
    expect(f.register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configDir: f.options.configDir,
        gatewayId: f.connected.gatewayId,
        publicOrigin: f.connected.publicOrigin,
        sessionFile: join(f.relayDirectory, "session.json"),
        ownerKeyFile: join(f.relayDirectory, "owner.key"),
      }),
    );
    expect((await readdir(f.relayDirectory)).sort()).toEqual(RETAINED);
    expect(after).toMatchObject({
      configured: true,
      gatewayId: f.connected.gatewayId,
      hostname: f.connected.hostname,
    });
    expect(manager!.spkiFingerprintSha256()).toBe("c".repeat(64));
    // It connects again, to the same account or another, as the same gateway.
    f.relay.poll({ status: "approved" });
    const waiting = await manager!.connect({ termsAccepted: true });
    expect(waiting.gatewayId).toBe(f.connected.gatewayId);
    expect(await settled("done")).toMatchObject({
      hostname: f.connected.hostname,
      account: { linked: true },
    });
  },
);
test(
  "a gateway disconnected while the relay is out of reach is disconnected at once, keeps asking, and registers again only once the relay has dropped it",
  { timeout: 30_000 },
  async () => {
    const f = await connectedGateway({ releaseRetryMs: 5 });
    let reachable = false,
      asked = 0;
    f.relay.handle(UNLINK, () => {
      asked++;
      return reachable ? Response.json({ ok: true }) : new Response(null, { status: 503 });
    });
    expect(await manager!.accountUnlink()).toMatchObject(disconnected);
    // Its session waits, to prove the gateway to the relay once more; the rest is as above.
    const waiting = [...RETAINED, "release.json", "session.json"].sort();
    expect((await readdir(f.relayDirectory)).sort()).toEqual(waiting);
    expect(
      JSON.parse(await readFile(join(f.relayDirectory, "release.json"), "utf8")),
    ).toMatchObject({
      gatewayId: f.connected.gatewayId,
      relayUrl: "https://relay.example.test",
      sessionFile: join(f.relayDirectory, "session.json"),
    });
    await vi.waitFor(() => expect(asked).toBeGreaterThan(2));
    // Still in its old account on the relay, it may not register under the same id yet.
    await expect(manager!.enable()).rejects.toMatchObject({ code: "relay-unreachable" });
    expect(await manager!.status()).toMatchObject(disconnected);
    // A restart keeps asking, and stops once the relay answers.
    await manager!.close();
    manager = await GatewayCloudRelayManagement.open(f.options);
    expect(await manager.status()).toMatchObject(disconnected);
    reachable = true;
    manager.start();
    await vi.waitFor(async () =>
      expect((await readdir(f.relayDirectory)).sort()).toEqual(RETAINED),
    );
    const total = asked;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(asked).toBe(total);
    f.relay.poll({ status: "approved" });
    await manager.connect({ termsAccepted: true });
    expect(await settled("done")).toMatchObject({ gatewayId: f.connected.gatewayId });
  },
);
test("a disconnected gateway the relay never drops is given up after a month, and one it already forgot is done at once", async () => {
  const relayDirectory = join(directory, "cloud-relay"),
    file = join(relayDirectory, "release.json"),
    sessionFile = join(relayDirectory, "session.json");
  const waiting = async (createdAt: number) => {
    await mkdir(relayDirectory, { recursive: true });
    await writeFile(sessionFile, "{}");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        relayUrl: "https://relay.example.test",
        gatewayId: "11111111-1111-4111-8111-111111111111",
        publicOrigin: "https://gateway.example.test",
        sessionFile,
        ownerKeyFile: join(relayDirectory, "owner.key"),
        certificateFile: join(relayDirectory, "public.pem"),
        privateKeyFile: join(relayDirectory, "public.key"),
        createdAt,
      }),
    );
  };
  const gone = () =>
    vi.waitFor(async () => expect(await readdir(relayDirectory)).toEqual([]), { timeout: 5000 });
  // A month old: dropped without a word to the relay.
  const f = fixture({ releaseRetryMs: 5, register: undefined });
  await waiting(Date.now() - 31 * 86400_000);
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await gone();
  // Recent, with no usable key to prove itself: it waits, and closing ends the asking.
  await waiting(Date.now());
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.close();
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await readdir(relayDirectory)).sort()).toEqual(["release.json", "session.json"]);
  // The relay answering "you are not registered" is the relay having dropped it.
  const forgetful = fixture({
    releaseRetryMs: 5,
    register: vi.fn(async () => {
      throw new GatewayUnregistered();
    }) as unknown as CloudRelayManagerOptions["register"],
  });
  manager = await GatewayCloudRelayManagement.open(forgetful.options);
  manager.start();
  await gone();
  // Unknown release state cannot authorize another registration.
  await writeFile(file, "{");
  manager.start();
  await manager.close();
  expect(await readFile(file, "utf8")).toBe("{");
});
test("a gateway named by its environment leaves the same way, with the operator's certificate untouched", async () => {
  const tls = tlsFiles(directory),
    gatewayId = "26435b2c-768a-4ce8-ae85-72ade9c2d529",
    sessionFile = join(directory, "legacy-session"),
    receiptFile = join(directory, "legacy-receipt.json");
  let reachable = false;
  const unlinks: (string | null)[] = [];
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
      OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
      OMNESIS_TLS_CERT: tls.certFile,
      OMNESIS_TLS_KEY: tls.keyFile,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
      OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE: receiptFile,
    },
    controller: undefined,
    fetch: vi.fn<typeof fetch>(async (url, init) => {
      if (!String(url).endsWith(UNLINK)) return new Response(null, { status: 404 });
      unlinks.push(new Headers(init!.headers).get("authorization"));
      return reachable ? Response.json({ ok: true }) : new Response(null, { status: 503 });
    }),
  });
  await writeFile(sessionFile, "{}");
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await idle();
  // Leaving cannot finish while the account link cannot be removed, and says so in the log only.
  const blocked = join(directory, "cloud-relay/account-link.json");
  await mkdir(join(blocked, "kept"), { recursive: true });
  relayForgot(f)();
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await manager.status()).not.toHaveProperty("notice");
  expect(await readFile(sessionFile, "utf8")).toBe("{}");
  await rm(blocked, { recursive: true });

  // The owner disconnects it while the relay is out of reach.
  await writeFile(receiptFile, "{}");
  expect(await manager.accountUnlink()).toMatchObject({
    ...disconnected,
    configured: true,
    gatewayId,
  });
  expect(unlinks).toEqual(["Bearer private-session"]);
  await expect(readFile(receiptFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    JSON.parse(await readFile(join(directory, "cloud-relay/release.json"), "utf8")),
  ).toMatchObject({
    gatewayId,
    sessionFile,
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
  });
  await expect(manager.enable()).rejects.toMatchObject({ code: "relay-unreachable" });
  reachable = true;
  expect((await manager.enable()).enabled).toBe(true);
  await idle();
  await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(tls.keyFile, "utf8")).toContain("PRIVATE KEY");

  // Its account is deleted later: the tunnel hears of it, and nothing is left to ask the relay.
  await writeFile(sessionFile, "{}");
  relayForgot(f)();
  expect(await forgotten()).toMatchObject({ ...disconnected, configured: true, gatewayId });
  await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  // Connecting it again uses the operator's configuration as it is, and clears the note.
  await expect(manager.connect({ termsAccepted: true })).rejects.toMatchObject({
    code: "relay-unreachable",
  });
  expect(f.discover).not.toHaveBeenCalled();
  expect(await manager.status()).not.toHaveProperty("notice");
  expect(await readdir(join(directory, "cloud-relay"))).toEqual(["management.json"]);
  expect(await readFile(tls.certFile, "utf8")).toContain("BEGIN CERTIFICATE");
});

test("a gateway not linked to an account learns from its relay that accounts need approval, at most every ten minutes", async () => {
  const requestAccessUrl = "https://groups.example.com/g/fictional-testers";
  const signupAccess = vi.fn<NonNullable<CloudRelayManagerOptions["signupAccess"]>>(async () => ({
    inviteOnly: true as const,
    requestAccessUrl,
  }));
  const f = fixture({ signupAccess });
  manager = await GatewayCloudRelayManagement.open(f.options);
  // Status alone never reaches the network.
  expect(await manager.status()).not.toHaveProperty("signup");
  expect(signupAccess).not.toHaveBeenCalled();
  await manager.refreshSignupAccess();
  expect(signupAccess).toHaveBeenCalledTimes(1);
  expect(signupAccess.mock.calls[0]![0]).toBe("https://relay.example.test");
  expect((await manager.status()).signup).toEqual({ inviteOnly: true, requestAccessUrl });
  await manager.refreshSignupAccess();
  expect(signupAccess).toHaveBeenCalledTimes(1);
  // After ten minutes it asks again; a relay that stopped being invite-only clears the notice.
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
  signupAccess.mockResolvedValueOnce(undefined);
  await manager.refreshSignupAccess();
  expect(signupAccess).toHaveBeenCalledTimes(2);
  expect(await manager.status()).not.toHaveProperty("signup");
  // A relay that cannot be reached keeps the last answer and is asked again a minute later.
  vi.spyOn(Date, "now").mockReturnValue(now + 20 * 60_000 + 2);
  await manager.refreshSignupAccess();
  expect((await manager.status()).signup).toEqual({ inviteOnly: true, requestAccessUrl });
  vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000 + 3);
  signupAccess.mockRejectedValueOnce(new Error("relay offline"));
  await manager.refreshSignupAccess();
  expect((await manager.status()).signup).toEqual({ inviteOnly: true, requestAccessUrl });
  vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000 + 30_000);
  await manager.refreshSignupAccess();
  expect(signupAccess).toHaveBeenCalledTimes(4);
  vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000 + 4);
  await manager.refreshSignupAccess();
  expect(signupAccess).toHaveBeenCalledTimes(5);
});

test("a slow relay holds a status read only briefly, and its answer is there on the next read", async () => {
  let answer!: (value: { inviteOnly: true; requestAccessUrl: string }) => void;
  const signupAccess = vi.fn<NonNullable<CloudRelayManagerOptions["signupAccess"]>>(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const f = fixture({ signupAccess });
  manager = await GatewayCloudRelayManagement.open(f.options);
  const started = performance.now();
  await manager.refreshSignupAccess();
  expect(performance.now() - started).toBeLessThan(3000);
  expect(await manager.status()).not.toHaveProperty("signup");
  // A second read while the first is in flight does not ask again.
  const second = manager.refreshSignupAccess();
  answer({ inviteOnly: true, requestAccessUrl: "https://groups.example.com/g/fictional-testers" });
  await second;
  expect(signupAccess).toHaveBeenCalledTimes(1);
  expect((await manager.status()).signup?.inviteOnly).toBe(true);
});

test("signup access is not asked for or shown without a usable relay service or once linked", async () => {
  const signupAccess = vi.fn<NonNullable<CloudRelayManagerOptions["signupAccess"]>>(async () => ({
    inviteOnly: true as const,
    requestAccessUrl: "https://groups.example.com/g/fictional-testers",
  }));
  manager = await GatewayCloudRelayManagement.open(
    fixture({ signupAccess, env: { OMNESIS_CLOUD_RELAY_URL: "invalid" } }).options,
  );
  await manager.refreshSignupAccess();
  expect(signupAccess).not.toHaveBeenCalled();
  expect(await manager.status()).not.toHaveProperty("signup");
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(fixture({ signupAccess }).options);
  await manager.refreshSignupAccess();
  expect((await manager.status()).signup).toBeDefined();
  // A linked gateway has its account: there is nothing to ask for, and nothing is shown.
  vi.spyOn(
    (manager as unknown as { account: { status(): { linked: boolean } } }).account,
    "status",
  ).mockReturnValue({ linked: true } as never);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
  await manager.refreshSignupAccess();
  expect(signupAccess).toHaveBeenCalledTimes(1);
  expect(await manager.status()).not.toHaveProperty("signup");
});

test("by default the gateway asks its relay's public signup path through its own fetch", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url) === "https://relay.example.test/_relay/v3/signup/access"
      ? Response.json({ signup: { inviteOnly: true } })
      : new Response(null, { status: 404 }),
  );
  manager = await GatewayCloudRelayManagement.open(fixture({ fetch }).options);
  await manager.refreshSignupAccess();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await manager.status()).signup).toEqual({ inviteOnly: true });
});

test("a delivered release retry cannot restart work during or after close", async () => {
  let retry: (() => void) | undefined;
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay === 60_001) retry = () => callback(...args);
    return schedule(callback, delay, ...args);
  });
  let entered!: () => void, finish!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const register = vi
    .fn<NonNullable<CloudRelayManagerOptions["register"]>>()
    .mockRejectedValueOnce(new Error("Invented temporary relay refusal"))
    .mockImplementationOnce(async (options) => {
      entered();
      await held;
      options.signal?.throwIfAborted();
      throw new Error("Invented joined interrupted release");
    });
  const f = fixture({ register, releaseRetryMs: 60_001 });
  manager = await GatewayCloudRelayManagement.open(f.options);
  const pending = await pendingRelease();
  const read = vi.spyOn(privateCredentials, "readPrivateJson");
  let closing: Promise<void> | undefined;
  try {
    manager.start();
    await vi.waitFor(() => expect(retry).toBeTypeOf("function"));
    retry!();
    await active;
    closing = manager.close();
    const reads = read.mock.calls.length;
    retry!();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(register).toHaveBeenCalledTimes(2);
    finish();
    await closing;
    retry!();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(register).toHaveBeenCalledTimes(2);
    expect(await readFile(pending.file, "utf8")).toBe(pending.bytes);
    expect(await readFile(pending.sessionFile, "utf8")).toBe("{}");
  } finally {
    finish();
    await closing;
  }
});

test.each(["own", "cause"] as const)(
  "marked management absence cannot adopt enabled legacy configuration (%s)",
  async (placement) => {
    const tls = tlsFiles(directory),
      failure = markedFileError("ENOENT", placement);
    const f = fixture({
      env: {
        OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
        OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
        OMNESIS_TLS_CERT: tls.certFile,
        OMNESIS_TLS_KEY: tls.keyFile,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "legacy-session"),
      },
    });
    const original = privateCredentials.readPrivateJson;
    vi.spyOn(privateCredentials, "readPrivateJson").mockImplementation((path) =>
      path === join(directory, "cloud-relay", "management.json")
        ? Promise.reject(failure)
        : original(path),
    );
    await expect(
      (async () => {
        manager = await GatewayCloudRelayManagement.open(f.options);
        return manager.hasSavedConfiguration();
      })(),
    ).rejects.toBe(failure);
    expect(f.options.startTunnel).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

test.each(["own", "cause"] as const)(
  "marked account metadata absence cannot select the legacy Google authority (%s)",
  async (placement) => {
    const tls = tlsFiles(directory),
      failure = markedFileError("ENOENT", placement);
    const f = fixture({
      env: {
        OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
        OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
        OMNESIS_TLS_CERT: tls.certFile,
        OMNESIS_TLS_KEY: tls.keyFile,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "legacy-session"),
      },
    });
    const original = privateCredentials.readPrivateJson;
    vi.spyOn(privateCredentials, "readPrivateJson").mockImplementation((path) =>
      path === join(directory, "cloud-relay", "account-link.json")
        ? Promise.reject(failure)
        : original(path),
    );
    const google = vi.spyOn(GatewayGoogleWeb.prototype, "start").mockResolvedValue({
      authorizeUrl: "https://accounts.example.test/start",
      cookie: "invented-cookie",
    });
    await expect(
      (async () => {
        manager = await GatewayCloudRelayManagement.open(f.options);
        return manager.googleLink({ requestOrigin: "https://gateway.example.test" });
      })(),
    ).rejects.toBe(failure);
    expect(google).not.toHaveBeenCalled();
  },
);

function brokerEnvironment(origin: string) {
  return {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_ACME_DNS_PROVIDER: "broker",
    OMNESIS_ACME_DNS_BROKER_URL: origin,
  };
}
const hostedDiscovery = async (_url: string, gatewayId: string) => ({
  protocol: 2 as const,
  gatewayId,
  publicOrigin: `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}`,
  invitationRequired: false,
  dnsChallenges: true,
});

test("F3: a relay that knows a gateway's id cannot claim its name at the broker before the gateway does", async () => {
  const harness = await brokerHarness({
    fallback: async () => new Response(null, { status: 404 }),
  });
  const f = fixture({ env: brokerEnvironment(harness.origin), fetch: harness.fetch });
  const races: unknown[] = [];
  f.discover.mockImplementation(async (url, gatewayId) => {
    // The relay learns the id here, and at once tries to take the name with a key of its own.
    races.push(
      await brokerCall(
        (request) => harness.broker.handle(request),
        brokerOwner("relay.example.test", gatewayId),
        { type: "claim" },
      ),
    );
    return hostedDiscovery(url, gatewayId);
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  const status = await manager.configure(input);
  expect(races).toEqual([{ status: 409, body: { error: "name-taken" } }]);
  const owner = await readOrCreateGatewayOwnerKey(
    join(directory, "cloud-relay", "owner.key"),
    false,
  );
  const { createPublicKey } = await import("node:crypto");
  expect(
    harness.store.values.get(
      `name:${hostedGatewayHostname(status.gatewayId!, "relay.example.test")}`,
    ),
  ).toMatchObject({
    gatewayId: status.gatewayId,
    ownerPublicKey: createPublicKey(owner)
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  });
});

test("a name the broker binds to another key costs a new gateway a redraw, and a saved one its configure", async () => {
  const harness = await brokerHarness({
    fallback: async () => new Response(null, { status: 404 }),
  });
  let taken = 2;
  const transport = vi.fn<typeof fetch>(async (input, init) =>
    String(input).endsWith("/_dns/v2/complete") && taken-- > 0
      ? new Response(JSON.stringify({ error: "name-taken" }), { status: 409 })
      : harness.fetch(input, init),
  );
  const f = fixture({ env: brokerEnvironment(harness.origin), fetch: transport });
  f.discover.mockImplementation(hostedDiscovery);
  manager = await GatewayCloudRelayManagement.open(f.options);
  const status = await manager.configure(input);
  const claims = [...harness.store.values.keys()].filter((key) => key.startsWith("name:"));
  expect(claims).toEqual([
    `name:${hostedGatewayHostname(status.gatewayId!, "relay.example.test")}`,
  ]);
  expect(f.discover).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    status.gatewayId,
    expect.anything(),
    expect.anything(),
  );
  taken = 1;
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "relay-unreachable" });
  taken = 5;
  await manager.close();
  await rm(join(directory, "cloud-relay"), { recursive: true, force: true });
  manager = await GatewayCloudRelayManagement.open(f.options);
  f.discover.mockClear();
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "relay-unreachable" });
  expect(f.discover).not.toHaveBeenCalled();
});

test("new official setup fails closed without disclosing its gateway id when the broker is unavailable", async () => {
  for (const reply of [undefined, { protocol: "unexpected-broker" }]) {
    const transport = vi.fn<typeof fetch>(async () => {
      if (!reply) throw new TypeError("fetch failed");
      return Response.json(reply);
    });
    const f = fixture({ env: {}, fetch: transport });
    manager = await GatewayCloudRelayManagement.open(f.options);
    await expect(
      manager.configure({ relayUrl: "https://relay.omnesis.app", termsAccepted: true }),
    ).rejects.toMatchObject({ code: "relay-unreachable" });
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://dns.omnesis.app/_dns/v2/health",
    ]);
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(manager.hasSavedConfiguration()).toBe(false);
    await manager.close();
    manager = undefined;
  }
});

test("a broker the operator requires must answer, and a custom domain never asks it", async () => {
  const harness = await brokerHarness({
    fallback: async () => new Response(null, { status: 404 }),
  });
  const down = fixture({
    env: brokerEnvironment(harness.origin),
    fetch: async () => new Response(null, { status: 503 }),
  });
  manager = await GatewayCloudRelayManagement.open(down.options);
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "relay-unreachable" });
  expect(down.discover).not.toHaveBeenCalled();
  await manager.close();
  const custom = fixture({ env: brokerEnvironment(harness.origin), fetch: harness.fetch });
  manager = await GatewayCloudRelayManagement.open(custom.options);
  await manager.configure({ ...input, publicOrigin: "https://gateway.example.test" });
  expect(harness.calls).toEqual([]);
  await manager.close();
  const unset = fixture({
    env: { ...brokerEnvironment(harness.origin), OMNESIS_ACME_DNS_BROKER_URL: undefined },
  });
  manager = await GatewayCloudRelayManagement.open(unset.options);
  await expect(manager.configure(input)).rejects.toMatchObject({ code: "configuration-invalid" });
});

test("CAA drift raises the incident hold, which the owner acknowledges on the gateway", async () => {
  const account = "https://acme-v02.api.letsencrypt.org/acme/acct/42";
  let issue = [`letsencrypt.org; validationmethods=dns-01; accounturi=${account}`];
  const held = vi.fn();
  const f = fixture({
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
    },
    caaLookup: async () => issue,
    onIncidentHold: held,
  });
  f.options.controller = vi.fn(async () => ({
    cleanupFailure: () => undefined,
    close: f.close,
    renew: f.renew,
    fingerprintSha256: () => "b".repeat(64),
    spkiFingerprintSha256: () => "c".repeat(64),
    expectedCaa: async () => account,
  }));
  // Certificate transparency, the monitor's other side, lists no issuance.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json([])),
  );
  manager = await GatewayCloudRelayManagement.open(f.options);
  const monitor = (manager as unknown as { monitor: { checkCaa(): Promise<void> } }).monitor;
  // Before the gateway publishes anything, there is nothing to drift from.
  await monitor.checkCaa();
  await manager.configure(input);
  await manager.enable();
  await idle();
  await monitor.checkCaa();
  expect((await manager.status()).incidentHold).toBeUndefined();
  // Someone with write access to the zone points the name at another ACME account.
  issue = ["letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/666"];
  await monitor.checkCaa();
  expect((await manager.status()).incidentHold).toMatchObject({
    certificates: [expect.stringMatching(/^[a-f0-9]{64}$/)],
  });
  expect(held).toHaveBeenCalledOnce();
  await manager.acknowledgeIncidentHold();
  // The same records don't hold again once acknowledged; different ones do.
  await monitor.checkCaa();
  expect((await manager.status()).incidentHold).toBeUndefined();
  issue = [];
  await monitor.checkCaa();
  expect((await manager.status()).incidentHold).toBeDefined();
  expect(held).toHaveBeenCalledTimes(2);
});

test("the portal's account refresh reads the account at once, one read at a time, and at most once per interval", async () => {
  await connectedGateway({ accountRefreshMs: 60_000 });
  let finish!: () => void;
  const refresh = vi
    .spyOn(GatewayAccountLink.prototype, "refresh")
    .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const before = (await manager!.status()).revision;
  // Two tabs opening the page together share one read, and both wait for it.
  const first = manager!.refreshAccount(),
    second = manager!.refreshAccount();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  finish();
  const [a, b] = await Promise.all([first, second]);
  expect(a.revision).toBeGreaterThan(before);
  expect(b.revision).toBe(a.revision);
  expect(a.account?.linked).toBe(true);
  // Inside the interval the page gets the status it has, and the relay is not asked again.
  for (let i = 0; i < 5; i++) await manager!.refreshAccount();
  expect(refresh).toHaveBeenCalledOnce();
  // The read is the periodic check-in's own, bounded by a signal that ends when the gateway does.
  const signal = refresh.mock.calls[0]![0]!;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
});
test("a refresh asked for inside the interval reads once more when it ends, and closing cancels that", async () => {
  await connectedGateway({ accountRefreshMs: 500 });
  const refresh = vi.spyOn(GatewayAccountLink.prototype, "refresh").mockResolvedValue();
  await manager!.refreshAccount();
  expect(refresh).toHaveBeenCalledOnce();
  // Back from the relay's account page soon after opening this one: still noticed.
  await manager!.refreshAccount();
  await manager!.refreshAccount();
  expect(refresh).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2), { timeout: 2000 });
  // Only one read was queued, however many calls asked for it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(refresh).toHaveBeenCalledTimes(2);
  // A read queued when the gateway shuts down never runs.
  await manager!.refreshAccount();
  await manager!.close();
  manager = undefined;
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(refresh).toHaveBeenCalledTimes(2);
});
test("closing aborts an accepted account refresh and waits for its completion", async () => {
  await connectedGateway();
  let finish!: () => void;
  const refresh = vi
    .spyOn(GatewayAccountLink.prototype, "refresh")
    .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const reading = manager!.refreshAccount().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  let closed = false;
  const closing = manager!.close().then(() => {
    closed = true;
  });
  let result: unknown;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(refresh.mock.calls[0]![0]!.aborted).toBe(true);
    expect(closed).toBe(false);
  } finally {
    finish();
    [result] = await Promise.all([reading, closing]);
  }
  // The accepted work is drained, but shutdown refuses its subsequent status read.
  expect(result).toMatchObject({ status: 409, code: "configuration-invalid" });
});

test("a queued account refresh retains cleanup uncertainty and closes admission", async () => {
  await connectedGateway({ accountRefreshMs: 100 });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  // This synthetic receipt owns no actual native operation.
  const failure = Object.assign(new Error("invented account cleanup failure"), {
    cleanupFailure: undefined,
  });
  const refresh = vi
    .spyOn(GatewayAccountLink.prototype, "refresh")
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(failure);
  await manager!.refreshAccount();
  await manager!.refreshAccount();
  clock.mockReturnValue(now + 100);
  await vi.waitFor(() => expect(manager!.cleanupFailure()).toBe(failure), { timeout: 3_000 });
  expect(refresh).toHaveBeenCalledTimes(2);
  await expect(manager!.refreshAccount()).rejects.toBe(failure);
  await expect(manager!.close()).rejects.toSatisfy(
    (error: unknown) => core.ownedProcessCleanupReceipt(error)?.pending === false,
  );
  manager = undefined;
});

test("an account refresh on a gateway with no linked account asks the relay nothing", async () => {
  const refresh = vi.spyOn(GatewayAccountLink.prototype, "refresh");
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(await manager.refreshAccount()).toMatchObject({ enabled: false });
  await manager.configure(input);
  await manager.enable();
  await idle();
  refresh.mockClear();
  expect((await manager.refreshAccount()).account?.linked).not.toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  expect(f.options.fetch).not.toHaveBeenCalledWith(
    expect.stringContaining("/_relay/v3/account-browser"),
    expect.anything(),
  );
});
test("by default the portal's account refresh reads at most once every fifteen seconds", async () => {
  await connectedGateway();
  const refresh = vi.spyOn(GatewayAccountLink.prototype, "refresh").mockResolvedValue();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await manager!.refreshAccount();
  clock.mockReturnValue(now + 14_000);
  await manager!.refreshAccount();
  expect(refresh).toHaveBeenCalledOnce();
  clock.mockReturnValue(now + 15_000);
  await manager!.refreshAccount();
  expect(refresh).toHaveBeenCalledTimes(2);
});

async function connectingWithDnsCheck() {
  const relay = fakeSignupRelay();
  const broker = await brokerHarness({ fallback: relay.fetch });
  const verification = {
    url: `${broker.origin}/_dns/v2/enroll?ticket=fictional`,
    expiresAt: Date.now() + 60_000,
  };
  let verified = false;
  let refusal: { status: number; code: string } | undefined;
  const claims: { gatewayId: string; ownerPublicKey: string }[] = [];
  let hold: (() => Promise<void>) | undefined;
  const f = await connecting(relay, {
    env: {
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_ACME_DNS_PROVIDER: "broker",
      OMNESIS_ACME_DNS_BROKER_URL: broker.origin,
    },
    fetch: async (input, init) => {
      if (String(input) === `${broker.origin}/_dns/v2/challenge`) {
        claims.push(JSON.parse(String(init?.body)));
        const pending = hold;
        hold = undefined;
        await pending?.();
        if (refusal) return Response.json({ error: refusal.code }, { status: refusal.status });
        if (!verified)
          return Response.json(
            { error: "browser-verification-required", verification },
            { status: 428 },
          );
      }
      return broker.fetch(input, init);
    },
    discover: vi.fn(async (_url: string, gatewayId: string) => ({
      protocol: 2 as const,
      gatewayId,
      publicOrigin: `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}`,
      invitationRequired: false,
      dnsChallenges: true,
    })),
  });
  return {
    ...f,
    verification,
    claims,
    refuse: (status: number, code: string) => {
      refusal = { status, code };
    },
    verify: () => {
      verified = true;
    },
    holdNext: (value: () => Promise<void>) => {
      hold = value;
    },
  };
}

test("first cloud connect exposes an independent DNS check without disclosing the gateway id to the relay", async () => {
  const f = await connectingWithDnsCheck();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const waiting = await manager.connect({ termsAccepted: true });
  expect(waiting.connect).toEqual({
    state: "waiting",
    intent: "existing",
    verification: f.verification,
  });
  expect(waiting.configured).toBe(false);
  // A repeated connect during the browser check joins the existing attempt.
  expect((await manager.connect({ termsAccepted: true })).connect).toEqual(waiting.connect);
  expect(f.claims).toHaveLength(1);
  expect(f.options.discover).not.toHaveBeenCalled();
  expect(f.relay.started()).toBeUndefined();
  expect(f.claims).toHaveLength(1);
  f.verify();
  await vi.waitFor(async () => expect((await manager!.status()).connect?.code).toBe("ABCD-EF23"), {
    timeout: 5000,
  });
  expect((await manager.status()).connect).not.toHaveProperty("verification");
  expect(f.options.discover).toHaveBeenCalledOnce();
  expect(
    f.claims.every(
      (claim) =>
        claim.gatewayId === f.claims[0]!.gatewayId &&
        claim.ownerPublicKey === f.claims[0]!.ownerPublicKey,
    ),
  ).toBe(true);
});

test("cancelling a delayed DNS check joins its setup before a retry and cannot overwrite that retry", async () => {
  const f = await connectingWithDnsCheck();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true });
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdNext(async () => {
    entered();
    await held;
  });
  await checking;
  const cancelling = manager.cancelConnect();
  release();
  expect((await cancelling).connect).toBeUndefined();
  const retry = await manager.connect({ termsAccepted: true });
  expect(retry.connect).toEqual({
    state: "waiting",
    intent: "existing",
    verification: f.verification,
  });
  expect(f.relay.started()).toBeUndefined();
  f.verify();
  await vi.waitFor(async () => expect((await manager!.status()).connect?.code).toBe("ABCD-EF23"), {
    timeout: 5000,
  });
  expect((await manager.status()).connect?.state).toBe("waiting");
  expect(f.claims.every((claim) => claim.gatewayId === f.claims[0]!.gatewayId)).toBe(true);
});

test("advanced configure reports a required browser check and reuses its gateway id after verification", async () => {
  const f = await connectingWithDnsCheck();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await expect(manager.configure({ termsAccepted: true })).rejects.toMatchObject({
    code: "dns-verification-required",
  });
  expect((await manager.status()).connect?.verification).toEqual(f.verification);
  f.verify();
  const configured = await manager.configure({ termsAccepted: true });
  expect(configured.configured).toBe(true);
  expect(configured.connect).toBeUndefined();
  expect(f.claims.map((claim) => claim.gatewayId)).toEqual([
    f.claims[0]!.gatewayId,
    f.claims[0]!.gatewayId,
  ]);
});

for (const [status, code] of [
  [507, "dns-capacity"],
  [429, "dns-allocation-rate"],
  [503, "enrollment-refused"],
] as const) {
  test(`a pending DNS check reports ${code} and keeps the gateway private when admission fails`, async () => {
    const f = await connectingWithDnsCheck();
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.connect({ termsAccepted: true });
    f.refuse(status, code);
    await vi.waitFor(
      async () =>
        expect((await manager!.status()).connect).toEqual({
          state: "failed",
          intent: "existing",
          error: code,
        }),
      { timeout: 5000 },
    );
    expect(f.options.discover).not.toHaveBeenCalled();
    expect(f.relay.started()).toBeUndefined();
    expect((await manager.status()).configured).toBe(false);
    // Nothing was saved, so starting over only ends the failed attempt.
    const fresh = await manager.startOver();
    expect(fresh.connect).toBeUndefined();
    expect(fresh.configured).toBe(false);
  });
}

test("an invite the relay refuses after the security check stays on the status with its reason", async () => {
  const f = await connectingWithDnsCheck();
  f.relay.handle("/_relay/v3/signup/invite", inviteAnswer("valid"));
  f.relay.handle("/_relay/v3/signup/start", () =>
    Response.json({ error: "invite-expired" }, { status: 403 }),
  );
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true, intent: "create", invite: fictionalInvite });
  f.verify();
  await vi.waitFor(
    async () =>
      expect((await manager!.status()).connect).toEqual({
        state: "failed",
        intent: "create",
        error: "invite-expired",
      }),
    { timeout: 5000 },
  );
});

test("a DNS security check that exceeds the setup lifetime expires without contacting the relay", async () => {
  const f = await connectingWithDnsCheck();
  const expired = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 10 * 60_000 ? expired.signal : timeout(ms),
  );
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true });
  expired.abort(new DOMException("Timed out", "TimeoutError"));
  await vi.waitFor(async () =>
    expect((await manager!.status()).connect).toEqual({
      state: "failed",
      intent: "existing",
      error: "expired",
    }),
  );
  expect(f.options.discover).not.toHaveBeenCalled();
  expect((await manager.status()).configured).toBe(false);
});

for (const [status, code] of [
  [507, "dns-capacity"],
  [429, "dns-allocation-rate"],
] as const) {
  test(`advanced setup surfaces ${code} before sending a gateway identity to the relay`, async () => {
    const f = await connectingWithDnsCheck();
    f.refuse(status, code);
    manager = await GatewayCloudRelayManagement.open(f.options);
    await expect(manager.configure({ termsAccepted: true })).rejects.toMatchObject({ code });
    expect(f.options.discover).not.toHaveBeenCalled();
    expect((await manager.status()).configured).toBe(false);
  });
}

test("disconnecting and reconnecting owns the new setup even when the previous sign-in transport ignores abort", async () => {
  const relay = fakeSignupRelay();
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const firstRelease = gate(),
    secondRelease = gate();
  let starts = 0;
  const f = await connecting(relay, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/signup/start")) {
        const attempt = ++starts;
        if (attempt === 1) {
          await firstRelease.promise;
        }
        if (attempt === 2) {
          await secondRelease.promise;
        }
      }
      return relay.fetch(input, init);
    },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  const previous = manager.connect({ termsAccepted: true });
  try {
    await vi.waitFor(() => expect(starts).toBe(1));
    await manager.accountUnlink();
    const current = manager.connect({ termsAccepted: true });
    await vi.waitFor(() => expect(starts).toBe(2));
    firstRelease.resolve();
    await previous;
    // The old catch cannot publish a failed/idle state, and its finally cannot clear
    // the new preparation: another click must still join that same second attempt.
    expect((await manager.connect({ termsAccepted: true })).connect).toEqual({
      state: "waiting",
      intent: "existing",
    });
    expect(starts).toBe(2);
    secondRelease.resolve();
    expect((await current).connect?.code).toBe("ABCD-EF23");
    expect(starts).toBe(2);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
  }
});

test("cancelling and failed sign-in setup drain safely in either microtask order", async () => {
  // An HTTP failure and a user's cancellation can land in adjacent microtasks.
  // Vary their ordering without inspecting or replacing the manager's private promises.
  // One configured manager serves every ordering: each round leaves it ready for the next
  // attempt, and opening and configuring a manager per round costs most of the time where
  // every private file operation is a separate process.
  let entered!: () => void, reject!: (error: Error) => void;
  let started!: Promise<void>, transport!: Promise<never>;
  const relay = fakeSignupRelay();
  const f = await connecting(relay, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/signup/start")) {
        entered();
        return transport;
      }
      return relay.fetch(input, init);
    },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  for (let turns = 0; turns < 25; turns++) {
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const preparing = manager.connect({ termsAccepted: true }).catch(() => undefined);
    await started;
    reject(new Error("fixture sign-in service unavailable"));
    for (let turn = 0; turn < turns; turn++) await Promise.resolve();
    await manager.cancelConnect();
    await preparing;
    const status = await manager.status();
    expect(status.connect, `cancellation after ${turns} microtasks`).toBeUndefined();
    expect(status.configured).toBe(true);
  }
});

test("a connection that never finished offers its address nowhere, and starting over leaves a gateway that never connected", async () => {
  const f = await connecting();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const waiting = await manager.connect({ termsAccepted: true });
  expect(waiting.connect).toMatchObject({ state: "waiting", intent: "existing" });
  // While it connects, the connection is what shows; it can still be started over.
  expect(waiting.unfinished).toBeUndefined();
  expect(waiting.can.startOver).toBe(true);
  const firstId = waiting.gatewayId;
  expect(firstId).toBeDefined();
  // The owner stops before signing in, and the gateway restarts.
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const left = await manager.status();
  expect(left).toMatchObject({
    configured: true,
    enabled: false,
    gatewayId: firstId,
    unfinished: {},
    can: { startOver: true, enable: true },
  });
  // Nothing was issued for the reserved name, so nothing failed and nothing is served or offered.
  expect(left.certificate.lastError).toBeUndefined();
  expect(f.options.activate).not.toHaveBeenCalled();
  expect(left.publicOrigin).toBeUndefined();
  expect(left.hostname).toBeUndefined();
  expect(left.publicMcp.url).toBeUndefined();
  expect(left.identities?.find(({ id }) => id === "cloud")?.names).toEqual([]);
  expect(manager.publicOrigin()).toBeUndefined();
  const relayDirectory = join(f.options.configDir, "cloud-relay");
  expect(await readdir(relayDirectory)).toEqual(
    expect.arrayContaining(["management.json", "owner.key"]),
  );

  const fresh = await manager.startOver();
  expect(fresh).toMatchObject({
    configured: false,
    enabled: false,
    enrollment: { state: "unconfigured" },
    can: { startOver: false },
  });
  expect(fresh.gatewayId).toBeUndefined();
  expect(fresh.unfinished).toBeUndefined();
  expect(fresh.connect).toBeUndefined();
  // Only the owner's own choices about new devices may stay; every trace of the attempt is gone.
  expect(
    (await readdir(relayDirectory)).filter(
      (file) => !["account-link.json", "google-link.json"].includes(file),
    ),
  ).toEqual([]);
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(await manager.status()).toMatchObject({ configured: false, can: { startOver: false } });
  // Starting over again changes nothing, and connecting again draws a new gateway id.
  await manager.startOver();
  const again = await manager.connect({ termsAccepted: true });
  expect(again.gatewayId).toBeDefined();
  expect(again.gatewayId).not.toBe(firstId);
  await manager.cancelConnect();
});

test("a refused registration leaves an unfinished connection that says why, and starting over stops its retries", async () => {
  const f = await connecting(undefined, { probeRetryMs: 5 });
  f.relay.poll({ status: "approved" });
  f.register.mockRejectedValue(new Error("Invitation refused"));
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true });
  const failed = await settled("failed");
  expect(failed).toMatchObject({
    enabled: true,
    unfinished: { error: "enrollment-refused" },
    can: { startOver: true },
  });
  expect(failed.publicMcp.url).toBeUndefined();
  const fresh = await manager.startOver();
  expect(fresh).toMatchObject({ configured: false, enabled: false, tunnel: { state: "disabled" } });
  const attempts = f.register.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.register).toHaveBeenCalledTimes(attempts);
});

test("a gateway that has registered is never started over, and a linked one never connects again before it is unlinked", async () => {
  const f = await connectedGateway();
  const before = (await readdir(f.relayDirectory)).sort();
  expect(f.connected).toMatchObject({ can: { startOver: false } });
  expect(f.connected.unfinished).toBeUndefined();
  await expect(manager!.startOver()).rejects.toMatchObject({
    status: 409,
    code: "already-connected",
  });
  const starts = f.relay.calls.filter((path) => path === "/_relay/v3/signup/start").length;
  await expect(manager!.connect({ termsAccepted: true })).rejects.toMatchObject({
    status: 409,
    code: "already-connected",
  });
  expect(f.relay.calls.filter((path) => path === "/_relay/v3/signup/start")).toHaveLength(starts);
  expect((await readdir(f.relayDirectory)).sort()).toEqual(before);
  // Unlinked, it keeps its address for its paired devices: still not something to start over.
  f.relay.handle("/_relay/v3/account-browser/unlink", () => Response.json({ ok: true }));
  const unlinked = await manager!.accountUnlink();
  expect(unlinked.unfinished).toBeUndefined();
  expect(unlinked.can.startOver).toBe(false);
  await expect(manager!.startOver()).rejects.toMatchObject({ code: "already-connected" });
  await manager!.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const restarted = await manager.status();
  expect(restarted.unfinished).toBeUndefined();
  expect(restarted.publicOrigin).toBe(f.connected.publicOrigin);
});

test("connecting reports each step of registering, and whether a chosen new account already existed", async () => {
  const held = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  const certificate = held(),
    tunnel = held();
  const f = await connecting(undefined, {
    startTunnel: vi.fn(() => ({
      stop: vi.fn(),
      close: async () => {},
      cleanupFailure: () => undefined,
      status: () => ({ state: "online" as const }),
      online: () => tunnel.promise,
    })) as unknown as CloudRelayManagerOptions["startTunnel"],
  });
  f.renew.mockImplementationOnce(async () => {
    await certificate.promise;
    return true;
  });
  f.relay.poll({ status: "approved", accountCreated: false });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.connect({ termsAccepted: true, intent: "create" });
  await vi.waitFor(async () =>
    expect((await manager!.status()).connect).toMatchObject({
      state: "registering",
      intent: "create",
      step: "certificate",
    }),
  );
  certificate.release();
  await vi.waitFor(async () =>
    expect((await manager!.status()).connect).toMatchObject({
      state: "registering",
      step: "tunnel",
    }),
  );
  tunnel.release();
  const done = await settled("done");
  expect(done.connect).toEqual({ state: "done", intent: "create", existingAccount: true });
  expect(f.relay.pollFeatures()).toBe("account-created");
  expect(done.publicMcp.url).toBe("https://gateway.example.test/mcp");
  // Once the owner has been told, later reads no longer say it; acknowledging again changes nothing.
  const acknowledged = await manager.acknowledgeConnect();
  expect(acknowledged.connect).toEqual({ state: "done", intent: "create" });
  expect((await manager.status()).connect).toEqual({ state: "done", intent: "create" });
  expect((await manager.acknowledgeConnect()).connect).toEqual({ state: "done", intent: "create" });
});

test("acknowledging leaves a connection that is not done with an existing account as it was", async () => {
  const f = await connecting();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.acknowledgeConnect()).connect).toBeUndefined();
  await manager.connect({ termsAccepted: true, intent: "create" });
  expect((await manager.acknowledgeConnect()).connect).toMatchObject({ state: "waiting" });
  await manager.cancelConnect();
});

test("only a chosen new account that turned out to exist is reported, and an older relay reports nothing", async () => {
  for (const [intent, accountCreated, existingAccount] of [
    ["create", true, false],
    ["existing", false, false],
    ["create", undefined, false],
  ] as const) {
    const f = await connecting();
    f.relay.poll({
      status: "approved",
      ...(accountCreated === undefined ? {} : { accountCreated }),
    });
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.connect({ termsAccepted: true, intent });
    const done = await settled("done");
    expect(done.connect?.existingAccount ?? false).toBe(existingAccount);
    await manager.close();
    manager = undefined;
  }
});

test("a gateway that registered before the marker existed is recognised by what registering left, and records it", async () => {
  const marker = join(directory, "cloud-relay/registered.json");
  // Its session file, a pending release, or a certificate its authority issued.
  const evidence: Array<[string, () => Promise<void>]> = [
    ["session", () => writeFile(join(directory, "cloud-relay/session.json"), "{}")],
    ["release", () => writeFile(join(directory, "cloud-relay/release.json"), "{}")],
    [
      "certificate",
      async () => {
        const issuer = tlsFiles(await mkdtemp(join(directory, "issuer-")));
        const leaf = tlsFiles(await mkdtemp(join(directory, "leaf-")), "gateway.example.test");
        expiredCertificate({
          certificateFile: leaf.certFile,
          privateKeyFile: leaf.keyFile,
          outputFile: join(directory, "cloud-relay/public.pem"),
          issuer: { certificateFile: issuer.certFile, privateKeyFile: issuer.keyFile },
        });
      },
    ],
  ];
  for (const [kind, leave] of evidence) {
    const f = fixture();
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure(input);
    await manager.close();
    await leave();
    manager = await GatewayCloudRelayManagement.open(f.options);
    const status = await manager.status();
    expect(status.publicOrigin, kind).toBe("https://gateway.example.test");
    expect(status.unfinished, kind).toBeUndefined();
    expect(status.can.startOver, kind).toBe(false);
    expect(JSON.parse(await readFile(marker, "utf8")), kind).toMatchObject({ version: 1 });
    await manager.close();
    manager = undefined;
    await rm(join(directory, "cloud-relay"), { recursive: true, force: true });
  }
  // A certificate the gateway made for itself proves nothing.
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  const own = tlsFiles(directory, "gateway.example.test");
  await writeFile(join(directory, "cloud-relay/public.pem"), await readFile(own.certFile));
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.status()).unfinished).toEqual({});
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test("starting over waits for a registration in flight, which may succeed", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture();
  f.register.mockImplementationOnce(async () => {
    await held;
    return { token: "private-session", accountId: "a".repeat(64), expiresAt: 4000000000 };
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await vi.waitFor(() => expect(f.register).toHaveBeenCalled());
  expect((await manager.status()).can.startOver).toBe(false);
  await expect(manager.startOver()).rejects.toMatchObject({ code: "operation-in-progress" });
  release();
  await idle();
  // It registered, so there is nothing unfinished to discard.
  expect((await manager.status()).unfinished).toBeUndefined();
  await expect(manager.startOver()).rejects.toMatchObject({ code: "already-connected" });
});

test("a marker that can't be written leaves the registration standing, and a marked failure stops admission", async () => {
  const original = privateCredentials.savePrivateJson;
  let failure: unknown = new Error("disk full");
  vi.spyOn(privateCredentials, "savePrivateJson").mockImplementation((path, value) =>
    String(path).endsWith("registered.json") ? Promise.reject(failure) : original(path, value),
  );
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  // Registered all the same: the address is offered, and its session says so after a restart.
  expect(await manager.status()).toMatchObject({
    enrollment: { state: "enrolled" },
    publicOrigin: "https://gateway.example.test",
  });
  await manager.close();
  failure = markedFileError("ENOENT", "own");
  const marked = fixture();
  await rm(join(directory, "cloud-relay"), { recursive: true, force: true });
  manager = await GatewayCloudRelayManagement.open(marked.options);
  await manager.configure(input);
  // The launch may already have failed by the time enabling returns.
  await manager.enable().catch(() => {});
  await vi.waitFor(() => expect(manager!.cleanupFailure()).toBe(failure));
  // Closing reports the same unfinished private operation.
  await expect(manager.close()).rejects.toBeDefined();
  manager = undefined;
});

async function issuedRouteCertificate() {
  const { execFileSync } = await import("node:child_process");
  const issuer = tlsFiles(await mkdtemp(join(directory, "route-issuer-")));
  const leaf = tlsFiles(await mkdtemp(join(directory, "route-leaf-")), "gateway.example.test");
  const request = join(directory, "route.csr"),
    output = join(directory, "cloud-relay/public.pem");
  execFileSync(
    "openssl",
    ["x509", "-x509toreq", "-in", leaf.certFile, "-signkey", leaf.keyFile, "-out", request],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      issuer.certFile,
      "-CAkey",
      issuer.keyFile,
      "-set_serial",
      "1",
      "-days",
      "1",
      "-out",
      output,
    ],
    { stdio: "ignore" },
  );
}

test("actual periodic public route probes expose fresh loss/recovery and invalidate changed certificate evidence", async () => {
  const probe = vi.fn(async () => true),
    f = fixture({
      probe,
      env: { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test", OMNESIS_DESKTOP_MANAGED: "1" },
    });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await issuedRouteCertificate();
  vi.useFakeTimers();
  try {
    await manager.enable();
    await idle();
    const first = await manager.status();
    expect(first.certificate.state).toBe("expiring");
    expect(first.publicMcp).toMatchObject({
      ready: true,
      checkedAt: expect.any(Number),
      validUntil: expect.any(Number),
    });
    probe.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect((await manager!.status()).publicMcp.ready).toBe(false));
    expect((await manager.status()).publicMcp.checkedAt).toBeUndefined();
    probe.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect((await manager!.status()).publicMcp.ready).toBe(true));
    const startTunnel = f.options.startTunnel;
    if (!startTunnel) throw new Error("Fixture tunnel factory unavailable");
    const tunnel = vi.mocked(startTunnel).mock.results[0]?.value;
    if (!tunnel) throw new Error("Fixture tunnel unavailable");
    vi.spyOn(tunnel, "status").mockReturnValue({
      state: "online",
      lastConnectedAt: new Date(Date.now()).toISOString(),
    });
    expect((await manager.status()).publicMcp.checkedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () =>
      expect((await manager!.status()).publicMcp.checkedAt).toBeTypeOf("number"),
    );
    const checked = (await manager.status()).publicMcp.checkedAt!;
    await issuedRouteCertificate();
    expect((await manager.status()).publicMcp.checkedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () =>
      expect((await manager!.status()).publicMcp.checkedAt!).toBeGreaterThan(checked),
    );
    const calls = probe.mock.calls.length;
    await manager.disable();
    expect((await manager.status()).publicMcp.checkedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probe).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});

test("disabling joins a noncooperative periodic route probe and cannot overlap a new generation", async () => {
  const probe = vi.fn(async (_origin: string, _signal: AbortSignal) => true),
    f = fixture({
      probe,
      env: { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test", OMNESIS_DESKTOP_MANAGED: "1" },
    });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await issuedRouteCertificate();
  let release = (value: boolean) => {},
    settled = false;
  vi.useFakeTimers();
  try {
    await manager.enable();
    await idle();
    probe.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    const stopped = manager.disable().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(probe.mock.calls[1]?.[1].aborted).toBe(true));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probe).toHaveBeenCalledTimes(2);
    release(true);
    await stopped;
    expect((await manager.status()).publicMcp.checkedAt).toBeUndefined();
  } finally {
    release(false);
    vi.useRealTimers();
  }
});

test("ordinary headless relay keeps existing probe cadence without the desktop periodic loop", async () => {
  const probe = vi.fn(async () => true),
    f = fixture({ probe });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  vi.useFakeTimers();
  try {
    await manager.enable();
    await idle();
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probe).toHaveBeenCalledOnce();
    expect((await manager.status()).publicMcp.ready).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a queued negative retry after periodic success cannot lend fresh evidence to a legacy ready flag", async () => {
  const probe = vi
    .fn(async () => false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const f = fixture({
    probe,
    probeRetryMs: 45_000,
    env: { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test", OMNESIS_DESKTOP_MANAGED: "1" },
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await issuedRouteCertificate();
  vi.useFakeTimers();
  try {
    await manager.enable();
    await idle();
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () =>
      expect((await manager!.status()).publicMcp.checkedAt).toBeTypeOf("number"),
    );
    expect((await manager.status()).publicMcp.ready).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () =>
      expect((await manager!.status()).publicMcp.checkedAt).toBeUndefined(),
    );
    // Preserve the old boolean contract; only an actual positive probe can certify new readiness.
    expect((await manager.status()).publicMcp.ready).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
