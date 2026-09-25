// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E harness for the synthetic-providers framework.
 *
 * Spawns a real gateway subprocess + an in-process collector that loads the
 * synthetic provider packages via the real discovery path. Tests exercise the
 * full sync pipeline (provider → engine → gateway → indexer → search) without
 * needing real OAuth or live external APIs.
 *
 * Differs from E2EHarness in two ways:
 * - No `registerMockSource()`; sources come from `@omnesis/provider-*-synth`
 *   packages, which the collector discovers when `OMNESIS_SYNTHETIC=1`.
 * - Sources are instantiated via `setupSources()` (production path), not
 *   pre-built `RegisteredProvider` objects, so the test exercises the real
 *   definition → descriptor → instance pipeline.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  type SourceOrProviderDefinition,
  type SourceDescriptor,
  type AnalyticsTableSchema,
  type ColumnDefinition,
  type ColumnType,
  type DiscoveredAccount,
  type HistoryCoverage,
} from "@omnesis/source-sdk";
import {
  AccountId,
  SCOPE_ADMIN,
  SCOPE_READ,
  SourceId,
  SourceType,
  defaultScopesForDeviceKind,
  type DeviceCapability,
  type ProviderType,
  type DocumentIngestionContext,
} from "@omnesis/types";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import {
  hostingDeviceKinds,
  loadUniverse,
  sourceHostAssignments,
  type UniverseDeviceEntry,
  type UniverseMultiDeviceMode,
} from "@omnesis/providers-synth-common";
import { createLogger, readSecretTextFile, type SourceConfig } from "@omnesis/core";
import { SyncEngine, type StatusChangeEvent } from "../sync-engine.js";
import { setupSources } from "../source-instantiator.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import {
  startFakeEmbedderServer,
  type FakeEmbedderServer,
  type FakeEmbedderOptions,
} from "./fake-embedder.js";
import {
  startFakeApnsServer,
  type FakeApnsServer,
  type ReceivedApnsPush,
  type StartFakeApnsServerOptions,
} from "./fake-apns.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { gatewayFetch, gatewayJson, type GatewayEndpoint } from "./gateway-request.js";

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

/** Map a JS runtime value to the closest DuckDB analytics column type. */
function inferColumnType(value: unknown): ColumnType {
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") return Number.isInteger(value) ? "BIGINT" : "DOUBLE";
  return "VARCHAR";
}

/**
 * Build a minimal `AnalyticsTableSchema` from one record so an ad-hoc
 * `pushAnalyticsRow` call can create the DuckDB table. Column types are
 * inferred from the row's values; the chosen primary key (first key by
 * default) is the upsert conflict target.
 */
function inferAnalyticsSchema(
  table: string,
  row: Record<string, unknown>,
  primaryKey?: string[],
): AnalyticsTableSchema {
  const keys = Object.keys(row);
  const columns: ColumnDefinition[] = keys.map((name) => ({
    name,
    type: inferColumnType(row[name]),
    description: name,
    nullable: true,
  }));
  const pk = primaryKey && primaryKey.length > 0 ? primaryKey : keys.length > 0 ? [keys[0]!] : [];
  // Ad-hoc harness rows carry no declared semantic time, so the table is
  // timeless (not citable as a timeline record); the record spec falls back to
  // the primary-key column(s), which are always present.
  return {
    tableName: table,
    displayName: table,
    description: `Synthetic harness table ${table}`,
    columns,
    primaryKey: pk,
    semanticTimeColumn: null,
    record: { titleColumns: pk.length > 0 ? pk : keys, keyColumns: pk.length > 0 ? pk : keys },
  };
}

const log = createLogger("collector").child("e2e-harness");

export interface SynthHarnessStatus {
  sourceId: string;
  state: "idle" | "syncing" | "error" | "disabled";
  lastError?: string;
  [key: string]: unknown;
}

export type SyntheticGatewayMode =
  | "stable"
  | "experimental"
  | "synthetic"
  | "synthetic-experimental";

const GATEWAY_ENV_BY_MODE = {
  stable: { OMNESIS_SYNTHETIC: "0", OMNESIS_EXPERIMENTAL: "0" },
  experimental: { OMNESIS_SYNTHETIC: "0", OMNESIS_EXPERIMENTAL: "1" },
  synthetic: { OMNESIS_SYNTHETIC: "1", OMNESIS_EXPERIMENTAL: "0" },
  "synthetic-experimental": { OMNESIS_SYNTHETIC: "1", OMNESIS_EXPERIMENTAL: "1" },
} as const satisfies Record<
  SyntheticGatewayMode,
  Readonly<Record<"OMNESIS_SYNTHETIC" | "OMNESIS_EXPERIMENTAL", "0" | "1">>
>;

const GATEWAY_MODE_HELP = '"stable", "experimental", "synthetic", or "synthetic-experimental"';

class GatewayModeMismatchError extends Error {}

function requireSyntheticGatewayMode(mode: unknown): SyntheticGatewayMode {
  if (typeof mode !== "string" || !Object.hasOwn(GATEWAY_ENV_BY_MODE, mode)) {
    throw new Error(
      `SyntheticE2EHarness requires an explicit gatewayMode (${GATEWAY_MODE_HELP}); got ${String(mode)}. ` +
        "The spawned gateway cannot inherit feature gates implicitly.",
    );
  }
  return mode as SyntheticGatewayMode;
}

/** Apply the selected child-gateway feature mode after every inherited override. */
export function syntheticGatewayEnv(
  base: NodeJS.ProcessEnv,
  gatewayMode: SyntheticGatewayMode,
): NodeJS.ProcessEnv {
  const mode = requireSyntheticGatewayMode(gatewayMode);
  return { ...base, ...GATEWAY_ENV_BY_MODE[mode] };
}

/** Verify the public health signal before a suite exercises the selected surface. */
export function assertSyntheticGatewayVisibility(
  gatewayMode: SyntheticGatewayMode,
  experimental: unknown,
): void {
  const selected = GATEWAY_ENV_BY_MODE[gatewayMode];
  const expectedExperimental = gatewayMode !== "stable";
  if (experimental !== expectedExperimental) {
    throw new GatewayModeMismatchError(
      `Expected ${gatewayMode} gateway ` +
        `(OMNESIS_SYNTHETIC=${selected.OMNESIS_SYNTHETIC}, ` +
        `OMNESIS_EXPERIMENTAL=${selected.OMNESIS_EXPERIMENTAL}), but ` +
        `/health.experimental=${String(experimental)} — ` +
        "check the harness environment, not the product.",
    );
  }
}

