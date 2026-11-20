// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";
import { createGatewayAcmeController } from "./acme-integration.js";
import { prepareGatewayOwner } from "./gateway-key-client.js";
import { readPrivateJson } from "./google-credentials.js";
import { readPrivateText } from "./private-inputs.js";

vi.mock("./acme-bootstrap.js", () => ({ ensureAcmeBootstrap: vi.fn() }));
vi.mock("./google-credentials.js", () => ({ readPrivateJson: vi.fn() }));
vi.mock("./gateway-key-client.js", () => ({
  prepareGatewayOwner: vi.fn(),
  registerGatewayKey: vi.fn(),
  gatewayKeySessionSource: vi.fn(),
}));
vi.mock("./private-inputs.js", () => ({ readPrivateText: vi.fn() }));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "acme-controller-dns-"));
  const vectors = JSON.parse(
    await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
  ) as { gateway: { certificate: string } };
  await writeFile(join(directory, "public.pem"), vectors.gateway.certificate);
  vi.mocked(ensureAcmeBootstrap).mockResolvedValue(undefined);
  vi.mocked(readPrivateJson).mockResolvedValue({ token: "invented-token" });
  vi.mocked(prepareGatewayOwner).mockResolvedValue({ accountId: "invented-account" } as Awaited<
    ReturnType<typeof prepareGatewayOwner>
  >);
  vi.mocked(readPrivateText).mockResolvedValue("invented activation key");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const env = {
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_TERMS_ACCEPTED: "1",
    OMNESIS_ACME_DNS_PROVIDER: "cloudflare",
    OMNESIS_ACME_DNS_ZONE_ID: "a".repeat(32),
    OMNESIS_ACME_DNS_ZONE_NAME: "example.test",
    OMNESIS_ACME_DNS_TOKEN_FILE: join(directory, "token.json"),
    OMNESIS_ACME_CERT_FILE: join(directory, "public.pem"),
    OMNESIS_TLS_CERT: join(directory, "direct.pem"),
    OMNESIS_TLS_KEY: join(directory, "direct.key"),
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: "00000000-0000-4000-8000-000000000001",
  };
  const activate = vi.fn(async () => {});
  return { env, options: { configDir: directory, activate }, activate };
}

function dnsOwner() {
  let failure: unknown;
  const close = vi.fn(async () => {
    if (failure !== undefined) throw failure;
  });
  // Only the provider actor seam is substituted; no native process is launched.
  const owner = {
    create: vi.fn(),
    remove: vi.fn(),
    close,
    cleanupFailure: () => failure,
  };
  vi.spyOn(AcmeDnsChallenges, "open").mockResolvedValue(owner as unknown as AcmeDnsChallenges);
  return { owner, close, hold: (error: unknown) => (failure = error) };
}

test("a returned DNS owner with an explicit receipt is retained before activation", async () => {
  const f = fixture(),
    dns = dnsOwner();
  const failure = Object.assign(new Error("Invented DNS publication uncertainty"), {
    cleanupFailure: undefined,
  });
  dns.hold(failure);
  const controller = (await createGatewayAcmeController(f.env, f.options))!;
  expect(controller.cleanupFailure()).toBe(failure);
  expect(readPrivateText).not.toHaveBeenCalled();
  expect(f.activate).not.toHaveBeenCalled();
  const count = vi.mocked(ensureAcmeBootstrap).mock.calls.length;
  await expect(controller.renew(new AbortController().signal)).rejects.toBe(failure);
  expect(ensureAcmeBootstrap).toHaveBeenCalledTimes(count);
  const closing = controller.close();
  expect(controller.close()).toBe(closing);
  await expect(closing).rejects.toMatchObject({ cleanupFailure: undefined });
  expect(dns.close).toHaveBeenCalledOnce();
});

test("failed initialization cannot orphan a DNS owner whose close is unconfirmed", async () => {
  const f = fixture(),
    dns = dnsOwner();
  f.activate.mockRejectedValue(new Error("Invented ordinary activation failure"));
  const failure = Object.assign(new Error("Invented DNS close uncertainty"), {
    cleanupFailure: undefined,
  });
  dns.close.mockRejectedValue(failure);
  const controller = (await createGatewayAcmeController(f.env, f.options))!;
  expect(AcmeDnsChallenges.open).toHaveBeenCalledOnce();
  expect(dns.close).toHaveBeenCalledOnce();
  expect(controller.cleanupFailure()).toMatchObject({ cleanupFailure: undefined });
  await expect(controller.renew(new AbortController().signal)).rejects.toMatchObject({
    cleanupFailure: undefined,
  });
  await expect(controller.close()).rejects.toMatchObject({ cleanupFailure: undefined });
  expect(AcmeDnsChallenges.open).toHaveBeenCalledOnce();
  expect(dns.close).toHaveBeenCalledOnce();
});

