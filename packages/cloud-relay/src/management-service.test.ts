// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import {
  GatewayCloudRelayManagement,
  type CloudRelayManagerOptions,
} from "./management-service.js";
import { CloudRelayManagementFailure } from "./management.js";

let directory: string, manager: GatewayCloudRelayManagement | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-management-"));
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
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
    env: { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test" },
    gatewayUrl: () => "https://localhost:12345",
    fetch: vi.fn<typeof fetch>(async (url, init) =>
      String(url).includes("/_relay/v2/google/browser/config")
        ? new Response(null, { status: 404 })
        : fetch(url, init),
    ),
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
      close,
      renew,
      fingerprintSha256: () => "b".repeat(64),
      spkiFingerprintSha256: () => "c".repeat(64),
    })),
    startTunnel: vi.fn(() => ({
      stop,
      status: () => ({ state: "online" as const }),
    })) as unknown as CloudRelayManagerOptions["startTunnel"],
    ...overrides,
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
test("configure assigns a stable gateway, explicitly enables actual enrollment and reports independent public/direct identities", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  const saved = await manager.configure(input);
  expect(saved).toMatchObject({
    configured: true,
    enabled: false,
    publicOrigin: "https://gateway.example.test",
    enrollment: { state: "pending" },
  });
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.register).not.toHaveBeenCalled();
  const certificate = await readFile(tlsFiles(directory).certFile, "utf8");
  await writeFile(join(directory, "cloud-relay/public.pem"), certificate);
  await manager.enable({ invitation: "private-invitation" });
  await idle();
  expect(await manager.status()).toMatchObject({
    enabled: true,
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    publicMcp: { ready: true },
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
    JSON.parse(await readFile(join(directory, "cloud-relay/invitation.json"), "utf8")),
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
  await writeFile(join(directory, "cloud-relay"), "invalid");
  await expect(GatewayCloudRelayManagement.open(fixture().options)).rejects.toThrow();
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
    startTunnel: undefined,
    stopLegacy: vi.fn(async () => {}),
    probe: undefined,
  });
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ resource: "https://gateway.example.test/mcp" }),
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
  expect((await manager.status()).publicMcp).toMatchObject({
    ready: false,
    lastError: "public-endpoint-unreachable",
  });
  expect((await manager.status()).certificate.lastError).toBeUndefined();
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
  const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", transport);
  await manager.googleUnlink();
  expect((await manager.status()).enabled).toBe(true);
});
test("disabled restart restores the existing hostname-specific context without renewal, and wrong-host material fails closed", async () => {
  const f = fixture();
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  const files = tlsFiles(directory, "gateway.example.test");
  await writeFile(join(directory, "cloud-relay/public.pem"), await readFile(files.certFile));
  await writeFile(join(directory, "cloud-relay/public.key"), await readFile(files.keyFile));
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
    JSON.parse(await readFile(join(directory, "cloud-relay/invitation.json"), "utf8")),
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
  const f = fixture({ env: {} });
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect(await manager.status()).toMatchObject({
    serviceConfigured: true,
    config: { relayUrl: "https://relay.omnesis.app" },
  });
  await manager.configure({ termsAccepted: true });
  expect(f.discover).toHaveBeenCalledWith(
    "https://relay.omnesis.app",
    expect.any(String),
    expect.any(AbortSignal),
    f.options.fetch,
  );
  await manager.close();
  manager = await GatewayCloudRelayManagement.open(f.options);
  expect((await manager.configure({ termsAccepted: true })).config.relayUrl).toBe(
    "https://relay.omnesis.app",
  );
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
  manager = await GatewayCloudRelayManagement.open({ ...f.options, env: {} });
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
    publicOrigin: saved.publicOrigin!,
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
  await expect(manager.close()).rejects.toMatchObject({ code: "relay-unreachable" });
  expect(f.stop).toHaveBeenCalledTimes(stopped + 1);
  expect(f.close).toHaveBeenCalledTimes(closed + 1);
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
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "managed-owner-client",
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "managed-device-client",
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS: "managed-device-client",
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES: "managed-android",
    },
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
  expect(transport).toHaveBeenCalledOnce();
  expect(String(transport.mock.calls[0]![0])).toBe(
    "https://relay.example.test/_relay/v2/google/browser/config",
  );
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
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "managed-owner-client",
    },
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

test("missing independent deployment IDs leave Google unavailable without querying the relay or disrupting direct and relay operation", async () => {
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error("unconfigured Google must not query a service");
  });
  const f = fixture({ fetch: transport });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure(input);
  await manager.enable();
  await idle();
  expect(transport).not.toHaveBeenCalled();
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
  expect(transport).not.toHaveBeenCalled();
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
    env: {
      OMNESIS_CLOUD_RELAY_URL: input.relayUrl,
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID: "trusted-owner",
      OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID: "trusted-device",
    },
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
