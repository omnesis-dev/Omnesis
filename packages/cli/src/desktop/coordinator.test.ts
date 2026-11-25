// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DesktopCoordinator } from "./coordinator.js";
import { DesktopInteractionBroker, type DesktopProtocolRequest } from "./protocol.js";
import { desktopProfile } from "./environment.js";
import type { DesktopInstall } from "./bootstrap.js";
import type { DesktopPairing } from "./enrollment.js";

type Dependencies = NonNullable<ConstructorParameters<typeof DesktopCoordinator>[1]>;
const origin = "https://library.example.test";
function pairing(kind: "cli" | "collector"): DesktopPairing {
  return {
    kind,
    gatewayUrl: origin,
    gatewayCertificate: "fictional-public-certificate",
    gatewayFingerprint: "a".repeat(64),
    token: `fictional-${kind}-token`,
    deviceId:
      kind === "cli"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
    scopes: kind === "cli" ? ["admin", "read"] : ["read", "write:*"],
  };
}
function fixture(mode?: "home" | "joined") {
  const profile = desktopProfile("/tmp/fictional-desktop-coordinator");
  let install: DesktopInstall | null = mode
    ? {
        version: 1,
        owner: "omnesis-desktop",
        phase: "configured",
        mode,
        instance: profile.instance,
        secretService: profile.secretService,
        embedder: mode === "home" ? "fictional-embedder" : null,
        memoryLimitMb: 512,
      }
    : null;
  let linked = false;
  const pairs = new Map<string, DesktopPairing>(),
    tokens = new Map<string, string>();
  const calls: string[] = [];
  const controller = new AbortController();
  const prompts: Record<string, unknown>[] = [];
  const broker = new DesktopInteractionBroker(async ({ interaction }) => {
    prompts.push(interaction);
    const value =
      interaction.kind === "compareCode"
        ? "approve"
        : interaction.kind === "chooseGateway"
          ? (interaction.choices as { id: string }[])[0]!.id
          : "continue";
    queueMicrotask(() => broker.respond(interaction.id, value));
  });
  const context = { signal: controller.signal, interactions: broker };
  const transport = {
    url: "http://127.0.0.1:18602",
    gatewayUrl: origin,
    close: vi.fn(async () => {}),
  };
  const deps = {
    readInstall: vi.fn(async () => install),
    prepareInstall: vi.fn<NonNullable<Dependencies["prepareInstall"]>>(
      async (_profile, options) => {
        calls.push("protected");
        install = {
          version: 1,
          owner: "omnesis-desktop",
          phase: "configured",
          mode: options.mode,
          instance: profile.instance,
          secretService: profile.secretService,
          embedder: null,
          memoryLimitMb: 512,
        };
        return install;
      },
    ),
    prepareRuntime: vi.fn(async () => ({ version: 1 as const, port: 18601 })),
    protected: vi.fn(async () => true),
    localCollectorDeviceId: vi.fn(async () => "00000000-0000-4000-8000-000000000004"),
    connection: vi.fn(async () => ({
      url: "https://localhost:18601",
      token: "fictional-owner-token",
      certificatePEM: "fictional-public-certificate",
    })),
    request: vi.fn<NonNullable<Dependencies["request"]>>(async (_profile, path) => {
      calls.push(path);
      return path === "/health"
        ? { status: "ok" }
        : {
            account: { linked },
            publicOrigin: origin,
            signup: { inviteOnly: true },
            config: { acmeTermsUrl: "https://ca.example.test/terms" },
          };
    }),
    discover: vi.fn<NonNullable<Dependencies["discover"]>>().mockResolvedValue({ kind: "no-home" }),
    enroll: vi.fn<NonNullable<Dependencies["enroll"]>>(async (options) =>
      pairing(options.role === "interactive" ? "cli" : "collector"),
    ),
    connectAccount: vi.fn<NonNullable<Dependencies["connectAccount"]>>(async () => {
      linked = true;
      return { account: { linked: true } };
    }),
    searchModel: vi
      .fn<NonNullable<Dependencies["searchModel"]>>()
      .mockResolvedValue({ state: "ready" }),
    readPair: vi.fn<NonNullable<Dependencies["readPair"]>>(async (path) => {
      const value = pairs.get(path);
      if (value) return value;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    savePair: vi.fn<NonNullable<Dependencies["savePair"]>>(async (path, value) => {
      pairs.set(path, value);
    }),
    readToken: vi.fn<NonNullable<Dependencies["readToken"]>>(
      async (path) => tokens.get(path) ?? null,
    ),
    saveToken: vi.fn<NonNullable<Dependencies["saveToken"]>>(async (path, value) => {
      tokens.set(path, value);
      return { encrypted: true };
    }),
    stopDaemon: vi.fn(async () => true),
    startDaemon: vi.fn(async () => {
      calls.push("daemon");
    }),
    startTransport: vi.fn(async () => transport),
    verifyTransport: vi.fn(async () => {}),
    relayUrl: () => "https://relay.example.test",
    memoryBytes: () => 8 * 1024 ** 3,
    name: () => "fictional-mac",
    sleep: vi.fn(async () => {}),
  } satisfies Dependencies;
  const coordinator = new DesktopCoordinator(profile, deps);
  const run = (command: DesktopProtocolRequest["command"], params?: unknown) =>
    coordinator.handle({ version: 1, id: "fixture", command, params }, context);
  const save = (kind: "cli" | "collector") => {
    const value = pairing(kind);
    pairs.set(join(profile.configDir, "cloud-relay", `${kind}-device.json`), value);
    tokens.set(join(profile.configDir, kind === "cli" ? "token" : "collector-token"), value.token);
  };
  return {
    profile,
    controller,
    context,
    deps,
    coordinator,
    run,
    pairs,
    tokens,
    calls,
    transport,
    prompts,
    save,
    setLinked: (value: boolean) => {
      linked = value;
    },
  };
}

test("welcome has no runtime, connection or relay side effects", async () => {
  const f = fixture();
  expect(await f.run("status")).toEqual({ phase: "welcome" });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
  expect(f.deps.request).not.toHaveBeenCalled();
});

test("home preparation protects first, starts only owned runtime and waits for verified health", async () => {
  const f = fixture();
  f.deps.request.mockRejectedValueOnce(new Error("still starting"));
  const state = await f.run("prepare", { mode: "home", name: "fictional-mac" });
  expect(state).toMatchObject({
    phase: "accountRequired",
    mode: "home",
    encrypted: true,
    signup: { policy: "invite", acmeTermsUrl: "https://ca.example.test/terms" },
  });
  expect(f.calls.slice(0, 2)).toEqual(["protected", "daemon"]);
  expect(f.deps.sleep).toHaveBeenCalledOnce();
  expect(f.deps.searchModel).toHaveBeenCalledWith(
    f.profile,
    expect.objectContaining({ start: true }),
  );
  expect(state.connection).toBeUndefined();
});

test("an unavailable or unprotected home never claims readiness", async () => {
  const f = fixture("home");
  f.deps.protected.mockResolvedValue(false);
  expect(await f.run("status")).toMatchObject({ phase: "error" });
  expect(f.deps.request).not.toHaveBeenCalled();
  f.deps.protected.mockResolvedValue(true);
  f.deps.request.mockRejectedValue(new Error("fictional-private-error"));
  const state = await f.run("status");
  expect(state.phase).toBe("waiting");
  expect(JSON.stringify(state)).not.toContain("fictional-private-error");
});

test("linked home waits for local search readiness and respects explicit download retry", async () => {
  const f = fixture("home");
  f.setLinked(true);
  f.deps.searchModel.mockResolvedValueOnce({
    state: "downloading",
    downloadedBytes: 10,
    totalBytes: 100,
  });
  expect(await f.run("status")).toMatchObject({
    phase: "preparing",
    searchModel: { downloadedBytes: 10, totalBytes: 100 },
  });
  expect(f.deps.connection).not.toHaveBeenCalled();
  f.deps.searchModel.mockResolvedValueOnce({ state: "needs-download" });
  expect(await f.run("status")).toMatchObject({
    phase: "error",
    searchModel: { state: "needs-download" },
  });
  expect(await f.run("status")).toMatchObject({
    phase: "ready",
    encrypted: true,
    connection: {
      url: "https://localhost:18601",
      collectorDeviceId: "00000000-0000-4000-8000-000000000004",
    },
  });
});

test("discovery outage does not create another home and an explicit empty account offers home choice", async () => {
  const f = fixture();
  f.deps.discover.mockRejectedValueOnce(new Error("directory unavailable"));
  expect(await f.run("connect", { intent: "existing", termsAccepted: false })).toMatchObject({
    phase: "error",
  });
  expect(f.deps.prepareInstall).not.toHaveBeenCalled();
  expect(await f.run("connect")).toMatchObject({ phase: "chooseHome" });
  expect(await f.run("status")).toMatchObject({ phase: "chooseHome" });
  expect(f.deps.prepareInstall).not.toHaveBeenCalled();
});

test("joining encrypts separate roles before starting collector and verifies interactive identity", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValue({
    kind: "homes",
    homes: [
      { gatewayId: "00000000-0000-4000-8000-000000000003", publicOrigin: origin, online: true },
    ],
  });
  const state = await f.run("connect");
  expect(state).toMatchObject({
    phase: "ready",
    mode: "joined",
    connection: { url: f.transport.url, deviceId: pairing("cli").deviceId },
  });
  expect(f.deps.prepareInstall.mock.calls[0]![1].mode).toBe("joined");
  expect(f.deps.enroll.mock.calls.map(([options]) => options.role)).toEqual([
    "interactive",
    "collector",
  ]);
  for (const [options] of f.deps.enroll.mock.calls)
    expect(options.deviceKeySecretOptions).toMatchObject({
      configDir: f.profile.configDir,
      service: f.profile.secretService,
      backend: "macos-keychain",
    });
  expect(f.tokens.get(join(f.profile.configDir, "token"))).toBe(pairing("cli").token);
  expect(f.tokens.get(join(f.profile.configDir, "collector-token"))).toBe(
    pairing("collector").token,
  );
  expect(f.deps.startDaemon.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.deps.saveToken.mock.invocationCallOrder.at(-1)!,
  );
  expect(f.deps.verifyTransport).toHaveBeenCalledOnce();
});

test("partial role persistence resumes without reenrolling the already approved interactive device", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.tokens.clear();
  expect(await f.run("connect")).toMatchObject({ phase: "ready", mode: "joined" });
  expect(f.deps.enroll.mock.calls.map(([options]) => options.role)).toEqual(["collector"]);
  expect(f.tokens.get(join(f.profile.configDir, "token"))).toBe(pairing("cli").token);
});