test("a joined ordinary DNS close failure allows fresh journal recovery on retry", async () => {
  const f = fixture(),
    dns = dnsOwner();
  f.activate.mockRejectedValueOnce(new Error("Invented ordinary activation failure"));
  dns.close.mockRejectedValue(new Error("Invented joined DNS cleanup outage"));
  const replacement = { ...dns.owner, close: vi.fn(async () => {}) };
  vi.mocked(AcmeDnsChallenges.open)
    .mockResolvedValueOnce(dns.owner as unknown as AcmeDnsChallenges)
    .mockResolvedValue(replacement as unknown as AcmeDnsChallenges);
  const controller = (await createGatewayAcmeController(f.env, f.options))!;
  expect(controller.cleanupFailure()).toBeUndefined();
  // Stop the test after successful replacement initialization, before any issuer/network work.
  vi.mocked(ensureAcmeBootstrap)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Invented joined renewal outage"));
  await expect(controller.renew(new AbortController().signal)).rejects.toThrow(
    "Invented joined renewal outage",
  );
  expect(AcmeDnsChallenges.open).toHaveBeenCalledTimes(2);
  expect(dns.close).toHaveBeenCalledOnce();
  expect(controller.cleanupFailure()).toBeUndefined();
  await controller.close();
  expect(replacement.close).toHaveBeenCalledOnce();
});

test("a DNS publication receipt after activation blocks the next native renewal phase", async () => {
  const f = fixture(),
    dns = dnsOwner();
  const controller = (await createGatewayAcmeController(f.env, f.options))!;
  expect(f.activate).toHaveBeenCalledOnce();
  const failure = new Error("Invented outer DNS receipt", {
    cause: Object.assign(new Error("Invented unresolved publication"), {
      cleanupFailure: undefined,
    }),
  });
  dns.hold(failure);
  expect(controller.cleanupFailure()).toBe(failure);
  const count = vi.mocked(ensureAcmeBootstrap).mock.calls.length;
  await expect(controller.renew(new AbortController().signal)).rejects.toBe(failure);
  expect(ensureAcmeBootstrap).toHaveBeenCalledTimes(count);
  await expect(controller.close()).rejects.toMatchObject({ cleanupFailure: undefined });
  expect(dns.close).toHaveBeenCalledOnce();
});

test("actual pending DNS work is not latched as terminal uncertainty", async () => {
  const f = fixture(),
    dns = dnsOwner();
  const controller = (await createGatewayAcmeController(f.env, f.options))!;
  const pending = Object.assign(new Error("Invented accepted DNS work"), {
    cleanupFailure: undefined,
    cleanupPending: true,
  });
  dns.hold(pending);
  expect(controller.cleanupFailure()).toBe(pending);
  const ordinary = new Error("Invented joined bootstrap outage");
  vi.mocked(ensureAcmeBootstrap).mockRejectedValueOnce(ordinary);
  await expect(controller.renew(new AbortController().signal)).rejects.toBe(ordinary);
  dns.hold(undefined);
  expect(controller.cleanupFailure()).toBeUndefined();
  await controller.close();
});

test("closing construction adopts and joins a late DNS owner without activating it", async () => {
  const f = fixture(),
    dns = dnsOwner();
  const construction = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(AcmeDnsChallenges.open).mockImplementationOnce(async () => {
    entered();
    await gate;
    return dns.owner as unknown as AcmeDnsChallenges;
  });
  const pending = createGatewayAcmeController(f.env, { ...f.options, signal: construction.signal });
  await started;
  construction.abort();
  release();
  const controller = (await pending)!;
  expect(dns.close).toHaveBeenCalledOnce();
  expect(f.activate).not.toHaveBeenCalled();
  expect(readPrivateText).not.toHaveBeenCalled();
  expect(controller.cleanupFailure()).toBeUndefined();
  await controller.close();
  expect(dns.close).toHaveBeenCalledOnce();
});
