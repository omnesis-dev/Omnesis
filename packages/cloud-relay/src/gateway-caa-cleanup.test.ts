// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { GatewayCertificateMonitor } from "./gateway-certificate-monitor.js";

const expected = {
  hostname: "gateway.example.test",
  accountUri: "https://ca.example.test/acme/acct/42",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each(["account", "dns"] as const)(
  "close joins an accepted %s lookup without admitting a later phase",
  async (phase) => {
    let entered = false;
    const gate = deferred<void>();
    const caa = vi.fn(async () => {
      if (phase === "account") {
        entered = true;
        await gate.promise;
      }
      return expected;
    });
    const lookup = vi.fn(async () => {
      if (phase === "dns") {
        entered = true;
        await gate.promise;
      }
      return [] as string[];
    });
    const drift = vi.fn(async () => {});
    const monitor = new GatewayCertificateMonitor({
      env: {},
      configDir: "invented-fixture",
      identity: () => undefined,
      caa,
      caaLookup: lookup,
      onCaaDrift: drift,
    });
    let work: Promise<void> | undefined, closing: Promise<void> | undefined;
    try {
      work = monitor.checkCaa();
      void work.catch(() => {});
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(monitor.cleanupFailure()).toMatchObject({ cleanupPending: true });
      closing = monitor.close();
      expect(monitor.close()).toBe(closing);
      expect(monitor.cleanupFailure()).toMatchObject({ cleanupPending: true });
      gate.resolve();
      await work;
      await closing;
      expect(drift).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledTimes(phase === "account" ? 0 : 1);
      await monitor.checkCaa();
      expect(caa).toHaveBeenCalledOnce();
      expect(monitor.cleanupFailure()).toBeUndefined();
    } finally {
      gate.resolve();
      await Promise.allSettled([work, closing, monitor.close()]);
    }
  },
);

test.each([
  { phase: "account", nested: false },
  { phase: "account", nested: true },
  { phase: "incident", nested: false },
  { phase: "incident", nested: true },
] as const)(
  "CAA $phase uncertainty remains terminal (nested=$nested)",
  async ({ phase, nested }) => {
    vi.useFakeTimers();
    const marker = Object.assign(new Error("invented CAA operation uncertainty"), {
      cleanupFailure: undefined,
    });
    const failure = nested ? new Error("invented CAA wrapper", { cause: marker }) : marker;
    const caa = vi.fn(async () => {
      if (phase === "account") throw failure;
      return expected;
    });
    const lookup = vi.fn(async () => [] as string[]);
    const drift = vi.fn(async () => {
      throw failure;
    });
    const monitor = new GatewayCertificateMonitor({
      env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_INTERVAL_MS: "60000" },
      configDir: "invented-fixture",
      identity: () => undefined,
      caa,
      caaLookup: lookup,
      onCaaDrift: drift,
    });
    try {
      monitor.start();
      await expect(monitor.checkCaa()).rejects.toBe(failure);
      expect(monitor.cleanupFailure()).toBe(failure);
      await vi.advanceTimersByTimeAsync(120000);
      await monitor.checkCaa();
      expect(caa).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledTimes(phase === "account" ? 0 : 1);
      const close = monitor.close();
      expect(monitor.close()).toBe(close);
      await expect(close).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await Promise.allSettled([monitor.close()]);
    }
  },
);

test("an ordinary failed CAA account lookup remains retryable", async () => {
  const caa = vi
    .fn(async () => expected)
    .mockRejectedValueOnce(new Error("invented ordinary outage"));
  const drift = vi.fn(async () => {});
  const monitor = new GatewayCertificateMonitor({
    env: {},
    configDir: "invented-fixture",
    identity: () => undefined,
    caa,
    caaLookup: async () => [],
    onCaaDrift: drift,
  });
  try {
    await monitor.checkCaa();
    expect(monitor.cleanupFailure()).toBeUndefined();
    await monitor.checkCaa();
    expect(drift).toHaveBeenCalledOnce();
    expect(monitor.cleanupFailure()).toBeUndefined();
  } finally {
    await monitor.close();
  }
});
