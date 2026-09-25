// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Control mDNS discovery while leaving the rest of @omnesis/core intact
// (createLogger, etc.). main.ts does not launch the daemon on import —
// its self-invocation is gated behind an entrypoint check.
// `vi.hoisted` lets the mock fn be referenced inside the hoisted factory.
const { discoverMock, localUrlMock } = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  localUrlMock: vi.fn(),
}));

vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return { ...actual, discoverGatewayViaMdns: discoverMock, localGatewayRequestUrl: localUrlMock };
});

import {
  makeCommand,
  parseResponsePayload,
  readCollectorPairingState,
  tokenFingerprint,
  writeCollectorPairingState,
  writeCollectorTokenFile,
} from "@omnesis/core";
import {
  handleSourceSyncCommand,
  registerSourceUpdatedCommand,
  resolveCollectorToken,
  resolveGatewayUrl,
  waitForGateway,
} from "./main.js";
import { SourceConfigReconciler } from "./source-config-reconciler.js";
import { createCommandDispatch } from "./ws-command-dispatch.js";
import type { RegisteredSource, SyncEngine } from "./sync-engine.js";

const SAVED = {
  url: process.env.OMNESIS_GATEWAY_URL,
  disable: process.env.OMNESIS_MDNS_DISABLE,
};

beforeEach(() => {
  discoverMock.mockReset();
  localUrlMock.mockReset();
  localUrlMock.mockImplementation((url: string) => url);
  delete process.env.OMNESIS_GATEWAY_URL;
  delete process.env.OMNESIS_MDNS_DISABLE;
});

afterEach(() => {
  if (SAVED.url === undefined) delete process.env.OMNESIS_GATEWAY_URL;
  else process.env.OMNESIS_GATEWAY_URL = SAVED.url;
  if (SAVED.disable === undefined) delete process.env.OMNESIS_MDNS_DISABLE;
  else process.env.OMNESIS_MDNS_DISABLE = SAVED.disable;
});

describe("resolveGatewayUrl", () => {
  test("OMNESIS_GATEWAY_URL override beats mDNS discovery", async () => {
    process.env.OMNESIS_GATEWAY_URL = "https://gateway.example.com:7600";
    discoverMock.mockResolvedValue({ url: "https://192.168.1.20:7600", fingerprint: "deadbeef" });

    const result = await resolveGatewayUrl();

    expect(result).toEqual({ url: "https://gateway.example.com:7600" });
    expect(discoverMock).not.toHaveBeenCalled();
  });

  test("OMNESIS_MDNS_DISABLE=1 short-circuits to localhost without probing", async () => {
    process.env.OMNESIS_MDNS_DISABLE = "1";

    const result = await resolveGatewayUrl();

    expect(result).toEqual({ url: "https://localhost:7600" });
    expect(discoverMock).not.toHaveBeenCalled();
  });

  test("a discovered gateway returns its url + fingerprint", async () => {
    discoverMock.mockResolvedValue({ url: "https://192.168.1.20:7600", fingerprint: "cafef00d" });

    const result = await resolveGatewayUrl();

    expect(result).toEqual({ url: "https://192.168.1.20:7600", fingerprint: "cafef00d" });
    expect(discoverMock).toHaveBeenCalledWith({ timeoutMs: 3000 });
  });

  test("falls back to localhost when discovery finds nothing", async () => {
    discoverMock.mockResolvedValue(null);

    const result = await resolveGatewayUrl();

    expect(result).toEqual({ url: "https://localhost:7600" });
  });
});

describe("waitForGateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // A collector unit written before installs recorded loopback still names the
  // LAN address, and at boot its gateway may not hold the config directory yet.
  test("switches to loopback once the gateway on this machine holds the config directory", async () => {
    vi.useFakeTimers();
    let gatewayHoldsDir = false;
    localUrlMock.mockImplementation((url: string) =>
      gatewayHoldsDir ? "https://localhost:7600" : url,
    );
    const fetchMock = vi.fn((input: string) =>
      input.startsWith("https://localhost:7600/")
        ? Promise.resolve(new Response("{}", { status: 200 }))
        : Promise.reject(new TypeError("fetch failed")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const waiting = waitForGateway("https://omnesis.local:7600", "/cfg", undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    gatewayHoldsDir = true;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe("https://localhost:7600");
    expect(fetchMock).toHaveBeenCalledWith("https://omnesis.local:7600/health");
    expect(localUrlMock).toHaveBeenCalledWith("https://omnesis.local:7600", "/cfg");
  });

  // A gateway serving a certificate that does not name localhost (an
  // operator-supplied or tailnet one) keeps being reached by the name it carries.
  test("falls back to the recorded address when loopback does not answer", async () => {
    localUrlMock.mockImplementation(() => "https://localhost:7600");
    const fetchMock = vi.fn((input: string) =>
      input.startsWith("https://localhost:7600/")
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForGateway("https://gateway.example.org:7600", "/cfg", undefined),
    ).resolves.toBe("https://gateway.example.org:7600");
    expect(fetchMock).toHaveBeenCalledWith("https://localhost:7600/health");
    expect(fetchMock).toHaveBeenCalledWith("https://gateway.example.org:7600/health");
  });

  test("a gateway on another machine is reached at the recorded address", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForGateway("https://gateway.example.org:7600", "/cfg", undefined),
    ).resolves.toBe("https://gateway.example.org:7600");
    expect(fetchMock).toHaveBeenCalledWith("https://gateway.example.org:7600/health");
  });
});

