// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { GatewaySignupClient } from "./gateway-signup-client.js";
import * as credentials from "./google-credentials.js";
import * as releases from "./gateway-release.js";
import * as privateInputs from "./private-inputs.js";
import * as gatewayKeys from "./gateway-key-client.js";
import { DNS_BROKER_PROTOCOL } from "./dns-broker-contract.js";
import { markedFileError } from "../test/private-operation-fixture.js";
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
  const socket = new Proxy(module.default, {
    construct() {
      sockets.created++;
      throw new Error("No fixture websocket connection is expected");
    },
  });
  return { ...module, default: socket, WebSocket: socket };
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
  vi.mocked(credentials.readPrivateJson)
    .mockReset()
    .mockImplementation(async (path: string) => {
      if (!storage.has(path)) throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
      return storage.get(path);
    });
  vi.mocked(credentials.savePrivateJson)
    .mockReset()
    .mockImplementation(async (path, value) => {
      storage.set(path, value);
    });
  sockets.created = 0;
});
afterEach(async () => {
  await manager?.close().catch(() => {});
  manager = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
  expect(sockets.created).toBe(0);
});

test("a hosted-name claim retains its private owner-key cleanup receipt", async () => {
  const f = fixture();
  f.options.discover = vi.fn(f.options.discover);
  const failure = markedFileError("ENOENT", "cause");
  vi.spyOn(gatewayKeys, "readOrCreateGatewayOwnerKey").mockRejectedValue(failure);
  f.options.env = {
    ...f.options.env,
    OMNESIS_ACME_DNS_PROVIDER: "broker",
    OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test",
  };
  f.options.fetch = vi.fn(async () =>
    Response.json({
      protocol: DNS_BROKER_PROTOCOL,
      relayDomain: "relay.example.test",
      caa: { issuer: "ca.example.test", accountUriPrefix: "https://ca.example.test/acme/acct/" },
    }),
  );
  manager = await GatewayCloudRelayManagement.open(f.options);
  await expect(
    manager.configure({ relayUrl: "https://relay.example.test", termsAccepted: true }),
  ).rejects.toBe(failure);
  expect(manager.cleanupFailure()).toBe(failure);
  expect(f.options.discover).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  await expect(manager.configure({ termsAccepted: true })).rejects.toBe(failure);
});

test("close during the public probe cannot schedule another retry", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<boolean>((resolve) => {
    release = () => resolve(false);
  });
  const probe = vi.fn(async () => gate);
  f.options.probe = probe;
  f.options.probeRetryMs = 1;
  let closing: Promise<void> | undefined;
  try {
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure({ relayUrl: "https://relay.example.test", termsAccepted: true });
    await manager.enable();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    closing = manager.close();
    void closing.catch(() => {});
    release();
    const failure: unknown = await closing.catch((error: unknown) => error);
    expect(ownedProcessCleanupReceipt(failure)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    await Promise.allSettled([closing, manager?.close()]);
  }
});