export interface SyntheticHarnessOptions {
  /**
   * Feature mode for the spawned gateway. This is independent of the test
   * worker's `OMNESIS_SYNTHETIC=1`, which exists only for synth-provider
   * discovery. `synthetic` enables test-only controls and therefore still
   * reports `/health.experimental=true`; use `stable` for the ungated path.
   */
  gatewayMode: SyntheticGatewayMode;
  /** Collector locale context to persist on every source-emitted document. */
  ingestionContext?: DocumentIngestionContext;
  /**
   * Synthetic corpus universe to load. Resolved as a name (under
   * `<repoRoot>/evals/universes/<name>/`) or a path. Defaults to `default`
   * (the catch-all universe inherited from `synth-env.ts`).
   */
  universe?: string;
  /**
   * Agent backend to enable on the spawned gateway. Defaults to `"off"`
   * — tests that don't need the agent shouldn't pay the wiring cost.
   * `"replay"` wires the gateway to `<universe>/agent-demos/` (the same
   * directory the demo gateway uses) so scenario routing works out of
   * the box. The universe must declare `agentDemos` for `"replay"` to
   * have anything to load.
   */
  agentBackend?: "off" | "replay";
  /**
   * Embedder backend to wire on the spawned gateway. Defaults to `"off"`
   * — tests that don't exercise semantic search / semantic triggers
   * shouldn't pay the embedder wiring cost. `"fake"` starts a local
   * deterministic embedding server (see `fake-embedder.ts`) BEFORE the
   * gateway boots and assigns it as the gateway's embedder via
   * `inference.backends.fake` + `inference.assignments.embedder`. The
   * server is torn down in `destroy()`.
   */
  embedderBackend?: "off" | "fake";
  /** Options forwarded to `startFakeEmbedderServer` when `embedderBackend === "fake"`. */
  fakeEmbedderOptions?: FakeEmbedderOptions;
  /**
   * APNs backend to wire on the spawned gateway. Defaults to `"off"`.
   * `"fake"` starts a local HTTP/2 (h2c) fake APNs server (see
   * `fake-apns.ts`) BEFORE the gateway boots, writes a throwaway P-256
   * `gateway.apns` block into the gateway's `omnesis.json`, and points
   * `OMNESIS_APNS_BASE_URL` at the fake so the real `Http2ApnsTransport`
   * delivers every push to the fake end-to-end. Register a device with
   * `registerFakeIosDevice()` and read captured pushes with
   * `getApnsPushes()`. The server is torn down in `destroy()`.
   */
  apnsBackend?: "off" | "fake";
  /** Options forwarded to `startFakeApnsServer` when `apnsBackend === "fake"`. */
  fakeApnsOptions?: StartFakeApnsServerOptions;
  /**
   * Transcriber backend to wire on the spawned gateway. Defaults to `"off"`.
   * `"replay"` assigns the deterministic synthetic transcriber
   * (`inference.assignments.transcriber = "replay"`), so
   * `POST /inference/transcribe` returns each request's audio bytes decoded as
   * UTF-8 — no Whisper model or native dependency required.
   */
  transcriberBackend?: "off" | "replay";
  /**
   * OCR backend to wire on the spawned gateway. Defaults to `"off"`.
   * `"replay"` assigns the deterministic synthetic OCR backend
   * (`inference.assignments.ocr = "replay"`), so `POST /inference/ocr` returns
   * each request's image bytes decoded as UTF-8 — no OCR model or native
   * dependency required.
   */
  ocrBackend?: "off" | "replay";
  /**
   * Extra `inference.backends` / `inference.assignments` merged into the
   * spawned gateway's `omnesis.json` on top of whatever the per-backend
   * flags above produce. Lets a caller wire an arbitrary configured backend
   * — e.g. the replay-scenario recorder injecting the operator's real
   * `agent` assignment + its backend definition so the gateway runs the
   * *configured* agent rather than the deterministic replay one. Merged
   * last, so an explicit assignment here overrides a flag-derived one for
   * the same role. The gateway still boots in this harness's isolated
   * config dir, so nothing here touches the operator's live instance.
   */
  extraInference?: {
    backends?: Readonly<Record<string, { type: "http"; url: string } & Record<string, unknown>>>;
    assignments?: Readonly<Record<string, string>>;
    /**
     * Sets `inference.allowRemoteInference` in the spawned gateway's config.
     * Required when a declared backend resolves to a non-loopback address
     * (the inference URL policy refuses remote hosts by default) — e.g. the
     * briefs scorecard's priced cloud lane.
     */
    allowRemoteInference?: boolean;
  };
  /**
   * Extra top-level `omnesis.json` blocks written verbatim into the spawned
   * gateway's config (e.g. `{ brain: { conversationDebounce: "2s" } }` to
   * compress the Cognition Steward's durations for an E2E). The harness-assembled
   * `inference` / `gateway` blocks win over same-named keys here — use
   * `extraInference` / the dedicated backend flags for those two. A callback
   * receives the allocated Gateway URL when a test needs a port-dependent value.
   */
  extraGatewayConfig?:
    | Readonly<Record<string, unknown>>
    | ((context: { gatewayUrl: string }) => Readonly<Record<string, unknown>>);
  /**
   * Explicit environment overrides for the spawned gateway. Applied after the
   * harness's memory-conscious E2E defaults; use when the environment setting
   * itself is part of the behavior under test (for example, worker count).
   */
  extraGatewayEnv?: Readonly<Record<string, string>> & {
    OMNESIS_SYNTHETIC?: never;
    OMNESIS_EXPERIMENTAL?: never;
  };
  /**
   * Documents to ingest immediately after the gateway becomes reachable,
   * before collector source setup. Used to put early-startup pressure on
   * indexing and persistence paths.
   */
  initialDocuments?: readonly PushDocumentInput[];
}

/**
 * Shape accepted by {@link SyntheticE2EHarness.pushDocument}. Every field
 * is optional: the harness fills sensible fictional defaults for the
 * required `DocumentInput` fields and defaults `sourceCreatedAt` /
 * `sourceUpdatedAt` to "now" so the 24h trigger freshness gate passes.
 * Override `externalId` + a changed field (e.g. `content`) to drive a
 * `change` (UPDATE) transition through the EventService.
 */
export interface PushDocumentInput {
  providerId?: string;
  sourceId?: string;
  externalId?: string;
  documentType?: string;
  title?: string;
  content?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
}

/**
 * A universe roster device as paired into the harness's gateway: its gateway
 * identity, the token it pushes with, and the engine that syncs the sources
 * attributed to it.
 */
export interface HarnessDevice {
  /** Roster id from the universe manifest (`macbook`, `iphone`, …). */
  readonly rosterId: string;
  readonly name: string;
  readonly kind: UniverseDeviceEntry["kind"];
  /** Gateway device id. */
  readonly deviceId: string;
  /** The device's own token; every document its sources push carries it. */
  readonly token: string;
  /** `<sourceType>:<accountId>` of every source it hosts, as owner or member. */
  readonly sourceIds: readonly string[];
  /** The sources it owns — the first host of each; the other hosts are members. */
  readonly ownedSourceIds: readonly string[];
  /** The per-source config its engine runs with. */
  readonly sourceConfigs: Readonly<Record<string, SourceConfig>>;
  readonly engine: SyncEngine;
  readonly gateway: HttpGatewayClient;
  /** Production-like control connection for collector-kind roster entries. */
  readonly ws?: GatewayWsClient;
}

/**
 * The definitions with the universe's multi-device modes declared on them:
 * a definition (or a provider's source entry) named in `modes` carries that
 * mode as if it shipped it; every other definition is returned as is.
 */
function withMultiDeviceModes(
  definitions: readonly SourceOrProviderDefinition[],
  modes: Readonly<Record<string, UniverseMultiDeviceMode>>,
): SourceOrProviderDefinition[] {
  if (Object.keys(modes).length === 0) return [...definitions];
  return definitions.map((def) => {
    if (def.type === "source") {
      const mode = modes[def.id];
      return mode ? { ...def, multiDevice: { mode } } : def;
    }
    if (!def.sources.some((s) => modes[s.id])) return def;
    return {
      ...def,
      sources: def.sources.map((s) => {
        const mode = modes[s.id];
        return mode ? { ...s, multiDevice: { mode } } : s;
      }),
    };
  });
}

/**
 * Near-duplicate scheduler config that lets a test drive DF rebuilds.
 *
 * Production rebuilds the DF table when a file-like document has arrived and
 * the table is at least `dfRefreshPeriodMs` old, and otherwise once
 * `dfMaxAgeMs` has passed and the local clock reaches `dfQuietHourLocal`.
 * Only the first of those is usable from a test: the second depends on the
 * wall-clock hour, which a suite neither controls nor stays inside — a run
 * that crosses an hour boundary would stop matching mid-test.
 *
 * So this drops the floor to nothing and leaves the quiet hour at its
 * default. The first rebuild on a fresh database fires regardless (no build
 * exists yet); any later one a test wants is asked for by ingesting a
 * file-like document, which is also the trigger that carries production.
 *
 * Note that the floor is compared against a build time stored in whole
 * seconds, so a rebuild still cannot be asked for in the same second as the
 * build before it.
 *
 * Spread into `extraGatewayConfig.nearDuplicates.scheduler`, alongside
 * whatever compute cadence the caller wants.
 */
export function nearDupRebuildOnAnyFile(): { dfRefreshPeriodMs: number } {
  return { dfRefreshPeriodMs: 1 };
}

export class SyntheticE2EHarness {
  gatewayPort = 0;
  gatewayUrl = "";
  apiKey = "";

  private tempDir: string;
  private configDir: string;
  private dbPath: string;
  private gatewayProcess: ChildProcess | null = null;

