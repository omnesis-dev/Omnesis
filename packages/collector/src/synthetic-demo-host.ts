// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A roster-aware, real-ingestion host for materialised demonstration universes. */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createLogger, type SourceConfig } from "@omnesis/core";
import { HttpGatewayClient, GatewayWsClient } from "@omnesis/gateway-client";
import { loadUniverse } from "@omnesis/providers-synth-common";
import {
  AccountId,
  SourceType,
  SCOPE_ADMIN,
  SCOPE_READ,
  defaultScopesForDeviceKind,
} from "@omnesis/types";
import { createAttachmentExtractor } from "./attachments/index.js";
import { SyncEngine } from "./sync-engine.js";
import { setupSources } from "./source-instantiator.js";
import { prepareDemoHostStates } from "./synthetic-demo-host-state.js";
import { retainDemoHost, waitForDemoGraph } from "./synthetic-demo-host-lifecycle.js";

const log = createLogger("collector:synthetic-demo");

function canonicalLocation(path: string): string {
  let candidate = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(candidate)) {
    suffix.unshift(basename(candidate));
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return join(realpathSync(candidate), ...suffix);
}

export function assertDemoIsolation(configDir: string, gatewayUrl: string): void {
  const location = canonicalLocation(configDir),
    live = canonicalLocation(join(homedir(), ".config", "omnesis"));
  const url = new URL(gatewayUrl);
  if (
    location === live ||
    location.startsWith(live + "/") ||
    url.protocol !== "https:" ||
    url.port === "7600" ||
    !url.port ||
    Number(url.port) < 1024
  )
    throw new Error(
      "Synthetic demo host requires an isolated config directory and explicit high HTTPS port",
    );
  if (process.env.OMNESIS_SYNTHETIC !== "1")
    throw new Error("Synthetic demo host requires OMNESIS_SYNTHETIC=1");
}