test("a late actor receipt after the public probe prevents another scheduled command", async () => {
  const f = fixture();
  const failure = markedFileError("EPRIVATE", "cause");
  let probeComplete = false,
    published = false;
  f.options.probe = async () => {
    probeComplete = true;
    return true;
  };
  f.controller.cleanupFailure = () => {
    if (published) return failure;
    if (probeComplete) {
      probeComplete = false;
      // A producer can publish its retained receipt after a successful read
      // but before the caller's next asynchronous continuation.
      queueMicrotask(() => {
        published = true;
      });
    }
    return undefined;
  };
  let enabling: Promise<unknown> | undefined;
  try {
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure({ relayUrl: "https://relay.example.test", termsAccepted: true });
    vi.useFakeTimers();
    enabling = manager.enable().catch((error: unknown) => error);
    await vi.waitFor(() => expect(published).toBe(true));
    await enabling;
    expect(manager.cleanupFailure()).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await expect(manager.renew()).rejects.toBe(failure);
  } finally {
    await Promise.allSettled([enabling, manager?.close()]);
  }
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

async function assertHeld(error: unknown): Promise<void> {
  await vi.waitFor(() => expect(manager!.cleanupFailure()).toBe(error));
  await expect(manager!.renew()).rejects.toBe(error);
  await expect(manager!.close()).rejects.toSatisfy(
    (failure: unknown) => ownedProcessCleanupReceipt(failure)?.pending === false,
  );
}

test.each(["own", "cause"] as const)(
  "a discovery operation with an unjoined receipt cannot redraw an identity (%s)",
  async (placement) => {
    const f = fixture();
    const error = markedFileError("ENOENT", placement);
    const discover = vi
      .fn<NonNullable<CloudRelayManagerOptions["discover"]>>()
      .mockRejectedValue(error);
    f.options.discover = discover;
    manager = await GatewayCloudRelayManagement.open(f.options);
    await expect(manager.configure({ termsAccepted: true })).rejects.toBe(error);
    await expect(manager.configure({ termsAccepted: true })).rejects.toBe(error);
    expect(discover).toHaveBeenCalledOnce();
    expect(f.register).not.toHaveBeenCalled();
    await assertHeld(error);
  },
);

test.each(["configure", "enable"] as const)(
  "an unjoined %s settings publication cannot authorize further registration",
  async (phase) => {
    const f = fixture();
    manager = await GatewayCloudRelayManagement.open(f.options);
    if (phase === "enable") await manager.configure({ termsAccepted: true });
    const error = markedFileError("ENOENT", "cause");
    const publish = vi
      .spyOn(credentials, "savePrivateJson")
      .mockClear()
      .mockRejectedValueOnce(error);
    await expect(
      phase === "configure" ? manager.configure({ termsAccepted: true }) : manager.enable(),
    ).rejects.toBe(error);
    expect(publish).toHaveBeenCalledOnce();
    expect(f.register).not.toHaveBeenCalled();
    await assertHeld(error);
  },
);

test("unconfigured control operations keep their public domain refusals", async () => {
  manager = await GatewayCloudRelayManagement.open(fixture().options);
  await expect(manager.enable()).rejects.toMatchObject({
    status: 400,
    code: "configuration-invalid",
  });
  await expect(manager.reconnect()).rejects.toMatchObject({
    status: 409,
    code: "configuration-invalid",
  });
  await expect(manager.renew()).rejects.toMatchObject({
    status: 409,
    code: "configuration-invalid",
  });
  expect(manager.cleanupFailure()).toBeUndefined();
});

test("a public probe's unjoined receipt closes admitted actors and prevents rechecking", async () => {
  const f = fixture();
  const error = markedFileError("EPRIVATE", "own");
  f.options.probe = vi.fn().mockRejectedValue(error);
  f.controller.close.mockRejectedValue(new Error("Invented joined controller close failure"));
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  await manager.enable().catch(() => {});
  await assertHeld(error);
  expect(f.options.probe).toHaveBeenCalledOnce();
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(f.monitor.close).toHaveBeenCalledOnce();
});

test("an unjoined signup-access source cannot become an ordinary cached answer", async () => {
  const f = fixture();
  const error = markedFileError("ENOENT", "cause");
  f.options.signupAccess = vi.fn().mockRejectedValue(error);
  manager = await GatewayCloudRelayManagement.open(f.options);
  await expect(manager.refreshSignupAccess()).rejects.toBe(error);
  await assertHeld(error);
  expect(f.options.signupAccess).toHaveBeenCalledOnce();
});

const pendingSignup = () => ({
  operationId: "fictional-operation",
  redemptionSecret: "fictional-redemption",
  nonce: "fictional-nonce",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  authorizeUrl: "https://relay.example.test/authorize",
  connectUrl: "https://relay.example.test/connect",
  code: "FICTIONAL",
});

test.each(["start", "poll", "publish"] as const)(
  "signup %s uncertainty cannot turn into an enrollment refusal or retry",
  async (phase) => {
    const f = fixture();
    const error = markedFileError("EPRIVATE", "cause");
    const begin = vi.spyOn(GatewaySignupClient.prototype, "start");
    if (phase === "start") begin.mockRejectedValue(error);
    else begin.mockResolvedValue(pendingSignup());
    const poll = vi.spyOn(GatewaySignupClient.prototype, "poll");
    if (phase === "poll") poll.mockRejectedValue(error);
    else
      poll.mockResolvedValue({
        status: "approved",
        accountId: "a".repeat(64),
        enrollmentToken: "fictional-invitation",
        signInProof: { type: "google", idToken: "fictional-proof", salt: "b".repeat(43) },
      });
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure({ termsAccepted: true });
    if (phase === "publish") {
      const publish = vi.mocked(credentials.savePrivateJson).getMockImplementation()!;
      vi.spyOn(credentials, "savePrivateJson").mockImplementation(async (path, value) => {
        if (path.endsWith("invitation.json")) throw error;
        await publish(path, value);
      });
    }
    const connected = manager.connect({ termsAccepted: true });
    if (phase === "start") await expect(connected).rejects.toBe(error);
    else await connected.catch(() => {});
    await assertHeld(error);
    expect(begin).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledTimes(phase === "start" ? 0 : 1);
    expect(f.register).not.toHaveBeenCalled();
  },
);

test.each(["read", "release"] as const)(
  "an unjoined pending release %s keeps the durable journal and refuses new work",
  async (phase) => {
    const f = fixture();
    const error = markedFileError("ENOENT", "own");
    const path = join(directory, "cloud-relay", "release.json");
    const record = {
      version: 1,
      relayUrl: "https://relay.example.test",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      publicOrigin: "https://gateway.example.test",
      sessionFile: join(directory, "fictional-session.json"),
      ownerKeyFile: join(directory, "fictional-owner.key"),
      certificateFile: join(directory, "fictional-public.pem"),
      privateKeyFile: join(directory, "fictional-private.key"),
      createdAt: Date.now(),
    };
    storage.set(path, record);
    if (phase === "read") {
      const read = vi.mocked(credentials.readPrivateJson).getMockImplementation()!;
      vi.spyOn(credentials, "readPrivateJson").mockImplementation(async (file) => {
        if (file === path) throw error;
        return read(file);
      });
    } else vi.spyOn(releases, "releaseGateway").mockRejectedValue(error);
    manager = await GatewayCloudRelayManagement.open(f.options);
    manager.start();
    await assertHeld(error);
    expect(storage.get(path)).toBe(record);
    expect(f.register).not.toHaveBeenCalled();
  },
);

test("a disabled installation cannot serve a private key whose reader is unjoined", async () => {
  const f = fixture();
  const vectors = JSON.parse(
    await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
  ) as { gateway: { publicOrigin: string; certificate: string } };
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true, publicOrigin: vectors.gateway.publicOrigin });
  await manager.close();
  manager = undefined;
  const root = join(directory, "cloud-relay");
  await mkdir(root);
  await writeFile(join(root, "public.pem"), vectors.gateway.certificate);
  const error = markedFileError("ENOENT", "cause");
  vi.spyOn(privateInputs, "readPrivateText").mockRejectedValueOnce(error);
  const activate = vi.fn<CloudRelayManagerOptions["activate"]>();
  await expect(GatewayCloudRelayManagement.open({ ...f.options, activate })).rejects.toBe(error);
  expect(activate).not.toHaveBeenCalled();
});

