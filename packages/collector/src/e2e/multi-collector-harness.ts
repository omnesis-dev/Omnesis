// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared harness for the multi-collector / multi-account E2E suites.
 *
 * Boots one gateway subprocess and any number of in-test pseudo-collectors.
 * Each pseudo-collector pairs as a real `kind=collector` device, holds an
 * authenticated WS connection, advertises a curated `hostableSourceTypes`
 * list and a curated descriptor set, and answers the source-lifecycle
 * commands the gateway dispatches (`source.add`, `source.discover`,
 * `sources.snapshot`, …) by writing through the real
 * `/devices/sources/bulk-upsert` endpoint.
 *
 * Deliberately no real `SyncEngine`: the suites built on this exercise the
 * registration and dispatch path (resolver → WS command → gateway row). The
 * one document seam is {@link MultiCollectorHarness.pushDocuments}, which
 * pushes hand-built documents as a given collector so attribution and
 * per-contributor behaviour can be asserted without a sync loop; real sync
 * is covered by the `SyntheticE2EHarness` suites.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { GatewayWsClient } from "@omnesis/gateway-client";
import {
  createRecordingUpdater,
  registerSelfUpdateCommand,
  type RecordingUpdater,
} from "../self-update.js";
import { createCommandDispatch } from "../ws-command-dispatch.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import type {
  WsCommandType,
  WsRequestPayload,
  WsResponsePayload,
  WsEventPayload,
} from "@omnesis/core";
import type { DoctorReport } from "@omnesis/core/doctor";
import type { DeviceCapability } from "@omnesis/types";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const CLI_ENTRY = "packages/cli/src/index.ts";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export interface PairedCollector {
  name: string;
  deviceId: string;
  token: string;
  /** Gateway HTTPS base (no trailing slash) — held here so the pseudo-
   *  collector's source.add handler can POST to /devices/sources/bulk-upsert
   *  without spelunking into the WS client's private fields. */
  gatewayBase: string;
  hostableSourceTypes: string[];
  capabilities: DeviceCapability;
  ws: GatewayWsClient;
  /** Synth descriptors this collector advertises to source.descriptors. */
  descriptors: Array<Record<string, unknown>>;
  /** Exact account ids returned by source.discover, keyed by descriptor id. */
  discoveredAccountsByType: Record<string, string[]>;
  /** WS commands the gateway sent this collector — used for routing assertions. */
  receivedCommands: Array<{ type: string; payload: unknown }>;
  /** Configurable acknowledgement for source.sync route coverage. */
  sourceSyncResponse: WsResponsePayload<"source.sync">;
  /** Scripted local doctor output; no real host inspection runs in E2E. */
  doctorResult: Omit<WsEventPayload<"device.doctor.result">, "runId">;
  /** Configurable immediate receipt/refusal for the doctor command. */
  doctorResponse: WsResponsePayload<"device.doctor">;
  /** Delay before the scripted report event, for disconnect/reconnect coverage. */
  doctorResultDelayMs: number;
  /**
   * The self-updater the production `device.update` handler runs against.
   * Recording rather than real, so the whole dispatch path — command,
   * acknowledgement, result event, reconnect — is exercised without a git
   * remote or a build. Set `.answer` to drive the failure arms.
   */
  updater: RecordingUpdater;
  /**
   * Whether the pseudo-collector "exits" after a successful update. Real
   * collectors do, so the gateway's loop closes on the reconnect that
   * follows; a test drives that reconnect itself, so the hand-over is
   * recorded here instead of acted on.
   */
  handedOver: boolean;
  /** Whether this pseudo-collector implements `device.update` at all. */
  selfUpdate: boolean;
}

export interface MultiCollectorHarnessOptions {
  /** Extra process environment for the isolated gateway. Fixed DB/config/port
   * values are applied afterwards and cannot be redirected to live state. */
  extraGatewayEnv?: NodeJS.ProcessEnv;
  /** Optional isolated `omnesis.json` content written before gateway boot. */
  gatewayConfig?: Record<string, unknown>;
}