test("different library choices cannot start collection or mix role credentials", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.deps.enroll.mockResolvedValue({
    ...pairing("collector"),
    gatewayUrl: "https://other.example.test",
  });
  expect(await f.run("connect")).toMatchObject({ phase: "error" });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
  expect(f.deps.savePair).not.toHaveBeenCalled();
});

test("joined status waits on missing/revoked identity and closes only its own proxy", async () => {
  const f = fixture("joined");
  expect(await f.run("status")).toMatchObject({ phase: "waiting" });
  f.save("cli");
  f.save("collector");
  f.deps.verifyTransport.mockRejectedValueOnce(new Error("unauthorized"));
  expect(await f.run("status")).toMatchObject({ phase: "waiting" });
  expect(f.transport.close).toHaveBeenCalledOnce();
  expect(await f.run("status")).toMatchObject({ phase: "ready" });
  await f.coordinator.close();
  expect(f.transport.close).toHaveBeenCalledTimes(2);
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("advanced portal link uses the canonical account address and carries no bearer", async () => {
  const f = fixture("home");
  f.setLinked(true);
  expect(await f.run("openPortal")).toMatchObject({ phase: "ready" });
  expect(f.prompts[0]).toMatchObject({ kind: "openBrowser", url: `${origin}/portal/` });
  expect(JSON.stringify(f.prompts)).not.toContain("fictional-owner-token");
});

test("preparing another Mac first neither allocates local state nor starts a competing gateway", async () => {
  const f = fixture();
  expect(await f.run("prepare", { mode: "joined" })).toMatchObject({ phase: "waiting" });
  expect(f.deps.prepareInstall).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("cancellation after enrollment never publishes a late credential", async () => {
  const f = fixture("joined");
  f.deps.enroll.mockImplementation(async () => {
    f.controller.abort();
    return pairing("cli");
  });
  await expect(f.run("connect")).rejects.toThrow();
  expect(f.deps.savePair).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("the same hostname with a different approved key cannot mix the two device grants", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.deps.enroll.mockResolvedValue({ ...pairing("collector"), gatewayFingerprint: "b".repeat(64) });
  expect(await f.run("connect")).toMatchObject({ phase: "error" });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("stopping reports success only after owned daemon acknowledgement and closes its proxy", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  await f.run("status");
  f.deps.stopDaemon.mockResolvedValueOnce(false);
  expect(await f.run("stop")).toMatchObject({ phase: "error" });
  expect(f.transport.close).not.toHaveBeenCalled();
  expect(await f.run("stop")).toMatchObject({
    phase: "waiting",
    message: expect.stringContaining("has stopped"),
  });
  expect(f.transport.close).toHaveBeenCalledOnce();
});

test("home reconnect resumes its owned runtime without linking an already connected account again", async () => {
  const f = fixture("home");
  f.setLinked(true);
  expect(await f.run("connect")).toMatchObject({ phase: "ready" });
  expect(f.deps.startDaemon).toHaveBeenCalledOnce();
  expect(f.deps.connectAccount).not.toHaveBeenCalled();
});

test("existing joined setup cannot bypass encryption protection through Connect", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  f.deps.protected.mockResolvedValue(false);
  expect(await f.run("connect")).toMatchObject({ phase: "error", mode: "joined" });
  expect(f.deps.prepareInstall).toHaveBeenCalledOnce();
  expect(f.deps.enroll).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
  expect(f.deps.startTransport).not.toHaveBeenCalled();
});