test("start observes a previously returned actor's terminal receipt before launching work", async () => {
  const f = fixture();
  f.options.certificateMonitor = { ...f.monitor, cleanupFailure: () => receipt };
  manager = await GatewayCloudRelayManagement.open(f.options);
  const error = markedFileError("EPRIVATE", "own");
  const receipt = error;
  manager.start();
  expect(f.monitor.start).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  await assertHeld(error);
});

test("a scheduled public recheck retains an unjoined probe instead of scheduling another retry", async () => {
  const f = fixture();
  const error = markedFileError("EPRIVATE", "cause");
  const scheduled = Promise.withResolvers<boolean>();
  const probe = vi
    .fn<NonNullable<CloudRelayManagerOptions["probe"]>>()
    .mockResolvedValueOnce(false)
    .mockImplementation(() => scheduled.promise);
  f.options.probe = probe;
  f.options.probeRetryMs = 1;
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  try {
    await manager.enable();
    // Let initial admission finish before the independent scheduled probe fails.
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    scheduled.reject(error);
    await assertHeld(error);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(f.register).toHaveBeenCalledOnce();
  } finally {
    scheduled.resolve(false);
  }
});

test("a failed release retry retains its own unjoined helper receipt", async () => {
  const f = fixture();
  f.options.releaseRetryMs = 1;
  const path = join(directory, "cloud-relay", "release.json");
  const record = {
    version: 1,
    relayUrl: "https://relay.example.test",
    gatewayId: "33333333-3333-4333-8333-333333333333",
    publicOrigin: "https://gateway.example.test",
    sessionFile: join(directory, "fictional-session.json"),
    certificateFile: join(directory, "fictional-public.pem"),
    privateKeyFile: join(directory, "fictional-private.key"),
    createdAt: Date.now(),
  };
  storage.set(path, record);
  const error = markedFileError("EPRIVATE", "cause");
  const release = vi
    .spyOn(releases, "releaseGateway")
    .mockRejectedValueOnce(new Error("Invented joined network refusal"))
    .mockRejectedValue(error);
  manager = await GatewayCloudRelayManagement.open(f.options);
  manager.start();
  await assertHeld(error);
  expect(release).toHaveBeenCalledTimes(2);
  expect(storage.get(path)).toBe(record);
});

