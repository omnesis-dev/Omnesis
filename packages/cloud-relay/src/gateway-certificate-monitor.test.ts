// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { GatewayCertificateMonitor } from "./gateway-certificate-monitor.js";
import type { CertificateMonitorOptions, CertificateMonitorStatus } from "./certificate-monitor.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gateway-ct-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
const known = { publicOrigin: "https://gateway.example.test", spkiFingerprint: "a".repeat(64) };
function port() {
  const value: CertificateMonitorStatus = {
    provider: "certspotter",
    hostname: "gateway.example.test",
    state: "observing",
    incidents: [],
  };
  return { status: vi.fn(() => value), check: vi.fn(() => Promise.resolve(value)) };
}
test("explicit 0 disables: no files, no provider work, and gateway identity is never read", async () => {
  const identity = vi.fn(() => known),
    create = vi.fn(),
    monitor = new GatewayCertificateMonitor({
      configDir: directory,
      env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0" },
      identity,
      create,
    });
  monitor.start();
  expect(monitor.status()).toMatchObject({ enabled: false, state: "disabled", incidents: [] });
  await monitor.close();
  expect(identity).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});
test("unset enables the monitor, since automatic enrollment relies on it", async () => {
  const watcher = port(),
    create = vi.fn(() => Promise.resolve(watcher)),
    monitor = new GatewayCertificateMonitor({
      configDir: directory,
      env: {},
      identity: () => known,
      create,
    });
  monitor.start();
  await vi.waitFor(() => expect(watcher.check).toHaveBeenCalledOnce());
  expect(monitor.status()).toMatchObject({ enabled: true, state: "observing" });
  await monitor.close();
});
test("unconfigured and unknown-key gateways remain pending, then known identity starts one lazy monitor", async () => {
  let identity: typeof known | undefined;
  const watcher = port(),
    create = vi.fn(() => Promise.resolve(watcher)),
    monitor = new GatewayCertificateMonitor({
      env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1" },
      configDir: directory,
      identity: () => identity,
      create,
    });
  expect(monitor.status().state).toBe("pending");
  identity = {} as typeof known;
  monitor.start();
  identity = { publicOrigin: known.publicOrigin } as typeof known;
  monitor.start();
  expect(create).not.toHaveBeenCalled();
  identity = known;
  monitor.start();
  monitor.status();
  await vi.waitFor(() => expect(watcher.check).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledOnce();
  expect(monitor.status()).toMatchObject({
    enabled: true,
    state: "observing",
    hostname: "gateway.example.test",
  });
  await monitor.close();
  expect(monitor.status().state).toBe("disabled");
});
test("default production factory reads only dedicated CT credentials and persists public evidence without endpoint or secret status fields", async () => {
  const file = join(directory, "ct-key.json");
  await writeFile(file, JSON.stringify({ apiKey: "ct-test-token" }));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  vi.stubGlobal("fetch", transport);
  const monitor = new GatewayCertificateMonitor({
    env: {
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_CERTSPOTTER_API_KEY_FILE: file,
    },
    configDir: directory,
    identity: () => known,
  });
  expect(monitor.status().state).toBe("pending");
  await vi.waitFor(() => expect(monitor.status().state).toBe("observing"));
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0][1]!.headers).toMatchObject({
    authorization: "Bearer ct-test-token",
  });
  const status = JSON.stringify(monitor.status());
  for (const privateValue of [file, "ct-test-token", "api.certspotter.com"])
    expect(status).not.toContain(privateValue);
  expect(
    JSON.parse(await readFile(join(directory, "cloud-relay/certificate-incidents.json"), "utf8")),
  ).toMatchObject({ hostname: "gateway.example.test", incidents: [] });
  await monitor.close();
});
test("closing a suspended lazy factory cannot create a late orphan poller", async () => {
  const watcher = port();
  let release!: (value: ReturnType<typeof port>) => void;
  const create = vi.fn(
      () => new Promise<ReturnType<typeof port>>((resolve) => (release = resolve)),
    ),
    monitor = new GatewayCertificateMonitor({
      env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1" },
      configDir: directory,
      identity: () => known,
      create,
    });
  monitor.start();
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  monitor.status();
  await monitor.close();
  release(watcher);
  await Promise.resolve();
  await Promise.resolve();
  expect(watcher.check).not.toHaveBeenCalled();
  expect(monitor.status().state).toBe("disabled");
});
test("initialization errors are sanitized and bounded before a later successful retry", async () => {
  let now = Date.now();
  const watcher = port(),
    create = vi
      .fn()
      .mockRejectedValueOnce(new Error("private-path-api-key"))
      .mockResolvedValue(watcher),
    monitor = new GatewayCertificateMonitor({
      env: {
        OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
        OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_INTERVAL_MS: "60000",
      },
      configDir: directory,
      identity: () => known,
      create,
      now: () => now,
    });
  monitor.start();
  await vi.waitFor(() => expect(monitor.status().state).toBe("unavailable"));
  monitor.start();
  expect(create).toHaveBeenCalledOnce();
  expect(JSON.stringify(monitor.status())).not.toContain("private-path");
  now += 60000;
  monitor.start();
  await vi.waitFor(() => expect(watcher.check).toHaveBeenCalledOnce());
  expect(monitor.status().state).toBe("observing");
  await monitor.close();
});
test("invalid operator interval, origin, pin and failing identity callbacks never start a provider", async () => {
  for (const interval of ["bad", "0", "59999", "86400001", "1.5"]) {
    const create = vi.fn(),
      monitor = new GatewayCertificateMonitor({
        env: {
          OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1",
          OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_INTERVAL_MS: interval,
        },
        configDir: directory,
        identity: () => known,
        create,
      });
    expect(monitor.status()).toMatchObject({
      state: "unavailable",
      lastError: "ct-configuration-invalid",
    });
    expect(create).not.toHaveBeenCalled();
    await monitor.close();
  }
  for (const identity of [
    () => ({ ...known, publicOrigin: "http://gateway.example.test" }),
    () => ({ ...known, spkiFingerprint: "bad" }),
    () => {
      throw new Error("private identity path");
    },
  ]) {
    const create = vi.fn(),
      monitor = new GatewayCertificateMonitor({
        env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1" },
        configDir: directory,
        identity,
        create,
      });
    expect(monitor.status().state).toBe("unavailable");
    expect(create).not.toHaveBeenCalled();
    await monitor.close();
  }
});
test("local identity changes cannot reuse the old hostname baseline and pending monitors check immediately when a key becomes known", async () => {
  let current: typeof known | undefined = known,
    fail = false;
  const watcher = port(),
    create = vi.fn((_options: Omit<CertificateMonitorOptions, "provider">) =>
      Promise.resolve(watcher),
    ),
    monitor = new GatewayCertificateMonitor({
      env: { OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "1" },
      configDir: directory,
      identity: () => {
        if (fail) throw new Error("private-callback");
        return current;
      },
      create,
    });
  monitor.start();
  await vi.waitFor(() => expect(watcher.check).toHaveBeenCalledOnce());
  const getter = create.mock.calls[0][0].expectedSpkiFingerprint;
  expect(getter()).toBe(known.spkiFingerprint);
  current = { ...known, publicOrigin: "https://other.example.test" };
  expect(getter()).toBeUndefined();
  current = { ...known, publicOrigin: "invalid" };
  expect(getter()).toBeUndefined();
  fail = true;
  expect(getter()).toBeUndefined();
  expect(monitor.status()).toMatchObject({
    state: "unavailable",
    lastError: "ct-configuration-invalid",
  });
  fail = false;
  current = undefined;
  expect(getter()).toBeUndefined();
  watcher.status.mockReturnValue({
    provider: "certspotter",
    hostname: "gateway.example.test",
    state: "pending",
    incidents: [],
  });
  monitor.status();
  expect(watcher.check).toHaveBeenCalledOnce();
  current = known;
  monitor.status();
  await vi.waitFor(() => expect(watcher.check.mock.calls.length).toBeGreaterThan(1));
  await monitor.close();
});
