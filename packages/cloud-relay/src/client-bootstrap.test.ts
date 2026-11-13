// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import {
  initializePairedDeviceTransport,
  pairedGatewayRequestUrl,
  pairedLogicalGatewayUrl,
} from "./client-bootstrap.js";
import { runRelayCommand } from "./runtime.js";
vi.mock("./runtime.js", () => ({ runRelayCommand: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runRelayCommand).mockReset();
});

test("native bootstrap is optional and explicit operator destination wins without reading any pairing credential", async () => {
  const start = vi.fn();
  for (const env of [
    {},
    { OMNESIS_CLOUD_RELAY_ENABLED: "1" },
    { OMNESIS_CLOUD_RELAY_DEVICE_FILE: "private.json" },
    {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: "private.json",
      OMNESIS_GATEWAY_URL: "https://manual.example",
    },
  ])
    await initializePairedDeviceTransport(env, { start, findDefault: async () => undefined });
  for (const args of [["--help"], ["-h"], ["--version"], ["-V"], ["help"]])
    await initializePairedDeviceTransport(
      { OMNESIS_CLOUD_RELAY_ENABLED: "1", OMNESIS_CLOUD_RELAY_DEVICE_FILE: "private.json" },
      { start },
      args,
    );
  expect(start).not.toHaveBeenCalled();
});

test("automatic ephemeral adapter changes only destination, keeps component-owned token and closes on exit", async () => {
  const env = {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_CLOUD_RELAY_DEVICE_FILE: "private.json",
    OMNESIS_TOKEN: "component-owned-token",
  } as NodeJS.ProcessEnv;
  const close = vi.fn().mockResolvedValue(undefined),
    onExit = vi.fn();
  const start = vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:12345",
    gatewayUrl: "https://canonical.example.com",
    close,
  });
  await initializePairedDeviceTransport(env, { start, onExit }, ["search", "--", "help"]);
  expect(env.OMNESIS_GATEWAY_URL).toBe("https://canonical.example.com");
  expect(env.OMNESIS_GATEWAY_REQUEST_URL).toBe("http://127.0.0.1:12345");
  expect(env.OMNESIS_TOKEN).toBe("component-owned-token");
  expect(start).toHaveBeenCalledWith({
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_CLOUD_RELAY_DEVICE_FILE: "private.json",
    OMNESIS_TOKEN: "component-owned-token",
    OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
    OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1",
  });
  onExit.mock.calls[0]![0]();
  expect(close).toHaveBeenCalledTimes(1);
  close.mockRejectedValue(new Error("already closed"));
  onExit.mock.calls[0]![0]();
  await Promise.resolve();
});

test("production launcher uses client mode and one beforeExit handler, while startup errors never replace configured destination", async () => {
  const listener = vi.spyOn(process, "once").mockReturnValue(process);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(runRelayCommand).mockResolvedValue({
    url: "http://127.0.0.1:12345",
    gatewayUrl: "https://canonical.example.com",
    close,
  });
  const env = { OMNESIS_CLOUD_RELAY_ENABLED: "1", OMNESIS_CLOUD_RELAY_DEVICE_FILE: "private.json" };
  await initializePairedDeviceTransport({ ...env });
  expect(runRelayCommand).toHaveBeenCalledWith(
    "client",
    expect.objectContaining({ OMNESIS_CLOUD_RELAY_CLIENT_UNREF: "1" }),
  );
  expect(listener).toHaveBeenCalledWith("beforeExit", expect.any(Function));
  (listener.mock.calls[0]![1] as () => void)();
  expect(close).toHaveBeenCalledOnce();
  vi.mocked(runRelayCommand).mockResolvedValue({ url: "http://127.0.0.1:12345", close });
  await expect(initializePairedDeviceTransport({ ...env })).rejects.toThrow("did not start");
  expect(close).toHaveBeenCalledTimes(2);
  vi.mocked(runRelayCommand).mockResolvedValue(undefined);
  await expect(initializePairedDeviceTransport({ ...env })).rejects.toThrow("did not start");
  vi.mocked(runRelayCommand).mockRejectedValue(new Error("invalid saved pin"));
  const unchanged = { ...env };
  await expect(initializePairedDeviceTransport(unchanged)).rejects.toThrow("invalid saved pin");
  expect(unchanged).not.toHaveProperty("OMNESIS_GATEWAY_URL");
});

test("transport loopback stays distinct from logical identity and unrelated explicit destinations", () => {
  const env = {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_GATEWAY_REQUEST_URL: "http://127.0.0.1:12345",
    OMNESIS_GATEWAY_URL: "https://canonical.example.com",
  };
  expect(pairedLogicalGatewayUrl(env.OMNESIS_GATEWAY_REQUEST_URL, env)).toBe(
    env.OMNESIS_GATEWAY_URL,
  );
  expect(pairedLogicalGatewayUrl("https://manual.example", env)).toBe("https://manual.example");
  expect(
    pairedLogicalGatewayUrl("http://127.0.0.1:12345", {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_GATEWAY_REQUEST_URL: "http://127.0.0.1:12345",
    }),
  ).toBe("http://127.0.0.1:12345");
  expect(pairedLogicalGatewayUrl("https://manual.example")).toBe("https://manual.example");
});