test("synchronous actor-close failures cannot prevent independent teardown or lose the Native receipt", async () => {
  const f = fixture();
  const error = markedFileError("EPRIVATE", "cause");
  const tunnelClose = vi.fn<() => Promise<void>>(() => {
    throw error;
  });
  f.tunnel.mockReturnValue({
    stop: vi.fn(),
    close: tunnelClose,
    cleanupFailure: () => undefined,
    status: () => ({ state: "online" }),
  } as unknown as NonNullable<ReturnType<NonNullable<CloudRelayManagerOptions["startTunnel"]>>>);
  manager = await GatewayCloudRelayManagement.open(f.options);
  await manager.configure({ termsAccepted: true });
  await manager.enable();
  await vi.waitFor(() => expect(f.tunnel).toHaveBeenCalledOnce());
  f.controller.close.mockImplementation(() => {
    throw new Error("Invented joined controller close failure");
  });
  f.monitor.close.mockImplementation(() => {
    throw new Error("Invented joined monitor close failure");
  });
  f.stopLegacy.mockRejectedValue(new Error("Invented joined legacy shutdown failure"));
  await expect(manager.disable()).rejects.toSatisfy(
    (failure: unknown) => ownedProcessCleanupReceipt(failure)?.pending === false,
  );
  await expect(manager.close()).rejects.toSatisfy(
    (failure: unknown) => ownedProcessCleanupReceipt(failure)?.pending === false,
  );
  expect(tunnelClose).toHaveBeenCalledOnce();
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(f.monitor.close).toHaveBeenCalledOnce();
  expect(f.stopLegacy).toHaveBeenCalled();
});

test("close joins an accepted registration rejection and all independent actors", async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  const blocked = new Promise<never>((_resolve, fail) => (reject = fail));
  // A setup failure can leave this invented gate unclaimed by the producer.
  void blocked.catch(() => {});
  f.register.mockImplementationOnce(async () => blocked);
  let enabling: Promise<void> | undefined, closing: Promise<void> | undefined;
  let observed: Promise<unknown> | undefined;
  try {
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure({ termsAccepted: true });
    let enabled = false;
    enabling = manager.enable().then(
      () => {
        enabled = true;
      },
      (error: unknown) => {
        enabled = true;
        throw error;
      },
    );
    void enabling.catch(() => {});
    await vi.waitFor(() => expect(enabled).toBe(true));
    await enabling;
    await vi.waitFor(() => expect(f.register).toHaveBeenCalledOnce());
    closing = manager.close();
    observed = closing.catch((error: unknown) => error);
    reject(new Error("Invented joined registration refusal"));
    const failure = await observed;
    expect(ownedProcessCleanupReceipt(failure)).toBeUndefined();
    expect(manager.cleanupFailure()).toBeUndefined();
    expect(f.controller.close).toHaveBeenCalledOnce();
    expect(f.monitor.close).toHaveBeenCalledOnce();
    expect(f.stopLegacy).toHaveBeenCalled();
  } finally {
    reject(new Error("Invented registration gate cleanup"));
    await Promise.allSettled([enabling, observed, closing ?? manager?.close()]);
  }
});

test("disable joins a pending registration's late Native receipt before completing teardown", async () => {
  const f = fixture();
  let reject!: (error: unknown) => void;
  const blocked = new Promise<never>((_resolve, fail) => (reject = fail));
  void blocked.catch(() => {});
  f.register.mockImplementationOnce(async () => blocked);
  let enabling: Promise<void> | undefined, stopping: Promise<unknown> | undefined;
  try {
    manager = await GatewayCloudRelayManagement.open(f.options);
    await manager.configure({ termsAccepted: true });
    let enabled = false;
    enabling = manager.enable().then(
      () => {
        enabled = true;
      },
      (error: unknown) => {
        enabled = true;
        throw error;
      },
    );
    void enabling.catch(() => {});
    await vi.waitFor(() => expect(enabled).toBe(true));
    await enabling;
    await vi.waitFor(() => expect(f.register).toHaveBeenCalledOnce());
    stopping = manager.disable().catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.monitor.close).not.toHaveBeenCalled();
    const error = markedFileError("EPRIVATE", "own");
    reject(error);
    expect(ownedProcessCleanupReceipt(await stopping)?.pending).toBe(false);
    await assertHeld(error);
    expect(f.controller.close).toHaveBeenCalledOnce();
  } finally {
    reject(new Error("Invented registration gate cleanup"));
    await Promise.allSettled([enabling, stopping, manager?.close()]);
  }
});
