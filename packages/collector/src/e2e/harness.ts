// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E test harness: starts a real gateway subprocess + collector in-process
 * with injected mock providers. Tests communicate via direct harness method
 * calls (for triggering syncs / mutating sources / reading status) and via
 * the gateway's HTTP/WebSocket API (for things the gateway is the source of
 * truth for: documents, search, /device/ws events).
 *
 * The legacy collector `:7601` status server + collector-ws-server are gone;
 * tests no longer reference any collector port.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { parseSourceKey, websocketAuthProtocol } from "@omnesis/core";
import { SourceId } from "@omnesis/types";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import { SyncEngine } from "../sync-engine.js";
import { SourceManager } from "../source-manager.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { gatewayFetch, gatewayJson, type GatewayEndpoint } from "./gateway-request.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import {
  MockSource,
  createMockProvider,
  createMockDescriptor,
  type MockSourceOptions,
} from "./mock-source.js";
import type { SourceDescriptor } from "@omnesis/source-sdk";
import type { CollectorInternalConfig } from "../internal-config.js";

/**
 * Probe the OS for a free TCP port on loopback. Eliminates the
 * cross-fork port-collision flake that the previous `pid * 100`
 * scheme could produce when two vitest fork PIDs differed by a
 * multiple of 100 — they'd allocate the same port and the second
 * harness's `/health` poll would land on the first fork's orphaned
 * gateway, whose token table does not match this harness's freshly
 * minted bootstrap token (→ 401 on every collector call).
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export interface HarnessOptions {
  /** Sync interval override (default: very high so tests control sync manually) */
  syncInterval?: string;
  /** Additional config to merge */
  config?: Partial<CollectorInternalConfig>;
}

export interface HarnessStatus {
  sourceId: string;
  state: "idle" | "syncing" | "error" | "disabled";
  lastError?: string;
  lastSyncStats?: { documentsUpserted: number };
  [key: string]: unknown;
}

export class E2EHarness {
  // Set in `start()` after probing for a free port; tests only access
  // these after `await harness.start()` returns.
  gatewayPort = 0;
  gatewayUrl = "";
  apiKey = "";

  private tempDir: string;
  private configDir: string;
  private dbPath: string;
  private configPath: string;
  private gatewayProcess: ChildProcess | null = null;
  private engine: SyncEngine | null = null;
  private manager: SourceManager | null = null;
  private gateway: HttpGatewayClient | null = null;
  private collectorWs: GatewayWsClient | null = null;
  private options: HarnessOptions;
  private statusListeners = new Set<
    (change: import("../sync-engine.js").StatusChangeEvent) => void
  >();

  // Mock sources and providers registered before start()
  private mockSources: MockSource[] = [];
  private descriptors: SourceDescriptor[] = [];
  private sourceConfigs: Record<string, { enabled: boolean }> = {};

  constructor(opts?: HarnessOptions) {
    // Gateway always serves HTTPS (auto-generated self-signed cert at first
    // boot). E2E tests connect via undici/fetch which honors
    // NODE_TLS_REJECT_UNAUTHORIZED at module init; we set it once here so
    // every harness instance can talk to its self-signed gateway.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    this.options = opts ?? {};

    // Create temp directory for this harness instance
    this.tempDir = mkdtempSync(join(tmpdir(), "omnesis-e2e-"));
    this.configDir = join(this.tempDir, "config");
    mkdirSync(this.configDir, { recursive: true });
    this.dbPath = join(this.tempDir, "omnesis-e2e.db");
    this.configPath = join(this.configDir, "collector.json");
  }

  /**
   * Register a mock source. Must be called before start().
   * Returns the created MockSource for configuration.
   */
  registerMockSource(opts: MockSourceOptions): MockSource {
    const mockSource = new MockSource(opts);
    this.mockSources.push(mockSource);

    // Add descriptor if not already present
    const hasDescriptor = this.descriptors.some((d) => d.id === opts.sourceType);
    if (!hasDescriptor) {
      this.descriptors.push(createMockDescriptor(opts.sourceType, opts.providerType));
    }

    // Add source config entry
    const configKey = `${opts.sourceType}:${opts.accountId ?? "test"}`;
    this.sourceConfigs[configKey] = { enabled: true };

    return mockSource;
  }