test("the request URL variable is read only with the cloud relay opt-in", () => {
  const env = {
    OMNESIS_GATEWAY_REQUEST_URL: "http://127.0.0.1:12345",
    OMNESIS_GATEWAY_URL: "https://canonical.example.com",
  };
  expect(pairedGatewayRequestUrl(env)).toBeUndefined();
  expect(pairedLogicalGatewayUrl(env.OMNESIS_GATEWAY_REQUEST_URL, env)).toBe(
    env.OMNESIS_GATEWAY_REQUEST_URL,
  );
  expect(pairedGatewayRequestUrl({ ...env, OMNESIS_CLOUD_RELAY_ENABLED: "1" })).toBe(
    env.OMNESIS_GATEWAY_REQUEST_URL,
  );
  expect(pairedGatewayRequestUrl({ OMNESIS_CLOUD_RELAY_ENABLED: "1" })).toBeUndefined();
});

test("automatic component bundles require matching active tokens and never override manual destinations or credentials", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultCloudDeviceFile } = await import("./client-bootstrap.js");
  const dir = await mkdtemp(join(tmpdir(), "cloud-default-bootstrap-"));
  const env = { OMNESIS_CLOUD_RELAY_ENABLED: "1", OMNESIS_CONFIG_DIR: dir };
  try {
    expect(await defaultCloudDeviceFile(env, "cli")).toBeUndefined();
    await mkdir(join(dir, "cloud-relay"));
    const cliFile = join(dir, "cloud-relay", "cli-device.json"),
      collectorFile = join(dir, "cloud-relay", "collector-device.json");
    await writeFile(cliFile, JSON.stringify({ kind: "cli", token: "cloud-cli-token" }));
    expect(await defaultCloudDeviceFile(env, "cli")).toBeUndefined();
    await writeFile(join(dir, "token"), "manual-token\n");
    expect(await defaultCloudDeviceFile(env, "cli")).toBeUndefined();
    await writeFile(join(dir, "token"), "cloud-cli-token\n");
    expect(await defaultCloudDeviceFile(env, "cli")).toBe(cliFile);
    await writeFile(collectorFile, JSON.stringify({ kind: "collector", token: "cloud-collector" }));
    await writeFile(join(dir, "collector-token"), "cloud-collector\n");
    expect(await defaultCloudDeviceFile(env, "collector")).toBe(collectorFile);
    for (const override of [
      { OMNESIS_CLOUD_RELAY_ENABLED: "0" },
      { OMNESIS_GATEWAY_URL: "https://manual.example.test" },
      { OMNESIS_GATEWAY_REQUEST_URL: "https://manual.example.test" },
      { OMNESIS_TOKEN: "manual-token" },
    ])
      expect(await defaultCloudDeviceFile({ ...env, ...override }, "cli")).toBeUndefined();
    await writeFile(cliFile, "null");
    expect(await defaultCloudDeviceFile(env, "cli")).toBeUndefined();
    await writeFile(cliFile, JSON.stringify({ kind: "collector", token: "cloud-cli-token" }));
    expect(await defaultCloudDeviceFile(env, "cli")).toBeUndefined();
    await writeFile(cliFile, JSON.stringify({ kind: "cli" }));
    expect(await defaultCloudDeviceFile(env, "cli")).toBeUndefined();
    await writeFile(cliFile, JSON.stringify({ kind: "cli", token: "cloud-cli-token" }));
    const start = vi.fn(async () => ({
      url: "http://127.0.0.1:12345",
      gatewayUrl: "https://cloud.example.test",
      close: async () => {},
    }));
    await initializePairedDeviceTransport({ ...env }, { start, onExit: () => {} }, ["status"]);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ OMNESIS_CLOUD_RELAY_DEVICE_FILE: cliFile }),
    );
    const collectorStart = vi.fn(async () => ({
      url: "http://127.0.0.1:12345",
      gatewayUrl: "https://cloud.example.test",
      close: async () => {},
    }));
    await initializePairedDeviceTransport(
      { ...env },
      { start: collectorStart, onExit: () => {} },
      [],
      "collector",
    );
    expect(collectorStart).toHaveBeenCalledWith(
      expect.objectContaining({ OMNESIS_CLOUD_RELAY_DEVICE_FILE: collectorFile }),
    );
    await initializePairedDeviceTransport({ ...env, OMNESIS_TOKEN: "manual-token" }, { start }, [
      "status",
    ]);
    expect(start).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