export class MultiCollectorHarness {
  gatewayPort = 0;
  gatewayUrl = "";
  /** Admin token written by the gateway at boot — used to pair the collectors. */
  bootstrapToken = "";

  private tempDir: string;
  private configDir: string;
  private dbPath: string;
  private gatewayProcess: ChildProcess | null = null;
  private gatewayOutput = "";
  collectors: PairedCollector[] = [];

  constructor(private readonly options: MultiCollectorHarnessOptions = {}) {
    this.tempDir = mkdtempSync(join(tmpdir(), "omnesis-multi-e2e-"));
    this.configDir = join(this.tempDir, "config");
    mkdirSync(this.configDir, { recursive: true });
    this.dbPath = join(this.tempDir, "omnesis-multi.db");
    if (options.gatewayConfig) {
      writeFileSync(
        join(this.configDir, "omnesis.json"),
        JSON.stringify(options.gatewayConfig, null, 2),
      );
    }
  }

  async start(): Promise<void> {
    this.gatewayPort = await getFreePort();
    this.gatewayUrl = `https://localhost:${this.gatewayPort}`;
    await this.startGateway();
  }

  /** Isolated SQLite path for read-only E2E assertions. */
  getDbPath(): string {
    return this.dbPath;
  }

  /** The config dir the gateway owns; a second gateway pointed here must refuse to boot. */
  get gatewayConfigDir(): string {
    return this.configDir;
  }

  /** The PID of the gateway process this harness spawned, or null before boot. */
  get gatewayPid(): number | null {
    return this.gatewayProcess?.pid ?? null;
  }

  /**
   * Stop the gateway and boot it again on the same database, config dir and
   * port, then reconnect every collector. What survives is exactly what the
   * gateway persists: in-memory state such as the sync lease does not.
   * `signal` picks how the old gateway goes: SIGTERM lets it drain and release
   * its stores; SIGKILL leaves them for the replacement to reclaim.
   */
  async restartGateway(opts: { signal?: NodeJS.Signals } = {}): Promise<void> {
    for (const c of this.collectors) {
      try {
        c.ws.disconnect();
      } catch {
        /* best effort */
      }
    }
    await this.killGateway(opts.signal);
    await this.startGateway();
    for (const c of this.collectors) await this.reconnectCollector(c);
  }

  /** Recent isolated gateway output, useful when an E2E request fails. */
  getGatewayOutput(): string {
    return this.gatewayOutput;
  }

