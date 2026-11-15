// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startCertificateMonitorPoller } from "./certificate-monitor-poller.js";
import { GatewayCertificateMonitor } from "./gateway-certificate-monitor.js";
import type { CertificateMonitorStatus } from "./certificate-monitor.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const status: CertificateMonitorStatus = {
  provider: "certspotter",
  hostname: "gateway.example.test",
  state: "observing",
  incidents: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test("marked polling failures stop retries and remain terminal through repeated stop", async () => {
  const marker = Object.assign(new Error("fixture private publication uncertain"), {
    cleanupFailure: undefined,
  });
  const check = vi.fn(async () => {
    throw new Error("wrapper", { cause: marker });
  });
  const poller = startCertificateMonitorPoller({
    monitor: { check, status: () => status },
    intervalMs: 60_000,
  })!;
  await expect(poller.check()).rejects.toThrow("wrapper");
  expect(poller.cleanupFailure()).toMatchObject({ cause: marker });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(check).toHaveBeenCalledOnce();
  await expect(poller.check()).rejects.toBe(poller.cleanupFailure());
  const stopped = poller.stop();
  expect(poller.stop()).toBe(stopped);
  await expect(stopped).rejects.toBe(poller.cleanupFailure());
  expect(vi.getTimerCount()).toBe(0);
});

test("ordinary polling failures retain normal unavailable status and retry", async () => {
  const check = vi
    .fn()
    .mockRejectedValueOnce(new Error("ordinary fixture outage"))
    .mockResolvedValue(status);
  const poller = startCertificateMonitorPoller({
    monitor: { check, status: () => status },
    intervalMs: 60_000,
  })!;
  await expect(poller.check()).resolves.toMatchObject({ state: "unavailable" });
  expect(poller.cleanupFailure()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(check).toHaveBeenCalledTimes(2);
  expect(poller.status()).toMatchObject({ state: "observing" });
  await expect(poller.stop()).resolves.toBeUndefined();
});

test("gateway close joins accepted initialization and prevents a late poller", async () => {
  const entered = deferred<void>(),
    gate = deferred<{
      check: () => Promise<CertificateMonitorStatus>;
      status: () => CertificateMonitorStatus;
    }>();
  const check = vi.fn(async () => status);
  const create = vi.fn(async () => {
    entered.resolve();
    return gate.promise;
  });
  const actor = new GatewayCertificateMonitor({
    env: {},
    configDir: "/fixture",
    identity: () => ({
      publicOrigin: "https://gateway.example.test",
      spkiFingerprint: "a".repeat(64),
    }),
    create,
  });
  actor.start();
  await entered.promise;
  const close = actor.close();
  expect(actor.close()).toBe(close);
  expect(actor.cleanupFailure()).toMatchObject({ cleanupPending: true });
  gate.resolve({ check, status: () => status });
  await close;
  expect(check).not.toHaveBeenCalled();
  expect(actor.cleanupFailure()).toBeUndefined();
  actor.start();
  expect(create).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("gateway initialization uncertainty is never reduced to a retryable status string", async () => {
  const marker = Object.assign(new Error("fixture journal read uncertain"), {
    cleanupFailure: undefined,
  });
  const create = vi.fn(async () => {
    throw marker;
  });
  const actor = new GatewayCertificateMonitor({
    env: {},
    configDir: "/fixture",
    identity: () => ({
      publicOrigin: "https://gateway.example.test",
      spkiFingerprint: "a".repeat(64),
    }),
    create,
  });
  actor.start();
  await vi.waitFor(() => expect(actor.cleanupFailure()).toBe(marker));
  await vi.advanceTimersByTimeAsync(60_001);
  actor.start();
  expect(create).toHaveBeenCalledOnce();
  await expect(actor.close()).rejects.toBe(marker);
});

test("closing during a recorded-incident callback never starts a late probe", async () => {
  const entered = deferred<void>(),
    gate = deferred<void>();
  const check = vi.fn(async () => status);
  const incident = {
    hostname: "gateway.example.test",
    certificateFingerprint: "c".repeat(64),
    spkiFingerprint: "d".repeat(64),
    issuer: "Fictional test issuer",
    serial: "01",
    validFrom: "2028-01-01T00:00:00.000Z",
    validTo: "2028-02-01T00:00:00.000Z",
    providerEntryId: "fixture-recorded-incident",
    observedAt: "2028-01-02T00:00:00.000Z",
  };
  const actor = new GatewayCertificateMonitor({
    env: {},
    configDir: "/fixture",
    identity: () => ({
      publicOrigin: "https://gateway.example.test",
      spkiFingerprint: "a".repeat(64),
    }),
    create: async () => ({
      check,
      status: () => ({ ...status, state: "incident", incidents: [incident] }),
    }),
    onIncident: async () => {
      entered.resolve();
      await gate.promise;
    },
  });
  actor.start();
  await entered.promise;
  const close = actor.close();
  expect(actor.cleanupFailure()).toMatchObject({ cleanupPending: true });
  gate.resolve();
  await close;
  expect(check).not.toHaveBeenCalled();
  expect(actor.cleanupFailure()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