  /**
   * Start the harness: gateway subprocess + collector in-process.
   */
  async start(): Promise<void> {
    // Allocate a real free port via OS probe. Done here (not in the
    // constructor) because the probe is async.
    this.gatewayPort = await getFreePort();
    this.gatewayUrl = `https://localhost:${this.gatewayPort}`;

    // Write initial config
    const config: CollectorInternalConfig = {
      sources: this.sourceConfigs,
      defaultSyncInterval: this.options.syncInterval ?? "999999s", // effectively disable auto-sync
      ...this.options.config,
    };
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));

    // 1. Start gateway subprocess
    await this.startGateway();

    // 2. Pair the in-process collector and use its device token for collector
    // traffic. `apiKey` remains the bootstrap-admin credential used by test
    // assertions; production collectors never sync with that credential.
    const collector = await this.pairCollector();
    this.gateway = new HttpGatewayClient(this.gatewayUrl, collector.token);
    this.engine = new SyncEngine(this.gateway);

    // Build RegisteredProvider objects from mock sources
    // Group sources by (providerType, accountId)
    const byProviderKey = new Map<string, MockSource[]>();
    for (const s of this.mockSources) {
      const key = String(s.providerId);
      const list = byProviderKey.get(key) ?? [];
      list.push(s);
      byProviderKey.set(key, list);
    }

    for (const [providerKey, sources] of byProviderKey) {
      // ProviderId shares the `<type>:<account>` shape with SourceId so
      // parseSourceKey is the right parser even though the brand differs.
      const parts = parseSourceKey(providerKey);
      const providerType = parts.sourceType;
      const accountId = providerKey.includes(":") ? parts.accountId : "test";
      const provider = createMockProvider(providerType, accountId, sources);
      this.engine.registerProvider(provider);
    }

    this.manager = new SourceManager(this.engine, this.gateway, config, {
      definitions: [], // No definitions needed — sources are pre-registered
      descriptors: this.descriptors,
      configPath: this.configPath,
    });

    // Single fan-out handler for all status listeners. Lets multiple
    // concurrent waitForSyncComplete calls coexist without overwriting each
    // other (engine.onStatusChange is single-handler).
    this.engine.onStatusChange((change) => {
      for (const handler of this.statusListeners) {
        try {
          handler(change);
        } catch {
          /* don't let one listener break others */
        }
      }
    });

    // Match the real collector lifecycle: establish the command/status
    // WebSocket before publishing descriptor-derived metadata. Readiness is
    // intentionally connected-only, so an HTTP-only pseudo collector must
    // not receive a test-only exemption.
    this.collectorWs = new GatewayWsClient(this.gatewayUrl, collector.token, {
      capabilities: {
        hostname: "synthetic-collector.example.com",
        platform: "linux",
        hostableSourceTypes: this.descriptors.map((descriptor) => descriptor.id),
      },
    });
    this.collectorWs.onCommand(async (command) => {
      if (command.type === "sources.snapshot") return { ok: true, applied: true };
      throw new Error(`Unsupported synthetic harness command: ${command.type}`);
    });
    this.collectorWs.connect();
    await this.waitForDeviceOnline(collector.deviceId);

    // 3. Start sync loop (with very high interval — tests trigger syncs manually).
    // Skip the boot-time staggered initial sync; tests fire `triggerSync`
    // explicitly and the stagger would just add boot wall-clock.
    await this.engine.startSyncLoop(config, { skipInitialSync: true });

    // Production publishes one atomic link-declaration generation after its
    // source snapshot has registered providers. Mirror that handshake here so
    // background link extraction is allowed to start: the gateway deliberately
    // waits for every live collector before making destructive URL decisions.
    // Mock sources normally declare no URL roles, but an empty declaration is
    // still the collector's positive acknowledgement of that fact.
    await this.engine.pushLinkDeclarations(this.manager.getKnownUrlPatterns());
  }

  // ───────────────────────────────────────────────────────────────────────
  // Test-facing helpers (replace the legacy `:7601` HTTP API)
  // ───────────────────────────────────────────────────────────────────────

  /** Get a snapshot of all source statuses from the in-process engine. */
  getStatus(): { statuses: HarnessStatus[]; timestamp: string } {
    if (!this.engine) throw new Error("Harness not started");
    return {
      statuses: this.engine.getStatuses() as unknown as HarnessStatus[],
      timestamp: new Date().toISOString(),
    };
  }

  /** Trigger sync for a single source and wait for it to complete. */
  async triggerSyncAndWait(sourceId: string, timeout = 30000): Promise<void> {
    this.triggerSync(sourceId);
    await this.waitForSyncComplete(sourceId, timeout);
  }

  /**
   * Trigger sync without waiting. Returns whatever the engine returns
   * (`triggered`, `skipped`, `disabled`, optional `error`).
   */
  triggerSync(pattern: string): {
    triggered: string[];
    skipped: string[];
    disabled: string[];
    error?: string;
  } {
    if (!this.engine) throw new Error("Harness not started");
    return this.engine.triggerSync(pattern);
  }

  async disableSource(key: string): Promise<void> {
    if (!this.manager) throw new Error("Harness not started");
    await this.manager.disableSources([key]);
  }

  async enableSource(key: string): Promise<void> {
    if (!this.manager) throw new Error("Harness not started");
    await this.manager.enableSources([key]);
  }

  async removeSource(key: string): Promise<{ deleted: number }> {
    if (!this.manager) throw new Error("Harness not started");
    return this.manager.removeSources([key]);
  }

  /**
   * Mirror the legacy `/resync/:id`: delete all data + re-trigger sync.
   * Returns 404 (as a thrown error) if the source isn't registered.
   */
  async resync(
    sourceId: string,
    timeout = 30000,
  ): Promise<{ deleted: number; triggered: string[] }> {
    if (!this.engine || !this.gateway) throw new Error("Harness not started");
    const status = this.engine.getStatuses().find((s) => s.sourceId === sourceId);
    if (!status) throw new Error(`Source not found: ${sourceId}`);
    if (status.state === "syncing") {
      throw new Error(`Source is currently syncing: ${sourceId}`);
    }
    const deleted = await this.gateway.deleteAllBySource(SourceId(sourceId));
    for (const source of this.engine.getSourcesById(sourceId)) {
      source.instance.onResync?.();
    }
    const result = this.triggerSync(sourceId);
    await this.waitForSyncComplete(sourceId, timeout);
    return { deleted, triggered: result.triggered };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Polling helpers
  // ───────────────────────────────────────────────────────────────────────

  async waitForSourceState(
    sourceId: string,
    targetState: HarnessStatus["state"],
    timeout = 15000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = this.getStatus().statuses.find((x) => x.sourceId === sourceId);
      if (s?.state === targetState) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Source ${sourceId} did not reach state "${targetState}" within ${timeout}ms`);
  }

  async waitForSourceNotSyncing(sourceId: string, timeout = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = this.getStatus().statuses.find((x) => x.sourceId === sourceId);
      if (s && s.state !== "syncing") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Source ${sourceId} did not stop syncing within ${timeout}ms`);
  }

  /**
   * Wait for the next `sync.completed` or `sync.error` event for `sourceId`.
   * Subscribes to engine status changes so it doesn't false-positive on the
   * stale state from a previous sync.
   */
  async waitForSyncComplete(sourceId: string, timeout = 30000): Promise<void> {
    if (!this.engine) throw new Error("Harness not started");
    return new Promise((resolve, reject) => {
      const handler = (change: import("../sync-engine.js").StatusChangeEvent): void => {
        if (change.sourceId !== sourceId) return;
        if (change.event === "sync.completed" || change.event === "sync.error") {
          clearTimeout(timer);
          this.statusListeners.delete(handler);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.statusListeners.delete(handler);
        reject(new Error(`Sync for ${sourceId} did not complete within ${timeout}ms`));
      }, timeout);
      this.statusListeners.add(handler);
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  /** Direct engine access — for tests that need fine-grained control. */
  getEngine(): SyncEngine {
    if (!this.engine) throw new Error("Harness not started");
    return this.engine;
  }

  getManager(): SourceManager {
    if (!this.manager) throw new Error("Harness not started");
    return this.manager;
  }

  getGatewayClient(): HttpGatewayClient {
    if (!this.gateway) throw new Error("Harness not started");
    return this.gateway;
  }

  /**
   * Connect a WebSocket to the gateway's /device/ws using the harness's
   * bootstrap admin token (which has admin scope) at the HTTP upgrade boundary.
   */
  connectGatewayWs(): WebSocket {
    // Gateway serves WSS over the auto-generated self-signed cert.
    // NODE_TLS_REJECT_UNAUTHORIZED=0 is set in the constructor for the
    // self-signed test gateway cert; the token rides in Sec-WebSocket-Protocol.
    return new WebSocket(
      `wss://localhost:${this.gatewayPort}/device/ws`,
      websocketAuthProtocol(this.apiKey),
    );
  }

  /**
   * Request a route and parse its JSON body. Throws on any non-2xx, so a
   * failure names the status and the gateway's own message rather than a
   * missing field on an error envelope. Callers exercising a non-2xx use
   * {@link gatewayFetch}, or match `status` on the rejection.
   */
  async gatewayJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return gatewayJson<T>(this.endpoint(), path, init);
  }

  /** The raw response, for callers asserting on a non-2xx status or body. */
  async gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
    return gatewayFetch(this.endpoint(), path, init);
  }

  private endpoint(): GatewayEndpoint {
    return {
      gatewayUrl: this.gatewayUrl,
      apiKey: this.apiKey,
      gatewayLogPath: join(this.tempDir, "gateway.log"),
    };
  }

  /**
   * Tear down: kill gateway, stop engine, clean up.
   */
  async destroy(): Promise<void> {
    this.collectorWs?.disconnect();
    this.collectorWs = null;
    if (this.engine) {
      this.engine.stopSyncLoop();
    }
    await this.killGatewaySubprocess();
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Gateway subprocess
  // ───────────────────────────────────────────────────────────────────────

  private async pairCollector(): Promise<{ deviceId: string; token: string }> {
    const response = await fetch(`${this.gatewayUrl}/admin/devices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Synthetic E2E collector",
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: {
          hostname: "synthetic-collector.example.com",
          platform: "linux",
          hostableSourceTypes: this.descriptors.map((descriptor) => descriptor.id),
        },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to pair synthetic collector: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { device: { id: string }; token: string };
    return { deviceId: body.device.id, token: body.token };
  }

  private async waitForDeviceOnline(deviceId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { items } = await this.gatewayJson<{ items: Array<{ id: string; online: boolean }> }>(
        "/admin/devices",
      );
      if (items.some((device) => device.id === deviceId && device.online)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Synthetic collector WebSocket did not become ready within 10000ms");
  }

  private async startGateway(): Promise<void> {
    const env = {
      ...e2eGatewayEnv(),
      OMNESIS_DB_PATH: this.dbPath,
      OMNESIS_GATEWAY_PORT: String(this.gatewayPort),
      OMNESIS_CONFIG_DIR: this.configDir,
      OMNESIS_LOG_LEVEL: "warn",
      // The gateway's stdio is discarded to keep test output readable, so this
      // file is the only record of why it answered a 5xx — a sanitized error
      // body carries a request id and nothing else. `gatewayJson` reads its
      // tail into the failure it throws.
      OMNESIS_LOG_FILE: join(this.tempDir, "gateway.log"),
      // The gateway exits on its own once this pid disappears. Teardown and the
      // reaper cover every signal we can catch; this covers the one we cannot —
      // a SIGKILLed runner (kernel OOM, CI cancellation) sends us nothing.
      OMNESIS_PARENT_PID: String(process.pid),
      // Disable indexer by not providing a model
    };

    // `detached: true` puts the gateway in its own process group so we
    // can SIGTERM the whole tree on teardown. Without this we'd only
    // signal the entry process, leaving any subprocess as a zombie bound
    // to the port — the next fork's harness would then see
    // `/health` from the zombie and authenticate its freshly minted
    // bootstrap token against the wrong DB (→ 401 storm).
    const gatewayCommand = e2eTsxCommand("packages/gateway/src/index.ts");
    this.gatewayProcess = spawn(gatewayCommand.command, gatewayCommand.args, {
      env,
      cwd: join(import.meta.dirname, "../../../.."), // monorepo root
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    // Reap this detached group even if the runner dies before stop() runs
    // (e.g. `timeout` SIGTERMs the e2e run) — otherwise the gateway orphans.
    registerSubprocessGroup(this.gatewayProcess);

    // Wait for gateway to be ready AND for the token we read to be
    // accepted by it. Just hitting `/health` isn't enough — a stale
    // gateway from a previous fork could be answering on the same port
    // with a different DB. The `/whoami` round-trip with our token
    // proves we're talking to the right one.
    const startTime = Date.now();
    const timeout = gatewayBootBudgetMs();
    const tokenPath = join(this.configDir, "token");
    while (Date.now() - startTime < timeout) {
      try {
        const health = await fetch(`${this.gatewayUrl}/health`);
        if (!health.ok) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        let token: string;
        try {
          token = readFileSync(tokenPath, "utf-8").trim();
        } catch {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (!token) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        const whoami = await fetch(`${this.gatewayUrl}/whoami`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (whoami.ok) {
          this.apiKey = token;
          return;
        }
      } catch {
        // gateway not reachable yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Gateway did not start (or auth) within ${timeout}ms`);
  }

  private async killGatewaySubprocess(): Promise<void> {
    const proc = this.gatewayProcess;
    if (!proc) return;
    await killSubprocessGroup(proc);
  }
}
