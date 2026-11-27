// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { ManagedDesktopNearbyCleanupError } from "@omnesis/core";
import { expect, test, vi } from "vitest";
import { DesktopNearbyHints } from "./nearby-hints.js";
import { DesktopCoordinator, type DesktopStateCommand } from "./coordinator.js";
import { desktopStorageAdmission } from "./desktop-state.js";
import { DesktopInteractionBroker } from "./protocol.js";
import { desktopProfile } from "./environment.js";
import type { DesktopRetirement } from "./retirement.js";
import type { DesktopInstall } from "./bootstrap.js";
import type { DesktopPairing } from "./enrollment.js";

type Dependencies = NonNullable<ConstructorParameters<typeof DesktopCoordinator>[1]>;
const origin = "https://library.example.test";
const cleanupGuidance =
  "Omnesis could not finish checking your connection. Try again to check its status.";
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
  let retirement: DesktopRetirement | null = null;
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
    remoteProtection: vi.fn<NonNullable<Dependencies["remoteProtection"]>>(async () => "encrypted"),
    updateBlocked: vi.fn(async () => false),
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
    readRetirement: vi.fn(async () => retirement),
    resumeRetirement: vi.fn(async () => {
      retirement = null;
      return true;
    }),
    removalPreview: vi.fn<NonNullable<Dependencies["removalPreview"]>>(
      async (_profile, options) => ({
        available: true,
        mode: options.eraseData ? "erase-data" : "keep-data",
        confirmationId: "a".repeat(64),
        summary: "Fictional removal plan",
        dataKept: !options.eraseData,
        keyKept: !options.eraseData,
      }),
    ),
    removeInstall: vi.fn<NonNullable<Dependencies["removeInstall"]>>(async (_profile, options) => ({
      status: "retired",
      data: options.eraseData ? "erased" : "retained",
      keyring: options.eraseData ? "cleared" : "retained",
    })),
    protected: vi.fn(async () => true),
    restartCollector: vi.fn(async () => ({
      kind: "desktopCollectorRestart" as const,
      status: "ready" as const,
      deviceId: "00000000-0000-4000-8000-000000000004",
      permissionRecheckRequired: true as const,
    })),
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
    backgroundHandoff: vi.fn<NonNullable<Dependencies["backgroundHandoff"]>>(async () => null),
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
    publish: async (_profile, _signal, work) => work(),
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
  const run = (command: DesktopStateCommand, params?: unknown) =>
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
    restartCollection: () =>
      coordinator.handle(
        { version: 1, id: "restart-fixture", command: "restartCollector", params: {} },
        context,
      ),
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
    setRetirement: (value: DesktopRetirement | null) => {
      retirement = value;
    },
    preview: (params?: unknown) =>
      coordinator.handle({ version: 1, id: "preview", command: "removePreview", params }, context),
    remove: (params?: unknown) =>
      coordinator.handle({ version: 1, id: "remove", command: "remove", params }, context),
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
  expect(await f.run("status")).toMatchObject({
    phase: "error",
    mode: "home",
    message: "Unlock your Mac's Keychain to protect your Omnesis library.",
  });
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
    installationId: f.profile.instance,
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
    installationId: f.profile.instance,
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
  expect(f.deps.verifyTransport).toHaveBeenCalledTimes(2);
});

