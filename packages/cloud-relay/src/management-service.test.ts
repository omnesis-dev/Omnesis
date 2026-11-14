// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { expiredCertificate } from "../test/expired-certificate.js";
import { fakeSignupRelay } from "../test/fake-signup-relay.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import {
  GatewayCloudRelayManagement,
  type CloudRelayManagerOptions,
} from "./management-service.js";
import { CloudRelayManagementFailure } from "./management.js";
import { HostedNameTaken } from "./relay-configuration.js";
import { googleBrowserTrust } from "./google-browser-trust.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { GatewayUnregistered, readOrCreateGatewayOwnerKey } from "./gateway-key-client.js";

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
  expect(status.publicOrigin).toBe(
    `https://${hostedGatewayHostname(drawn[2]!, "relay.example.test")}`,
  );
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ gatewayId: drawn[2] }),
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
  // Still being looked at again, so not reported as an error yet, and never with its details.
  expect((await manager.status()).publicMcp).toMatchObject({ ready: false });
  expect(JSON.stringify(await manager.status())).not.toContain("private-endpoint-details");
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
  await manager.disable();
  finish(true);
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
  const f = fixture({
    fetch: transport,
    googleTrust: () => ({ deviceClientIds: [], deviceAuthorizedParties: [] }),
  });
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
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
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
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
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
    expect((await settled("failed")).connect).toEqual({ state: "failed", error: reason });
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
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
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
function relayForgot(f: ReturnType<typeof fixture>): () => void {
  const start = f.options.startTunnel as unknown as { mock: { calls: unknown[][] } };
  return start.mock.calls.at(-1)![2] as () => void;
}
async function forgotten() {
  await vi.waitFor(async () => expect((await manager!.status()).notice).toBe("account-deleted"), {
    timeout: 10_000,
  });
  return manager!.status();
}
const UNLINK = "/_relay/v3/account-browser/unlink";
/** What stays on a gateway that left its account: its id and what serves its paired devices. */
const RETAINED = ["acme-account.key", "management.json", "owner.key", "public.key", "public.pem"];
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
  // A record that cannot be read cannot be acted on, and does not hold the gateway back.
  await writeFile(file, "{");
  manager.start();
  await gone();
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
  const requestAccessUrl = "https://groups.example.com/g/fictional-testers";
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url) === "https://relay.example.test/_relay/v3/signup/access"
      ? Response.json({ signup: { inviteOnly: true, requestAccessUrl } })
      : new Response(null, { status: 404 }),
  );
  manager = await GatewayCloudRelayManagement.open(fixture({ fetch }).options);
  await manager.refreshSignupAccess();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await manager.status()).signup).toEqual({ inviteOnly: true, requestAccessUrl });
});
