// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startCertificateMonitorPoller } from "./certificate-monitor-poller.js";
import type { CertificateMonitorStatus } from "./certificate-monitor.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  let current: CertificateMonitorStatus = {
    provider: "certspotter",
    hostname: "gateway.example.test",
    state: "observing",
    incidents: [],
  };
  const monitor = {
    status: () => current,
    check: vi
      .fn<(_signal?: AbortSignal) => Promise<CertificateMonitorStatus>>()
      .mockImplementation(() => Promise.resolve(current)),
  };
  return {
    monitor,
    set(value: Partial<CertificateMonitorStatus>) {
      current = { ...current, ...value };
    },
  };
}
test("default-off imports schedule nothing and malformed intervals are rejected", () => {
  expect(startCertificateMonitorPoller()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  for (const intervalMs of [0, 59999, 86400001, NaN, 1.5])
    expect(() => startCertificateMonitorPoller({ monitor: fixture().monitor, intervalMs })).toThrow(
      "interval",
    );
});
test("checks immediately then on the configured interval with one unreferenced lifecycle timer", async () => {
  const f = fixture(),
    poller = startCertificateMonitorPoller({ monitor: f.monitor })!;
  await poller.check();
  expect(f.monitor.check).toHaveBeenCalledOnce();
  expect(poller.status().state).toBe("observing");
  await vi.advanceTimersByTimeAsync(899999);
  expect(f.monitor.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.monitor.check).toHaveBeenCalledTimes(2);
  await poller.stop();
  expect(vi.getTimerCount()).toBe(0);
});
test("provider retry windows are respected and a past retry deadline returns to the ordinary interval", async () => {
  const f = fixture();
  f.set({ nextCheckAt: new Date(Date.now() + 180000).toISOString() });
  const poller = startCertificateMonitorPoller({ monitor: f.monitor, intervalMs: 60000 })!;
  await poller.check();
  await vi.advanceTimersByTimeAsync(179999);
  expect(f.monitor.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.monitor.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.monitor.check).toHaveBeenCalledTimes(3);
  await poller.stop();
});
test("service outages back off with a bound and recovery resets the normal interval", async () => {
  const f = fixture();
  f.set({ state: "unavailable" });
  const poller = startCertificateMonitorPoller({ monitor: f.monitor, intervalMs: 60000 })!;
  await poller.check();
  await vi.advanceTimersByTimeAsync(119999);
  expect(f.monitor.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.monitor.check).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 11; index++) await vi.advanceTimersToNextTimerAsync();
  expect(vi.getTimerCount()).toBe(1);
  f.set({ state: "stale" });
  await vi.advanceTimersToNextTimerAsync();
  f.set({ state: "incident" });
  await vi.advanceTimersToNextTimerAsync();
  const calls = f.monitor.check.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.monitor.check).toHaveBeenCalledTimes(calls + 1);
  await poller.stop();
});
test("manual checks coalesce; stop aborts pending work and a late completion cannot reschedule", async () => {
  const f = fixture();
  let release!: (value: CertificateMonitorStatus) => void;
  f.monitor.check.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
  const poller = startCertificateMonitorPoller({ monitor: f.monitor, intervalMs: 60000 })!,
    first = poller.check(),
    second = poller.check();
  expect(first).toBe(second);
  const stop = poller.stop();
  expect(f.monitor.check.mock.calls[0][0]!.aborted).toBe(true);
  release(f.monitor.status());
  await stop;
  expect(vi.getTimerCount()).toBe(0);
  await poller.check();
  expect(f.monitor.check).toHaveBeenCalledOnce();
  await poller.stop();
});
test("unexpected adapter rejection is surfaced as unavailable without forwarding secret-bearing causes", async () => {
  const f = fixture();
  f.monitor.check.mockRejectedValueOnce(new Error("private-file-and-credential"));
  const poller = startCertificateMonitorPoller({ monitor: f.monitor })!;
  await poller.check();
  expect(poller.status()).toMatchObject({
    state: "unavailable",
    lastError: "ct-provider-unavailable",
  });
  expect(JSON.stringify(poller.status())).not.toContain("private-file");
  await poller.check();
  expect(poller.status().state).toBe("observing");
  await poller.stop();
});