export async function seedDemoUniverse(options: {
  configDir: string;
  gatewayUrl: string;
  token: string;
  universe: string;
  resident?: boolean;
  graphTimeoutMs?: number;
}): Promise<void> {
  assertDemoIsolation(options.configDir, options.gatewayUrl);
  process.env.OMNESIS_SYNTH_UNIVERSE = options.universe;
  const manifest = loadUniverse(options.universe).manifest;
  const hostStates = prepareDemoHostStates(
    options.configDir,
    manifest.devices.map((device) => device.id),
  );
  const headers = { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" };
  const adminJson = async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(new URL(path, options.gatewayUrl), {
      headers,
      signal,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Demo gateway ${path} returned HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  const health = await adminJson<{ experimental: boolean }>("/health");
  const status = await adminJson<{ testInstance?: unknown }>("/status");
  if (!health.experimental || !status.testInstance)
    throw new Error("Refusing a gateway without synthetic/test-instance identity");
  const { allDefinitions, extractDescriptors } = await import("./source-descriptors.js");
  const descriptors = allDefinitions.flatMap(extractDescriptors);
  const sourceToProvider = new Map(descriptors.map((d) => [d.id, d.provider.id]));
  for (const source of manifest.sources)
    if (!descriptors.some((d) => String(d.id) === source.descriptorId))
      throw new Error(`No synthetic descriptor loaded for ${source.descriptorId}`);
  const clients: HttpGatewayClient[] = [],
    engines: SyncEngine[] = [],
    sockets: GatewayWsClient[] = [];
  const existing = await adminJson<{ items: { id: string; name: string; kind: string }[] }>(
    "/admin/devices",
  );
  try {
    for (const device of manifest.devices) {
      const entries = manifest.sources.filter((s) => s.device === device.id);
      if (entries.length === 0) continue;
      if (entries.some((s) => s.members?.length))
        throw new Error(
          "Demo host does not support member rosters; use the multi-device E2E harness",
        );
      const hostState = hostStates.get(device.id);
      if (!hostState) throw new Error("Demo roster state was not preflighted");
      const hostDir = hostState.dir,
        saved = hostState.saved;
      const existingDevice = existing.items.find((d) => d.name === device.name);
      if (
        existingDevice &&
        (!saved ||
          saved.device.id !== existingDevice.id ||
          saved.universe !== resolve(options.universe) ||
          saved.gatewayUrl !== options.gatewayUrl)
      )
        throw new Error(
          `Demo roster device ${device.name} already exists; reuse the materialised instance or seed a fresh isolated gateway`,
        );
      const hosted = descriptors.filter((d) =>
        entries.some((s) => s.descriptorId === String(d.id)),
      );
      const capabilities = {
        hostname: `${device.id}.example.com`,
        platform: device.kind === "collector" ? process.platform : device.kind,
        hostableSourceTypes: entries.map((s) => SourceType(s.descriptorId)),
        syncLease: true,
        pushBasedSourceTypes: hosted.filter((d) => d.pushBased).map((d) => d.id),
        multiDeviceModes: Object.fromEntries(
          hosted.flatMap((d) =>
            d.multiDevice && d.multiDevice.mode !== "exclusive"
              ? [[String(d.id), d.multiDevice.mode]]
              : [],
          ),
        ),
        replicaVersionPolicies: Object.fromEntries(
          hosted.flatMap((d) =>
            d.multiDevice?.replicaVersionPolicy
              ? [[String(d.id), d.multiDevice.replicaVersionPolicy]]
              : [],
          ),
        ),
        memberScopedParams: Object.fromEntries(
          hosted.map((d) => [String(d.id), d.memberScopedParamNames ?? []]),
        ),
      };
      const candidate =
        saved && existingDevice
          ? saved
          : await adminJson<{ device: { id: string }; token: string }>("/admin/devices", {
              name: device.name,
              kind: device.kind,
              scopes: [
                ...new Set([...defaultScopesForDeviceKind(device.kind), SCOPE_ADMIN, SCOPE_READ]),
              ],
              capabilities,
            });
      const paired = hostState.save({
        ...candidate,
        universe: resolve(options.universe),
        gatewayUrl: options.gatewayUrl,
      });
      const client = new HttpGatewayClient(options.gatewayUrl, paired.token);
      clients.push(client);
      const registered = await client.bulkUpsertSources(
        entries.flatMap((s) =>
          s.accountIds.map((accountId) => ({
            type: SourceType(s.descriptorId),
            accountId: AccountId(accountId),
            enabled: true,
          })),
        ),
      );
      if (registered.errors.length)
        throw new Error(
          `Registering ${device.name}: ${registered.errors.map((e) => e.error).join("; ")}`,
        );
      const sourceConfigs: Record<string, SourceConfig> = {};
      for (const entry of entries)
        for (const accountId of entry.accountIds)
          sourceConfigs[`${entry.descriptorId}:${accountId}`] = {
            enabled: true,
            params: { __syntheticDeviceId: device.id },
          };
      const engine = new SyncEngine(client, { syncTimeoutMs: 3_600_000 });
      engines.push(engine);
      const failures = await setupSources(
        {
          definitions: allDefinitions,
          descriptors,
          sourceToProvider,
          config: { sources: sourceConfigs, defaultSyncInterval: "999999s" },
          gateway: client,
          engine,
          configDir: hostDir,
          configDerivedAccountKeys: new Set(Object.keys(sourceConfigs)),
          extractAttachment: createAttachmentExtractor({
            ocr: (data, mimeType, opts) => client.ocr(data, mimeType, opts),
            ocrEnabled: () => true,
            transcribe: (data, mimeType, opts) => client.transcribe(data, mimeType, opts),
          }),
          transcribeAudio: (data, mimeType, opts) => client.transcribe(data, mimeType, opts),
        },
        sourceConfigs,
      );
      if (failures.length) throw new Error(`Source setup failed: ${JSON.stringify(failures)}`);
      engine.onStatusChange((change) => log.info(`source ${change.sourceId}: ${change.event}`));
      if (device.kind === "collector") {
        const socket = new GatewayWsClient(options.gatewayUrl, paired.token, { capabilities });
        socket.onCommand(async (command) => {
          if (command.type === "sources.snapshot") return { ok: true, applied: true };
          throw new Error(`Unsupported demo host command ${command.type}`);
        });
        sockets.push(socket);
        socket.connect();
        const deadline = Date.now() + 30_000;
        while (!socket.isAuthenticated() && Date.now() < deadline) await delay(50);
        if (!socket.isAuthenticated())
          throw new Error("Demo collector did not authenticate its socket");
      }
    }
    const everySource = engines.flatMap((e) => e.registeredSources());
    const primary = engines[0],
      client = clients[0];
    if (!primary || !client) throw new Error("No roster host was created");
    const {
      collectKnownUrlPatterns,
      collectOwnedWebDomains,
      collectDocumentEventProfiles,
      collectWidgetOrigins,
      collectWidgetRenderers,
    } = await import("./source-manager.js");
    const publishDeclarations = async () => {
      await primary.pushSourcePriorDefaults(everySource);
      await primary.pushSelfIdentitySources(everySource);
      await primary.pushUrlCanonicalizers(everySource);
      await primary.pushUrlGraphRoles(everySource);
      for (const engine of engines) await engine.pushAnalyticsSchemas();
      await client.setOwnedWebDomains(collectOwnedWebDomains(allDefinitions));
      await client.setDocumentEventProfiles(collectDocumentEventProfiles(allDefinitions));
      await client.setWidgetOrigins(collectWidgetOrigins(allDefinitions));
      await client.setWidgetRenderers(collectWidgetRenderers(allDefinitions));
      await primary.pushLinkDeclarations(collectKnownUrlPatterns(allDefinitions), everySource);
    };
    await publishDeclarations();
    let identities = sockets.map((socket) => socket.getIdentity());
    const refresh = async () => {
      if (sockets.some((socket) => !socket.isAuthenticated())) return;
      const current = sockets.map((socket) => socket.getIdentity());
      if (current.some((identity, i) => identity !== identities[i])) {
        await publishDeclarations();
        identities = current;
      }
    };
    for (const engine of engines) await engine.syncAll();
    const statuses = engines.flatMap((e) => e.getStatuses());
    const failed = statuses.filter((s) => s.lastError);
    if (failed.length)
      throw new Error(
        `Demo source sync failures: ${JSON.stringify(failed.map(({ sourceId, lastError }) => ({ sourceId, lastError })))}`,
      );
    const expected = manifest.sources.reduce((sum, s) => sum + s.accountIds.length, 0);
    if (everySource.length !== expected)
      throw new Error(`Expected ${expected} instantiated sources; got ${everySource.length}`);
    await adminJson("/admin/search-snapshot/refresh", {});
    log.info(
      `Seeded ${expected} sources as ${engines.length} roster devices through production ingestion`,
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await waitForDemoGraph({
        readJobs: () =>
          adminJson(
            "/admin/background-jobs",
            undefined,
            AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          ),
        after: Date.now(),
        timeoutMs: options.graphTimeoutMs,
        signal: controller.signal,
        refresh,
        report: (message) => log.info(message),
      });
      log.info("Production document-link derivation is caught up");
      if (options.resident) {
        log.info("Resident demo host active; stop with SIGTERM or SIGINT");
        await retainDemoHost({ signal: controller.signal, refresh });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  } finally {
    for (const engine of engines) {
      await engine.stopSyncLoopAndDrain();
      for (const source of engine.registeredSources())
        await engine.unregisterSource(source.source.id);
    }
    for (const socket of sockets) socket.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configDir = process.env.OMNESIS_CONFIG_DIR,
    gatewayUrl = process.env.OMNESIS_GATEWAY_URL,
    universe = process.env.OMNESIS_SYNTH_UNIVERSE;
  if (!configDir || !gatewayUrl || !universe)
    throw new Error(
      "Set explicit OMNESIS_CONFIG_DIR, OMNESIS_GATEWAY_URL and OMNESIS_SYNTH_UNIVERSE",
    );
  const token = readFileSync(join(configDir, "token"), "utf8").trim();
  await seedDemoUniverse({
    configDir,
    gatewayUrl,
    universe,
    token,
    resident: process.env.OMNESIS_SYNTH_RESIDENT === "1",
    graphTimeoutMs:
      process.env.OMNESIS_SYNTH_GRAPH_TIMEOUT_MS === undefined
        ? undefined
        : Number(process.env.OMNESIS_SYNTH_GRAPH_TIMEOUT_MS),
  });
}