  /** Test-only: the current gateway process-group leader PID. */
  get gatewayPid(): number | undefined {
    return this.gatewayProcess?.pid;
  }
  /** The primary roster device's engine — the collector that hosts the polled sources. */
  private engine: SyncEngine | null = null;
  private gateway: HttpGatewayClient | null = null;
  private devices: HarnessDevice[] = [];
  private statusListeners = new Set<(change: StatusChangeEvent, device: HarnessDevice) => void>();
  private allDescriptors: SourceDescriptor[] = [];
  private universe: string;
  private gatewayMode: SyntheticGatewayMode;
  private agentBackend: "off" | "replay";
  private embedderBackend: "off" | "fake";
  private transcriberBackend: "off" | "replay";
  private ocrBackend: "off" | "replay";
  private fakeEmbedderOptions: FakeEmbedderOptions;
  private fakeEmbedder: FakeEmbedderServer | null = null;
  private apnsBackend: "off" | "fake";
  private fakeApnsOptions: StartFakeApnsServerOptions;
  private fakeApns: FakeApnsServer | null = null;
  private extraInference?: SyntheticHarnessOptions["extraInference"];
  private extraGatewayConfig?: SyntheticHarnessOptions["extraGatewayConfig"];
  private extraGatewayEnv?: SyntheticHarnessOptions["extraGatewayEnv"];
  private initialDocuments: readonly PushDocumentInput[];
  private ingestionContext?: DocumentIngestionContext;

  constructor(opts: SyntheticHarnessOptions) {
    if (!opts) requireSyntheticGatewayMode(undefined);
    this.gatewayMode = requireSyntheticGatewayMode(opts.gatewayMode);
    for (const key of ["OMNESIS_SYNTHETIC", "OMNESIS_EXPERIMENTAL"] as const) {
      if (opts.extraGatewayEnv && Object.hasOwn(opts.extraGatewayEnv, key)) {
        throw new Error(
          `SyntheticE2EHarness.extraGatewayEnv cannot set ${key}; use gatewayMode instead.`,
        );
      }
    }
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    this.tempDir = mkdtempSync(join(tmpdir(), "omnesis-synth-e2e-"));
    this.configDir = join(this.tempDir, "config");
    mkdirSync(this.configDir, { recursive: true });
    this.dbPath = join(this.tempDir, "omnesis-synth-e2e.db");
    this.universe = opts.universe ?? process.env.OMNESIS_SYNTH_UNIVERSE ?? "default";
    this.agentBackend = opts.agentBackend ?? "off";
    this.embedderBackend = opts.embedderBackend ?? "off";
    this.transcriberBackend = opts.transcriberBackend ?? "off";
    this.ocrBackend = opts.ocrBackend ?? "off";
    this.fakeEmbedderOptions = opts.fakeEmbedderOptions ?? {};
    this.apnsBackend = opts.apnsBackend ?? "off";
    this.fakeApnsOptions = opts.fakeApnsOptions ?? {};
    this.extraInference = opts.extraInference;
    this.extraGatewayConfig = opts.extraGatewayConfig;
    this.extraGatewayEnv = opts.extraGatewayEnv;
    this.initialDocuments = opts.initialDocuments ?? [];
    this.ingestionContext = opts.ingestionContext;
    // Set the env var before any synth-side module reads it. The provider
    // packages cache the active universe on first call, so this needs to
    // happen before the harness's dynamic source-descriptors import.
    process.env.OMNESIS_SYNTH_UNIVERSE = this.universe;
  }

