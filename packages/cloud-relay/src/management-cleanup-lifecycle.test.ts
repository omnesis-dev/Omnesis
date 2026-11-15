// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { GatewayTunnel } from "./tunnel-client.js";
import {
  GatewayCloudRelayManagement,
  type CloudRelayManagerOptions,
} from "./management-service.js";

// This suite tests ownership at the existing persistence seam. Native private-file behavior
// has separate real-Windows regressions; no helper process is left behind by these markers.
const storage = vi.hoisted(() => new Map<string, unknown>());
const sockets = vi.hoisted(() => ({ created: 0 }));
vi.mock("ws", async (actual) => {
  const module = await actual<typeof import("ws")>();
  return {
    ...module,
    default: new Proxy(module.default, {
      construct() {
        sockets.created++;
        throw new Error("No fixture websocket connection is expected");
      },
    }),
  };
});
vi.mock("./google-credentials.js", async (actual) => ({
  ...(await actual<typeof import("./google-credentials.js")>()),
  readPrivateJson: vi.fn(async (path: string) => {
    if (!storage.has(path)) throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
    return storage.get(path);
  }),
  savePrivateJson: vi.fn(async (path: string, value: unknown) => {
    storage.set(path, value);
  }),
}));
vi.mock("./private-inputs.js", async (actual) => ({
  ...(await actual<typeof import("./private-inputs.js")>()),
  identityArtifactPresent: vi.fn(async () => false),
  readPrivateText: vi.fn(async () => {
    throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
  }),
}));
let directory: string;
let manager: GatewayCloudRelayManagement | undefined;
beforeEach(async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  directory = await mkdtemp(join(tmpdir(), "relay-cleanup-lifecycle-"));
  storage.clear();
  sockets.created = 0;
});
afterEach(async () => {
  await manager?.close().catch(() => {});
  manager = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const monitor = {
    start: vi.fn(),
    status: () => ({
      enabled: false,
      provider: "certspotter" as const,
      state: "disabled" as const,
      incidents: [],
    }),
    cleanupFailure: () => undefined,
    close: vi.fn(async () => {}),
  };
  const controller = {
    cleanupFailure: (): unknown => undefined,
    close: vi.fn(async () => {}),
    renew: vi.fn(async () => false),
    fingerprintSha256: () => undefined,
    spkiFingerprintSha256: () => undefined,
  };
  const register = vi.fn(async () => ({
    token: "invented-session",
    accountId: "a".repeat(64),
    expiresAt: 4_000_000_000,
  }));
  const tunnel = vi.fn<NonNullable<CloudRelayManagerOptions["startTunnel"]>>(() => undefined);
  const stopLegacy = vi.fn(async () => {});
  const options: CloudRelayManagerOptions = {
    configDir: directory,
    env: { OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test" },
    gatewayUrl: () => "https://localhost:12345",
    activate: async () => {},
    directIdentity: () => ({
      id: "direct",
      names: ["localhost"],
      kind: "self-signed",
      state: "valid",
      pinPolicy: "existing-device-policy",
    }),
    directCertificateCoversHostname: () => false,
    certificateMonitor: monitor,
    controller: async () => controller,
    register,
    prepare: async (input) => ({ gatewayId: input.gatewayId, accountId: "a".repeat(64) }),
    discover: async (_url, gatewayId) => ({
      protocol: 2,
      gatewayId,
      publicOrigin: "https://gateway.example.test",
      invitationRequired: false,
      dnsChallenges: true,
    }),
    fetch: async () => new Response(null, { status: 404 }),
    probe: async () => true,
    startTunnel: tunnel,
    stopLegacy,
  };
  return { options, monitor, controller, register, tunnel, stopLegacy };
}

test("a controller returned with startup uncertainty prevents registration and retries", async () => {
  const f = fixture();
  const marker = Object.assign(new Error("fixture controller uncertain"), {
    cleanupFailure: undefined,
  });
  f.controller.cleanupFailure = () => marker;
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  await manager.enable().catch(() => {});
  await vi.waitFor(() => expect(manager!.cleanupFailure()).toBe(marker));
  expect(f.register).not.toHaveBeenCalled();
  expect(f.controller.renew).not.toHaveBeenCalled();
  expect(f.tunnel).not.toHaveBeenCalled();
  await expect(manager.renew()).rejects.toBe(marker);
  const close = manager.close();
  expect(manager.close()).toBe(close);
  await expect(close).rejects.toSatisfy(
    (error: unknown) => ownedProcessCleanupReceipt(error)?.pending === false,
  );
  expect(f.monitor.close).toHaveBeenCalledOnce();
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(f.stopLegacy).toHaveBeenCalled();
});

test("close joins accepted registration and retires every actor without creating a tunnel", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.register.mockImplementationOnce(async () => {
    entered();
    await gate;
    return { token: "invented-session", accountId: "a".repeat(64), expiresAt: 4_000_000_000 };
  });
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  await manager.enable();
  await started;
  const close = manager.close();
  expect(manager.close()).toBe(close);
  expect(manager.cleanupFailure()).toMatchObject({ cleanupPending: true });
  release();
  await expect(close).resolves.toBeUndefined();
  expect(manager.cleanupFailure()).toBeUndefined();
  expect(f.tunnel).not.toHaveBeenCalled();
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(f.monitor.close).toHaveBeenCalledOnce();
  await expect(manager.renew()).rejects.toThrow("closed");
});

test("closing during discovery joins the lookup without preparing keys or publishing settings", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prepare = vi.fn(f.options.prepare!);
  f.options.prepare = prepare;
  f.options.discover = async (_url, gatewayId) => {
    entered();
    await gate;
    return {
      protocol: 2,
      gatewayId,
      publicOrigin: "https://gateway.example.test",
      invitationRequired: false,
      dnsChallenges: true,
    };
  };
  manager = await GatewayCloudRelayManagement.open(f.options);
  const before = [...storage.entries()];
  const configure = manager.configure({ termsAccepted: true });
  const refused = expect(configure).rejects.toMatchObject({ code: "configuration-invalid" });
  await started;
  const close = manager.close();
  expect(manager.cleanupFailure()).toMatchObject({ cleanupPending: true });
  release();
  await refused;
  await close;
  expect(prepare).not.toHaveBeenCalled();
  expect([...storage.entries()]).toEqual(before);
  expect(f.register).not.toHaveBeenCalled();
});

