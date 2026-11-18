// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";
import { createGatewayAcmeController } from "./acme-integration.js";
import { readBrokerMarker } from "./dns-broker-client.js";
import { hostedGatewayHostname } from "./hosted-name.js";

vi.mock("./acme-bootstrap.js", () => ({ ensureAcmeBootstrap: vi.fn() }));
vi.mock("./private-inputs.js", () => ({
  readPrivateText: vi.fn(async () => "invented activation key"),
}));
vi.mock("./gateway-key-client.js", () => ({
  gatewayKeySessionSource: vi.fn(),
  prepareGatewayOwner: vi.fn(),
  readOrCreateGatewayOwnerKey: vi.fn(),
  registerGatewayKey: vi.fn(),
}));
vi.mock("./dns-broker-client.js", () => ({
  dnsBrokerSelection: vi.fn(() => ({ url: "https://dns.example.test", required: true })),
  dnsBrokerClient: vi.fn(),
  brokerOrRelayPresenter: vi.fn(() => ({ beforeOrder: vi.fn(), create: vi.fn(), remove: vi.fn() })),
  readBrokerMarker: vi.fn(),
}));
let directory: string;
const controllers: NonNullable<Awaited<ReturnType<typeof createGatewayAcmeController>>>[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "invented-acme-caa-"));
  const vectors = JSON.parse(
    await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
  ) as { gateway: { certificate: string } };
  await writeFile(join(directory, "public.pem"), vectors.gateway.certificate);
  vi.mocked(ensureAcmeBootstrap).mockResolvedValue(undefined);
  vi.mocked(readBrokerMarker).mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.allSettled(controllers.splice(0).map((controller) => controller.close()));
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function controller() {
  const gatewayId = "00000000-0000-4000-8000-000000000001";
  const result = (await createGatewayAcmeController(
    {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
      OMNESIS_ACME_TERMS_ACCEPTED: "1",
      OMNESIS_ACME_DNS_PROVIDER: "broker",
      OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test",
      OMNESIS_ACME_CERT_FILE: join(directory, "public.pem"),
      OMNESIS_TLS_CERT: join(directory, "direct.pem"),
      OMNESIS_TLS_KEY: join(directory, "direct.key"),
      OMNESIS_PUBLIC_BASE_URL: `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}`,
      OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
      OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    },
    { configDir: directory, activate: async () => {} },
  ))!;
  controllers.push(result);
  return result;
}

test.each([false, true])(
  "expectedCaa retains an explicit private-read receipt (nested=%s)",
  async (nested) => {
    const owner = await controller();
    const marker = Object.assign(new Error("invented broker marker uncertainty"), {
      cleanupFailure: undefined,
    });
    const error = nested ? new Error("invented broker marker wrapper", { cause: marker }) : marker;
    vi.mocked(readBrokerMarker).mockRejectedValue(error);
    await expect(owner.expectedCaa!()).rejects.toBe(error);
    expect(owner.cleanupFailure()).toBe(error);
    await expect(owner.expectedCaa!()).rejects.toBe(error);
    await expect(owner.renew(new AbortController().signal)).rejects.toBe(error);
    expect(readBrokerMarker).toHaveBeenCalledOnce();
    expect(ensureAcmeBootstrap).toHaveBeenCalledOnce();
    const close = owner.close();
    expect(owner.close()).toBe(close);
    await expect(close).rejects.toBe(error);
  },
);

test("close retains the accepted account read and refuses its late continuation", async () => {
  const owner = await controller();
  let entered = false;
  const gate = deferred<Awaited<ReturnType<typeof readBrokerMarker>>>();
  vi.mocked(readBrokerMarker).mockImplementation(async () => {
    entered = true;
    return gate.promise;
  });
  let work: ReturnType<NonNullable<typeof owner.expectedCaa>> | undefined,
    closing: Promise<void> | undefined;
  try {
    work = owner.expectedCaa!();
    void work.catch(() => {});
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(owner.cleanupFailure()).toMatchObject({ cleanupPending: true });
    closing = owner.close();
    expect(owner.close()).toBe(closing);
    expect(owner.cleanupFailure()).toMatchObject({ cleanupPending: true });
    gate.resolve({ claimedAt: 1, accountUri: "https://ca.example.test/acme/acct/42" });
    await expect(work).rejects.toThrow("closed");
    await closing;
    await expect(owner.expectedCaa!()).rejects.toThrow("closed");
    expect(readBrokerMarker).toHaveBeenCalledOnce();
    expect(owner.cleanupFailure()).toBeUndefined();
  } finally {
    gate.resolve(undefined);
    await Promise.allSettled([work, closing, owner.close()]);
  }
});

test("an ordinary account read failure can recover without losing its CAA binding", async () => {
  const owner = await controller();
  const failure = Object.assign(new Error("invented ordinary marker read failure"), {
    code: "EACCES",
  });
  vi.mocked(readBrokerMarker)
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ claimedAt: 1, accountUri: "https://ca.example.test/acme/acct/42" });
  await expect(owner.expectedCaa!()).rejects.toBe(failure);
  expect(owner.cleanupFailure()).toBeUndefined();
  await expect(owner.expectedCaa!()).resolves.toBe("https://ca.example.test/acme/acct/42");
  await owner.close();
});