  async start(): Promise<void> {
    if (process.env.OMNESIS_SYNTHETIC !== "1") {
      throw new Error(
        "SyntheticE2EHarness requires OMNESIS_SYNTHETIC=1 in the test env so the collector's discovery loop loads synth packages.",
      );
    }

    // Dynamic import — must happen after OMNESIS_SYNTHETIC is set, because
    // source-descriptors.ts runs discovery via top-level await on module load.
    // The env var is set by vitest before this file is imported in synth tests,
    // so by the time we reach this dynamic import the env is already in place
    // — but a dynamic import preserves the intent that the test owns the
    // ordering rather than relying on static import side-effects.
    const mod = (await import("../source-descriptors.js")) as {
      allDefinitions: SourceOrProviderDefinition[];
      extractDescriptors: (def: SourceOrProviderDefinition) => SourceDescriptor[];
    };
    // The universe's `multiDeviceModes` stand in for the modes its descriptors
    // would declare: each named descriptor's definition carries the mode, so
    // the collector reads it where it reads a shipped one — the sources it
    // registers sync under that mode and its pairing announces it.
    const manifest = loadUniverse(this.universe).manifest;
    const allDefinitions = withMultiDeviceModes(
      mod.allDefinitions,
      manifest.multiDeviceModes ?? {},
    );
    const allDescriptors = allDefinitions.flatMap((def) => mod.extractDescriptors(def));
    this.allDescriptors = allDescriptors;

    if (allDefinitions.length === 0) {
      throw new Error(
        "SyntheticE2EHarness: discovery loaded zero synth definitions. Is the worktree missing the @omnesis/provider-*-synth symlinks?",
      );
    }

    // Build the source-config map by running each descriptor's discover().
    // Each synth descriptor returns a fixed reserved identity (e.g. john.smith@example.com).
    //
    // A focused single-source universe (e.g. the #586 whatsapp-only ones) ships
    // fixtures for only its source; the other synth providers' `discover()` may
    // eagerly read a fixture this universe doesn't carry and throw. That's not
    // an error — that source simply has no accounts in this universe — so skip
    // it rather than failing the whole boot. The full multi-source universes
    // (default / e2e-minimal) ship every fixture, so nothing is skipped there.
    const sourceConfigs: Record<string, SourceConfig> = {};
    for (const desc of allDescriptors) {
      let accounts: DiscoveredAccount[];
      try {
        accounts = (await desc.discover?.()) ?? [];
      } catch {
        continue;
      }
      for (const { id: aid } of accounts) {
        sourceConfigs[`${String(desc.id)}:${String(aid)}`] = { enabled: true };
      }
    }

    const defaultSyncInterval = "999999s";

    // Start the optional fake backends BEFORE the gateway so their URLs
    // are available to bake into the gateway's omnesis.json + env.
    if (this.embedderBackend === "fake") {
      this.fakeEmbedder = await startFakeEmbedderServer(this.fakeEmbedderOptions);
    }
    if (this.apnsBackend === "fake") {
      this.fakeApns = await startFakeApnsServer(this.fakeApnsOptions);
    }

    this.gatewayPort = await getFreePort();
    this.gatewayUrl = `https://localhost:${this.gatewayPort}`;
    await this.startGateway();
    if (this.initialDocuments.length > 0) {
      await this.pushDocuments([...this.initialDocuments]);
    }

    const sourceToProvider = new Map<SourceType, ProviderType>();
    for (const desc of allDescriptors) {
      sourceToProvider.set(desc.id, desc.provider.id);
    }

    // Every source syncs as the roster device the universe attributes it to:
    // each device pairs into the gateway under its own name and token, runs
    // its own engine over its own sources, and registers those sources as
    // its own — so every synthetic document is pushed by a device the
    // gateway knows. The manifest maps `<descriptorId>:<accountId>`; a
    // discovered account the manifest doesn't list falls back to whichever
    // device hosts that descriptor, then to the primary collector — loudly —
    // and is left out entirely when no roster device of a kind that can host
    // the type exists (a twin whose `discover()` answers without fixtures).
    const hostAssignments = sourceHostAssignments(manifest);
    const byDescriptor = new Map<string, UniverseDeviceEntry>();
    for (const src of manifest.sources) {
      const device = manifest.devices.find((d) => d.id === src.device);
      if (device && !byDescriptor.has(src.descriptorId)) byDescriptor.set(src.descriptorId, device);
    }
    const primary = manifest.devices.find((d) => d.kind === "collector") ?? manifest.devices[0];
    if (!primary) throw new Error(`Universe ${this.universe} declares no devices`);
    const sourcesByDevice = new Map<string, Record<string, SourceConfig>>(
      manifest.devices.map((d) => [d.id, {}]),
    );
    const ownedByDevice = new Map<string, string[]>(manifest.devices.map((d) => [d.id, []]));
    for (const [sourceId, sourceConfig] of Object.entries(sourceConfigs)) {
      const type = sourceId.slice(0, sourceId.indexOf(":"));
      let hosts = hostAssignments.get(sourceId);
      if (!hosts) {
        const hostKinds = hostingDeviceKinds(type);
        const device =
          byDescriptor.get(type) ??
          (hostKinds.length === 0
            ? primary
            : manifest.devices.find((d) => hostKinds.includes(d.kind)));
        if (!device) {
          log.warn(
            `Universe ${this.universe} lists no device for ${sourceId} and none of its devices can host ${type}; leaving it out`,
          );
          continue;
        }
        log.warn(
          `Universe ${this.universe} lists no device for ${sourceId}; syncing it as "${device.id}"`,
        );
        hosts = [device];
      }
      // Every host syncs the source; the first host registers it and owns
      // it, the others join it as members.
      for (const host of hosts) {
        sourcesByDevice.get(host.id)![sourceId] = {
          ...sourceConfig,
          params: {
            ...sourceConfig.params,
            // Synth twins may use this generic, test-only context to model
            // distinct local stores while preserving cross-host identities.
            __syntheticDeviceId: host.id,
          },
        };
      }
      ownedByDevice.get(hosts[0]!.id)!.push(sourceId);
    }

    // The modes the universe's hosts announce, the way a real host declares
    // the storage contract of the source it is about to create. Persisted
    // source modes are pinned from that creating device, so letting only a
    // sibling collector announce a phone-hosted source's synthetic override
    // would incorrectly create the row as exclusive.
    const announcedModes: Record<string, UniverseMultiDeviceMode> = {};
    const announcedMemberScopedParams: Record<string, string[]> = {};
    const announcedReplicaVersionPolicies: Record<string, "source-updated-at"> = {};
    for (const d of allDescriptors) {
      if (d.multiDevice && d.multiDevice.mode !== "exclusive") {
        announcedModes[String(d.id)] = d.multiDevice.mode;
      }
      if (d.multiDevice?.replicaVersionPolicy) {
        announcedReplicaVersionPolicies[String(d.id)] = d.multiDevice.replicaVersionPolicy;
      }
      // The formula a real collector uses, not a re-derivation of it. A
      // harness that computes this differently agrees with production only
      // while no source declares an advanced member-scoped setting, and then
      // stops covering the contract it exists to cover — silently.
      announcedMemberScopedParams[String(d.id)] = d.memberScopedParamNames ?? [];
    }

    let primaryDevice: HarnessDevice | null = null;
    const dispatch = (change: StatusChangeEvent, device: HarnessDevice): void => {
      for (const handler of this.statusListeners) {
        try {
          handler(change, device);
        } catch {
          /* don't let one listener break others */
        }
      }
    };
    for (const entry of manifest.devices) {
      const deviceSources = sourcesByDevice.get(entry.id) ?? {};
      const sourceIds = Object.keys(deviceSources);
      const hostableSourceTypes = [...new Set(sourceIds.map((id) => id.slice(0, id.indexOf(":"))))];
      const hostedModes = Object.fromEntries(
        hostableSourceTypes.flatMap((type) =>
          announcedModes[type] ? [[type, announcedModes[type]]] : [],
        ),
      );
      const hostedMemberScopedParams = Object.fromEntries(
        hostableSourceTypes.map((type) => [type, announcedMemberScopedParams[type] ?? []]),
      );
      // The scopes the kind really pairs with: a phone pushes with
      // `write:<its hosted types>`, a collector with `write:*`. The primary
      // collector also drives the gateway registries, which need admin.
      const scopes = [
        ...new Set([...defaultScopesForDeviceKind(entry.kind), SCOPE_ADMIN, SCOPE_READ]),
      ];
      // Lease-backed modes are only honored from a host that also announces
      // the lease capability, whatever its kind — a phone hosting a
      // replicated source announces it exactly as a collector does. The
      // replica version policy travels with the descriptor that declares it,
      // the way every shipped host derives its own announcement.
      const hostsLeaseBackedMode = Object.values(hostedModes).some(
        (mode) => mode === "handoff" || mode === "replicated",
      );
      const replicaVersionPolicies = Object.fromEntries(
        hostableSourceTypes.flatMap((type) =>
          announcedReplicaVersionPolicies[type]
            ? [[type, announcedReplicaVersionPolicies[type]] as const]
            : [],
        ),
      );
      const capabilities = {
        hostname: `${entry.id}.example.com`,
        platform: entry.kind === "collector" ? process.platform : entry.kind,
        hostableSourceTypes: hostableSourceTypes.map(SourceType),
        ...(entry.kind === "collector" || hostsLeaseBackedMode ? { syncLease: true } : {}),
        ...(Object.keys(hostedModes).length > 0 ? { multiDeviceModes: hostedModes } : {}),
        ...(Object.keys(replicaVersionPolicies).length > 0 ? { replicaVersionPolicies } : {}),
        ...(entry.kind === "collector" ? { memberScopedParams: hostedMemberScopedParams } : {}),
      };
      const created = await this.gatewayJson<{ device: { id: string }; token: string }>(
        "/admin/devices",
        {
          method: "POST",
          body: JSON.stringify({
            name: entry.name,
            kind: entry.kind,
            scopes,
            // A collector pairs as the real one does: it syncs under the
            // gateway's sync lease. Every synthetic host announces the modes
            // this universe assigned to the source types it actually hosts.
            capabilities,
          }),
        },
      );
      if (!created?.device?.id || !created.token) {
        throw new Error(`Pairing roster device "${entry.id}" failed: ${JSON.stringify(created)}`);
      }
      const gateway = new HttpGatewayClient(this.gatewayUrl, created.token);
      const engine = new SyncEngine(gateway, { ingestionContext: this.ingestionContext });
      const setupFailures = await setupSources(
        {
          definitions: allDefinitions,
          descriptors: allDescriptors,
          sourceToProvider,
          config: { sources: deviceSources, defaultSyncInterval },
          gateway,
          engine,
          // Give every source a writable home isolated to this harness's temp
          // dir — the wraps-real WhatsApp twin roots the real provider's
          // store.db + Baileys auth state under `<configDir>/whatsapp/<account>`.
          configDir: this.configDir,
          ingestionContext: this.ingestionContext,
        },
        deviceSources,
      );
      // A seed source that fails to instantiate produces an empty corpus and a
      // test that fails somewhere far from the cause. Name it here instead.
      for (const failure of setupFailures) {
        log.error(`Universe source ${failure.key} did not instantiate: ${failure.error}`);
      }
      let ws: GatewayWsClient | undefined;
      if (entry.kind === "collector") {
        ws = new GatewayWsClient(this.gatewayUrl, created.token, { capabilities });
        ws.onCommand(async (command) => {
          if (command.type === "sources.snapshot") return { ok: true, applied: true };
          throw new Error(`Unsupported synthetic harness command: ${command.type}`);
        });
        ws.connect();
        await this.waitForDeviceOnline(created.device.id);
      }
      const device: HarnessDevice = {
        rosterId: entry.id,
        name: entry.name,
        kind: entry.kind,
        deviceId: created.device.id,
        token: created.token,
        sourceIds,
        ownedSourceIds: ownedByDevice.get(entry.id) ?? [],
        sourceConfigs: deviceSources,
        engine,
        gateway,
        ...(ws ? { ws } : {}),
      };
      engine.onStatusChange((change) => dispatch(change, device));
      this.devices.push(device);
      if (entry.id === primary.id) primaryDevice = device;
    }
    if (!primaryDevice) throw new Error(`Primary roster device "${primary.id}" was not paired`);

    // Register the rows as the devices that sync them — what the real
    // collector's SourceManager does at startup — so `/admin/sources`
    // attributes each source to its hosts. Owners go first, so a source's
    // first registration creates it; a member's registration then joins it.
    const register = async (device: HarnessDevice, ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) return;
      const registered = await device.gateway.bulkUpsertSources(
        ids.map((id) => {
          const sep = id.indexOf(":");
          return {
            type: SourceType(id.slice(0, sep)),
            accountId: AccountId(id.slice(sep + 1)),
            enabled: true,
          };
        }),
      );
      if (registered.errors.length > 0) {
        throw new Error(
          `Registering sources for roster device "${device.rosterId}" failed: ${registered.errors.map((e) => e.error).join("; ")}`,
        );
      }
    };
    for (const device of this.devices) await register(device, device.ownedSourceIds);
    for (const device of this.devices) {
      await register(
        device,
        device.sourceIds.filter((id) => !device.ownedSourceIds.includes(id)),
      );
    }
    this.gateway = primaryDevice.gateway;
    this.engine = primaryDevice.engine;