describe("handleSourceSyncCommand", () => {
  test("routes the requested source to the engine and maps its buckets to protocol counts", () => {
    const triggerSync = vi.fn().mockReturnValue({
      triggered: ["local-notes:local"],
      skipped: ["calendar:local"],
      disabled: ["tasks:local"],
      restarting: ["chat:local"],
      unhosted: [],
    });

    const response = handleSourceSyncCommand({ triggerSync }, { sourceId: "local-notes:local" });

    expect(response).toEqual({
      ok: true,
      triggered: 1,
      skipped: 1,
      disabled: 1,
      restarting: 1,
    });
    expect(triggerSync).toHaveBeenCalledWith("local-notes:local", { restart: false });
    expect(parseResponsePayload("source.sync", response).ok).toBe(true);
  });

  test("preserves a no-match error with zero counts", () => {
    const triggerSync = vi.fn().mockReturnValue({
      triggered: [],
      skipped: [],
      disabled: [],
      restarting: [],
      unhosted: [],
      error: "No sources match: missing-source",
    });

    const response = handleSourceSyncCommand(
      { triggerSync },
      makeCommand("source.sync", { sourceId: "missing-source" }),
    );

    expect(response).toEqual({
      ok: false,
      triggered: 0,
      skipped: 0,
      disabled: 0,
      restarting: 0,
      error: "No sources match: missing-source",
    });
    expect(parseResponsePayload("source.sync", response).ok).toBe(true);
  });
});

describe("source.updated dispatch", () => {
  test("applies a persisted mode to an already-registered live source", async () => {
    const source = {
      id: "local-notes:local",
      multiDeviceMode: "exclusive",
    } as RegisteredSource;
    const config = { sources: { [source.id]: { enabled: true } } };
    const reconciler = new SourceConfigReconciler({
      getConfig: () => config,
      getRegisteredKeys: () => new Set([source.id]),
      engine: {
        getSourcesById: (id: string) => (id === source.id ? [source] : []),
        getStatuses: () => [],
      } as unknown as SyncEngine,
      setupSources: vi.fn(async () => undefined),
      findSourcesForKeys: () => [source],
      saveConfig: vi.fn(),
    });
    const dispatch = createCommandDispatch();
    registerSourceUpdatedCommand(dispatch, {
      applySourcesSnapshot: (records, opts) => reconciler.applySnapshot(records, opts),
    });

    await dispatch.handle(
      makeCommand("source.updated", {
        source: {
          id: source.id,
          enabled: true,
          multiDeviceMode: "partitioned",
        },
      }),
    );

    expect(source.multiDeviceMode).toBe("partitioned");
  });
});

/**
 * The credential decision a collector makes at boot. Everything here is
 * driven through a stubbed `fetch`, so the branch that parks a locked-out
 * daemon and the branch that self-pairs a fresh one are both observable
 * without a gateway.
 */