test("partial role persistence resumes without reenrolling the already approved interactive device", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.tokens.clear();
  expect(await f.run("connect")).toMatchObject({
    phase: "ready",
    mode: "joined",
    installationId: f.profile.instance,
  });
  expect(await f.run("status")).toMatchObject({ installationId: f.profile.instance });
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
  expect(await f.run("status")).toMatchObject({
    phase: "waiting",
    message:
      "Check that Omnesis is running on the computer that keeps your library, then try again.",
  });
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

function retired(
  profile: ReturnType<typeof desktopProfile>,
  mode: DesktopRetirement["mode"] = "keep-data",
  phase: DesktopRetirement["phase"] = "complete",
): DesktopRetirement {
  return {
    version: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: "00000000-0000-4000-8000-000000000005",
    mode,
    phase,
    root: { device: "1", inode: "2" },
  };
}

test("removal preview defaults to keeping data and does not stop or restart background work", async () => {
  const f = fixture("home");
  expect(await f.preview()).toMatchObject({
    available: true,
    mode: "keep-data",
    dataKept: true,
    keyKept: true,
  });
  expect(f.deps.removeInstall).not.toHaveBeenCalled();
  expect(f.deps.stopDaemon).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("erase cannot reach the backend without the matching structured confirmation", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  await f.run("status");
  for (const params of [{ eraseData: true }, { eraseData: true, confirmationId: "yes" }])
    await expect(f.remove(params)).rejects.toThrow();
  expect(f.deps.removeInstall).not.toHaveBeenCalled();
  expect(f.transport.close).not.toHaveBeenCalled();
});

test("confirmed removal closes only the session proxy before backend retirement and never starts a daemon", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  await f.run("status");
  const plan = await f.preview({ eraseData: true });
  const result = await f.remove({ eraseData: true, confirmationId: plan.confirmationId });
  expect(result).toEqual({ status: "retired", data: "erased", keyring: "cleared" });
  expect(f.transport.close.mock.invocationCallOrder[0]).toBeLessThan(
    f.deps.removeInstall.mock.invocationCallOrder[0]!,
  );
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("status honors retirement before reading absent data and never auto-resumes a kept library", async () => {
  const f = fixture();
  f.setRetirement(retired(f.profile));
  expect(await f.run("status")).toMatchObject({
    phase: "waiting",
    retired: true,
    retirement: { mode: "keep-data", phase: "complete" },
  });
  expect(f.deps.readInstall).not.toHaveBeenCalled();
  expect(f.deps.resumeRetirement).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test.each(["connect", "prepare"] as const)(
  "explicit %s may resume a completed kept library",
  async (command) => {
    const f = fixture("joined");
    f.save("cli");
    f.save("collector");
    f.setRetirement(retired(f.profile));
    expect(
      await f.run(command, command === "prepare" ? { mode: "joined" } : undefined),
    ).toMatchObject({ phase: "ready", mode: "joined" });
    expect(f.deps.resumeRetirement).toHaveBeenCalledOnce();
    expect(f.deps.startDaemon).toHaveBeenCalledOnce();
  },
);

test.each([
  ["keep-data", "requested"],
  ["keep-data", "stopped"],
  ["erase-data", "requested"],
  ["erase-data", "dataRemoved"],
  ["erase-data", "keyCleanupPending"],
  ["erase-data", "complete"],
] as const)("%s retirement at %s cannot be cleared by Connect or Prepare", async (mode, phase) => {
  const f = fixture("home");
  f.setRetirement(retired(f.profile, mode, phase));
  expect(await f.run("connect")).toMatchObject({ phase: "waiting", retired: true });
  expect(await f.run("prepare", { mode: "home" })).toMatchObject({
    phase: "waiting",
    retired: true,
  });
  expect(f.deps.resumeRetirement).not.toHaveBeenCalled();
  expect(f.deps.prepareInstall).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("cancellation after durable removal intent remains retired rather than falsely ready", async () => {
  const f = fixture("home");
  f.deps.removeInstall.mockImplementation(async () => {
    f.setRetirement(retired(f.profile, "erase-data", "requested"));
    f.controller.abort();
    throw new Error("cancelled removal");
  });
  await expect(f.remove({ eraseData: true, confirmationId: "a".repeat(64) })).rejects.toThrow();
  const state = await f.coordinator.handle(
    { version: 1, id: "after-cancel", command: "status" },
    { signal: new AbortController().signal, interactions: f.context.interactions },
  );
  expect(state).toMatchObject({
    phase: "waiting",
    retired: true,
    retirement: { phase: "requested" },
  });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("pending key cleanup stays a structured removal result rather than a success claim", async () => {
  const f = fixture("home");
  f.deps.removeInstall.mockResolvedValue({
    status: "key-cleanup-pending",
    data: "erased",
    keyring: "pending",
  });
  expect(await f.remove({ eraseData: true, confirmationId: "a".repeat(64) })).toEqual({
    status: "key-cleanup-pending",
    data: "erased",
    keyring: "pending",
  });
});

test("retirement beginning during trusted connection verification cannot yield stale ready state", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  f.deps.verifyTransport.mockImplementation(async () => {
    f.setRetirement(retired(f.profile, "erase-data", "requested"));
  });
  expect(await f.run("status")).toMatchObject({ phase: "waiting", retired: true });
  expect(f.transport.close).toHaveBeenCalledOnce();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("a conflicting preparation role cannot clear a kept library's retirement", async () => {
  const f = fixture("home");
  f.setRetirement(retired(f.profile));
  expect(await f.run("prepare", { mode: "joined" })).toMatchObject({
    phase: "error",
    retired: true,
  });
  expect(f.deps.resumeRetirement).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("owned home restart waits for stop acknowledgement and verified health", async () => {
  const f = fixture("home");
  f.setLinked(true);
  expect(await f.run("restart")).toMatchObject({ phase: "ready", mode: "home", encrypted: true });
  expect(f.deps.startDaemon.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.deps.stopDaemon.mock.invocationCallOrder[0]!,
  );
  expect(f.deps.request.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.deps.startDaemon.mock.invocationCallOrder[0]!,
  );
});

test("a joined Mac cannot pretend restarting its collector changes the library memory limit", async () => {
  const f = fixture("joined");
  expect(await f.run("restart")).toMatchObject({ phase: "error", mode: "joined" });
  expect(f.deps.stopDaemon).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("restart never starts another daemon when stop could not be confirmed", async () => {
  const f = fixture("home");
  f.deps.stopDaemon.mockResolvedValue(false);
  expect(await f.run("restart")).toMatchObject({ phase: "error" });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("retirement during restart stop keeps the library retired", async () => {
  const f = fixture("home");
  f.deps.stopDaemon.mockImplementation(async () => {
    f.setRetirement(retired(f.profile));
    return true;
  });
  expect(await f.run("restart")).toMatchObject({ retired: true });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("restart cancellation after stopping cannot start a replacement", async () => {
  const f = fixture("home");
  f.deps.stopDaemon.mockImplementation(async () => {
    f.controller.abort();
    return true;
  });
  await expect(f.run("restart")).rejects.toThrow();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test("pending updates fence ordinary reconnect, preparation and restart without clearing intent", async () => {
  const f = fixture("home");
  f.deps.updateBlocked.mockResolvedValue(true);
  expect(await f.run("restart")).toMatchObject({
    phase: "waiting",
    message: expect.stringContaining("pending Omnesis update"),
  });
  expect(await f.run("prepare", { mode: "home" })).toMatchObject({ phase: "waiting" });
  expect(await f.run("connect")).toMatchObject({ phase: "waiting" });
  expect(f.deps.stopDaemon).not.toHaveBeenCalled();
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
  expect(f.deps.prepareInstall).not.toHaveBeenCalled();
  expect(f.deps.resumeRetirement).not.toHaveBeenCalled();
});

test("an update beginning during restart stop cannot start an old epoch replacement", async () => {
  const f = fixture("home");
  f.deps.stopDaemon.mockImplementation(async () => {
    f.deps.updateBlocked.mockResolvedValue(true);
    return true;
  });
  expect(await f.run("restart")).toMatchObject({
    phase: "waiting",
    message: expect.stringContaining("pending Omnesis update"),
  });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test.each(["unprotected", "unavailable"] as const)(
  "joined %s storage evidence blocks readiness and collector start",
  async (protection) => {
    const f = fixture("joined");
    f.save("cli");
    f.save("collector");
    f.deps.remoteProtection.mockResolvedValue(protection);
    expect(await f.run("connect")).toMatchObject({
      phase: "error",
      mode: "joined",
      encrypted: false,
    });
    expect(f.deps.startDaemon).not.toHaveBeenCalled();
    expect(f.deps.stopDaemon).toHaveBeenCalled();
    expect(f.transport.close).toHaveBeenCalled();
  },
);

test("joined collection begins only after authenticated remote protection evidence", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  expect(await f.run("connect")).toMatchObject({ phase: "ready", encrypted: true });
  expect(f.deps.startDaemon.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.deps.remoteProtection.mock.invocationCallOrder[0]!,
  );
});

test("strict pairing refusals expose fixed protection remediation and no arbitrary server detail", async () => {
  const f = fixture("joined");
  f.deps.enroll.mockRejectedValue(
    Object.assign(new Error("invented-private-server-detail"), {
      code: "STORAGE_PROTECTION_REQUIRED",
    }),
  );
  const state = await f.run("connect");
  expect(state).toMatchObject({
    phase: "error",
    encrypted: false,
    message: expect.stringContaining("Protect the library's storage"),
  });
  expect(JSON.stringify(state)).not.toContain("invented-private-server-detail");
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
});

test.each(["encrypted", "unprotected", "unavailable"] as const)(
  "joined %s state carries only the independently paired display name",
  async (protection) => {
    const f = fixture("joined");
    f.save("cli");
    f.save("collector");
    f.deps.readPair.mockImplementation(async (path) => ({
      ...pairing(path.endsWith("cli-device.json") ? "cli" : "collector"),
      homeName: "Example library",
    }));
    f.deps.remoteProtection.mockResolvedValue(protection);
    expect(await f.run("status")).toMatchObject({ homeName: "Example library", mode: "joined" });
  },
);

test("an offline joined library keeps its approved display name without inferring one from DNS", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  f.deps.readPair.mockImplementation(async (path) => ({
    ...pairing(path.endsWith("cli-device.json") ? "cli" : "collector"),
    homeName: "Example library",
  }));
  f.deps.verifyTransport.mockRejectedValue(new Error("invented-offline"));
  expect(await f.run("status")).toMatchObject({ phase: "waiting", homeName: "Example library" });
  const legacy = fixture("joined");
  legacy.save("cli");
  legacy.save("collector");
  expect(await legacy.run("status")).not.toHaveProperty("homeName");
});

test.each(["home", "joined"] as const)(
  "%s restartCollector preserves enrollment and interactive transport",
  async (mode) => {
    const f = fixture(mode);
    expect(await f.restartCollection()).toMatchObject({
      kind: "desktopCollectorRestart",
      status: "ready",
      permissionRecheckRequired: true,
    });
    expect(f.deps.restartCollector).toHaveBeenCalledOnce();
    expect(f.deps.startDaemon).not.toHaveBeenCalled();
    expect(f.deps.stopDaemon).not.toHaveBeenCalled();
    expect(f.deps.enroll).not.toHaveBeenCalled();
    expect(f.transport.close).not.toHaveBeenCalled();
  },
);

test("retirement and pending update cannot dispatch a collector restart", async () => {
  const f = fixture("home");
  f.setRetirement(retired(f.profile));
  await expect(f.restartCollection()).rejects.toThrow("pending library operation");
  expect(f.deps.restartCollector).not.toHaveBeenCalled();
  const updating = fixture("joined");
  updating.deps.updateBlocked.mockResolvedValue(true);
  await expect(updating.restartCollection()).rejects.toThrow("pending library operation");
  expect(updating.deps.restartCollector).not.toHaveBeenCalled();
});

function storageStatus(state = "normal", measuredAt: number | null = Date.now()) {
  return {
    storagePressure: {
      state,
      measuredAt,
      validUntil: measuredAt === null ? 0 : measuredAt + 120_000,
      policy: { measurementMaxAgeMs: 120_000 },
    },
  };
}

test("home storage loss and recovery preserve reading while projecting current growth admission", async () => {
  const f = fixture("home");
  f.setLinked(true);
  const originalRequest = f.deps.request.getMockImplementation()!;
  let storage: unknown = storageStatus();
  f.deps.request.mockImplementation(async (...args) =>
    args[1] === "/status" ? storage : originalRequest(...args),
  );
  for (const [value, expected] of [
    [storageStatus(), "ready"],
    [storageStatus("blocked"), "blocked"],
    [storageStatus("normal", Date.now() - 120_000), "unavailable"],
    [storageStatus("warning"), "ready"],
    [storageStatus("unknown", null), "checking"],
    [storageStatus(), "ready"],
  ] as const) {
    storage = value;
    expect(await f.run("status")).toMatchObject({
      phase: "ready",
      mode: "home",
      encrypted: true,
      connection: { token: "fictional-owner-token" },
      storageAdmission: { state: expected },
    });
  }
});

test("storage transport failure is content-free and does not replace a usable home connection", async () => {
  const f = fixture("home");
  f.setLinked(true);
  const originalRequest = f.deps.request.getMockImplementation()!;
  f.deps.request.mockImplementation(async (...args) => {
    if (args[1] === "/status") throw new Error("fictional-storage-private-detail");
    return originalRequest(...args);
  });
  const result = await f.run("status");
  expect(result).toMatchObject({ phase: "ready", storageAdmission: { state: "unavailable" } });
  expect(JSON.stringify(result)).not.toContain("fictional-storage-private-detail");
});

test("joined library does not project remote or local cache storage as home admission", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  const result = await f.run("connect");
  expect(result).toMatchObject({ phase: "ready", mode: "joined" });
  expect(result).not.toHaveProperty("storageAdmission");
  expect(result).not.toHaveProperty("remoteRoute");
  expect(f.calls).not.toContain("/status");
});

test.each([
  undefined,
  { storagePressure: null },
  storageStatus("unknown", 1_000),
  storageStatus("normal", 2_001),
  storageStatus("normal", Number.POSITIVE_INFINITY),
  { storagePressure: { ...storageStatus().storagePressure, validUntil: Number.POSITIVE_INFINITY } },
  { storagePressure: { ...storageStatus().storagePressure, validUntil: Number.MAX_SAFE_INTEGER } },
  { storagePressure: { ...storageStatus("normal", 1_000).storagePressure, validUntil: 900 } },
  { storagePressure: { ...storageStatus("normal", 1_000).storagePressure, validUntil: 121_001 } },
  { storagePressure: { ...storageStatus("normal", 1_000).storagePressure, policy: {} } },
  storageStatus("normal", null),
])("missing, future, stale or malformed storage evidence never certifies admission %#", (value) => {
  expect(desktopStorageAdmission(value, 2_000).state).toBe("unavailable");
});

test("server expiry is authoritative at the exact boundary without a replacement reserve policy", () => {
  const value = storageStatus("normal", 1_000);
  expect(desktopStorageAdmission(value, 120_999)).toMatchObject({
    state: "ready",
    validUntil: 121_000,
  });
  expect(desktopStorageAdmission(value, 121_000).state).toBe("unavailable");
  expect(desktopStorageAdmission(value, 121_001).state).toBe("unavailable");
});

test("explicit candidate connect hands ownership over before daemon claim and never clears an update intent", async () => {
  const f = fixture("home");
  f.setLinked(true);
  f.deps.updateBlocked.mockResolvedValue(true);
  f.deps.backgroundHandoff.mockResolvedValue({ kind: "candidate", mode: "home" });
  f.deps.startDaemon.mockImplementation(async () => {
    f.deps.updateBlocked.mockResolvedValue(false); // Normal daemon epoch claim, never the handoff validator.
  });
  expect(await f.run("connect")).toMatchObject({ phase: "ready", mode: "home" });
  expect(f.deps.backgroundHandoff.mock.invocationCallOrder[0]).toBeLessThan(
    f.deps.startDaemon.mock.invocationCallOrder[0]!,
  );
  expect(f.deps.resumeRetirement).not.toHaveBeenCalled();
  expect(f.deps.connectAccount).not.toHaveBeenCalled();
});

test("rebind refusal leaves the old update and processes untouched", async () => {
  const f = fixture("home");
  f.deps.backgroundHandoff.mockRejectedValue(new Error("Fixture native handoff refused"));
  expect(await f.run("connect")).toMatchObject({ phase: "error" });
  expect(f.deps.startDaemon).not.toHaveBeenCalled();
  expect(f.deps.resumeRetirement).not.toHaveBeenCalled();
});

test("ordinary restart never implicitly rebinds a helper", async () => {
  const f = fixture("home");
  f.setLinked(true);
  expect(await f.run("restart")).toMatchObject({ phase: "ready" });
  expect(f.deps.backgroundHandoff).not.toHaveBeenCalled();
});

test("home remote route loss and recovery preserve local search independently of account linkage", async () => {
  const f = fixture("home");
  f.setLinked(true);
  const request = f.deps.request.getMockImplementation()!;
  let online = true;
  f.deps.request.mockImplementation(async (...args) => {
    const value = await request(...args);
    if (args[1] !== "/admin/cloud-relay") return value;
    const checkedAt = Date.now();
    return {
      ...(typeof value === "object" && value !== null ? value : {}),
      tunnel: { state: online ? "online" : "offline" },
      certificate: { state: "valid", expiresAt: new Date(Date.now() + 200_000).toISOString() },
      publicMcp: { url: `${origin}/mcp`, ready: true, checkedAt, validUntil: checkedAt + 90_000 },
    };
  });
  expect(await f.run("status")).toMatchObject({
    phase: "ready",
    mode: "home",
    connection: { token: "fictional-owner-token" },
    remoteRoute: { state: "ready" },
  });
  online = false;
  expect(await f.run("status")).toMatchObject({
    phase: "ready",
    connection: { token: "fictional-owner-token" },
    remoteRoute: { state: "unavailable" },
  });
  online = true;
  expect(await f.run("status")).toMatchObject({ phase: "ready", remoteRoute: { state: "ready" } });
});

test("nearby denial remains display evidence while an authenticated protected relay connection stays ready", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  const refreshNearby = vi.fn(async () => {});
  const transport = { ...f.transport, nearbyState: () => "denied" as const, refreshNearby };
  f.deps.startTransport.mockResolvedValue(transport);
  expect(await f.run("status")).toMatchObject({
    phase: "ready",
    mode: "joined",
    nearby: "denied",
    encrypted: true,
  });
  expect(refreshNearby).toHaveBeenCalledTimes(1);
  expect(f.deps.verifyTransport).toHaveBeenCalledTimes(1);
  expect(f.deps.remoteProtection).toHaveBeenCalledTimes(1);
  expect(f.deps.stopDaemon).not.toHaveBeenCalled();
  await f.coordinator.close(false);
});

test("nearby status does not authorize a disconnected library and ordinary query failure keeps relay checks", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  const transport = {
    ...f.transport,
    nearbyState: () => "unavailable" as const,
    refreshNearby: vi.fn(async () => {
      throw new Error("nearby temporarily unavailable");
    }),
  };
  f.deps.startTransport.mockResolvedValue(transport);
  f.deps.verifyTransport.mockRejectedValue(new Error("offline"));
  expect(await f.run("status")).toMatchObject({ phase: "waiting", nearby: "unavailable" });
  expect(f.deps.verifyTransport).toHaveBeenCalledTimes(1);
  expect(f.deps.remoteProtection).not.toHaveBeenCalled();
  await f.coordinator.close(false);
});

function uncertainInteractiveQuery(profile: ReturnType<typeof desktopProfile>) {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let confirmed = false;
  const refused = new Error("the exact query has not physically joined");
  const joined = Promise.reject(refused);
  void joined.catch(() => {});
  const stop = vi.fn(async () => {
    throw refused;
  });
  const owned = vi.fn(() => ({
    child,
    ready: Promise.resolve(),
    joined,
    get joinedConfirmed() {
      return confirmed;
    },
    stop,
  }));
  const provider = new DesktopNearbyHints(profile, {
    invocation: () => ({ command: "/example/runtime-exec", args: ["--background-nearby"] }),
    owned,
  });
  return {
    provider,
    owned,
    stop,
    confirm: () => {
      confirmed = true;
    },
  };
}

test("unknown failures give neutral status guidance without inventing a Keychain repair", async () => {
  const f = fixture("joined");
  f.deps.readInstall.mockRejectedValueOnce(new Error("fictional-private-diagnostic"));
  expect(await f.run("status")).toEqual({
    phase: "error",
    message: "Omnesis could not finish this step. Try again to check the current status.",
  });
  expect(f.deps.startTransport).not.toHaveBeenCalled();
  expect(f.transport.close).not.toHaveBeenCalled();
  await f.coordinator.close(false);
});

test("an unrelated oversized error graph is not described as retained connection cleanup", async () => {
  const f = fixture("joined");
  f.deps.readInstall.mockRejectedValueOnce(
    new AggregateError(
      Array.from({ length: 33 }, (_, index) => new Error(`Fictional unrelated problem ${index}`)),
      "Fictional operation failed",
    ),
  );
  expect(await f.run("status")).toEqual({
    phase: "error",
    message: "Omnesis could not finish this step. Try again to check the current status.",
  });
  expect(f.deps.startTransport).not.toHaveBeenCalled();
  expect(f.transport.close).not.toHaveBeenCalled();
  await f.coordinator.close(false);
});

test("failed interactive close retains the transport and refuses every successor until the same query joins", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  const query = uncertainInteractiveQuery(f.profile);
  const close = vi.fn(() => query.provider.close());
  f.deps.startTransport.mockResolvedValueOnce({ ...f.transport, close });
  expect(await f.run("status")).toMatchObject({ phase: "ready" });
  await expect(query.provider.snapshot(new AbortController().signal)).rejects.toBeInstanceOf(
    ManagedDesktopNearbyCleanupError,
  );
  await expect(f.coordinator.close(false)).rejects.toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  expect(await f.run("status")).toEqual({ phase: "error", message: cleanupGuidance });
  expect(await f.run("status")).toEqual({ phase: "error", message: cleanupGuidance });
  expect(f.deps.startTransport).toHaveBeenCalledTimes(1);
  expect(query.owned).toHaveBeenCalledTimes(1);
  expect(query.stop).toHaveBeenCalledTimes(1);
  query.confirm();
  expect(await f.run("status")).toMatchObject({ phase: "ready" });
  expect(f.deps.startTransport).toHaveBeenCalledTimes(2);
  expect(query.owned).toHaveBeenCalledTimes(1);
  expect(query.stop).toHaveBeenCalledTimes(1);
  await f.coordinator.close(false);
  expect(f.transport.close).toHaveBeenCalledTimes(1);
});

test("failed startup retains its cleanup capability and original errors before admitting a new interactive transport", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  const query = uncertainInteractiveQuery(f.profile);
  const retryCleanup = vi.spyOn(query.provider, "retryCleanup");
  const cleanup = await query.provider
    .snapshot(new AbortController().signal)
    .catch((error: unknown) => error);
  expect(cleanup).toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  const startup = new Error("the original interactive transport startup failed");
  const failure = new AggregateError([startup, cleanup], "startup and cleanup failed");
  f.deps.startTransport.mockRejectedValueOnce(failure);
  expect(await f.run("status")).toEqual({ phase: "error", message: cleanupGuidance });
  expect(retryCleanup).not.toHaveBeenCalled();
  expect(await f.run("status")).toEqual({ phase: "error", message: cleanupGuidance });
  expect(retryCleanup).toHaveBeenCalledTimes(1);
  await expect(f.coordinator.close(false)).rejects.toBe(failure);
  expect(retryCleanup).toHaveBeenCalledTimes(2);
  expect(failure.errors).toEqual([startup, cleanup]);
  expect(f.deps.startTransport).toHaveBeenCalledTimes(1);
  expect(query.owned).toHaveBeenCalledTimes(1);
  expect(query.stop).toHaveBeenCalledTimes(1);
  query.confirm();
  expect(await f.run("status")).toMatchObject({ phase: "ready" });
  expect(f.deps.startTransport).toHaveBeenCalledTimes(2);
  expect(query.owned).toHaveBeenCalledTimes(1);
  expect(query.stop).toHaveBeenCalledTimes(1);
  await f.coordinator.close(false);
});

test("uncertain status query marks the retained transport draining before the next status can replace it", async () => {
  const f = fixture("joined");
  f.save("cli");
  f.save("collector");
  const query = uncertainInteractiveQuery(f.profile);
  let queryEnabled = false;
  const close = vi.fn(() => query.provider.close());
  const retainedTransport = {
    ...f.transport,
    close,
    refreshNearby: async (signal: AbortSignal) => {
      if (queryEnabled) await query.provider.snapshot(signal);
    },
  };
  f.deps.startTransport.mockResolvedValueOnce(retainedTransport);
  expect(await f.run("status")).toMatchObject({ phase: "ready" });
  queryEnabled = true;
  expect(await f.run("status")).toEqual({ phase: "error", message: cleanupGuidance });
  expect(await f.run("status")).toEqual({ phase: "error", message: cleanupGuidance });
  expect(f.deps.startTransport).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(query.owned).toHaveBeenCalledTimes(1);
  expect(query.stop).toHaveBeenCalledTimes(1);
  query.confirm();
  expect(await f.run("status")).toMatchObject({ phase: "ready" });
  expect(f.deps.startTransport).toHaveBeenCalledTimes(2);
  expect(query.owned).toHaveBeenCalledTimes(1);
  expect(query.stop).toHaveBeenCalledTimes(1);
  await f.coordinator.close(false);
});