    // Mirror the per-source descriptor pushes that `main.ts` fires
    // after `applySourcesSnapshot` returns in the real collector.
    // The synthetic harness bypasses the WS sources-snapshot protocol
    // — provider registration happens via `setupSources()` directly —
    // so these wouldn't otherwise run, and E2Es that depend on the
    // gateway-side registries (e.g. graph-url-hub.e2e) would see an
    // empty registry until something else pushed. Awaited so the
    // beforeAll's "harness ready" deadline includes registration.
    // The older descriptor registries are replace-all, so they take the union
    // of every device's sources in one push. Link declarations are different:
    // readiness is tracked per live collector, so each collector must publish
    // a complete atomic generation through its own device token.
    const everySource = this.devices.flatMap((d) => d.engine.registeredSources());
    await this.engine.pushSourcePriorDefaults(everySource);
    await this.engine.pushSelfIdentitySources(everySource);
    // The known-url-pattern push (#668) sources from the full definition
    // set rather than the registry of added sources, so it lives on
    // `SourceManager` in production; mirror it here via the shared helper.
    // Imported lazily (not at module top): `source-manager.js` statically
    // pulls in `source-descriptors.js`, which discovers providers via
    // top-level await on load — a static import here would run that discovery
    // before the constructor sets `OMNESIS_SYNTH_UNIVERSE`, caching the
    // `default` universe and making non-default-universe E2Es read the wrong
    // fixtures. By now the dynamic source-descriptors import above has already
    // run discovery against the correct universe.
    const {
      collectDocumentEventProfiles,
      collectKnownUrlPatterns,
      collectOwnedWebDomains,
      collectWidgetOrigins,
      collectWidgetRenderers,
    } = await import("../source-manager.js");
    const knownUrlPatterns = collectKnownUrlPatterns(allDefinitions);
    for (const device of this.devices) {
      if (device.kind !== "collector") continue;
      await device.engine.pushLinkDeclarations(knownUrlPatterns);
    }
    await this.gateway.setOwnedWebDomains(collectOwnedWebDomains(allDefinitions));
    // Under OMNESIS_SYNTHETIC=1 this carries only the profiles of synth twins
    // that spread their real provider's source entries; twins that redeclare
    // their sources publish none. See #1561.
    await this.gateway.setDocumentEventProfiles(collectDocumentEventProfiles(allDefinitions));
    await this.gateway.setWidgetOrigins(collectWidgetOrigins(allDefinitions));
    await this.gateway.setWidgetRenderers(collectWidgetRenderers(allDefinitions));