describe("resolveCollectorToken", () => {
  const GATEWAY = "https://gateway.example.com:7600";
  let dir: string;
  let realFetch: typeof globalThis.fetch;
  let savedEnvToken: string | undefined;

  const answer = (routes: { config?: number; register?: Response | number }) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config")) return new Response("{}", { status: routes.config ?? 200 });
      if (url.endsWith("/admin/devices")) {
        void init;
        const r = routes.register;
        if (typeof r === "number") return new Response("nope", { status: r });
        return r ?? new Response("nope", { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

  const registered = (token: string, reclaimed = false) =>
    Response.json({ token, reclaimed, device: { id: "dev-1", name: "host-collector" } });

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = mkdtempSync(join(tmpdir(), "omnesis-collector-token-"));
    realFetch = globalThis.fetch;
    savedEnvToken = process.env.OMNESIS_TOKEN;
    delete process.env.OMNESIS_TOKEN;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (savedEnvToken === undefined) delete process.env.OMNESIS_TOKEN;
    else process.env.OMNESIS_TOKEN = savedEnvToken;
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  const recordAuthenticated = (token: string) =>
    writeCollectorPairingState(dir, {
      state: "paired",
      deviceName: "host-collector",
      gatewayUrl: GATEWAY,
      tokenFingerprint: tokenFingerprint(token),
      lastAuthenticatedAt: 1_700_000_000_000,
      unauthorizedAt: null,
      repairCommand: null,
    });

  test("keeps a saved token the gateway still accepts, and records that it worked", async () => {
    writeCollectorTokenFile("omn_saved", dir);
    globalThis.fetch = answer({ config: 200 });

    expect(await resolveCollectorToken(GATEWAY, dir)).toEqual({
      outcome: "token",
      token: "omn_saved",
    });
    const state = readCollectorPairingState(dir);
    expect(state?.state).toBe("paired");
    expect(state?.tokenFingerprint).toBe(tokenFingerprint("omn_saved"));
    expect(state?.lastAuthenticatedAt).toBeGreaterThan(0);
  });

  // The gateway-host case: the collector's own token is dead, but the local
  // bootstrap admin token is intact, so it registers again and the gateway
  // hands back its own reclaimed row.
  test("self-pairs with the bootstrap token when the saved one is refused", async () => {
    writeCollectorTokenFile("omn_dead", dir);
    recordAuthenticated("omn_dead");
    process.env.OMNESIS_TOKEN = "omn_admin";
    globalThis.fetch = answer({ config: 401, register: registered("omn_fresh", true) });

    expect(await resolveCollectorToken(GATEWAY, dir)).toEqual({
      outcome: "token",
      token: "omn_fresh",
    });
    expect(readCollectorPairingState(dir)?.tokenFingerprint).toBe(tokenFingerprint("omn_fresh"));
  });

  // The remote case: nothing here can register a device, and the credential
  // demonstrably worked before, so this is a revoke and retrying is futile.
  test("reports needs-pairing when a credential that worked is refused and nothing can register", async () => {
    writeCollectorTokenFile("omn_dead", dir);
    recordAuthenticated("omn_dead");
    globalThis.fetch = answer({ config: 401 });

    expect(await resolveCollectorToken(GATEWAY, dir)).toEqual({ outcome: "needs-pairing" });
  });

  test("reports needs-pairing when the bootstrap credential is refused too", async () => {
    writeCollectorTokenFile("omn_dead", dir);
    recordAuthenticated("omn_dead");
    process.env.OMNESIS_TOKEN = "omn_also_dead";
    globalThis.fetch = answer({ config: 401, register: 401 });

    expect(await resolveCollectorToken(GATEWAY, dir)).toEqual({ outcome: "needs-pairing" });
  });

  // A token with no history is a half-finished install, not a revoke: it must
  // fall through to the self-pair rather than park a fresh machine.
  test("a refused token with no history still tries to self-pair", async () => {
    writeCollectorTokenFile("omn_never_worked", dir);
    process.env.OMNESIS_TOKEN = "omn_admin";
    globalThis.fetch = answer({ config: 401, register: registered("omn_fresh") });

    expect(await resolveCollectorToken(GATEWAY, dir)).toEqual({
      outcome: "token",
      token: "omn_fresh",
    });
  });

  test("a refused token with no history and no bootstrap is a hard error, not a park", async () => {
    writeCollectorTokenFile("omn_never_worked", dir);
    globalThis.fetch = answer({ config: 401 });

    await expect(resolveCollectorToken(GATEWAY, dir)).rejects.toThrow(/No auth token found/);
  });

  // The history is bound to the gateway, so re-pointing a collector at a
  // different one starts fresh instead of reading its first 401 as a revoke.
  test("history from another gateway does not make a refusal a revoke", async () => {
    writeCollectorTokenFile("omn_dead", dir);
    writeCollectorPairingState(dir, {
      state: "paired",
      deviceName: "host-collector",
      gatewayUrl: "https://other.example.com:7600",
      tokenFingerprint: tokenFingerprint("omn_dead"),
      lastAuthenticatedAt: 1_700_000_000_000,
      unauthorizedAt: null,
      repairCommand: null,
    });
    globalThis.fetch = answer({ config: 401 });

    await expect(resolveCollectorToken(GATEWAY, dir)).rejects.toThrow(/No auth token found/);
  });

  // A scope refusal means the gateway still knows the credential; parking on
  // it would tell the operator to re-pair a device that is still paired.
  test("a scope refusal is not a revoke", async () => {
    writeCollectorTokenFile("omn_scoped_out", dir);
    recordAuthenticated("omn_scoped_out");
    globalThis.fetch = answer({ config: 403 });

    await expect(resolveCollectorToken(GATEWAY, dir)).rejects.toThrow(/No auth token found/);
  });

  test("an unreachable gateway is never read as a revoke", async () => {
    writeCollectorTokenFile("omn_saved", dir);
    recordAuthenticated("omn_saved");
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof globalThis.fetch;

    await expect(resolveCollectorToken(GATEWAY, dir)).rejects.toThrow(/No auth token found/);
  });
});