test("closing before an accepted configure starts preserves the public domain failure", async () => {
  const f = fixture();
  const discover = vi.fn(f.options.discover!);
  f.options.discover = discover;
  manager = await GatewayCloudRelayManagement.open(f.options);
  const configuring = manager.configure({ termsAccepted: true });
  const refused = expect(configuring).rejects.toMatchObject({
    code: "configuration-invalid",
    status: 409,
    cause: expect.any(Error),
  });
  const closing = manager.close();
  await refused;
  await closing;
  expect(discover).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(storage.size).toBe(0);
});

test.each([false, true])(
  "a late explicit preparation failure dominates closed admission (%s)",
  async (nested) => {
    const f = fixture();
    let entered!: () => void, reject!: (error: unknown) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<Awaited<ReturnType<NonNullable<CloudRelayManagerOptions["prepare"]>>>>(
      (_resolve, failure) => {
        reject = failure;
      },
    );
    f.options.prepare = async () => {
      entered();
      return gate;
    };
    const marker = Object.assign(new Error("invented preparation was not joined"), {
      cleanupFailure: undefined,
    });
    const failure = nested ? new Error("invented preparation wrapper", { cause: marker }) : marker;
    manager = await GatewayCloudRelayManagement.open(f.options);
    const before = [...storage.entries()];
    const configuring = manager.configure({ termsAccepted: true });
    const refused = expect(configuring).rejects.toBe(failure);
    await started;
    const closing = manager.close();
    void closing.catch(() => {});
    reject(failure);
    await refused;
    await expect(closing).rejects.toBe(failure);
    await expect(manager.configure({ termsAccepted: true })).rejects.toBe(failure);
    expect(manager.cleanupFailure()).toBe(failure);
    expect([...storage.entries()]).toEqual(before);
    expect(f.register).not.toHaveBeenCalled();
  },
);

test("closing during controller initialization adopts and joins the late returned owner", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let constructionSignal: AbortSignal | undefined;
  f.options.controller = async (_env, options) => {
    constructionSignal = options.signal;
    entered();
    await gate;
    return f.controller;
  };
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  await manager.enable();
  await started;
  expect(constructionSignal?.aborted).toBe(false);
  const close = manager.close();
  expect(constructionSignal?.aborted).toBe(true);
  expect(manager.cleanupFailure()).toMatchObject({ cleanupPending: true });
  expect(f.controller.close).not.toHaveBeenCalled();
  release();
  await close;
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.controller.renew).not.toHaveBeenCalled();
  expect(f.tunnel).not.toHaveBeenCalled();
  expect(manager.cleanupFailure()).toBeUndefined();
});

test("manager close joins the real tunnel's ignored-abort credential source", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tunnel = new GatewayTunnel({
    relayUrl: "https://relay.example.test",
    gatewayUrl: "https://localhost:12345",
    gatewayId: "11111111-1111-4111-8111-111111111111",
    session: async () => {
      entered();
      await gate;
      return "invented-session";
    },
  });
  f.options.startTunnel = () => {
    tunnel.start();
    return tunnel;
  };
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  await manager.enable();
  await started;
  const close = manager.close();
  expect(manager.cleanupFailure()).toMatchObject({ cleanupPending: true });
  expect(tunnel.cleanupFailure()).toMatchObject({ cleanupPending: true });
  release();
  await close;
  expect(manager.cleanupFailure()).toBeUndefined();
  expect(tunnel.cleanupFailure()).toBeUndefined();
  expect(tunnel.status().state).toBe("disabled");
  expect(sockets.created).toBe(0);
});