    // Skip the boot-time staggered initial sync — at `staggerMs=3000`
    // with 19 synth sources it burns ~54s before `start()` returns,
    // eating into per-test `beforeAll` budgets (60–180s) and producing
    // deterministic hook-timeout flakes. Tests trigger syncs explicitly
    // via `triggerSyncAndWait`, so the initial sync is redundant here.
    for (const device of this.devices) {
      await device.engine.startSyncLoop(
        { sources: device.sourceConfigs, defaultSyncInterval },
        { skipInitialSync: true },
      );
    }
  }

  /**
   * Stop every roster device's sync loop and wait for their in-flight syncs
   * to settle. `inflight` sums the syncs that were running; `timedOut` is set
   * if any device failed to drain within `timeoutMs`.
   */
  async stopSyncLoopsAndDrain(
    timeoutMs = 30_000,
  ): Promise<{ inflight: number; timedOut: boolean }> {
    const results = await Promise.all(
      this.devices.map((d) => d.engine.stopSyncLoopAndDrain(timeoutMs)),
    );
    return {
      inflight: results.reduce((sum, r) => sum + r.inflight, 0),
      timedOut: results.some((r) => r.timedOut),
    };
  }

  /** The universe's roster devices as paired into this gateway. */
  getDevices(): readonly HarnessDevice[] {
    if (this.devices.length === 0) throw new Error("Harness not started");
    return this.devices;
  }

  /** The roster device that owns `sourceId` — its first host. */
  deviceForSource(sourceId: string): HarnessDevice {
    const device = this.devices.find((d) => d.ownedSourceIds.includes(sourceId));
    if (!device) throw new Error(`No roster device hosts ${sourceId}`);
    return device;
  }

  /** Every roster device hosting `sourceId`: the owner, then its members. */
  devicesForSource(sourceId: string): readonly HarnessDevice[] {
    const owner = this.deviceForSource(sourceId);
    return [owner, ...this.devices.filter((d) => d !== owner && d.sourceIds.includes(sourceId))];
  }

  /** Source descriptors that the discovery loop produced. */
  getDescriptors(): SourceDescriptor[] {
    return this.allDescriptors;
  }

  /** All registered sourceIds in the form `<sourceType>:<accountId>`, across every roster device. */
  getSourceIds(): string[] {
    if (!this.engine) throw new Error("Harness not started");
    return [...new Set(this.devices.flatMap((d) => d.engine.getStatuses().map((s) => s.sourceId)))];
  }

  getStatus(): { statuses: SynthHarnessStatus[] } {
    if (!this.engine) throw new Error("Harness not started");
    return {
      statuses: this.devices.flatMap(
        (d) => d.engine.getStatuses() as unknown as SynthHarnessStatus[],
      ),
    };
  }

  /** Trigger on every roster device's engine; the pattern decides which sources match. */
  triggerSync(pattern: string): {
    triggered: string[];
    skipped: string[];
    disabled: string[];
    error?: string;
  } {
    if (!this.engine) throw new Error("Harness not started");
    const merged: { triggered: string[]; skipped: string[]; disabled: string[]; error?: string } = {
      triggered: [],
      skipped: [],
      disabled: [],
    };
    for (const device of this.devices) {
      const result = device.engine.triggerSync(pattern);
      merged.triggered.push(...result.triggered);
      merged.skipped.push(...result.skipped);
      merged.disabled.push(...result.disabled);
    }
    // An engine that hosts none of the matching sources reports "no match";
    // that is only an error when no engine matched anything.
    if (merged.triggered.length + merged.skipped.length + merged.disabled.length === 0) {
      merged.error = `No sources match: ${pattern}`;
    }
    return merged;
  }

  /**
   * Trigger `sourceId` and wait for every host's sync to settle — or, with
   * `device`, on that one host only.
   */
  async triggerSyncAndWait(
    sourceId: string,
    timeout = 30000,
    device?: HarnessDevice,
  ): Promise<void> {
    if (device) {
      const result = device.engine.triggerSync(sourceId);
      if (result.triggered.length === 0) {
        throw new Error(`Roster device "${device.rosterId}" does not sync ${sourceId}`);
      }
    } else {
      this.triggerSync(sourceId);
    }
    await this.waitForSyncComplete(sourceId, timeout, device);
  }

  /**
   * Run one concurrent bootstrap across every source registered in this
   * harness. Full synthetic universes deliberately exercise all providers at
   * once, so their long tail shares a larger default budget than a focused
   * single-source sync.
   */
  async syncAllSources(timeout = 90_000): Promise<void> {
    await Promise.all(this.getSourceIds().map((id) => this.triggerSyncAndWait(id, timeout)));
  }

  /**
   * Observe every roster device's status events; returns the unsubscribe.
   * A test that expects a tick to report nothing (a handoff member's tick
   * while another device holds the lease) records what arrives here.
   */
  onStatusChange(listener: (change: StatusChangeEvent, device: HarnessDevice) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Trigger a sync and return the coverage the source settled on.
   *
   * Read from the durable claim rather than the progress meter. The meter is
   * cleared on completion, so a test sampling it is watching the source think
   * rather than reading what it concluded — and would miss a source whose
   * final page revises the claim, which is the case worth testing. The
   * in-flight meter is still consulted as a fallback, so a source that reports
   * coverage only mid-run is observable too. The synth harness drives status
   * purely in-process (it has no WS status channel to the gateway), so this is
   * how a test reads a source's coverage signal.
   */
  async triggerSyncAndCaptureCoverage(
    sourceId: string,
    timeout = 30000,
  ): Promise<HistoryCoverage | undefined> {
    let coverage: HistoryCoverage | undefined;
    const capture = (change: StatusChangeEvent): void => {
      if (change.sourceId !== sourceId) return;
      const c = change.status.coverage ?? change.status.progress?.coverage;
      if (c) coverage = c;
    };
    this.statusListeners.add(capture);
    try {
      await this.triggerSyncAndWait(sourceId, timeout);
    } finally {
      this.statusListeners.delete(capture);
    }
    return coverage;
  }

  /**
   * Resolve once every host of `sourceId` has reported a completed or failed
   * sync (a replicated source syncs on each member), or once the one
   * `device` has. The hosts are the roster's: a test that detached a host
   * mid-run passes the device it still expects to sync. A source no roster
   * device hosts resolves on the first report.
   */
  async waitForSyncComplete(
    sourceId: string,
    timeout = 30000,
    device?: HarnessDevice,
  ): Promise<void> {
    if (!this.engine) throw new Error("Harness not started");
    const hosts = device ? [device] : this.devices.filter((d) => d.sourceIds.includes(sourceId));
    const pending = new Set(hosts.map((h) => h.rosterId));
    return new Promise((resolve, reject) => {
      const handler = (change: StatusChangeEvent, from: HarnessDevice): void => {
        if (change.sourceId !== sourceId) return;
        if (change.event !== "sync.completed" && change.event !== "sync.error") return;
        pending.delete(from.rosterId);
        if (pending.size > 0) return;
        clearTimeout(timer);
        this.statusListeners.delete(handler);
        resolve();
      };
      const timer = setTimeout(() => {
        this.statusListeners.delete(handler);
        reject(new Error(`Sync for ${sourceId} did not complete within ${timeout}ms`));
      }, timeout);
      this.statusListeners.add(handler);
    });
  }

  /** The primary roster device's engine (the collector hosting the polled sources). */
  getEngine(): SyncEngine {
    if (!this.engine) throw new Error("Harness not started");
    return this.engine;
  }

  /**
   * Absolute path to the spawned gateway's SQLite database. Tests that
   * need to inspect tables not exposed via HTTP (e.g. `document_links`
   * for citation-edge assertions) open a read-only connection against
   * this path.
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /** Absolute path to the gateway's `<configDir>/conversations/` dir. */
  getConversationsDir(): string {
    return join(this.configDir, "conversations");
  }

  /**
   * Absolute path to the spawned gateway's config dir. Tests that seed
   * filesystem artifacts the gateway reads from there (e.g. Cognition Steward
   * run transcripts under `briefs/transcripts/`) build paths off this.
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Absolute path to the spawned gateway's log file, for tests asserting on
   * what boot said. The only record of a subsystem that refused to start is
   * the line it logged on the way past.
   */
  getGatewayLogPath(): string {
    return join(this.tempDir, "gateway.log");
  }

  getGatewayClient(): HttpGatewayClient {
    if (!this.gateway) throw new Error("Harness not started");
    return this.gateway;
  }

  /**
   * Force the gateway's search snapshot to advance to the WAL head. The
   * pipeline reads from a long-running `BEGIN` snapshot on `index.db` that
   * normally refreshes every 10 minutes — without this nudge, chunks
   * indexed *after* gateway boot are invisible to BM25 + vector search.
   * Call after sync if your test queries `/search`.
   */
  async refreshSearchSnapshot(): Promise<void> {
    const res = await fetch(`${this.gatewayUrl}/admin/search-snapshot/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`refreshSearchSnapshot: gateway returned ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Rewrite the embedder assignment in the running gateway's `omnesis.json`,
   * the way an operator changing the model in the portal/CLI does. The
   * gateway's ConfigStore watches that file (debounced) and, on a resolved
   * embedder-identity change, drives `applyEmbedSwap` — so this is how an E2E
   * triggers a live embedder swap without a restart. The target backend must
   * already be declared in `extraInference.backends` at boot; `assignment` is
   * the `"<backend>/<model>"` string pointing at it (the model id may itself
   * contain slashes — only the first segment is the backend key). The new
   * inference block is merged over the existing one so other assignments
   * (agent/transcriber/…) are preserved.
   */
  setEmbedderAssignment(assignment: string): void {
    const path = join(this.configDir, "omnesis.json");
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      inference?: { backends?: Record<string, unknown>; assignments?: Record<string, string> };
    };
    cfg.inference ??= {};
    cfg.inference.assignments ??= {};
    cfg.inference.assignments.embedder = assignment;
    writeFileSync(path, JSON.stringify(cfg, null, 2));
  }

  /**
   * Stop and re-spawn the gateway subprocess against the SAME config dir + DBs,
   * the way a real operator restart does. The on-disk `index.db` / `index.usearch`
   * persist, so the versioned-index adopt-in-place migration runs on the fresh
   * boot — this is how an E2E gets a complete, adopted `active` generation
   * (the precondition the graceful double-buffered swap requires) without
   * mutating internal state. `omnesis.json` is re-assembled from the harness's
   * configured backends, so call this BEFORE any runtime `setEmbedderAssignment`.
   */
  async restartGateway(
    optionsOrWhileStopped:
      | {
          whileStopped?: () => void | Promise<void>;
          gatewayMode?: SyntheticGatewayMode;
        }
      | (() => void | Promise<void>) = {},
  ): Promise<void> {
    const options =
      typeof optionsOrWhileStopped === "function"
        ? { whileStopped: optionsOrWhileStopped }
        : optionsOrWhileStopped;
    const gatewayMode =
      options.gatewayMode === undefined
        ? this.gatewayMode
        : requireSyntheticGatewayMode(options.gatewayMode);
    // Quiesce the collector's background activity first: with the gateway about
    // to disappear, a scheduled sync / push / status emit mid-flight would hit a
    // dead socket and surface as an unhandled rejection. The test drives the
    // gateway directly over HTTP after the restart, so the sync loop is not
    // needed again.
    for (const device of this.devices) device.engine.stopSyncLoop();
    await this.killGatewaySubprocess();
    // Wait until the old gateway is truly unreachable before rebinding the port.
    // Otherwise startGateway's readiness probe can latch onto an instance that is
    // still answering mid-shutdown, and the caller would measure the OLD process
    // (the new one may even fail to bind the port behind it).
    await this.waitForGatewayDown();
    await options.whileStopped?.();
    this.gatewayMode = gatewayMode;
    await this.startGateway();
    this.gateway = new HttpGatewayClient(this.gatewayUrl, this.apiKey);
  }

  /** Poll `/health` until it stops answering (the prior process has exited). */
  private async waitForGatewayDown(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(`${this.gatewayUrl}/health`);
      } catch {
        return; // connection refused → port free → old gateway gone
      }
      await new Promise((r) => setTimeout(r, 50));
    }
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
   * Inject a single document straight into the gateway via `POST /documents`,
   * bypassing the sync pipeline. Required fields get fictional defaults and
   * `sourceCreatedAt` / `sourceUpdatedAt` default to NOW so the 24h trigger
   * freshness gate passes. To drive a `change` (UPDATE) transition through
   * the EventService, re-push the SAME `externalId` with a changed field
   * (e.g. a new `content`): the gateway sees the row already exists, so the
   * event's `before` is populated and the transition is an update, not an
   * insert.
   */
  async pushDocument(doc: PushDocumentInput = {}): Promise<void> {
    await this.pushDocuments([doc]);
  }

  /** Batch variant of {@link pushDocument}. */
  async pushDocuments(docs: PushDocumentInput[]): Promise<void> {
    const nowIso = new Date().toISOString();
    const documents = docs.map((d, i) => {
      const externalId = d.externalId ?? `synth-doc-${Date.now()}-${i}`;
      const content = d.content ?? "synthetic document content";
      const { documentType, metadata, ...rest } = d;
      return {
        providerId: d.providerId ?? "synthetic:test@example.com",
        sourceId: d.sourceId ?? "synthetic:test@example.com",
        externalId,
        title: d.title ?? "Synthetic document",
        content,
        // Distinct content must yield a distinct hash so the gateway's
        // change-detection treats a re-push with changed content as an
        // UPDATE rather than a no-op. A real digest — a content prefix is
        // NOT enough (documents differing only past the prefix would be
        // silently treated as unchanged).
        contentHash:
          d.contentHash ?? `sha256:${createHash("sha256").update(content).digest("hex")}`,
        metadata: {
          ...(documentType ? { documentType } : {}),
          ...(metadata ?? {}),
        },
        sourceCreatedAt: d.sourceCreatedAt ?? nowIso,
        sourceUpdatedAt: d.sourceUpdatedAt ?? nowIso,
        ...rest,
      };
    });
    await this.gatewayJson<{ ingested?: number }>("/documents", {
      method: "POST",
      body: JSON.stringify({ documents }),
    });
  }

  /**
   * Drain the real near-duplicate pipeline to a fixed point after test
   * ingestion. Deterministic callers keep automatic compute parked and put
   * the DF cadence permanently past due in their isolated gateway config
   * (see {@link nearDupRebuildOnAnyFile}), then stop ingestion before invoking
   * this exact flush → DF → compute sequence.
   */
  async convergeNearDuplicates(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastResult: { idle?: boolean } | undefined;

    // Document events first land in an in-memory buffer. Require a subsequent
    // idle flush generation so no buffered event can repopulate an inbox that
    // compute has already declared empty.
    do {
      lastResult = await this.runSyntheticPeriodic("nearDup.inboxFlush", deadline);
      if (typeof lastResult.idle !== "boolean") {
        throw new Error(
          `nearDup.inboxFlush returned an invalid result: ${JSON.stringify(lastResult)}`,
        );
      }
    } while (!lastResult.idle && Date.now() < deadline);
    if (!lastResult?.idle) {
      throw new Error("nearDup.inboxFlush did not reach idle before the convergence deadline");
    }

    // Exact waiting targets a trailing generation if a wall-clock refresh is
    // already running. The authoritative metadata below proves that a full
    // build landed before compute starts.
    lastResult = await this.runSyntheticPeriodic("backfill.nearDupDfRefresh", deadline);
    if (lastResult.idle !== false) {
      throw new Error(
        `backfill.nearDupDfRefresh did not rebuild post-ingest DF: ${JSON.stringify(lastResult)}`,
      );
    }
    const dfMeta = await this.nearDupDfMeta();
    if (dfMeta.builtAt === null || dfMeta.totalDocs <= 0 || dfMeta.uniqueShingles <= 0) {
      throw new Error(`backfill.nearDupDfRefresh left invalid metadata: ${JSON.stringify(dfMeta)}`);
    }

    let remaining = await this.nearDupInboxCount();
    while (remaining > 0 && Date.now() < deadline) {
      lastResult = await this.runSyntheticPeriodic("backfill.nearDupCompute", deadline);
      if (typeof lastResult.idle !== "boolean") {
        throw new Error(
          `backfill.nearDupCompute returned an invalid result: ${JSON.stringify(lastResult)}`,
        );
      }
      remaining = await this.nearDupInboxCount();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (remaining > 0) {
      throw new Error(
        `backfill.nearDupCompute left ${remaining} inbox rows before the convergence deadline (last result ${JSON.stringify(lastResult)})`,
      );
    }
  }

  private async runSyntheticPeriodic(
    taskName: string,
    deadline: number,
  ): Promise<{ idle?: boolean }> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${taskName} exceeded the convergence deadline`);
    const timeoutMs = Math.max(1, Math.min(120_000, remainingMs));
    const response = await this.gatewayJson<{ result: { idle?: boolean } }>(
      `/admin/background/run/${encodeURIComponent(taskName)}?timeoutMs=${timeoutMs}`,
      { method: "POST", signal: AbortSignal.timeout(timeoutMs + 1_000) },
    );
    return response.result;
  }

  private async nearDupInboxCount(): Promise<number> {
    const response = await this.gatewayJson<{ rows: unknown[][] }>("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*) FROM near_dup_inbox" }),
    });
    const count = Number(response.rows[0]?.[0]);
    if (!Number.isFinite(count)) {
      throw new Error(`invalid near-duplicate inbox count: ${JSON.stringify(response.rows)}`);
    }
    return count;
  }

  private async nearDupDfMeta(): Promise<{
    builtAt: number | null;
    totalDocs: number;
    uniqueShingles: number;
  }> {
    const response = await this.gatewayJson<{ rows: unknown[][] }>("/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT built_at, total_docs, unique_shingles FROM near_dup_df_meta LIMIT 1",
      }),
    });
    const row = response.rows[0];
    const builtAt = row?.[0] === null ? null : Number(row?.[0]);
    const totalDocs = Number(row?.[1]);
    const uniqueShingles = Number(row?.[2]);
    if (
      (builtAt !== null && !Number.isFinite(builtAt)) ||
      !Number.isFinite(totalDocs) ||
      !Number.isFinite(uniqueShingles)
    ) {
      throw new Error(`invalid near-duplicate DF metadata: ${JSON.stringify(response.rows)}`);
    }
    return { builtAt, totalDocs, uniqueShingles };
  }

  /**
   * Inject one analytics row to drive analytics-based triggers (match /
   * watch / combined). Uses the same `POST /analytics/ingest` path the
   * collector's analytics ingest calls, so the row lands through
   * the production AnalyticsService (ensureTable + upsert + the
   * `analytics_row.inserted` event), not a raw DB write.
   *
   * The gateway only creates the DuckDB table when a `schema` accompanies
   * the ingest (otherwise it tries to insert into a non-existent table and
   * 500s), so when the caller doesn't pass an explicit `schema` the harness
   * infers a minimal one from the row's keys + value types. The first key
   * becomes the primary key. Pass `opts.schema` to override, or
   * `opts.primaryKey` to choose a different key as the upsert conflict
   * target. Pass `opts.sourceId` to tag the catalog row — it MUST be a
   * valid `<type>:<accountId>` source id (the gateway parses it via
   * `parseSourceKey`); defaults to `synthetic:test@example.com`.
   */
  async pushAnalyticsRow(
    table: string,
    row: Record<string, unknown>,
    opts: { schema?: AnalyticsTableSchema; primaryKey?: string[]; sourceId?: string } = {},
  ): Promise<void> {
    const schema = opts.schema ?? inferAnalyticsSchema(table, row, opts.primaryKey);
    const sourceId = opts.sourceId ?? "synthetic:test@example.com";
    const { wipeEpoch } = await this.gatewayJson<{ wipeEpoch: number }>(
      `/sync-state/${encodeURIComponent(sourceId)}`,
    );
    await this.gatewayJson<{ ingested?: number }>("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: table,
        records: [row],
        schema,
        sourceId,
        writeEpoch: wipeEpoch,
      }),
    });
  }

  /**
   * Register a fake iOS device with a push token so the trigger
   * `notify-ios` fan-out (`listIosDevicesWithApnsToken`) targets it.
   * Creates an `ios`-kind device via `POST /admin/devices`, then stores a
   * claim-capable direct APNs registration. Requires `apnsBackend: "fake"`.
   * Returns the device id and the hex token (the
   * same token the fake APNs server will observe in the `/3/device/<token>`
   * path).
   */
  async registerFakeIosDevice(
    name = "Synthetic iOS device",
    capabilities?: DeviceCapability,
  ): Promise<{
    deviceId: string;
    token: string;
    authToken: string;
  }> {
    if (!this.fakeApns) {
      throw new Error(
        'registerFakeIosDevice() requires the harness to be constructed with apnsBackend: "fake".',
      );
    }
    const created = await this.gatewayJson<{ device: { id: string }; token: string }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          kind: "ios",
          scopes: ["read", "write:*", "admin", "push:claim"],
          ...(capabilities ? { capabilities } : {}),
        }),
      },
    );
    if (!created?.device?.id || !created.token) {
      throw new Error(`registerFakeIosDevice: device creation failed: ${JSON.stringify(created)}`);
    }
    const deviceId = created.device.id;
    const token = randomBytes(32).toString("hex");
    const reg = await this.gatewayJson<{ ok?: boolean }>(
      `/admin/devices/${encodeURIComponent(deviceId)}/push-registration`,
      {
        method: "POST",
        body: JSON.stringify({
          transport: "direct-apns",
          deviceToken: token,
          environment: "production",
          bundleId: "dev.omnesis.ios",
        }),
      },
    );
    if (!reg?.ok) {
      throw new Error(`registerFakeIosDevice: push registration failed: ${JSON.stringify(reg)}`);
    }
    return { deviceId, token, authToken: created.token };
  }

  /**
   * Every APNs push the fake server has observed, in arrival order. Empty
   * unless the harness was constructed with `apnsBackend: "fake"`.
   */
  getApnsPushes(): ReceivedApnsPush[] {
    return this.fakeApns?.received ?? [];
  }

  /** The fake embedder's base URL + model id, or null when `embedderBackend !== "fake"`. */
  getFakeEmbedder(): { url: string; modelId: string; dim: number } | null {
    if (!this.fakeEmbedder) return null;
    const { url, modelId, dim } = this.fakeEmbedder;
    return { url, modelId, dim };
  }

  /**
   * Total text inputs the fake embedder has embedded since boot (probe +
   * corpus + query/trigger calls). Monotonic; read before/after an action to
   * prove how many chunks were (re-)embedded. Returns 0 when the harness was
   * not constructed with `embedderBackend: "fake"`.
   */
  getEmbedCount(): number {
    return this.fakeEmbedder?.embedCount() ?? 0;
  }

  /** Get the sync_state row for a source (cursor, lastSyncedAt, etc.). */
  async getSyncState(sourceId: string): Promise<{ cursor: unknown; lastSyncedAt: string } | null> {
    if (!this.gateway) throw new Error("Harness not started");
    return this.gateway.getSyncState(SourceId(sourceId));
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
    throw new Error(`Synthetic collector ${deviceId} did not become ready within 10000ms`);
  }

  async destroy(): Promise<void> {
    for (const device of this.devices) {
      device.ws?.disconnect();
      device.engine.stopSyncLoop();
    }
    await this.killGatewaySubprocess();
    if (this.fakeEmbedder) {
      try {
        await this.fakeEmbedder.close();
      } catch {
        /* best effort */
      }
      this.fakeEmbedder = null;
    }
    if (this.fakeApns) {
      try {
        await this.fakeApns.close();
      } catch {
        /* best effort */
      }
      this.fakeApns = null;
    }
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  private async startGateway(): Promise<void> {
    const env = syntheticGatewayEnv(
      {
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
        OMNESIS_SYNTH_UNIVERSE: this.universe,
        // Never multicast from a test gateway — parallel E2E gateways would
        // otherwise advertise the same `_omnesis._tcp` service and collide,
        // and a stray collector could discover the wrong instance (#49).
        OMNESIS_MDNS_DISABLE: "1",
        ...(this.extraGatewayEnv ?? {}),
      },
      this.gatewayMode,
    );

    // Assemble the gateway's omnesis.json from the enabled backends.
    // Each block is additive so a test can opt into any combination of
    // replay-agent, fake-embedder, and fake-APNs without the blocks
    // clobbering each other.
    const inferenceBackends: Record<string, { type: "http"; url: string }> = {};
    const inferenceAssignments: Record<string, string> = {};
    const gatewayBlock: Record<string, unknown> = {};

    if (this.agentBackend === "replay") {
      // Universe lives at `<repoRoot>/evals/universes/<name>/`. The
      // gateway's replay factory expects an absolute path to the demos
      // directory; resolve from the worktree root that this harness is
      // already cd'd into (see `cwd` below).
      const repoRoot = join(import.meta.dirname, "../../../..");
      env.OMNESIS_AGENT_FIXTURE = join(
        repoRoot,
        "evals",
        "universes",
        this.universe,
        "agent-demos",
      );
      // Enable the agent through the inference-assignment mechanism. The
      // legacy `OMNESIS_AGENT_BACKEND` env override was retired; the gateway
      // now reads `inference.assignments.agent` from omnesis.json (see
      // scripts/synth-gateway.sh, which does the same).
      inferenceAssignments.agent = "replay";
    }

    if (this.fakeEmbedder) {
      // The fake embedder speaks the OpenAI-compatible subset the gateway's
      // HttpEmbedder + probeHttpEmbedder exercise. Assign it as the gateway's
      // embedder; `probeHttpEmbedder` discovers dim=768 by POSTing a probe.
      inferenceBackends.fake = { type: "http", url: this.fakeEmbedder.url };
      inferenceAssignments.embedder = `fake/${this.fakeEmbedder.modelId}`;
    }

    if (this.transcriberBackend === "replay") {
      // The synthetic transcriber decodes audio bytes as UTF-8 — no model needed.
      inferenceAssignments.transcriber = "replay";
    }
    if (this.ocrBackend === "replay") {
      // The synthetic OCR backend decodes image bytes as UTF-8 — no model needed.
      inferenceAssignments.ocr = "replay";
    }

    if (this.fakeApns) {
      // ApnsClient is only wired when `gateway.apns` is present, so we write
      // a throwaway-but-schema-valid block; the JWT it signs is never
      // verified by the fake. `OMNESIS_APNS_BASE_URL` redirects every push
      // from Apple's hosts to the local fake.
      const keyPath = join(this.configDir, "apns-key.p8");
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }) as string);
      gatewayBlock.apns = {
        keyPath,
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "dev.omnesis.ios",
        environment: "production",
      };
      env.OMNESIS_APNS_BASE_URL = this.fakeApns.url;
    }

    // Caller-supplied backends/assignments are merged LAST so an explicit
    // assignment (e.g. the recorder's configured `agent`) wins over a
    // flag-derived one for the same role.
    if (this.extraInference?.backends) {
      Object.assign(inferenceBackends, this.extraInference.backends);
    }
    if (this.extraInference?.assignments) {
      Object.assign(inferenceAssignments, this.extraInference.assignments);
    }

    // Caller-supplied top-level blocks first; the assembled `inference` /
    // `gateway` blocks below overwrite same-named keys (those two have
    // dedicated options).
    const suppliedGatewayConfig =
      typeof this.extraGatewayConfig === "function"
        ? this.extraGatewayConfig({ gatewayUrl: this.gatewayUrl })
        : (this.extraGatewayConfig ?? {});
    const omnesisJson: Record<string, unknown> = { ...suppliedGatewayConfig };
    if (Object.keys(inferenceBackends).length || Object.keys(inferenceAssignments).length) {
      omnesisJson.inference = {
        ...(Object.keys(inferenceBackends).length ? { backends: inferenceBackends } : {}),
        ...(Object.keys(inferenceAssignments).length ? { assignments: inferenceAssignments } : {}),
        ...(this.extraInference?.allowRemoteInference !== undefined
          ? { allowRemoteInference: this.extraInference.allowRemoteInference }
          : {}),
      };
    }
    if (Object.keys(gatewayBlock).length) {
      const configuredGateway =
        omnesisJson.gateway &&
        typeof omnesisJson.gateway === "object" &&
        !Array.isArray(omnesisJson.gateway)
          ? (omnesisJson.gateway as Record<string, unknown>)
          : {};
      omnesisJson.gateway = { ...configuredGateway, ...gatewayBlock };
    }
    if (Object.keys(omnesisJson).length) {
      writeFileSync(join(this.configDir, "omnesis.json"), JSON.stringify(omnesisJson, null, 2));
    }

    const gatewayCommand = e2eTsxCommand("packages/gateway/src/index.ts");
    this.gatewayProcess = spawn(gatewayCommand.command, gatewayCommand.args, {
      env,
      cwd: join(import.meta.dirname, "../../../.."),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    // Reap this detached group even if the runner dies before stop() runs
    // (e.g. `timeout` SIGTERMs the e2e run) — otherwise the gateway orphans.
    registerSubprocessGroup(this.gatewayProcess);

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
        const healthBody = (await health.json()) as { experimental?: unknown };
        try {
          assertSyntheticGatewayVisibility(this.gatewayMode, healthBody.experimental);
        } catch (error) {
          if (!(error instanceof GatewayModeMismatchError)) throw error;
          await this.killGatewaySubprocess();
          throw error;
        }
        let token: string;
        try {
          token =
            (await readSecretTextFile(tokenPath, { configDir: this.configDir }))?.trim() ?? "";
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
      } catch (error) {
        if (error instanceof GatewayModeMismatchError) throw error;
        /* gateway not reachable yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Say which of the two things happened. A gateway that exited is a real
    // failure with a cause worth chasing; one still running when the budget
    // expired is the harness giving up on a slow boot, and reads as a broken
    // suite unless the message says otherwise.
    const proc = this.gatewayProcess;
    const fate =
      proc?.exitCode !== null && proc?.exitCode !== undefined
        ? `the gateway process exited with code ${proc.exitCode}`
        : proc?.signalCode
          ? `the gateway process was killed by ${proc.signalCode}`
          : "the gateway process was still running — this is the harness giving up on a slow boot, not a gateway that failed";
    throw new Error(
      `The harness stopped waiting for the gateway after ${timeout}ms (the shared boot budget in scripts/lib/gateway-boot-budget.json): ${fate}.`,
    );
  }

  private async killGatewaySubprocess(): Promise<void> {
    const proc = this.gatewayProcess;
    if (!proc) return;
    await killSubprocessGroup(proc);
  }
}