  /**
   * Pair a new collector + open a live WS connection that advertises the
   * given `hostableSourceTypes`. Resolves once BOTH ends have finished the
   * handshake — the gateway registers a socket before it answers the hello,
   * so waiting on presence alone returns while the client still refuses to
   * emit events, and a command dispatched in that window loses its result.
   * Stays connected until `destroy()`.
   */
  async addCollector(opts: {
    name: string;
    hostableSourceTypes: string[];
    /** Non-exclusive modes this collector's descriptors declare, announced as the real collector does. */
    multiDeviceModes?: Record<string, "handoff" | "replicated" | "partitioned">;
    /** Announce that the collector claims the sync lease before syncing. */
    syncLease?: boolean;
    /** Set false only to model a collector built before remote doctor support. */
    deviceDoctor?: boolean;
    /**
     * Set false only to model a collector built before the update command:
     * it answers `device.update` with the collector's own unknown-command
     * fallback instead of running the production handler.
     */
    selfUpdate?: boolean;
    /**
     * The product version this pseudo-collector announces, in the pair-time
     * capabilities and in every hello — exactly where a real collector puts
     * it. Omit to announce none, which models a client built before the
     * version ledger existed: the gateway must still pair it and still let it
     * connect, and it reads as `unknown` rather than as a fault.
     */
    version?: string;
    /** Hosted types whose data an external runtime pushes, announced as the real collector does. */
    pushBasedSourceTypes?: string[];
    /**
     * Exact member-local parameter contract per hosted type. Omit to announce
     * an explicit empty contract for every type; pass false only when a test
     * deliberately models a collector predating contract negotiation.
     */
    memberScopedParams?: Record<string, string[]> | false;
    descriptors?: Array<Record<string, unknown>>;
    /** Per-source discovery results. Unspecified types retain the `local` fixture default. */
    discoveredAccountsByType?: Record<string, string[]>;
    doctorReport?: DoctorReport;
    doctorError?: string;
    doctorResponse?: WsResponsePayload<"device.doctor">;
    doctorResultDelayMs?: number;
  }): Promise<PairedCollector> {
    const memberScopedParams =
      opts.memberScopedParams === false
        ? undefined
        : (opts.memberScopedParams ??
          Object.fromEntries(opts.hostableSourceTypes.map((type) => [type, []])));
    // Pair by creating a fresh collector device with a known token. Reuses
    // the production /admin/devices POST path so the capabilities round-trip
    // through the same writer the real collector main.ts uses.
    const res = await fetch(`${this.gatewayUrl}/admin/devices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: opts.name,
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: {
          hostname: `${opts.name}.example.com`,
          platform: "linux",
          ...(opts.version ? { version: opts.version } : {}),
          hostableSourceTypes: opts.hostableSourceTypes,
          ...(opts.multiDeviceModes ? { multiDeviceModes: opts.multiDeviceModes } : {}),
          ...(memberScopedParams ? { memberScopedParams } : {}),
          ...(opts.syncLease ? { syncLease: true } : {}),
          ...(opts.deviceDoctor === false ? {} : { deviceDoctor: true }),
          ...(opts.pushBasedSourceTypes ? { pushBasedSourceTypes: opts.pushBasedSourceTypes } : {}),
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to pair ${opts.name}: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      device: { id: string; name: string };
      token: string;
    };

    // Default descriptor set: minimal — local auth, no params, push-based.
    // Tests can override via opts.descriptors for richer descriptor shapes.
    const descriptors =
      opts.descriptors ??
      opts.hostableSourceTypes.map((type) => ({
        id: type,
        name: type,
        description: `synthetic ${type}`,
        provider: { id: `${type}-provider`, name: `${type}-provider` },
        params: [],
        hasAuthFlow: false,
        hasDiscover: false,
        authType: "local",
        pushBased: true,
        singleInstance: false,
      }));

    // Cast: the test uses ad-hoc synthetic source-type strings
    // ("gmail-synth" etc.) that aren't members of the production
    // SourceType brand. The gateway treats `hostableSourceTypes` as
    // opaque strings at the WS boundary so this is safe.
    const wsCaps: DeviceCapability = {
      hostname: `${opts.name}.example.com`,
      platform: "linux",
      ...(opts.version ? { version: opts.version } : {}),
      hostableSourceTypes: opts.hostableSourceTypes as DeviceCapability["hostableSourceTypes"],
      ...(opts.multiDeviceModes ? { multiDeviceModes: opts.multiDeviceModes } : {}),
      ...(memberScopedParams ? { memberScopedParams } : {}),
      ...(opts.syncLease ? { syncLease: true } : {}),
      ...(opts.deviceDoctor === false ? {} : { deviceDoctor: true }),
      ...(opts.pushBasedSourceTypes
        ? {
            pushBasedSourceTypes:
              opts.pushBasedSourceTypes as DeviceCapability["pushBasedSourceTypes"],
          }
        : {}),
    };
    const collector: PairedCollector = {
      name: body.device.name,
      deviceId: body.device.id,
      token: body.token,
      gatewayBase: this.gatewayUrl,
      hostableSourceTypes: opts.hostableSourceTypes,
      capabilities: wsCaps,
      ws: null as unknown as GatewayWsClient,
      descriptors,
      discoveredAccountsByType: opts.discoveredAccountsByType ?? {},
      receivedCommands: [],
      sourceSyncResponse: { ok: true, triggered: 1 },
      doctorResult: opts.doctorError
        ? { error: opts.doctorError }
        : {
            report: opts.doctorReport ?? {
              ok: true,
              summary: { errors: 0, warnings: 0 },
              checks: [
                {
                  id: "process.event-loop",
                  section: "Process",
                  status: "pass",
                  message: "Collector process is responsive",
                },
              ],
            },
          },
      doctorResponse: opts.doctorResponse ?? { accepted: true },
      doctorResultDelayMs: opts.doctorResultDelayMs ?? 0,
      updater: createRecordingUpdater(),
      handedOver: false,
      selfUpdate: opts.selfUpdate !== false,
    };
    const ws = new GatewayWsClient(this.gatewayUrl, body.token, { capabilities: wsCaps });
    collector.ws = ws;
    attachCommandHandler(collector, ws);
    ws.connect();
    await waitForCondition(
      async () => ws.isAuthenticated() && (await isCollectorOnline(this, collector.deviceId)),
      10_000,
      `WS hello for ${opts.name}`,
    );

    this.collectors.push(collector);
    return collector;
  }

  /**
   * Drop a pseudo-collector's socket and wait until the gateway has actually
   * observed the close.
   *
   * Waiting is the whole point. `reconnectCollector` gates on the device
   * being *online*, which is still true for the moment between a client
   * closing its socket and the gateway processing that close — so a
   * disconnect immediately followed by a reconnect can return while the old
   * handle is still registered and the new hello has not landed. A test that
   * changes what a collector announces and reconnects would then assert
   * against the previous announcement and pass or fail for the wrong reason.
   */
  async disconnectCollector(collector: PairedCollector): Promise<void> {
    collector.ws.disconnect();
    await waitForCondition(
      async () => !(await isCollectorOnline(this, collector.deviceId)),
      10_000,
      `WS close observed for ${collector.name}`,
    );
  }

  /**
   * Model a client that was updated and reconnected: drop its socket, change
   * what it announces, and bring it back up. The gateway sees a fresh hello
   * carrying the new capabilities, which is the only way a device's declared
   * state — its version among them — changes after pairing.
   */
  async reannounceCollector(
    collector: PairedCollector,
    capabilities: DeviceCapability,
  ): Promise<void> {
    await this.disconnectCollector(collector);
    collector.capabilities = capabilities;
    await this.reconnectCollector(collector);
  }

  /** Re-open a pseudo-collector after an explicit disconnect. */
  async reconnectCollector(collector: PairedCollector): Promise<void> {
    // A real collector that handed over to its supervisor comes back as a new
    // process, holding none of what the old one recorded about itself.
    collector.handedOver = false;
    const ws = new GatewayWsClient(collector.gatewayBase, collector.token, {
      capabilities: collector.capabilities,
    });
    collector.ws = ws;
    attachCommandHandler(collector, ws);
    ws.connect();
    await waitForCondition(
      async () => ws.isAuthenticated() && (await isCollectorOnline(this, collector.deviceId)),
      10_000,
      `WS reconnect for ${collector.name}`,
    );
  }

  /** Admin-scoped JSON request using the bootstrap token. */
  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.bootstrapToken}`);
    if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(`${this.gatewayUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* leave as null */
    }
    if (!res.ok) {
      throw Object.assign(new Error(`Gateway ${res.status} ${path}`), {
        status: res.status,
        body: json ?? text,
      });
    }
    return json as T;
  }

  /**
   * Push documents to `POST /documents` as `collector` — with its own device
   * token by default, or with `opts.token` (e.g. a scoped token minted for it)
   * so a test can exercise what the token decides: a `write:<type>` token
   * self-registers an unknown source to the device, a `write:*` one does not.
   * Only `sourceId` and `externalId` are required; the rest gets fictional
   * defaults, with the content hash derived from the content so a re-push
   * with changed content reads as an update.
   */
  async pushDocuments(
    collector: PairedCollector,
    documents: Array<{
      sourceId: string;
      externalId: string;
      title?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    }>,
    opts: { token?: string } = {},
  ): Promise<{ ingested: number }> {
    const nowIso = new Date().toISOString();
    const body = documents.map((d) => {
      const content = d.content ?? "synthetic document content";
      return {
        providerId: d.sourceId,
        sourceId: d.sourceId,
        externalId: d.externalId,
        title: d.title ?? "Synthetic document",
        content,
        contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        metadata: d.metadata ?? {},
        sourceCreatedAt: nowIso,
        sourceUpdatedAt: nowIso,
      };
    });
    const res = await fetch(`${collector.gatewayBase}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token ?? collector.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ documents: body }),
    });
    if (!res.ok) {
      throw new Error(`push as ${collector.name} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { ingested: number };
  }

  async destroy(): Promise<void> {
    for (const c of this.collectors) {
      try {
        c.ws.disconnect();
      } catch {
        /* best effort */
      }
    }
    await this.killGateway();
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Run the CLI as a subprocess pointing at this gateway. Resolves with the
   * exit code + outputs regardless of success/failure (caller asserts). */
  async runCli(
    args: string[],
    opts: { token?: string; extraEnv?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OMNESIS_GATEWAY_URL: this.gatewayUrl,
      OMNESIS_TOKEN: opts.token ?? this.bootstrapToken,
      // Keep the CLI's TOFU preflight inside the harness. The isolated gateway
      // wrote its certificate here; falling back to the operator's default
      // config makes the test depend on unrelated host trust state.
      OMNESIS_CONFIG_DIR: this.configDir,
      NO_COLOR: "1",
      CI: "1",
      ...(opts.extraEnv ?? {}),
    };
    // The parent harness disables verification for its in-process pseudo
    // collectors. Do not leak that bypass into the CLI subprocess: its TOFU
    // preflight must prove the isolated gateway certificate is sufficient.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete env.NODE_EXTRA_CA_CERTS;
    delete env.OMNESIS_INSECURE_TLS;
    try {
      const { stdout, stderr } = await execFileAsync("npx", ["tsx", CLI_ENTRY, ...args], {
        cwd: REPO_ROOT,
        env,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      return {
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr: typeof e.stderr === "string" ? e.stderr : "",
        exitCode: typeof e.code === "number" ? e.code : Number(e.code ?? -1),
      };
    }
  }

  /**
   * The environment this harness boots its gateway with — the same stores,
   * config dir and port. A test that spawns its own gateway against this
   * harness's directory starts from it, so the only difference is the one
   * the test introduces.
   */
  get gatewayLaunchEnv(): NodeJS.ProcessEnv {
    return {
      ...e2eGatewayEnv(),
      ...(this.options.extraGatewayEnv ?? {}),
      OMNESIS_DB_PATH: this.dbPath,
      OMNESIS_GATEWAY_PORT: String(this.gatewayPort),
      OMNESIS_CONFIG_DIR: this.configDir,
      OMNESIS_LOG_LEVEL: "warn",
      // The gateway exits on its own once this pid disappears — the only
      // defence when the runner is SIGKILLed and no signal can reach it.
      OMNESIS_PARENT_PID: String(process.pid),
    };
  }

  private async startGateway(): Promise<void> {
    const env = this.gatewayLaunchEnv;
    const gatewayCommand = e2eTsxCommand("packages/gateway/src/index.ts");
    this.gatewayProcess = spawn(gatewayCommand.command, gatewayCommand.args, {
      env,
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const recordOutput = (chunk: Buffer | string): void => {
      this.gatewayOutput = `${this.gatewayOutput}${String(chunk)}`.slice(-8_000);
    };
    this.gatewayProcess.stdout?.on("data", recordOutput);
    this.gatewayProcess.stderr?.on("data", recordOutput);
    // Reap this detached group if the runner dies before teardown runs —
    // otherwise the gateway orphans and holds ~1.5 GB indefinitely.
    registerSubprocessGroup(this.gatewayProcess);

    // Same handshake pattern as E2EHarness — wait for /health AND /whoami
    // with our bootstrap token so we're definitely talking to this gateway.
    const startTime = Date.now();
    const timeout = gatewayBootBudgetMs();
    const tokenPath = join(this.configDir, "token");
    while (Date.now() - startTime < timeout) {
      if (this.gatewayProcess?.exitCode !== null || this.gatewayProcess?.signalCode) break;
      try {
        const health = await fetch(`${this.gatewayUrl}/health`);
        if (!health.ok) {
          await sleep(100);
          continue;
        }
        let token: string;
        try {
          token = readFileSync(tokenPath, "utf-8").trim();
        } catch {
          await sleep(100);
          continue;
        }
        if (!token) {
          await sleep(100);
          continue;
        }
        const whoami = await fetch(`${this.gatewayUrl}/whoami`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (whoami.ok) {
          this.bootstrapToken = token;
          return;
        }
      } catch {
        /* not reachable yet */
      }
      await sleep(100);
    }
    const proc = this.gatewayProcess;
    const fate =
      proc?.exitCode !== null && proc?.exitCode !== undefined
        ? `the gateway process exited with code ${proc.exitCode}`
        : proc?.signalCode
          ? `the gateway process was killed by ${proc.signalCode}`
          : "the gateway process was still running — this is the harness giving up on a slow boot, not a gateway that failed";
    const output = this.gatewayOutput.trim();
    throw new Error(
      `The harness stopped waiting for the gateway after ${timeout}ms (the shared boot budget in scripts/lib/gateway-boot-budget.json): ${fate}.${output ? `\nGateway output:\n${output}` : ""}`,
    );
  }

  private async killGateway(signal?: NodeJS.Signals): Promise<void> {
    const proc = this.gatewayProcess;
    if (!proc) return;
    await killSubprocessGroup(proc, signal ? { initialSignal: signal } : {});
  }
}

/**
 * Route gateway → collector commands for one pseudo-collector.
 *
 * `device.update` goes through the collector's **production** handler rather
 * than a test-only branch, with only the updater replaced. That is the point
 * of the port: the acknowledgement, the refusals, the result event and the
 * hand-over are the shipped code, and what a test drives is what would run
 * on a real machine. Everything else falls through to the pseudo responses.
 */
function attachCommandHandler(collector: PairedCollector, ws: GatewayWsClient): void {
  const dispatch = createCommandDispatch();
  if (collector.selfUpdate) {
    registerSelfUpdateCommand(dispatch, {
      updater: collector.updater,
      currentVersion: collector.capabilities.version ?? "",
      acquireLock: () => ({ id: "e2e-update-lock", release: () => {} }),
      emitResult: (payload) => ws.emitEvent("device.update.result", payload),
      // A real collector exits here for its supervisor to restart it. A test
      // drives the reconnect itself, so this only records that it happened.
      handOver: () => {
        collector.handedOver = true;
      },
    });
  }
  dispatch.register("device.doctor", ({ runId }) => {
    const response = collector.doctorResponse;
    if (response.accepted) {
      const emit = () => ws.emitEvent("device.doctor.result", { runId, ...collector.doctorResult });
      if (collector.doctorResultDelayMs > 0) {
        const timer = setTimeout(emit, collector.doctorResultDelayMs);
        timer.unref();
      } else {
        queueMicrotask(emit);
      }
    }
    return response;
  });
  ws.onCommand(async (command) => {
    collector.receivedCommands.push({ type: command.type, payload: command.payload });
    const handled = dispatch.handle(command);
    if (handled !== undefined) return handled;
    // The same fallback the collector's main loop throws for a command it
    // has no handler for, so an older build is answered as one would be.
    if (command.type === "device.update") throw new Error(`Unknown command: ${command.type}`);
    // The WS envelope carries `type` as a plain string; `handlePseudoCommand`
    // keys its response type off the command literal. Narrowing here is the
    // one place that boundary is crossed.
    return handlePseudoCommand(
      collector,
      command.type as WsCommandType,
      command.payload as WsRequestPayload<WsCommandType>,
    );
  });
}

/**
 * Implements the bare-minimum WS responses the gateway expects from a
 * collector for the disambiguation tests. Not a real collector — no sync
 * loops, no documents. For `source.add` we round-trip through the
 * /devices/sources/bulk-upsert HTTP path so the gateway's source row
 * lands with the correct device_id (matches the production wiring).
 */
async function handlePseudoCommand<K extends WsCommandType>(
  c: PairedCollector,
  type: K,
  payload: WsRequestPayload<K>,
): Promise<WsResponsePayload<K>> {
  switch (type) {
    case "source.descriptors": {
      return {
        descriptors: c.descriptors,
        hostname: `${c.name}.example.com`,
      } as unknown as WsResponsePayload<K>;
    }
    case "sources.snapshot":
    case "source.added":
    case "source.removed":
    case "source.updated": {
      return { ok: true, applied: true } as unknown as WsResponsePayload<K>;
    }
    case "sources.snapshot.request": {
      return { configured: {} } as unknown as WsResponsePayload<K>;
    }
    case "source.discover": {
      const descriptorId = (payload as WsRequestPayload<"source.discover">).descriptorId;
      const descriptor = c.descriptors.find((candidate) => candidate.id === descriptorId);
      if (!descriptor) throw new Error(`Unknown source descriptor: ${descriptorId}`);
      if (descriptor.hasDiscover !== true) {
        throw new Error(`Source descriptor does not support discovery: ${descriptorId}`);
      }
      return {
        accounts: Object.hasOwn(c.discoveredAccountsByType, descriptorId)
          ? c.discoveredAccountsByType[descriptorId]
          : ["local"],
      } as unknown as WsResponsePayload<K>;
    }
    case "source.validate-param": {
      return { valid: true } as unknown as WsResponsePayload<K>;
    }
    case "source.add": {
      const p = payload as WsRequestPayload<"source.add">;
      const accountIds = (p as { accountIds: string[] }).accountIds ?? ["local"];
      const descId = (p as { descriptorId: string }).descriptorId;
      const sources = accountIds.map((aid) => ({
        type: descId,
        accountId: aid,
        config: {},
        enabled: true,
      }));
      // Use this collector's own token so /devices/sources/bulk-upsert
      // attributes the rows to it (auth.deviceId is read from the token).
      const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sources }),
      });
      if (!res.ok) {
        throw new Error(`bulk-upsert failed: ${res.status} ${await res.text()}`);
      }
      const result = (await res.json()) as {
        sources: Array<{ id: string }>;
        errors: Array<{ error: string }>;
      };
      // Mirror the real SourceManager contract: a rejected entry (e.g.
      // hosted by another device) fails the add rather than returning
      // empty ids that would read as success.
      if (result.errors.length > 0) {
        throw new Error(result.errors.map((e) => e.error).join("; "));
      }
      return {
        sourceIds: result.sources.map((s) => s.id),
      } as unknown as WsResponsePayload<K>;
    }
    case "source.reauth-finalize": {
      // Pretend every source under this account got refreshed.
      const p = payload as { providerType: string; accountId: string };
      const matching = [`${p.providerType}:${p.accountId}`];
      return { sourceIds: matching } as unknown as WsResponsePayload<K>;
    }
    case "source.sync": {
      return c.sourceSyncResponse as unknown as WsResponsePayload<K>;
    }
    // A real collector spawns a subprocess here. The pseudo-collector only
    // acknowledges, so a test owns what the flow emits and when — which is the
    // point: what is under test is the path from a challenge to a client and
    // back, not the provider that produced it.
    case "auth.begin": {
      return { started: true } as unknown as WsResponsePayload<K>;
    }
    case "auth.answer":
    case "auth.code":
    case "auth.widget-result": {
      return { ok: true } as unknown as WsResponsePayload<K>;
    }
    case "auth.cancel": {
      return { cancelled: true } as unknown as WsResponsePayload<K>;
    }
    default: {
      throw new Error(`pseudo-collector: unhandled WS command ${type}`);
    }
  }
}

export async function getFreePort(): Promise<number> {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForCondition(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

/** Verify a paired device is currently connected via the admin devices route. */
export async function isCollectorOnline(
  h: MultiCollectorHarness,
  deviceId: string,
): Promise<boolean> {
  const { items } = await h.json<{ items: Array<{ id: string; online: boolean }> }>(
    "/admin/devices",
  );
  return items.some((d) => d.id === deviceId && d.online);
}
