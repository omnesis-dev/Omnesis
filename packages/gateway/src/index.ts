// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Load $OMNESIS_CONFIG_DIR/.env into process.env before any env reads. See #52.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname as osHostname } from "node:os";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { CONFIG_DEFAULTS, DEFAULT_PUSH_WAKE_RETRY_SETTINGS, scaffoldDotEnv } from "@omnesis/config";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  acquireGatewayLock,
  applyPrivateUmask,
  GATEWAY_SHUTDOWN_BUDGET_MS,
  assertNever,
  makeEvent,
  createLogger,
  DEFAULT_CONFIG_DIR,
  ensurePrivateDirSync,
  experimentalEnabled,
  experimentalVisible,
  loadManifest,
  primeSecretFileKeyCache,
  resolveWorkerEntry,
  runningSourceCommit,
} from "@omnesis/core";
import { type OmnesisConfig } from "@omnesis/config";
import { Ontology } from "@omnesis/watch";
import { dotEnvKeysAtBoot } from "./load-env.js";
import { resolveAnthropicApiKey, resolveAnthropicCredential } from "./model-credentials.js";
import { createDatabase, getDocumentTitlesAndSources, openReadOnlyDatabase } from "./db.js";
import { createServer } from "./server.js";
import { GATEWAY_VERSION } from "./version.js";
import { ReleaseCheckService } from "./release-check/service.js";
import { createReleaseCheckTask } from "./release-check/task.js";
import { GatewayHttpShutdown } from "./gateway-http-shutdown.js";
import { seedWebSourceMeta } from "./sources/web/source-meta.js";
import {
  bootBriefs,
  briefsFeatureStatus,
  cognitionSpendDay,
  resolveBrainSettings,
  SweepService,
} from "./brain/index.js";
import {
  BRIEF_JUDGE_SPEND_MECHANISM,
  ENTAILMENT_GATE_SPEND_MECHANISM,
} from "./agent/spend-recorder.js";
import { bootDateEnrichment } from "./enrichment/dates/task.js";
import { resolveDateEnrichmentSettings } from "./enrichment/dates/config.js";
import { countPendingDateExtraction } from "./enrichment/dates/storage.js";
import { resolveBriefsVirtualClock } from "./brain/virtual-clock.js";
import { backgroundAgentBackendResolver } from "./brain/backend-resolver.js";
import { LlmBriefJudge } from "./brain/steward/brief-judge.js";
import { CognitionRunActivity } from "./brain/run-activity.js";
import { FsCognitionTranscriptStore, cognitionTranscriptsDir } from "./brain/transcripts.js";
import { drainTranscriptEvictions } from "./brain/transcript-eviction.js";
import { createActivityRetentionTask } from "./activity-retention/task.js";
import { createAbsenceSweepTask } from "./absence/task.js";
import { directIndexWriteGate } from "./indexer/index-write-gate.js";
import { purgeCognitiveStateThroughGate } from "./brain/cognitive-state-cascade.js";
import { resolveRelaySettings } from "./push/relay-settings.js";
import { generateSelfSigned, resolveTlsBundle } from "./tls.js";
import { currentTlsMaterialPaths, partitionAddressedHosts } from "./tls-lifecycle/addressing.js";
import { isLoopbackIp, reverseProxyTrusted } from "./http/client-ip.js";
import { createHostMinter } from "./tls-lifecycle/minters.js";
import { TlsLifecycleService } from "./tls-lifecycle/service.js";
import { createTlsLifecycleTask } from "./tls-lifecycle/task.js";
import { DEFAULT_MDNS_ENABLED, DEFAULT_MDNS_HOSTNAME, MdnsAdvertiser } from "./mdns-advertiser.js";
import { DeviceWsServer } from "./ws.js";
import { mountDeviceWsRoute } from "./device-ws-route.js";
import { WsEventHandler } from "./http/services/WsEventHandler.js";
import { FleetUpdateService } from "./http/services/FleetUpdateService.js";
import { HostFleetUpdateService } from "./http/services/HostFleetUpdateService.js";
import { ServiceManagerPortalFleetUpdateLauncher } from "./portal-fleet-update-launcher.js";
import { portalFleetUpdateE2EFixture } from "./portal-fleet-update-e2e.js";
import { DeviceDoctorService } from "./http/services/DeviceDoctorService.js";
import { updateCollectorDeclarationPresence } from "./domain/LinkDeclarationService.js";
import { BackupService, DEFAULT_PRE_UPDATE_BACKUP_COUNT } from "./http/services/BackupService.js";
import { ExportService } from "./http/services/ExportService.js";
import { FsConversationStore } from "./agent/conversation-store.js";
import { AgentLifecycle, resolveRoleBackend } from "./agent/agent-lifecycle.js";
import { sendAgentAnswerPush } from "./agent/answer-push.js";
import { ConfigChangeOrchestrator } from "./http/services/ConfigChangeOrchestrator.js";
import { InferenceRegistry } from "./inference/registry.js";
import { ModelsDevCatalog } from "./models/models-dev-catalog.js";
import { EntailmentVerifierService } from "./inference/entailment-service.js";
import { withSpendRecording } from "./inference/spend-recording-completer.js";
import { loadCompletionFromResolved } from "./inference/completion-loader.js";
import { TranscribeService } from "./transcribe/index.js";
import { OcrService } from "./ocr/index.js";
import { ConfigBootError, ConfigStore, defaultConfigPath } from "./config-store.js";
import { OperatorInstructionsStore } from "./instructions/store.js";
import { reconcileConfig } from "./config-reconcile.js";
import {
  createIndexDatabase,
  purgeUsearchSidecars,
  getVectorWriteSeq,
  getUsearchSavedSeq,
  setUsearchSavedSeq,
  getIndexEmbedModel,
  reconcileIndexForGatewaySchema,
  enqueueDocumentIndexPurge,
  scrubPendingSourceIndexPurges,
} from "./indexer/db.js";
import { listInterruptedOmnesisChatRetentionDocumentIds } from "./sources/omnesis-chat/wiring.js";
import {
  encryptSidecar,
  restoreActiveSidecar,
  purgeSidecarTemps,
  tryUnlink as tryUnlinkSidecar,
} from "./indexer/usearch-sidecar-crypto.js";
import { IndexerStatusReporter } from "./indexer/indexer-status.js";
import { IndexerLifecycle } from "./indexer/indexer-lifecycle.js";
import {
  Scheduler,
  WriterTaskRunner,
  IoTaskRunner,
  CpuTaskRunner,
  MainTaskRunner,
  writeGateFromScheduler,
  ioGateFromScheduler,
  cpuGateFromScheduler,
  createBackfillTasks,
  createTokenUsageBuffer,
  tokenUsageFlushTask,
  createPrincipalCredentialUsageBuffer,
  principalCredentialUsageFlushTask,
  createNearDupInboxBuffer,
  nearDupInboxFlushTask,
  indexerWakeTask,
  createCleanupTasks,
  createBackendReprobeTask,
  createSubscriptionDeliveriesTask,
} from "./scheduler/index.js";
import {
  announceRuntimeSettings,
  backfillOptsFromRuntime,
  resolveRuntimeSettings,
} from "./runtime-settings.js";
import { SearchPipeline } from "./search/pipeline.js";
import { SearchWorkerPool } from "./workers/search-pool.js";
import { startSearchCacheWarm, type SearchCacheWarm } from "./workers/search-warm.js";
import { openSearchSnapshotHandle, type SearchSnapshotHandle } from "./search/snapshot-handle.js";
import {
  type SearchConfig,
  DEFAULT_SEARCH_READ_MMAP_BYTES,
  DEFAULT_SEARCH_READ_CACHE_BYTES,
} from "./search/search-config.js";
import { AnalyticsDb } from "./analytics-db.js";
import { startWatchV2 } from "./watch/host.js";
import { resolveWatchJournal, watchJournalPath } from "./watch/journal-path.js";
import { DiskUsageMonitor, measureDiskUsage } from "./disk-usage.js";
import {
  analyticsPortFor,
  openWatchStores,
  startWatchV2Engine,
  watchCompleterKeyResolver,
} from "./watch/engine-task.js";
import { holdUnarmed } from "./watch/health.js";
import { PushTransport } from "./watch/push-transport.js";
import { omnesisNotifyDelivery } from "./watch/delivery.js";
import { agentWakeDelivery } from "./watch/wake.js";
import { createWakeAnchors, watchAnchorBreaches, wakesAnAgent } from "./watch/anchors.js";
import { watchDisclosure, watchDisclosureSummaries } from "./watch/disclosure.js";
import { LiveRecall } from "./watch/recall.js";
import { createCompilePort, DEFAULT_COMPILE_TIMEOUT_MS } from "./watch/compile-port.js";
import { InFlightRequests } from "./watch/in-flight-requests.js";
import { liveBacktestPort } from "./watch/live-backtest.js";
import { WatchCompileRecorder } from "./watch/compile-run.js";
import { preflight, type PreflightOutcome } from "./watch/preflight.js";
import { createCompilerSession } from "./watch/compiler-session.js";
import {
  authorWatch,
  previewWatch,
  retireAuthoredWatch,
  type AuthorWatchDeps,
} from "./watch/authoring.js";
import {
  getSubscriptionCompiledPlan,
  listWorkflowOutcomesForFiringKeys,
} from "./subscriptions/store-queries.js";
import { isWatchV2Plan } from "./subscriptions/watch-v2-plan.js";
import { buildOntologySnapshot, promptPeopleDirectory } from "./watch/ontology.js";
import { gatewaySyncPhaseSignals } from "./watch/signals.js";
import { SyncStatusRegistry } from "./sync-status.js";
import { AuthFlowRegistry } from "./auth-flows.js";
import { ImportFlowRegistry } from "./import-flows.js";
import { MetricsRegistry } from "./metrics.js";
import { setBusyRetryRecorder } from "./data/retry.js";
import { BackgroundJobsRegistry } from "./background-jobs/index.js";
import { periodicJob } from "./background-jobs/scheduler-job.js";
import { StatelessTracker } from "./background-jobs/trackers.js";
import { derivationSlaTasks } from "./scheduler/tasks/derivation-sla.js";
import { DERIVATION_STAGES, type DerivationStage } from "./domain/DocumentDerivation.js";
import { subscribeDerivationNudge } from "./scheduler/tasks/derivation-nudge.js";
import { SubscriptionDeliveryService } from "./subscriptions/delivery.js";
import { AnswerCompletionDeliveryService } from "./privacy/completion-delivery.js";
import { createWatchFiringThreadOpener } from "./watch/firing-thread.js";
import { ApnsClient } from "./push/transports/direct-apns.js";
import { FcmClient } from "./push/transports/direct-fcm.js";
import { RelayPushClient } from "./push/transports/relay.js";
import { DEFAULT_NOTIFICATION_TTL_MS, PushBroadcaster } from "./push/broadcast.js";
import { allWatchNotificationWakeOutcomes, watchNotificationWakeOutcomes } from "./push/queue.js";
import { overlayWatchPushRetries } from "./watch/push-retry-ledger.js";
import { createPushWakeRetryTask } from "./scheduler/tasks/push-wake-retry.js";
import { NeedsAuthNotifier } from "./push/producers/needs-auth.js";
import {
  SourcePermissionNotifier,
  resolveSourcePermissionReminderConfig,
} from "./push/producers/source-permission.js";
import { resolveReauthBackoffConfig } from "./push/reauth-reminder-policy.js";
import { getDevice, listDevices } from "./data/repositories/DeviceRepository.js";
import { getSourceMeta } from "./data/repositories/SyncStateRepository.js";
import { PrivacyApprovalNotifier } from "./privacy/approval-notifier.js";
import { ConversationNotifier } from "./agent/conversation-notifier.js";
import { AccessAuthorizationNotifier } from "./access/authorization-notifier.js";
import { PrivacyPolicyStore } from "./privacy/policy-store.js";
import { runBootDataMigrations } from "./bootstrap/run-boot-data-migrations.js";
import { eventBus } from "./events.js";
import { runWithPriority } from "./priority.js";
import { resolveNearDupConfig, subscribeNearDupInbox } from "./near-dupes/index.js";
import { ModelManager } from "./models/manager.js";
import { CodexRuntimeService } from "./models/codex-runtime-service.js";
import { AnthropicCatalogService } from "./models/anthropic-catalog-service.js";
import { ModelHistoryStore } from "./models/model-history.js";
import { computeRecentModels } from "./models/recent-models.js";
import { ensureModelsDir, getSystemInfo } from "./system-info.js";
import { getPersonNames, resolvePersonIdsFromQuery } from "./data/repositories/PersonRepository.js";
import { getSelfPersonId } from "./data/repositories/DocumentPeopleRepository.js";
import { getInboundRefCounts } from "./data/repositories/DocumentLinksRepository.js";
import { ProcessVitalsCollector } from "./process-vitals.js";
import {
  UsearchReadRegistry,
  resolveActiveUsearchTarget,
} from "./indexer/usearch-read-registry.js";
import { quarantineCorruptUsearch } from "./indexer/usearch-boot-guard.js";
import { startParentWatchdogFromEnv } from "./parent-watchdog.js";
import {
  resolveGatewayStorageEncryptionKeys,
  storageEncryptionPosture,
} from "./storage-encryption.js";
import {
  COGNITION_BOOTSTRAP_STARTED_AT_KEY,
  getCognitionEngineState,
} from "./brain/storage/engine-state.js";
import type { WatchDefinition } from "@omnesis/watch";
import type { ChatRoleReadinessDeps } from "./models/chat-role-readiness.js";
import type { SourceDocCount } from "./search/source-isf-prior.js";
import type { WriteGate } from "./write-gate.js";
import type { AddressInfo } from "node:net";

const log = createLogger("gateway");
const GATEWAY_STARTED_AT = Date.now();

function parseJsonStringArrayEnv(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
      throw new Error("expected a JSON string array");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `${name} must be a JSON string array: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Parse a non-negative integer env var; undefined when unset, throws on junk. */
function parseNonNegativeIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

// mDNS / Bonjour advertiser. Started after the listen port is known
// (below), held at module scope so the shutdown coordinator can reach it.
let advertiser: MdnsAdvertiser | undefined;

// Crash on an unhandled promise rejection instead of silently limping —
// a supervised daemon gets restarted cleanly, which is much better than
// the "process alive, event loop wedged" state we used to hit (the
// previous failure mode where an embedder stall left the gateway
// accepting connections but not processing any of them).
process.on("unhandledRejection", (reason) => {
  log.error(
    `Unhandled promise rejection — exiting so a supervisor can restart: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.error(
    `Uncaught exception — exiting: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});

const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
const DB_PATH = process.env.OMNESIS_DB_PATH ?? join(configDir, "omnesis.db");
const PORT = parseInt(process.env.OMNESIS_GATEWAY_PORT ?? "7600", 10);

// Single source of truth for all user-editable settings. The file is watched
// for external edits (vim, CLI, portal); API mutations go through the same
// store and broadcast `config.changed` to connected devices.
applyPrivateUmask();
ensurePrivateDirSync(configDir);
// One gateway per config dir, decided before any store is opened: a second
// process on these files is refused here, not discovered by a corrupted
// analytics store later. A predecessor still shutting down is waited for.
const lockWaitEnv = process.env.OMNESIS_GATEWAY_LOCK_WAIT_MS;
const gatewayLock = await acquireGatewayLock(configDir, {
  // How long to wait for a predecessor to release the directory. The default
  // covers the gateway's own shutdown budget; a harness that boots a second
  // gateway on purpose shortens it, down to zero.
  waitMs: lockWaitEnv !== undefined && /^\d+$/.test(lockWaitEnv) ? Number(lockWaitEnv) : undefined,
  onWaiting: (holder) =>
    log.warn(
      `Gateway PID ${holder.pid} still owns ${configDir}; waiting for it to exit before opening any store`,
    ),
}).catch((err) => {
  log.error(`Cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
await primeSecretFileKeyCache({ configDir }).catch((err) => {
  log.warn(
    `Could not prime secret-file root key cache: ${err instanceof Error ? err.message : String(err)}`,
  );
});
// Drop a commented `.env` template into the config dir on first boot so
// operators have a discoverable place to set bootstrap vars (#52). Never
// overwrites an existing file.
if (scaffoldDotEnv(configDir)) {
  log.info(`Wrote a commented .env template to ${configDir}/.env — edit it to set bootstrap vars`);
}
// The operator's standing instructions to the agent — optional, absent until
// they write it. Read per prompt build (mtime-cached), so an edit in a terminal
// editor or the portal reaches the next run with no restart.
const operatorInstructions = new OperatorInstructionsStore(configDir);

const configStore = new ConfigStore({ filePath: defaultConfigPath(configDir) });
try {
  await configStore.load();
} catch (err) {
  if (err instanceof ConfigBootError) {
    // Refuse to start on a broken config rather than silently degrade to
    // defaults and persist the loss. Render a clean operator message instead
    // of a raw stack trace, then exit so a supervisor surfaces it.
    log.error(`Cannot start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
const config = configStore.get();

// Resolve tunable runtime knobs (env > omnesis.json > hardcoded default).
// Everything that used to live behind OMNESIS_192_MITIGATIONS is now an
// individual key in `gateway.*` / `indexer.*`. See src/mitigations.ts.
const runtime = resolveRuntimeSettings(config);
announceRuntimeSettings(runtime);

const storageEncryption = await resolveGatewayStorageEncryptionKeys(configDir).catch((err) => {
  log.error(`Cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
const storagePosture = storageEncryptionPosture(storageEncryption.enabled);
log[storagePosture.level](storagePosture.message);

// Indexer cycle / reconcile / reindex-missing cadences are resolved
// further down against the loaded config (env > config > default) —
// see the `runtime` object.

// Model config
const MODELS_DIR = join(configDir, "models");
// One-shot mkdir at boot so getSystemInfo's per-call statfs no longer
// has to defend against a missing directory. The previous
// mkdir-on-first-call inside `probeFreeBytes` made `getSystemInfo`
// have a side effect on every poll.
ensureModelsDir(MODELS_DIR);

// ── Inference registry ──────────────────────────────────────────────
// Single source of truth for how capability slots (embedder, agent,
// transcriber, …) map to concrete backends. Reads from the `inference`
// config block, probes HTTP backends, and resolves assignments.
const manifestPath = join(MODELS_DIR, "manifest.json");
const modelsDevCatalog = new ModelsDevCatalog({ configDir });
const anthropicCatalogService = new AnthropicCatalogService({
  readApiKey: () => resolveAnthropicApiKey(configDir),
  credentialSource: () => resolveAnthropicCredential(configDir)?.source,
});
anthropicCatalogService.start();
const inferenceRegistry = new InferenceRegistry({
  modelsDir: MODELS_DIR,
  configDir,
  manifest: () => loadManifest(manifestPath).manifest,
  hasAnthropicApiKey: () => resolveAnthropicApiKey(configDir) !== null,
  getCatalogEntry: (id) => anthropicCatalogService.getCatalogEntry(id),
  getAnthropicStatus: () => anthropicCatalogService.status(),
  getModelControls: (backendKey, model, backendUrl, protocol) =>
    modelsDevCatalog.controlsForBackend(backendKey, model, backendUrl, protocol),
});
inferenceRegistry.loadConfig(config);

// Probe HTTP backends asynchronously. The probe promise is stored so
// startIndexer() can await it before resolving assignments — this
// ensures the registry has up-to-date backend status (including
// discovered models) when the indexer boots.
const initialProbe = inferenceRegistry.probeBackends().catch((err) => {
  log.warn(`Backend probe failed: ${err instanceof Error ? err.message : String(err)}`);
});

const indexerStatus = new IndexerStatusReporter();

// One-shot schema creation + migrations on the main thread. We close
// this writable handle immediately after so the writer worker is the
// only connection with write access from this point on (#192).
{
  const bootDb = createDatabase(DB_PATH, { encryptionKey: storageEncryption.mainDbKey });
  bootDb.close();
}

// Scheduler is the single brain for "an IO task that needs to be done"
// in the gateway: priority queues, anti-starvation, continuations,
// coalesce, periodic ticks, wake debounce, metrics, SLA.
//
// Three runners cover every consumer:
//   - writer  → single writable better-sqlite3 handle on omnesis.db
//               (the post-#192 single-writer invariant lives in this
//               worker; Scheduler just owns its priority queue).
//   - compute → read-only handle, hosts the SELECT-side halves of
//               compute/upsert splits (mergeCandidates, peopleCounts,
//               sourceStatsRow, …) that used to run on the legacy
//               backfill-worker thread.
//   - main    → in-process, hosts orchestration tasks (the periodic
//               backfill tasks, the auth flush, the indexer wake).
// Worker entries resolve to .ts source under tsx (with the register-tsx
// preload) or to the emitted dist/*.js siblings when running compiled.
const REGISTER_TSX = "./workers/register-tsx.mjs";
const writerWorker = resolveWorkerEntry(
  "./workers/writer-worker.ts",
  import.meta.url,
  REGISTER_TSX,
);
const ioWorker = resolveWorkerEntry("./workers/io-worker.ts", import.meta.url, REGISTER_TSX);
const cpuWorker = resolveWorkerEntry("./workers/cpu-worker.ts", import.meta.url, REGISTER_TSX);
const searchWorker = resolveWorkerEntry(
  "./workers/search-worker.ts",
  import.meta.url,
  REGISTER_TSX,
);
const searchWarmWorker = resolveWorkerEntry(
  "./workers/search-warm-worker.ts",
  import.meta.url,
  REGISTER_TSX,
);
const scheduler = new Scheduler({
  admission: runtime.admission,
  reservedUserSlotsByRunner: { io: runtime.ioReservedUserSlots },
});
scheduler.registerRunner(
  new WriterTaskRunner({
    gatewayDbPath: DB_PATH,
    gatewayDbKeyHex: storageEncryption.mainDbKeyHex,
    journalMode: runtime.journalMode,
    workerUrl: writerWorker.url,
    workerExecArgv: writerWorker.execArgv,
  }),
);
scheduler.registerRunner(
  new IoTaskRunner({
    gatewayDbPath: DB_PATH,
    gatewayDbKeyHex: storageEncryption.mainDbKeyHex,
    concurrency: runtime.ioConcurrency,
    backgroundWorkerNice: runtime.backgroundWorkerNice,
    cacheSizeBytes: runtime.ioReadCacheSizeBytes,
    workerUrl: ioWorker.url,
    workerExecArgv: ioWorker.execArgv,
  }),
);
scheduler.registerRunner(new MainTaskRunner({ concurrency: 16 }));
scheduler.registerRunner(
  new CpuTaskRunner({
    concurrency: runtime.cpuConcurrency,
    backgroundWorkerNice: runtime.backgroundWorkerNice,
    workerUrl: cpuWorker.url,
    workerExecArgv: cpuWorker.execArgv,
  }),
);
await scheduler.start();

// One install-aware release lookup per gateway, kept out of spawned E2E
// gateways so the test lane is hermetic even when the host has network access.
// This task only records a successful answer; it never downloads or installs.
const releaseChecksAllowed = process.env.OMNESIS_E2E_DISABLE_RELEASE_CHECK !== "1";
const releaseCheckService = new ReleaseCheckService({
  configDir,
  argv1Path: process.argv[1] ?? "",
  currentVersion: GATEWAY_VERSION,
  enabled: releaseChecksAllowed && config.releaseCheck !== false,
});
const portalFleetUpdateFixture = portalFleetUpdateE2EFixture({
  env: process.env,
  configDir,
  gatewayVersion: GATEWAY_VERSION,
});
const releaseCheckTask = createReleaseCheckTask(releaseCheckService);
const releaseCheckHandle = scheduler.schedule(releaseCheckTask);
void releaseCheckHandle;
configStore.onChange((_before, after, changedPaths) => {
  if (!changedPaths.includes("/releaseCheck")) return;
  const enabled = releaseChecksAllowed && after.releaseCheck !== false;
  releaseCheckService.setEnabled(enabled);
  if (enabled) scheduler.kickPeriodic(releaseCheckTask.name);
});

// Typed gate for writer ops — drop-in replacement for the legacy
// WriterWorkerProxy. server.ts and ws.ts consume this as a WriteGate;
// they never see the Scheduler directly.
const writeGate: WriteGate = writeGateFromScheduler(scheduler);
const ioGate = ioGateFromScheduler(scheduler);
const cpuGate = cpuGateFromScheduler(scheduler);

// Main-thread READ-ONLY handle — used by every SELECT on the HTTP
// path, by WS device lookups, and by the search pipeline. Post-#192
// the main thread can't open writable; any accidental write here now
// fails fast with SQLITE_READONLY instead of silently reintroducing
// the `-shm` mmap race.
const db = openReadOnlyDatabase(DB_PATH, {
  encryptionKey: storageEncryption.mainDbKey,
  cacheSizeBytes: runtime.readCacheSizeBytes,
});

// Bootstrap device + admin token on first startup. Token is written to
// <configDir>/token (mode 0600) so CLIs can pick it up, and is used to pair
// real devices via POST /admin/devices/pair. Revoke after first pairing.
const bootstrapToken = await writeGate.ensureBootstrapToken(configDir);
if (bootstrapToken) {
  log.info(
    `Bootstrap admin token generated and saved to ${configDir}/token — use 'cli devices pair' to provision a real device, then revoke.`,
  );
}

const syncStatus = new SyncStatusRegistry();
const authFlows = new AuthFlowRegistry({
  ttlMs: runtime.authFlowTtlMs,
  onExpire: async (flow) => {
    await wsServerRef.current?.sendCommand(
      flow.deviceId,
      "auth.cancel",
      { flowId: flow.id },
      5_000,
    );
  },
});
const importFlows = new ImportFlowRegistry();

// APNs client for iOS push — a watch notifying the operator's phones, and the
// built-in needs-auth re-auth reminder (#617). Wired only when the
// operator has set `gateway.apns` in omnesis.json — otherwise null, and
// both push paths become logged no-ops.
//
// Held in a mutable `liveApnsClient` so the single configStore.onChange
// listener below can hot-swap it (so `omnesis push setup` activates push
// without a gateway restart). The push transport takes the new client via
// setApnsClient; the needs-auth notifier reads it through a thunk, so both
// always see the current instance.
const buildApnsClient = (cfg: OmnesisConfig): ApnsClient | null => {
  const apnsCfg = cfg.gateway?.apns;
  if (!apnsCfg) return null;
  // OMNESIS_APNS_BASE_URL overrides the config field, which in turn
  // overrides Apple's hosts. Used by end-to-end tests (fake APNs
  // server) and an on-host APNs proxy/relay; unset in normal operation.
  const baseUrl = process.env.OMNESIS_APNS_BASE_URL ?? apnsCfg.baseUrl;
  log.info(
    `APNs client wired: keyId=${apnsCfg.keyId} bundle=${apnsCfg.bundleId} env=${apnsCfg.environment}${baseUrl ? ` baseUrl=${baseUrl}` : ""}`,
  );
  return new ApnsClient({ config: apnsCfg, baseUrl });
};
let liveApnsClient = buildApnsClient(config);

const buildFcmClient = (cfg: OmnesisConfig): FcmClient | null => {
  const fcmCfg = cfg.gateway?.fcm;
  if (!fcmCfg) return null;
  log.info(`FCM client wired for Android push delivery`);
  return new FcmClient({ config: fcmCfg });
};
let liveFcmClient = buildFcmClient(config);

const getRelaySettings = (): { enabled: boolean; url: string; visible: boolean } => {
  return resolveRelaySettings(configStore.get());
};

const wsServerRef: { current?: DeviceWsServer } = {};
let watchV2EngineHandle: import("./watch/engine-task.js").WatchV2Engine | undefined;
const pushBroadcaster = new PushBroadcaster({
  queue: writeGate,
  listDevices: () => listDevices(db),
  apnsClient: {
    send: (wake) => {
      if (!liveApnsClient) throw new Error("APNs is not configured");
      return liveApnsClient.send(wake);
    },
  },
  fcmClient: {
    send: (wake) => {
      if (!liveFcmClient) throw new Error("FCM is not configured");
      return liveFcmClient.send(wake);
    },
  },
  relayClient: new RelayPushClient({
    deliveryUrl: process.env.OMNESIS_PUSH_RELAY_DELIVERY_URL,
  }),
  socket: {
    isConnected: (deviceId) => wsServerRef.current?.isConnected(deviceId) ?? false,
    sendEventToDevice: (deviceId, event) =>
      wsServerRef.current?.sendEventToDevice(deviceId, event) ?? false,
  },
  relayUrl: () => getRelaySettings().url,
  clearApnsRegistration: (deviceId, expected) => writeGate.clearDeviceApnsToken(deviceId, expected),
  clearFcmRegistration: (deviceId, expected) => writeGate.clearDeviceFcmToken(deviceId, expected),
  wakeRetry: () => ({
    ...DEFAULT_PUSH_WAKE_RETRY_SETTINGS,
    ...configStore.get().gateway?.pushWakeRetry,
  }),
  beforeWakeRetrySweep: async (now) => {
    const engine = watchV2EngineHandle;
    if (!engine) return;
    const outcomes = [...allWatchNotificationWakeOutcomes(db, now).values()].flatMap((byFiring) => [
      ...byFiring.values(),
    ]);
    await engine.reconcilePushRetryOutcomes(outcomes);
  },
});
const pushWakeRetrySettings = {
  ...DEFAULT_PUSH_WAKE_RETRY_SETTINGS,
  ...config.gateway?.pushWakeRetry,
};
const pushWakeRetryBundle = createPushWakeRetryTask(
  pushBroadcaster,
  scheduler,
  log.child("push:wake-retry"),
  {
    intervalMs: pushWakeRetrySettings.intervalMs,
    idleIntervalMs: pushWakeRetrySettings.idleIntervalMs,
  },
);

// Built-in re-auth reminder: pushed when a member device's grant for a
// provider connection needs re-auth. Reads the live APNs client + device
// list + clear-token through the same callbacks a watch's notification
// uses; the backoff gate reservation and recovery operations provide
// persisted per-(connection, device) de-dup + exponential backoff so one
// revoke nudges once, not once per source per tick (#683). The backoff
// schedule is a boot-time config snapshot.
const reauthBackoffConfig = resolveReauthBackoffConfig(config.gateway?.reauthReminders);
const needsAuthNotifier = new NeedsAuthNotifier({
  publisher: pushBroadcaster,
  reserve: (principal, deviceId) =>
    writeGate.reserveReauthReminder(principal, deviceId, Date.now(), reauthBackoffConfig),
  retain: async (reservation, message, deviceIds) => {
    const now = Date.now();
    const retained = await writeGate.commitReauthReminderNotification(reservation, now, {
      message,
      deviceIds,
      createdAt: now,
      expiresAt: now + DEFAULT_NOTIFICATION_TTL_MS,
    });
    return retained?.deviceIds ?? null;
  },
  release: async (reservation) => {
    await writeGate.releaseReauthReminder(reservation);
  },
  recover: async (principal, deviceId, collapsePrefix) => {
    await writeGate.recoverReauthReminder(principal, deviceId, collapsePrefix, Date.now());
  },
  deviceName: (deviceId) => getDevice(db, deviceId)?.name ?? deviceId,
});
const sourcePermissionReminderConfig = resolveSourcePermissionReminderConfig(
  config.gateway?.mobilePermissionReminders,
);
const mobilePermissionNotifier = new SourcePermissionNotifier({
  db,
  writeGate,
  publisher: pushBroadcaster,
  listDevices: () => listDevices(db),
  deviceName: (deviceId) => getDevice(db, deviceId)?.name.trim() || "the affected device",
  sourceName: (sourceId, sourceType) => {
    const meta = getSourceMeta(db);
    return meta[sourceId]?.label?.trim() || meta[sourceType]?.label?.trim() || "Mobile source";
  },
  config: sourcePermissionReminderConfig,
});

const privacyApprovalNotifier = new PrivacyApprovalNotifier(pushBroadcaster);
const accessAuthorizationNotifier = new AccessAuthorizationNotifier(pushBroadcaster);

// Tells the operator's phones that a conversation they were not looking at has
// something new in it. At most one banner per unread episode; the decision is
// the read-state store's, this only delivers it.
const conversationNotifier = new ConversationNotifier(pushBroadcaster);

// The socket server does not exist yet, so the fleet service resolves it
// through the same ref the rest of the boot uses. A pending update simply
// stays pending until there is a socket to send it on.
const fleetUpdate = new FleetUpdateService({
  db,
  writeGate,
  wsServer: () => wsServerRef.current,
  sourceCommit: runningSourceCommit(configDir, import.meta.url, GATEWAY_STARTED_AT),
});
const hostFleetUpdate = new HostFleetUpdateService({
  configDir,
  getReleaseCheck: () => portalFleetUpdateFixture?.release ?? releaseCheckService.snapshot(),
  fleetUpdate,
  launcher: portalFleetUpdateFixture?.launcher ?? new ServiceManagerPortalFleetUpdateLauncher(),
});
const deviceDoctor = new DeviceDoctorService({
  db,
  writeGate,
  wsServer: () => wsServerRef.current,
});
const wsEventHandler = new WsEventHandler({
  db,
  writeGate,
  syncStatus,
  authFlows,
  importFlows,
  needsAuthNotifier,
  fleetUpdate,
  deviceDoctor,
});
const wsServer = new DeviceWsServer({
  db,
  writeGate,
  authTimeoutMs: runtime.wsAuthTimeoutMs,
  heartbeatIntervalMs: runtime.wsHeartbeatIntervalMs,
  commandTimeoutMs: runtime.wsCommandTimeoutMs,
  onDeviceEvent: (conn, event) => wsEventHandler.handleEvent(conn, event),
  onDeviceCommand: (conn, command) => wsEventHandler.handleCommand(conn, command),
  onDeviceConnected: (conn) => wsEventHandler.handleConnected(conn),
  onDeviceDisconnected: (conn) => wsEventHandler.handleDisconnected(conn),
  onCollectorConnected: (deviceId) => updateCollectorDeclarationPresence(writeGate, deviceId, true),
  onCollectorDisconnected: (deviceId) =>
    updateCollectorDeclarationPresence(writeGate, deviceId, false),
});
wsServerRef.current = wsServer;
wsEventHandler.attachServer(wsServer);

// Index database (separate file from gateway DB)
const indexDbPath = process.env.OMNESIS_INDEX_DB_PATH ?? join(configDir, "index.db");
ensurePrivateDirSync(configDir);
const indexDb = createIndexDatabase(indexDbPath, { encryptionKey: storageEncryption.indexDbKey });
for (const documentId of listInterruptedOmnesisChatRetentionDocumentIds(db)) {
  enqueueDocumentIndexPurge(indexDb, documentId, true);
}
{
  const startedAt = Date.now();
  const reconciled = reconcileIndexForGatewaySchema(db, indexDb);
  if (reconciled.ran) {
    log.info(
      `Index reconciled for gateway schema v${reconciled.gatewaySchemaVersion}: removed ${reconciled.removedDocuments} stale document(s) and ${reconciled.removedChunks} chunk(s) in ${Date.now() - startedAt}ms`,
    );
  }
}
{
  const scrubbed = scrubPendingSourceIndexPurges(indexDb);
  if (scrubbed.sourceIds.length > 0) {
    log.info(
      `Re-applied ${scrubbed.sourceIds.length} pending source-index purge(s) before search startup: removed ${scrubbed.deletedDocuments} document(s)`,
    );
  }
}
if (storageEncryption.enabled) {
  // Under encryption the plaintext sidecar is never durable — only the
  // encrypted `.enc` is. Purge every plaintext working file + leftover crypto
  // temp (the purge regex keeps `.enc`), then re-materialise the ACTIVE
  // generation's plaintext graph from its `.enc` ONLY when a fingerprint proves
  // it is consistent with index.db. On any mismatch/tamper we leave no
  // plaintext file, so the indexer worker rebuilds the graph from
  // chunks.embedding — never a re-embed, never an index wipe.
  purgeUsearchSidecars(configDir);
  purgeSidecarTemps(configDir);
  const activeTarget = resolveActiveUsearchTarget(indexDb, configDir);
  const restore = storageEncryption.indexDbKey
    ? restoreActiveSidecar({
        encPath: `${activeTarget.path}.enc`,
        plaintextPath: activeTarget.path,
        indexDbKey: storageEncryption.indexDbKey,
        expectedSeq: getVectorWriteSeq(indexDb),
        expectedModel: getIndexEmbedModel(indexDb),
      })
    : { restored: false, reason: "no index-db key" };
  if (restore.restored) {
    // The restored plaintext reflects the sidecar's seq (which equals the live
    // `vector_write_seq` — that is why the restore was accepted). Record it as
    // `usearch_saved_seq` so a subsequent shutdown can re-encrypt this graph
    // even though the indexer worker skips its backfill (and thus its save +
    // stamp) after a restore. Without this an idle gateway restarted right after
    // a restore-boot would find `usearch_saved_seq` unset and skip the persist.
    setUsearchSavedSeq(indexDb, restore.seq ?? getVectorWriteSeq(indexDb));
    log.info(
      `HNSW sidecar restored from encrypted persistence (write-seq ${restore.seq}) — skipping rebuild`,
    );
  } else {
    log.info(`HNSW sidecar will rebuild from vectors: ${restore.reason}`);
  }
}

// Search pipeline (available immediately with BM25; embedder added later)
const searchConfig = config.search as unknown as SearchConfig | undefined;

// Snapshot isolation for the search handle. When enabled, search SQL
// runs against a dedicated read-only connection in a long-lived
// `BEGIN`. Phase-0 E8a measurement showed snapshot isolation is NOT
// subsumed by mmap — even with mmap=1 GiB on the read handle, snapshot
// OFF produces 10× the p99 tail of snapshot ON. The mechanism is
// stable WAL-frame visibility (no per-statement WAL-index walk), plus
// indirect pacing of the writer via WAL pinning.
//
// Default is `true` because the Phase-0 winning configuration (E6)
// has it on. Operator can opt out via `search.snapshot.enabled =
// false` in `omnesis.json`. See `search/snapshot-handle.ts` for the
// mechanism and the refresh-task failure mode (a stalled refresh
// pins the WAL indefinitely; mitigated by the periodic timer not
// being held across event-loop turns).
const snapshotEnabled = searchConfig?.snapshot?.enabled ?? true;
const snapshotRefreshMs = searchConfig?.snapshot?.refreshIntervalMs ?? 600_000;
// Read-only handle tunables. The mmap default (1 GiB) is the Phase-0
// winning configuration: OS-unified-cache sharing across all
// connections drops p99 by 82% under live ingest vs the historical
// mmap=0. Operator can disable via search.readHandle.mmapBytes = 0 if
// any #192-class SIGBUS shows up after deploy.
const readMmapBytes = searchConfig?.readHandle?.mmapBytes ?? DEFAULT_SEARCH_READ_MMAP_BYTES;
const readCacheBytes = searchConfig?.readHandle?.cacheSizeBytes ?? DEFAULT_SEARCH_READ_CACHE_BYTES;
// We always open a dedicated read-only handle for search, regardless
// of whether snapshot isolation is enabled. This lets the operator
// apply the readHandle pragmas (mmap, cache_size) independently of
// the snapshot.enabled flag — the two knobs are now orthogonal.
// `holdSnapshot=snapshotEnabled` controls whether the handle holds a
// long-lived BEGIN with periodic refresh.
const searchSnapshot: SearchSnapshotHandle = openSearchSnapshotHandle(indexDbPath, {
  holdSnapshot: snapshotEnabled,
  refreshIntervalMs: snapshotRefreshMs,
  mmapBytes: readMmapBytes,
  cacheSizeBytes: readCacheBytes,
  encryptionKey: storageEncryption.indexDbKey,
});
const searchIndexDb = searchSnapshot.db;
log.info(
  `search read handle opened: snapshot=${snapshotEnabled ? "on" : "off"} ` +
    `mmap=${readMmapBytes}B cache=${readCacheBytes}B` +
    (snapshotEnabled ? ` refresh=${snapshotRefreshMs}ms` : ""),
);

// Pre-warm the caches under index.db so the first search after a restart
// doesn't pay the cold-disk penalty. `prewarmFtsCaches`'s full-table scans
// run on a throwaway worker thread with its own read-only handle — opened with
// the snapshot handle's mmap setting and closed when the scans finish — so
// the main event loop stays responsive for the tens of seconds they take on
// a large corpus. What the scans leave behind is the kernel page cache, which
// the search workers' handles read through. The readiness probe flips to
// "ready" before warming completes: a query that arrives mid-warm may run
// cold; every subsequent one benefits.
const prewarmEnabled = config.search?.readHandle?.prewarm ?? true;
// Small on purpose: the handle's own page cache dies with the thread, so it is
// transient native memory that buys nothing beyond the kernel cache the scans fill.
const SEARCH_WARM_PAGE_CACHE_BYTES = 64 * 1024 * 1024;
let searchCacheWarm: SearchCacheWarm | undefined;
function scheduleSearchCachePrewarm(): void {
  if (!prewarmEnabled) {
    log.info("search cache pre-warm disabled by config");
    return;
  }

  const warm = startSearchCacheWarm({
    indexDbPath,
    indexDbKeyHex: storageEncryption.indexDbKeyHex,
    mmapBytes: readMmapBytes,
    cacheSizeBytes: SEARCH_WARM_PAGE_CACHE_BYTES,
    backgroundWorkerNice: runtime.backgroundWorkerNice,
    workerUrl: searchWarmWorker.url,
    workerExecArgv: searchWarmWorker.execArgv,
  });
  searchCacheWarm = warm;
  warm.done
    .then(
      ({ rows, ms, stoppedBy }) =>
        log.info(
          `search cache pre-warm complete in ${ms}ms (${rows} rows` +
            (stoppedBy ? `; scans stopped early: ${stoppedBy})` : ")"),
        ),
      (err: unknown) =>
        log.warn(
          `search cache pre-warm failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    )
    .finally(() => {
      searchCacheWarm = undefined;
    });
}
// Surface the embedder model name in SearchResponse.models.embedding so
// the pipeline debug card can show "Vector (nomic-embed-text-v1.5.Q8_0 ...)".
const embedderResolved = inferenceRegistry.resolve("embedder");
const embeddingModelIdForPipeline =
  embedderResolved.kind === "local"
    ? embedderResolved.catalogId
    : embedderResolved.kind === "http"
      ? embedderResolved.model
      : "(none)";
// Concrete impls for the QueryEnricher / LinkRefSource ports declared
// in search/types.ts. The pipeline takes these as
// dependencies instead of importing people.ts/links.ts directly, so
// `search/` now has no compile-time edge into the people or links
// subsystems.
const searchQueryEnricher = {
  resolvePersonIds: (text: string) => resolvePersonIdsFromQuery(db, text),
  getSelfPersonId: () => getSelfPersonId(db),
};
const searchLinkRefSource = {
  getInboundRefCounts: (docIds: readonly string[]) => getInboundRefCounts(db, [...docIds]),
};
// Versioned read router (#1011). Follows the `active_version` pointer and
// opens the read handle on the active generation's usearch file at that
// generation's OWN embedding dimension. Always a live handle (empty until
// the writer produces a file); it re-views on demand (`maybeRefresh()`), so
// vectors written after boot — new docs, and re-embeds after an embedder
// swap — become searchable without a gateway restart. With a single active
// generation this is behaviour-identical to opening `index.usearch`
// directly; the registry is what lets a later chunk hot-swap the serving
// generation.
// Crash safety: probe the active-generation sidecar in a throwaway subprocess
// and quarantine it if it's corrupt, BEFORE anything opens it in-process. A
// corrupt HNSW file aborts the process inside the native load()/view() (no
// catchable error), which would crash-loop the gateway; quarantining lets it
// rebuild from index.db instead. Runs here — before both the read registry
// (next line) and the later indexer-worker spawn open the same file — so one
// probe protects both.
{
  const { path: usearchPath, dim: usearchDim } = resolveActiveUsearchTarget(indexDb, configDir);
  const existedBefore = existsSync(usearchPath);
  quarantineCorruptUsearch(usearchPath, usearchDim);
  if (storageEncryption.enabled && existedBefore && !existsSync(usearchPath)) {
    // A plaintext graph existed only because the boot step decrypted it from a
    // fingerprint-consistent `.enc`; if quarantine then moved it aside, the
    // graph is structurally corrupt. Drop its `.enc` too so the next boot
    // rebuilds from chunks.embedding instead of re-decrypting the corruption.
    tryUnlinkSidecar(`${usearchPath}.enc`);
    log.warn(
      "Quarantined a corrupt decrypted HNSW graph; dropped its encrypted sidecar — will rebuild from vectors",
    );
  }
}
const usearchReadHandle = new UsearchReadRegistry(indexDb, configDir);
log.info(`HNSW read handle opened: ${usearchReadHandle.size()} vectors`);

// Cached per-source document counts for automatic inverse-source-frequency
// priors. Reads the maintained `source_stats` table (a handful of rows); the
// TTL keeps it off the per-search hot path. The prior is a soft ranking nudge,
// not a correctness input, so up-to-TTL staleness is fine — a newly-added
// source just gets its rarity boost a few minutes late. Empty/missing stats →
// no counts → the auto prior stays inert.
const SOURCE_DOC_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
let sourceDocCountCache: { at: number; counts: SourceDocCount[] } | null = null;
const getSourceDocCounts = (): readonly SourceDocCount[] => {
  const now = Date.now();
  if (sourceDocCountCache && now - sourceDocCountCache.at < SOURCE_DOC_COUNT_CACHE_TTL_MS) {
    return sourceDocCountCache.counts;
  }
  let counts: SourceDocCount[];
  try {
    counts = db
      .prepare<
        [],
        { sourceId: string; docCount: number }
      >("SELECT source_id AS sourceId, doc_count AS docCount FROM source_stats WHERE doc_count > 0")
      .all();
  } catch {
    counts = [];
  }
  sourceDocCountCache = { at: now, counts };
  return counts;
};

const searchPipeline = new SearchPipeline({
  indexDb: searchIndexDb,
  searchConfig,
  embeddingModelId: embeddingModelIdForPipeline,
  queryEnricher: searchQueryEnricher,
  linkRefSource: searchLinkRefSource,
  usearchRead: usearchReadHandle,
  getSourceDocCounts,
  // Phase-0 instrumentation. Slow-search log lines emit the
  // scheduler's inflight task set so we can correlate stalls with
  // concurrent writer / background work. Cheap — one Map walk per
  // runner, only invoked when totalMs > the slow threshold.
  inflightSummary: () => scheduler.inflightSummary(),
});
searchPipeline.setGatewayDb(db);

// Dedicated search-worker pool (Slice 3B): relocate the heavy
// candidate-generation block (BM25 + usearch + fusion/boost/diversity + hydrate)
// off the main event loop onto a worker thread with its OWN read-only index.db
// handle + usearch read registry. Gated on concurrency > 0 — 0 keeps the pure
// main-thread candidate-gen (pre-slice behaviour). A failed start degrades
// cleanly: the pipeline's gate falls back to running the identical
// `runCandidateGen` inline on main, so search is never failed by a worker fault.
let searchWorkerPool: SearchWorkerPool | undefined;
if (runtime.searchWorkerConcurrency > 0) {
  const pool = new SearchWorkerPool({
    indexDbPath,
    indexDbKeyHex: storageEncryption.indexDbKeyHex,
    configDir,
    cacheSizeBytes: runtime.searchWorkerCacheSizeBytes,
    concurrency: runtime.searchWorkerConcurrency,
    maxInflightBeforeFallback: runtime.searchWorkerMaxInflight,
    backgroundWorkerNice: runtime.backgroundWorkerNice,
    workerUrl: searchWorker.url,
    workerExecArgv: searchWorker.execArgv,
  });
  searchWorkerPool = pool;
  searchPipeline.setSearchPool(pool);
  // Fire-and-forget: don't block gateway boot on the worker's read-handle open.
  // Until it reports ready the gate falls back to main; a hard start failure
  // disposes the pool so the gate stays on main permanently. A worker that
  // dies after the pool has started is the pool's own business — it respawns
  // it, backing off and giving up on a slot that keeps crashing.
  pool.start().catch(async (err) => {
    log.error(
      `search worker pool failed to start — candidate generation stays on the main thread: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await pool.dispose().catch(() => {});
  });
}

// Per-process metrics + analytics DB are initialised here (earlier than
// most other subsystems) so the agent harness — which constructs its
// run_sql port over `analyticsDb` — has them available by the time the
// agent block runs further down. Moving these here is purely an
// ordering concern; the analytics writer queue still sees every
// downstream sync write because nothing downstream of this point
// writes before the agent block runs.
const metrics = new MetricsRegistry();
setBusyRetryRecorder((op) => metrics.recordBusyRetry(op));

const processVitals = new ProcessVitalsCollector();
processVitals.start();
const analyticsDbPath = process.env.OMNESIS_ANALYTICS_DB_PATH ?? join(configDir, "analytics.db");
const backupsDir = join(configDir, "backups");
const exportsDir = join(configDir, "exports");
// The coordinated shutdown is assembled once every subsystem exists, at the
// end of this module; until then a fatal store error can only exit outright.
let coordinatedShutdown: ((exitCode: number) => Promise<void>) | null = null;
function requestShutdown(exitCode: number): void {
  if (coordinatedShutdown) {
    void coordinatedShutdown(exitCode);
    return;
  }
  log.error(`Fatal error before the gateway finished booting; exiting with code ${exitCode}`);
  process.exit(exitCode);
}
const analyticsDb = new AnalyticsDb(analyticsDbPath, {
  metrics,
  encryptionKeyHex: storageEncryption.analyticsDbKeyHex,
  maxInlineStreamRekeyRows: runtime.analyticsStreamRekeyMaxRows,
  memoryLimitMiB: runtime.analyticsMemoryLimitMb,
  threads: runtime.analyticsThreads,
  // DuckDB keeps failing every statement once it has invalidated the store;
  // only reopening the file recovers, so exit non-zero and let the service
  // manager bring the gateway back.
  onFatal: () => requestShutdown(1),
});
await analyticsDb.open();
// Cross-store search hydration (#450): a hit whose source declares a
// `boundDocument` carries its co-described analytics row when the request sets
// `includeBoundRow`. Wired here (not at pipeline construction) because the
// analytics DB initialises after the pipeline.
searchPipeline.setBoundRowResolver(analyticsDb);

// Online backup: SQLite stores are vacuumed on a worker thread;
// the DuckDB analytics store is copied through the live pool (a second
// DuckDB instance can't open the locked file). Serves /admin/backup*.
const backupService = new BackupService({
  configDir,
  backupsDir,
  gatewayDbPath: DB_PATH,
  gatewayDbKeyHex: storageEncryption.mainDbKeyHex,
  indexDbPath,
  indexDbKeyHex: storageEncryption.indexDbKeyHex,
  // The canonical path rather than the one this boot settled on: a backup runs
  // long after startup has adopted any legacy journal, and taking the pure
  // function here keeps the backup service independent of boot ordering.
  watchDbPath: watchJournalPath(configDir),
  watchDbKeyHex: storageEncryption.watchDbKeyHex,
  analyticsDbPath,
  analyticsBackup: (dest) => analyticsDb.backupTo(dest),
  minFreeDiskBytes: () => resolveRuntimeSettings(configStore.get()).minFreeDiskMb * 1024 * 1024,
  preUpdateRetentionCount: () =>
    configStore.get().backupRetention?.preUpdateCount ?? DEFAULT_PRE_UPDATE_BACKUP_COUNT,
});

// Portable data export: documents stream to JSONL/CSV on a worker
// thread; analytics tables are copied to CSV through the live DuckDB pool
// (a second instance can't open the locked file). Serves /admin/export*.
const exportService = new ExportService({
  configDir,
  exportsDir,
  gatewayDbPath: DB_PATH,
  gatewayDbKeyHex: storageEncryption.mainDbKeyHex,
  analyticsExport: (destDir) => analyticsDb.exportTablesToCsv(destDir),
});

/**
 * The filesystem half of chat-role readiness: whether a replay assignment's
 * fixture actually resolves. `resolveRoleBackend` builds the replay backend
 * eagerly and returns null when the path cannot be loaded, so a non-empty
 * string is not enough — a typo'd path has to read as not runnable here too.
 * Applies the resolver's own precedence: the env override wins over the
 * assignment, and both are read fresh so an edit takes effect without a
 * restart.
 */
const chatRoleReadinessDeps: ChatRoleReadinessDeps = {
  hasReplayFixture: (fixture) => {
    const path = process.env.OMNESIS_AGENT_FIXTURE ?? fixture ?? "";
    if (path.length === 0) return false;
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
};

const codexRuntimeService = new CodexRuntimeService({
  configDir,
  command: process.env.OMNESIS_CODEX_COMMAND,
  args: parseJsonStringArrayEnv("OMNESIS_CODEX_ARGS_JSON") ?? undefined,
  versionArgs: parseJsonStringArrayEnv("OMNESIS_CODEX_VERSION_ARGS_JSON") ?? undefined,
  interactivePoolSize:
    parseNonNegativeIntEnv("OMNESIS_CODEX_INTERACTIVE_POOL_SIZE") ??
    config.inference?.codex?.interactivePoolSize,
  inferencePoolSize:
    parseNonNegativeIntEnv("OMNESIS_CODEX_INFERENCE_POOL_SIZE") ??
    config.inference?.codex?.inferencePoolSize,
  getSubagentDepthCap: () =>
    configStore.get().agent?.subagentDepthCap ?? CONFIG_DEFAULTS.agent.subagentDepthCap,
});
const inferenceOverviewWithCodex = () => ({
  ...inferenceRegistry.getOverview(),
  codex: codexRuntimeService.snapshot(),
});
{
  void codexRuntimeService.refresh().catch((err) => {
    log.warn(
      `Codex model status refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// ─── Agent harness ─────────────────────────────────────────────────────────
// The demo agent that runs inside the gateway. Configuration is resolved
// in this order (most-specific wins): env vars → `agent` section in
// `omnesis.json` → compiled defaults. The Anthropic key is read from
// the same `<configDir>/anthropic-credentials.json` every other Anthropic-
// backed role uses (managed on the portal's Models tab) — no separate secret.
//
// When the agent is *configured* but missing a prerequisite (e.g. backend
// = "anthropic" without a key), we keep `agentService` undefined and pass
// a human-readable `agentDisabledReason` to the route layer; the portal's
// /agent view renders it as an actionable error pointing the user at the
// Models tab.
//
// The replay fixture references documents via stable `$DOC_<externalId>`
// and `$PERSON_<Name>` placeholders. At session-create time the backend
// factory reads the gateway DB and resolves them to the actual UUIDs the
// standard sync pipeline (collector + synth or real providers) assigned.
// The gateway does NOT seed any data itself — every document and source
// lands the normal way.

const conversationsDir = join(configDir, "conversations");
const conversationStore = new FsConversationStore(conversationsDir, (files, cutoffMs) =>
  ioGate.conversationRetentionCandidates([...files], cutoffMs),
);
const subscriptionsPolicyStore = new PrivacyPolicyStore(configDir, { db, writeGate });
// Access grants may bind Answer to the Default policy as soon as the HTTP
// server starts. Establish its first immutable revision before mounting any
// route so overview, consent, token issuance, and invocation all observe the
// same initialized authorization state on a fresh gateway.
await subscriptionsPolicyStore.get();

const agentLifecycle = new AgentLifecycle({
  inferenceRegistry,
  config,
  configStore,
  configDir,
  operatorInstructions,
  indexDb,
  wsEventHandler,
  log,
  db,
  searchPipeline,
  syncStatus,
  analyticsDb,
  writeGate,
  wsServer,
  conversationStore,
  privacyPolicyStore: subscriptionsPolicyStore,
  isApnsConfigured: () => pushTransport.isConfigured(),
  // Lazy for the same reason: the watch runtime is assembled further down, and
  // an install that runs without one answers null rather than throwing — the
  // agent's watch tools then say so instead of failing mid-turn.
  getWatchAuthoring: () => watchAuthoring ?? null,
  watchFirings: (watchId, limit) => watchV2EngineHandle?.firings(watchId, limit) ?? [],
  watchFiringCount: (watchId) => watchV2EngineHandle?.firingCount(watchId) ?? 0,
  // The agent's own pre-flight — the same closure the admin route uses, so the
  // two surfaces cannot answer a question about this install differently.
  // Assembled with the runtime, so this reads it rather than capturing it.
  watchPreflight: (watch, opts) =>
    watchPreflightHandle
      ? watchPreflightHandle(watch, opts)
      : Promise.resolve({
          outcome: "refused" as const,
          refusal: { reason: "no-runtime" as const },
        }),
  codexRuntimeService,
  // Read-worker gate — `lookup_people` runs its heavy assembly off the main
  // event loop (fires on nearly every agent turn).
  personLookupGate: ioGate,
  deleteDocumentIndexBatch: async (documentId, limit, sourceDeleted) => {
    return indexerLifecycle.deleteDocumentIndexBatch(documentId, limit, sourceDeleted);
  },
  notifyPrivacyApproval: (approvalId) => privacyApprovalNotifier.notify(approvalId),
  // Slow-answer push: an agent turn requested with `notifyAfterMs` that
  // outlives its budget delivers the finished answer over APNs.
  notifyAgentAnswer: (notification) =>
    sendAgentAnswerPush(
      {
        publisher: pushBroadcaster,
      },
      notification,
    ),
  // One banner per unread episode when the agent writes into a conversation
  // nobody was looking at. The decision is the read-state store's; this only
  // delivers it.
  notifyConversation: (notification) => conversationNotifier.notify(notification),
});
await agentLifecycle.bootAgent();

// metrics + analyticsDb were initialised earlier (see the block before
// the agent harness setup) so the agent's run_sql port could be wired.
// Routes/services downstream consume the same `metrics` and
// `analyticsDb` references from that earlier site.

// Resolve the embedding model from the inference registry. For HTTP
// backends the model name is auto-discovered by startIndexer()'s probe;
// the boot-time resolve may return an empty model (probe hasn't run).
// We mark HTTP backends as present so /index/stats doesn't flash
// "model-missing" during the startup window before startIndexer runs.
const bootEmbedResolved = inferenceRegistry.resolve("embedder");
const embeddingModelName =
  bootEmbedResolved.kind === "local"
    ? (bootEmbedResolved.catalogEntry?.filename ?? bootEmbedResolved.catalogId)
    : bootEmbedResolved.kind === "http"
      ? bootEmbedResolved.model || "(discovering...)"
      : "(none)";
const embeddingModelPath =
  bootEmbedResolved.kind === "local"
    ? bootEmbedResolved.modelPath
    : bootEmbedResolved.kind === "http"
      ? `(http: ${bootEmbedResolved.url})`
      : join(MODELS_DIR, "(none)");
const embeddingModelPresent =
  bootEmbedResolved.kind === "http" ||
  (bootEmbedResolved.kind === "local" && bootEmbedResolved.available);

setInterval(() => {
  metrics.recordWriterQueueDepth(
    scheduler.pendingCount(),
    scheduler.queueDepthByPriority(),
    scheduler.queueDepthByOp(),
  );
}, 1_000).unref();

// Token-usage flush buffer. Server.ts middleware calls
// `tokenUsageBuffer.note(tokenId, deviceId)` on every authenticated
// request; the periodic `auth.flushTokenUsage` task drains the buffer
// every 5s into one writer call per pending token. Replaces the
// bespoke `lastTokenBeacon` Map + fire-and-forget that lived inline.
const tokenUsageBuffer = createTokenUsageBuffer();
const principalCredentialUsageBuffer = createPrincipalCredentialUsageBuffer();

// The embedder lives behind the indexer worker proxy and isn't ready until
// startIndexer() finishes. Returning null while it loads is the contract every
// caller expects: a watch's recall arm scores nothing and is retried on the
// next pass rather than nominating the whole corpus.
const getSemanticEmbedder = (): { embedQuery(text: string): Promise<number[]> } | null => {
  const proxy = indexerLifecycle.indexerProxy;
  return proxy
    ? {
        embedQuery: async (text: string): Promise<number[]> => {
          const vec = await proxy.embedQuery(text);
          return Array.from(vec as Float32Array | number[]);
        },
      }
    : null;
};

// Advanced by the credential route, the same supported mutation path that
// refreshes the Anthropic catalog and agent. This keeps secret-file I/O out of
// every Watch judgement while still retiring a provider after key rotation.
let watchJudgeAnthropicCredentialRevision = 0;
const watchJudgeCompleterKey = watchCompleterKeyResolver({
  revision: () => `${inferenceRegistry.revision()}:${watchJudgeAnthropicCredentialRevision}`,
  resolve: () => inferenceRegistry.resolve("watch-judge"),
  credentialIdentity: (resolved) =>
    resolved.kind === "http"
      ? inferenceRegistry.getBackendApiKey(resolved.backendKey)
      : resolved.kind === "anthropic"
        ? String(watchJudgeAnthropicCredentialRevision)
        : undefined,
});

const watchJudgeReadiness = (): { loadable: boolean; reason: string | null } => {
  const resolved = inferenceRegistry.resolve("watch-judge");
  switch (resolved.kind) {
    case "local":
    case "http":
      return {
        loadable: resolved.available,
        reason: resolved.available
          ? null
          : (resolved.reason ?? "The assigned model is unavailable"),
      };
    case "anthropic":
      return {
        loadable: resolved.available && resolved.allowRemoteInference,
        reason:
          resolved.available && resolved.allowRemoteInference
            ? null
            : (resolved.reason ?? "The assigned Anthropic model is unavailable"),
      };
    case "disabled":
      return { loadable: false, reason: "No model is assigned to watch-judge" };
    case "unresolved":
      return { loadable: false, reason: resolved.reason };
    case "replay":
      return { loadable: false, reason: "Replay cannot serve single-shot Watch completions" };
    case "codex":
      return {
        loadable: resolved.available && resolved.allowRemoteInference,
        reason:
          resolved.available && resolved.allowRemoteInference
            ? null
            : (resolved.reason ?? "The assigned Codex model is unavailable"),
      };
    default:
      return assertNever(resolved);
  }
};

// Shared background-agent resolver. Subscription compilation and the Loop
// Agent use the same live model assignment.
const resolveBackgroundAgentBackend = backgroundAgentBackendResolver({
  inferenceRegistry,
  configDir,
  db,
  getMaxToolIterations: () => configStore.get().agent?.maxToolIterations,
  log,
  codexRuntimeService,
});
/**
 * The one way a watch reaches a phone. Holds the live APNs client so a
 * `gateway.apns` change takes without a restart, and hands out the current
 * fan-out runner rather than letting anything keep one.
 */
const pushTransport = new PushTransport(pushBroadcaster);

// ── Background-jobs registry ─────────────────────────────────────────
// Created up front so the HTTP /admin/background-jobs endpoint has a
// reference at server construction time. Individual jobs are
// registered into this same instance later as the Scheduler tasks
// (and indexer worker proxy) come online — the cached snapshot
// updates incrementally without further plumbing.
const backgroundJobs = new BackgroundJobsRegistry({
  log: log.child("background-jobs"),
});
backgroundJobs.start();

// Date-enrichment pass (experimental): extract dates from every document,
// resolved against its emission date. Registered always but self-gates each
// tick on experimental + the enrichment.dates.enabled knob; the io→cpu→writer
// split keeps it off every user-serving lane. `kick` nudges it when new docs
// land (wired into onDocumentsUpserted below).
const dateEnrichment = bootDateEnrichment({
  scheduler,
  backgroundJobs,
  ioGate,
  cpuGate,
  writeGate,
  getSettings: () => resolveDateEnrichmentSettings(configStore.get().enrichment),
  countPending: () => countPendingDateExtraction(db),
  log: log.child("enrichment:dates"),
});

// Indexer lifecycle (boot / embed-swap / shutdown) — see
// ./indexer/indexer-lifecycle.ts. Constructed after its collaborators (the
// background-jobs registry above, plus inferenceRegistry / configStore /
// indexerStatus / searchPipeline / runtime / initialProbe) and above every
// consumer that reaches the live proxy / model-info snapshot through a lazy
// thunk.
// Cognition-spend recorder for the single-shot completion lanes (currently
// token-identity classification). Only HTTP-backed completers report usage —
// local GGUF completers stay unwrapped (withSpendRecording is then identity).
const recordCompleterSpend =
  (mechanism: string) =>
  (sample: { modelId: string; promptTokens: number; completionTokens: number }): void => {
    writeGate
      .recordCognitionSpend(cognitionSpendDay(Date.now()), mechanism, sample.modelId, {
        promptTokens: sample.promptTokens,
        completionTokens: sample.completionTokens,
      })
      .catch((err) => {
        log.warn(
          `Failed to record ${mechanism} spend: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

const indexerLifecycle = new IndexerLifecycle({
  inferenceRegistry,
  configStore,
  indexerStatus,
  searchPipeline,
  backgroundJobs,
  runtime,
  initialProbe,
  log,
  gatewayDbPath: DB_PATH,
  gatewayDbKeyHex: storageEncryption.mainDbKeyHex,
  indexDbPath,
  indexDbKeyHex: storageEncryption.indexDbKeyHex,
  indexDb,
  configDir,
  initialModelInfo: {
    name: embeddingModelName,
    path: embeddingModelPath,
    present: embeddingModelPresent,
    modelsDir: MODELS_DIR,
  },
});

// ── Model manager ────────────────────────────────────────────────────
// Owns the catalog/manifest/download surface for installable models.
// Activation is a config write — the configStore.onChange listener below
// picks up the change and orchestrates the runtime swap (a
// wipe-and-reindex for the embedder; a hot swap for the rest).
const lastModelProgressBroadcastAt = new Map<string, number>();
const modelManager = new ModelManager({
  modelsDir: MODELS_DIR,
  configDir,
  catalog: () => anthropicCatalogService.catalog(),
  onBroadcast: (event) => {
    // Progress events fire on every chunk; throttle to ~4Hz over the
    // bus so the portal/CLI render smoothly without flooding.
    if (event.kind === "progress") {
      const last = lastModelProgressBroadcastAt.get(event.downloadId) ?? 0;
      const now = Date.now();
      if (now - last < 250) return;
      lastModelProgressBroadcastAt.set(event.downloadId, now);
    } else if (
      event.kind === "completed" ||
      event.kind === "failed" ||
      event.kind === "cancelled"
    ) {
      lastModelProgressBroadcastAt.delete(event.downloadId);
    }
    wsServer.broadcast(makeEvent(`model.download.${event.kind}`, event));

    // If the model that just finished installing is the currently
    // configured embed model, refresh the cached presence flag and
    // bootstrap the indexer worker if startIndexer() bailed at startup
    // because the file was missing. Without this the user has to
    // restart the gateway after every first-time install.
    if (event.kind === "completed") {
      // Re-resolve the embedder assignment from the live registry to
      // see if the just-installed model is the currently configured one.
      inferenceRegistry.loadConfig(configStore.get());
      const liveEmbed = inferenceRegistry.resolve("embedder");
      const activeEmbedId = liveEmbed.kind === "local" ? liveEmbed.catalogId : undefined;
      if (activeEmbedId && event.modelId === activeEmbedId) {
        indexerLifecycle.modelInfo.present = existsSync(indexerLifecycle.modelInfo.path);
        const r = indexerStatus.getReadiness();
        if (r.status === "disabled" && /model not found/i.test(r.reason ?? "")) {
          log.info(`Active embed model ${event.modelId} just installed — bootstrapping indexer`);
          indexerLifecycle.startIndexer().catch((err) => {
            log.error(
              `Indexer auto-bootstrap after install failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
    }
  },
});
await modelManager.reconcileOnStartup();

// Per-capability model history for the picker's "Recently used" section.
// A sidecar file next to the config (not in it), fed by the configStore
// change hook below — recording never writes the config, so it can't loop.
const modelHistory = new ModelHistoryStore({
  filePath: join(configDir, "model-history.json"),
});
modelHistory.load();

// TLS bundle. Always serve HTTPS — auto-generated self-signed cert by default,
// or user-provided via OMNESIS_TLS_CERT / OMNESIS_TLS_KEY. iOS pins the
// SHA-256 fingerprint baked into the V3 QR pairing payload (TOFU); CLIs and
// the desktop collector get the cert via standard OS trust (operator can
// trust the cached cert manually) or the env-override path.
const tlsBundle = resolveTlsBundle({
  configDir,
  envCertPath: process.env.OMNESIS_TLS_CERT,
  envKeyPath: process.env.OMNESIS_TLS_KEY,
  envExtraNames: process.env.OMNESIS_TLS_EXTRA_NAMES,
});
log.info(
  `TLS enabled (${tlsBundle.source}); cert SHA-256 fingerprint=${tlsBundle.fingerprintSha256}`,
);
if (tlsBundle.source === "auto-generated") {
  // Self-signed: the portal shows a one-time browser warning, and the
  // browser-capture extension (#791) can't connect at all. Nudge the operator
  // toward the in-place retrofit rather than enforcing anything.
  log.info(
    "Serving a self-signed certificate — run `omnesis tls provision` to mint a browser-trusted cert (Tailscale or mkcert) and silence the portal warning.",
  );
}

// The served certificate over its lifetime: expiry diagnostics, renewal of
// the material Omnesis minted, and activation in this process through the
// listening server's secure context. The server is assigned once it exists,
// and the lifecycle task is scheduled only then: an activation with nothing
// listening is refused rather than recorded as served.
let activeServer: HttpsServer | undefined;
const addressedHosts = () =>
  partitionAddressedHosts({
    gatewayUrl: process.env.OMNESIS_GATEWAY_URL,
    publicBaseUrl: runtime.publicBaseUrl,
    trustOrigins: [
      ...runtime.pairingSystemTrustOrigins,
      ...(configStore.get().gateway?.pairingSystemTrustOrigins ?? []),
    ],
    proxyTrusted: reverseProxyTrusted(),
  });
const tlsLifecycle = new TlsLifecycleService({
  configDir,
  initial: { cert: tlsBundle.cert, key: tlsBundle.key },
  activate: (material) => {
    if (!activeServer) throw new Error("the HTTPS server is not listening yet");
    activeServer.setSecureContext(material);
  },
  materialPaths: () => currentTlsMaterialPaths(configDir, process.env, dotEnvKeysAtBoot),
  requiredHosts: () => addressedHosts().required,
  proxiedHosts: () => addressedHosts().proxied,
  minter: createHostMinter({
    selfSigned: () => generateSelfSigned({ extraNames: process.env.OMNESIS_TLS_EXTRA_NAMES }),
  }),
  settings: () => ({
    autoRenew: configStore.get().gateway?.tls?.autoRenew ?? CONFIG_DEFAULTS.gateway.tls.autoRenew,
    renewBeforeDays:
      configStore.get().gateway?.tls?.renewBeforeDays ??
      CONFIG_DEFAULTS.gateway.tls.renewBeforeDays,
  }),
  // A container has no `tailscale` or `mkcert`; those tiers renew on the host.
  inContainer: existsSync("/.dockerenv"),
  onRotation: (fingerprintSha256) => advertiser?.setFingerprint(fingerprintSha256),
});

// Speech-to-text service. Lazily loads the assigned Whisper model on first use
// and self-heals when the assignment changes. Resolves through the same
// InferenceRegistry as every other capability.
const transcribeService = new TranscribeService({
  resolveAssignment: () => inferenceRegistry.resolve("transcriber"),
});

// OCR service. Like the transcriber it resolves through the InferenceRegistry
// and self-heals on assignment change. HTTP vision backends get their bearer
// token from the registry (which owns the keys); the `gguf` runtime reads its
// model/projector paths from the live config's `inference.ocr.gguf` block.
const ocrService = new OcrService({
  resolveAssignment: () => inferenceRegistry.resolve("ocr"),
  deps: {
    codexRuntimeService,
    getBackendApiKey: (key) => inferenceRegistry.getBackendApiKey(key),
    getGgufConfig: () => configStore.get().inference?.ocr?.gguf,
    getPageConcurrency: () => configStore.get().inference?.ocr?.pageConcurrency,
  },
});

// Entailment verifier — the annotation write gate's entailment firewall.
// Resolves through the InferenceRegistry and self-heals on assignment change
// like the transcriber/OCR services; unset role resolves to null and the
// gate stays absent. Every verifier call's token usage is folded into
// `cognition_spend` under the `entailment-gate` mechanism via the write gate.
const entailmentService = new EntailmentVerifierService({
  resolveAssignment: () => inferenceRegistry.resolve("entailment-verifier"),
  deps: {
    configDir,
    codexRuntimeService,
    getBackendApiKey: (key) => inferenceRegistry.getBackendApiKey(key),
    getPromptStyle: () => configStore.get().inference?.entailment?.promptStyle ?? "judge",
    recordUsage: (u) => {
      writeGate
        .recordCognitionSpend(
          cognitionSpendDay(Date.now()),
          ENTAILMENT_GATE_SPEND_MECHANISM,
          u.modelId,
          {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
          },
        )
        .catch((err) => {
          log.warn(
            `Failed to record entailment-gate spend: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
  },
});

// Replay-only: a settable decision clock for the briefs engine, wired
// ONLY under OMNESIS_BRIEFS_VIRTUAL_CLOCK=1 (the backtest mirror gateway).
// Unset — the production default — leaves the seam empty and every briefs
// consumer on the wall clock.
const briefsVirtualClock = resolveBriefsVirtualClock(process.env);
if (briefsVirtualClock) {
  log.warn(
    "briefs VIRTUAL CLOCK enabled (OMNESIS_BRIEFS_VIRTUAL_CLOCK=1) — this gateway's briefs engine tells replay time, not wall time; never run a live instance this way",
  );
}
// Live-run registry shared between the Cognition Steward drainer (marks runs
// around execution) and the /admin/brain runs surface (reads it) —
// constructed here because the server mounts before bootBriefs runs.
const cognitionActivity = new CognitionRunActivity();

// The sweep set — system definitions layered with the operator's files under
// `<configDir>/sweeps`. Constructed here because the HTTP surface mounts
// before bootBriefs runs and both read the same list.
const sweepService = new SweepService({
  configDir,
  getScheduleContext: () => {
    const brain = resolveBrainSettings(configStore.get().brain);
    return {
      dailyRunHour: brain.dailyRunHour,
      digestEnabled: brain.digest.enabled,
      digestHour: brain.digest.hour,
      digestGraceMinutes: brain.digest.graceMinutes,
    };
  },
  log: log.child("sweeps"),
});

// Talk-back port holder: createServer runs before bootBriefs, so the
// routes read through this live reference; bootBriefs fills it when the
// Briefs feature comes up active.
const briefTalkback: {
  port: import("./brain/talkback/talkback-service.js").BriefTalkbackPort | null;
} = { port: null };

// Omnesis Notes runtime. Booted inside createServer (it
// needs DocumentService.ingest); held here for the shutdown sequence —
// flushAll() then dispose(), beside the omnesis-chat runtime's teardown.
let omnesisNotesRuntime: import("./sources/omnesis-notes/index.js").OmnesisNotesRuntime | undefined;
let agentConversationsRuntime:
  | import("./sources/agent-conversations/index.js").AgentConversationsRuntime
  | undefined;
// Held for the delivery loop below (policy review and operator-watch
// re-approval passes) and for the agent's watch port, which authors operator
// watches through it.
let subscriptionService: import("./subscriptions/service.js").SubscriptionService | undefined;
let statusCacheRuntime: import("./http/services/StatusCache.js").StatusCache | undefined;
let mcpHttpRuntime: import("./http/routes/mcp-streamable.js").McpHttpRuntime | undefined;

// The watch journal and the runtime over it.
//
// Settle the journal's path before anything opens it: an install from before
// the engine was renamed still has the file under the old name, and adopting
// it means folding its write-ahead log, which cannot be done underneath a live
// connection. A refusal here disables the watch subsystem and lets the rest of
// the gateway boot — under a restarting supervisor, exiting would be an
// outage, and the operator needs a running gateway to read the reason from.
// `watch` is the current spelling; `watchV2` is honoured so a rename does not
// quietly drop tuning somebody wrote. Resolved once — four read sites each
// picking their own fallback is three chances to forget one.
const watchTunables = config.gateway?.watch ?? config.gateway?.watchV2;
const journal = resolveWatchJournal(configDir, storageEncryption.watchDbKey);
if (!journal.ok) {
  log.error(`the watch journal could not be opened: ${journal.reason}`);
}
/** Whether a journal existed before this boot. See the reconcile call below. */
const journalExisted = journal.ok && journal.existed;
let watchV2RouteDeps: import("./http/routes/watch.js").WatchV2RoutesDeps | undefined;
/** Shared by the operator's compile route and an integration's own request. */
/**
 * The compiles this gateway is running, and whether it will start more.
 *
 * One per process, so two arrivals of one request find each other's run and so
 * the shutdown coordinator has one thing to close and one thing to wait on.
 * Held here for the same reason the other shutdown-reachable handles are.
 */
const compilesInFlight = new InFlightRequests();

let watchAuthoring: AuthorWatchDeps | undefined;
// Held so shutdown can close the runtime's own connection to the journal — the
// materializer's `stop()` closes the journal store's, not this one.
/**
 * The boot reconciliation of wake anchors against the live watch set.
 *
 * Built inside the watch block, which is where the census comes from, and run
 * once the subscription service every repair goes through has been wired.
 */
let reconcileWakeAnchors: (() => Promise<unknown>) | undefined;
/** The pre-flight the admin route and the agent both go through. */
let watchPreflightHandle:
  | ((
      watch: WatchDefinition,
      opts: { events?: number; days?: number },
    ) => Promise<PreflightOutcome>)
  | undefined;
/**
 * Build something the gateway can do without, or say why it could not.
 *
 * A subsystem that throws while being constructed takes the process with it,
 * and at boot that is a supervisor restart loop rather than a fault anybody
 * reads. What is optional is built through here instead.
 */
function tryStart<T>(what: string, build: () => T): T | null {
  try {
    return build();
  } catch (err) {
    log.error(`${what} could not be started: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Bringing the watch subsystem up, in the one place it is allowed to refuse.
//
// Every store on this file brings a copy written by an older build up to the
// shape its queries expect, and those upgrades take the write lock — so another
// process holding the journal past the busy timeout makes one of them throw. On
// the way out of boot that is an uncaught exception, and under a restarting
// supervisor a crash loop: the gateway dies, restarts, takes the lock again.
// Refusing instead disables the watch subsystem and lets the rest of the
// gateway boot, which is what an unopenable journal has always done and is the
// only outcome an operator can read the reason from.
//
// The materializer is built first because it opens the file first, and it is
// stopped again if the engine's stores then refuse: it subscribes to the ingest
// bus in its constructor, so leaving it standing would have every indexed
// document pushed into a queue that nothing drains, behind a log line claiming
// the journal is recording for a runtime that does not exist.
const watchV2 = journal.ok
  ? tryStart("the watch journal", () =>
      startWatchV2({
        journalPath: journal.path,
        db,
        indexDb,
        analyticsDb,
        bus: eventBus,
        storageKey: storageEncryption.watchDbKey,
        signals: gatewaySyncPhaseSignals({ syncStatus, importFlows }),
        tunables: watchTunables,
      }),
    )
  : null;
const watchStores =
  watchV2 === null
    ? null
    : openWatchStores({
        journalPath: journal.path,
        storageKey: storageEncryption.watchDbKey,
        tunables: watchTunables,
      });
if (watchV2 !== null && watchStores?.ok !== true) {
  if (watchStores !== null)
    log.error(`the watch stores could not be opened: ${watchStores.reason}`);
  watchV2.stop();
}
if (watchV2 && watchStores?.ok) {
  const watchV2Handle = scheduler.schedule(watchV2.task);
  void watchV2Handle;

  // The runtime, over the journal that host produces. Its own connection to
  // the journal — never the materializer's — because the two are separate
  // scheduler tasks and a shared connection would let one open a transaction
  // inside the other's.
  const wakeAnchors = createWakeAnchors({
    db,
    // A thunk: the subscription service is constructed after this point, and a
    // captured `undefined` would leave every wake silently unanchored.
    subscriptions: () => subscriptionService ?? null,
    // Read at the moment the anchor is decided, and a thunk for the same reason
    // — the engine that owns the definitions is built just below. This is what
    // makes an anchor a reading of the delivery block rather than of whichever
    // request happened to be carrying a copy of it.
    definition: (watchId) => watchV2Engine.definitions.get(watchId) ?? null,
    // Through the same turn every other writer of this file takes, and against
    // the store the engine reads its watches from — a hold written anywhere
    // else would be a hold the next evaluation does not see. What it is allowed
    // to overwrite is `holdUnarmed`'s to decide, not this call site's.
    hold: (watchId, note) =>
      watchV2.writes.run(() =>
        Promise.resolve(holdUnarmed(watchV2Engine.definitions, watchId, note)).then(
          () => undefined,
        ),
      ),
  });
  // One expression, two readers: the opener asks it per firing, and the report
  // asks it to decide whether a firing that shipped as a plain banner was a
  // degrade or simply this install. A second spelling of "is there an agent"
  // is how those two come to disagree.
  const watchFiringAgent = () => agentLifecycle.routeDeps.agentService ?? null;
  const firingThreadOpener = createWatchFiringThreadOpener({ getAgent: watchFiringAgent });
  const watchV2Engine = startWatchV2Engine({
    stores: watchStores.stores,
    journal: watchV2.store,
    // Shared with the materializer: both write the journal from the main
    // runner, and a synchronous driver makes the loser block the event loop
    // rather than wait.
    writes: watchV2.writes,
    analyticsDb,
    indexDb,
    ontologyDb: db,
    tunables: watchTunables,
    getEmbedder: () => getSemanticEmbedder(),
    getCompleter: () => {
      const provider = loadCompletionFromResolved(inferenceRegistry.resolve("watch-judge"), {
        configDir,
        codexRuntimeService,
        getBackendApiKey: (key) => inferenceRegistry.getBackendApiKey(key),
      });
      return provider ? withSpendRecording(provider, recordCompleterSpend("watch-v2-judge")) : null;
    },
    completerReadiness: watchJudgeReadiness,
    getCompleterKey: watchJudgeCompleterKey,
    // The push transport already knows which devices are registered and how to
    // reach them; a watch only has to say what to send. The opener turns a
    // firing into a conversation the agent writes the first message of, which
    // the banner then quotes — degrading to the plain notification whenever a
    // thread cannot be written.
    // Built once rather than per delivery: the opener remembers whether waiting
    // for an absent agent is still worth it, and one rebuilt for every firing
    // would forget — so an install with no agent would pay the wait on each of
    // them. `getAgent` is a thunk, so a single opener still sees every swap.
    delivery: () => omnesisNotifyDelivery(() => pushTransport.current(), firingThreadOpener),
    agentIntegration: () => watchFiringAgent() !== null,
    // Waking an agent goes through the subscription apparatus rather than a
    // transport: the wake, the answer authority, the privacy reviewer and the
    // egress ledger all live there, and a firing that skipped them would be a
    // firing nobody reviewed.
    wake: () => agentWakeDelivery(() => wakeAnchors),
  });
  const engineHandle = scheduler.schedule(watchV2Engine.task);
  void engineHandle;
  // A watch and its anchor live in two stores that cannot share a transaction,
  // so a crash between the two writes can leave an anchor whose watch no longer
  // wakes anything. Nothing else would ever notice — a watch that does not
  // exist never fires — so the set is reconciled against the live watches once
  // at start.
  //
  // Held rather than started: every repair it makes goes through the
  // subscription service, which `createServer` hands back further down this
  // file. Starting here would run the walk's synchronous prefix against a
  // service that does not exist yet.
  reconcileWakeAnchors = () =>
    wakeAnchors
      .reconcile(
        // A journal created on this boot has never held a watch, so the empty
        // list it returns is not the operator having removed them — and retiring
        // on that reading would revoke every wake subscription in the main
        // database, which putting the file back does not undo.
        journalExisted
          ? {
              kind: "known",
              wakingWatchIds: new Set(
                watchV2Engine.definitions
                  .list()
                  .filter((watch) => wakesAnAgent(watch.dsl))
                  .map((watch) => watch.id),
              ),
            }
          : { kind: "unknown", why: "the watch journal was created on this boot" },
      )
      .catch((error: unknown) => {
        log.warn(
          `could not reconcile watch wake anchors: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  /**
   * Bring a watch's anchor into line with what its definition now says.
   *
   * A pass-through, because the reading it used to do lives beside the anchors
   * themselves: what a watch wakes, what its firings may carry and the sentence
   * they answer are all properties of the definition, and a copy of that
   * reading here could classify the same watch differently depending on which
   * surface installed it.
   */
  const setWakeAnchor: AuthorWatchDeps["setWakeAnchor"] = (watchId, asker) =>
    wakeAnchors.set(watchId, asker);
  // Natural language in, a running watch or a refusal out — against this
  // install's own ontology rather than a universe's. One set of steps for both
  // the operator's surface and an agent's, so a watch cannot mean two things
  // depending on who asked for it.
  const compileTimeoutMs = watchTunables?.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
  // The compile turn's reasoning ceiling, when the operator set one. Left
  // unset by default: bounding a turn trades the model's own judgement about
  // how long to think for a fixed budget, which is worth measuring before it
  // is anyone's default. See `CompilerSessionDeps.reasoningTokens`.
  const compileReasoningTokens = watchTunables?.compileReasoningTokens;
  const watchCompileRecorder = new WatchCompileRecorder({
    writeGate,
    transcripts: new FsCognitionTranscriptStore(cognitionTranscriptsDir(configDir)),
    log: log.child("watch-v2:compile-runs"),
  });
  const authoring: AuthorWatchDeps = {
    definitions: watchV2Engine.definitions,
    inFlight: compilesInFlight,
    journal: watchV2.store,
    ontology: async () =>
      Ontology.parse(
        await buildOntologySnapshot({ db, analyticsDb, semanticallyIndexed: () => true }),
      ),
    compile: createCompilePort({
      // Every compile is written into the cognition ledger — one settled run
      // plus the agent transcript, which is the only record of what the
      // compiler looked at before deciding what a watch means. Built once and
      // handed back per compile: the recorder is stateless, and the recording
      // it mints is the per-compile object.
      record: () => watchCompileRecorder,
      // A compile is not a short call: the prompt is tens of thousands of
      // tokens and the answer is a document. The completion default aborts it
      // mid-answer, which surfaces as a failure of the request rather than of
      // the deadline. Read once and handed to both paths, so which one an
      // install runs does not change how long its caller waits.
      timeoutMs: () => compileTimeoutMs,
      // The same replay the probe route runs, so what the loop was shown and
      // what an operator can ask for themselves cannot disagree. Wired through
      // the handle rather than captured, because it is assigned when the route
      // deps are built — after this object.
      backtest: liveBacktestPort(
        // Null on a gateway with no watch runtime: there is no history to replay
        // a candidate over, and the compile proceeds on the validator alone.
        (watch, days) => watchPreflightHandle?.(watch, { days }) ?? null,
        (timing) =>
          log.info(`compile-time replay ${timing.outcome} in ${Math.round(timing.wallMs / 1000)}s`),
      ),
      backend: () =>
        loadCompletionFromResolved(inferenceRegistry.resolve("background-agent"), {
          configDir,
          codexRuntimeService,
          getBackendApiKey: (key) => inferenceRegistry.getBackendApiKey(key),
          timeoutMs: compileTimeoutMs,
        }),
      people: () => promptPeopleDirectory(db, watchTunables?.promptPeople),
      // The compiler runs as an ordinary agent turn holding the gateway's read
      // surface, so it can resolve the people a request names and find out what
      // a request means on this install rather than inferring it from a digest.
      // Read through the lifecycle rather than captured: the service is rebuilt
      // when the operator swaps the agent model, and a captured one would go on
      // compiling against a runtime that had been replaced.
      session: (sessionId, { timeoutMs, onEvent }) =>
        createCompilerSession(
          {
            backend: resolveBackgroundAgentBackend,
            // Exactly what the interactive agent holds; the read-only filter is
            // the compiler session's own policy, applied to this set.
            tools: () => agentLifecycle.routeDeps.agentService?.listTools() ?? [],
            timeoutMs,
            ...(compileReasoningTokens === undefined
              ? {}
              : { reasoningTokens: compileReasoningTokens }),
            onEvent,
          },
          sessionId,
        ),
    }),
    forget: (watchId) => watchV2Engine.forget(watchId),
    writes: watchV2.writes,
    setWakeAnchor,
  };
  watchAuthoring = authoring;
  watchV2RouteDeps = {
    definitions: watchV2Engine.definitions,
    compiles: compilesInFlight,
    traces: watchV2Engine.traces,
    journal: watchV2.store,
    ontology: { db, analyticsDb, semanticallyIndexed: () => true },
    firings: (id, limit) => watchV2Engine.firings(id, limit),
    evidenceDocuments: (ids) =>
      [...getDocumentTitlesAndSources(db, [...ids])].map(([id, found]) => ({
        id,
        title: found.title,
        sourceId: found.sourceId,
      })),
    deliveries: (id) =>
      overlayWatchPushRetries(
        id,
        watchV2Engine.deliveries(id),
        watchNotificationWakeOutcomes(db, id),
      ),
    firingCount: (id) => watchV2Engine.firingCount(id),
    // Straight off the trace store, which owns them: they are written beside
    // the judgement rows and rolled off on the same terms.
    judgeExchanges: (id, limit) => watchV2Engine.traces.judgeExchanges(id, limit),
    judgeSpend: () => watchV2Engine.judgeSpend(),
    judgeReadiness: () => watchV2Engine.judgeReadiness(),
    judgeBudget: (id) => watchV2Engine.judgeBudget(id),
    state: (id, parkedLimit) => watchV2Engine.stateSnapshot(id, parkedLimit),
    liveState: () => watchV2Engine.liveState(),
    firingSummary: () => watchV2Engine.firingSummary(),
    // Reads the subscriptions store rather than the journal: a wake record is
    // a subscription, and whether a watch still holds exactly one is the one
    // thing about its delivery that nothing else on a listing can see.
    anchorBreaches: (watchIds) => watchAnchorBreaches(db, watchIds),
    // What became of the wakes those firings caused. Also the subscriptions
    // store rather than the journal: the watch layer's knowledge ends at
    // "handed to the anchor", and everything after that — whether an agent
    // took it, and what its run reported doing — is recorded over there.
    workflowOutcomes: (firingKeys) => listWorkflowOutcomesForFiringKeys(db, firingKeys),
    // Whichever of a key's components turn out to be people. The directory is
    // asked about all of them because an instance key carries no type: what
    // resolves is a person, what does not reads as the id it is.
    people: (ids) => getPersonNames(db, ids),
    latency: () => watchV2Engine.latency(),
    ontologyCoverage: () => watchV2Engine.ontologyCoverage(),
    health: () => watchV2Engine.health(),
    analyticsOutbox: () => watchV2.outboxStats(),
    // Natural language in, a validated watch or a refusal out — against this
    // install's own ontology rather than a universe's.
    author: (input) => authorWatch(authoring, input),
    // The same compile through a dependency that has no store to write to.
    preview: (input) => previewWatch(authoring, input),
    retireAuthoredWatch: async (subscriptionId, revision) => {
      const plan = getSubscriptionCompiledPlan(db, subscriptionId, revision);
      // Only a watch an integration asked for. An operator's watch owns its
      // anchor the other way round — the watch is the thing they wrote — so
      // removing it here would delete work nobody asked to lose.
      if (!plan || !isWatchV2Plan(plan) || plan.predicate.authoredBy !== "integration") return;
      await retireAuthoredWatch(authoring, plan.predicate.watchId);
    },
    // The probe scores against the same embeddings the runtime nominates on —
    // a probe with its own scorer would answer a question about itself.
    probe: {
      db,
      indexDb,
      recall: new LiveRecall({ indexDb, embedder: () => getSemanticEmbedder() }),
      canScore: () => indexDb !== null && getSemanticEmbedder() !== null,
    },
    // The same engine, over a slice of the same journal, with a judge that
    // never says yes. Everything a watch decides lives in that engine, so a
    // probe that reimplemented any of it would drift from what the install
    // actually runs.
    preflight: (watchPreflightHandle = (watch, opts) =>
      preflight(
        {
          journal: watchV2.store,
          now: () => Date.now(),
          ontology: async () =>
            Ontology.parse(
              await buildOntologySnapshot({ db, analyticsDb, semanticallyIndexed: () => true }),
            ),
          analytics: () => analyticsPortFor(analyticsDb),
          recall: new LiveRecall({ indexDb, embedder: () => getSemanticEmbedder() }),
          canScore: () => indexDb !== null && getSemanticEmbedder() !== null,
        },
        watch,
        opts,
      )),
    pending: (id) => watchV2Engine.pending(id),
    forget: (id) => watchV2Engine.forget(id),
    disclosureSummaries: () => watchDisclosureSummaries(db),
    disclosure: (id) => watchDisclosure(db, id),
    reactivate: (id) => watchV2Engine.reactivate(id),
    failure: (id) => watchV2Engine.failure(id),
    setWakeAnchor: setWakeAnchor,
    deliveryToday: () => watchV2Engine.deliveryToday(),
    attemptedToday: (id) => watchV2Engine.attemptedToday(id),
    skipPlan: (id) => watchV2Engine.skipPlan(id),
    applySkip: (id, plan) => watchV2Engine.applySkip(id, plan),
    fireByHand: (id, input) => watchV2Engine.fireByHand(id, input),
    // The same turn-taking the two scheduler tasks use. A handler writing this
    // file without it would contend with whichever of them is mid-write, on the
    // request thread.
    writes: watchV2.writes,
  };
  watchV2EngineHandle = watchV2Engine;
}

// Measured in the background from boot, so the first /status already carries
// the whole footprint rather than falling back to the main database alone.
const diskUsage = new DiskUsageMonitor(() =>
  measureDiskUsage({
    configDir,
    dbPath: DB_PATH,
    indexDbPath,
    analyticsDbPath,
    watchDbPath: journal.path,
    transcriptsDir: cognitionTranscriptsDir(configDir),
    conversationsDir,
    modelsDir: MODELS_DIR,
    backupsDir,
  }),
);
void diskUsage.refresh();

const httpShutdown = new GatewayHttpShutdown();
const app = createServer(db, DB_PATH, {
  getDiskUsage: () => diskUsage.snapshot(),
  requestAdmission: (_c, next) => Promise.resolve(httpShutdown.guard(next)),
  // The same store the agent prompts read from, so a portal save and the next
  // prompt build cannot disagree about what the file says.
  operatorInstructions,
  watchV2Routes: watchV2RouteDeps,
  port: PORT,
  writeGate,
  ioGate,
  metrics,
  processVitals,
  scheduler,
  tokenUsageBuffer,
  principalCredentialUsageBuffer,
  backgroundJobs,
  onDocumentsUpserted: (sourceId, count) => {
    wsServer.broadcast(makeEvent("documents.upserted", { sourceId, count }));
    // Nudge the date-enrichment pass to pick up freshly ingested docs promptly.
    dateEnrichment.kick();
  },
  onOmnesisNotesRuntime: (runtime) => {
    omnesisNotesRuntime = runtime;
  },
  onAgentConversationsRuntime: (runtime) => {
    agentConversationsRuntime = runtime;
  },
  onSubscriptionService: (service) => {
    subscriptionService = service;
  },
  onStatusCache: (cache) => {
    statusCacheRuntime = cache;
  },
  onMcpHttpRuntime: (runtime) => {
    mcpHttpRuntime = runtime;
  },
  // Low-disk write guard (#15). DocumentService rejects ingestion with 507
  // when free disk on the DB volume drops below this many MB.
  minFreeDiskMb: runtime.minFreeDiskMb,
  ingestYieldBatch: runtime.ingestYieldBatch,
  config,
  configStore,
  pushPlan: {
    getRelaySettings,
    getFcmProjectId: async () => (liveFcmClient ? liveFcmClient.projectId() : undefined),
  },
  indexDb,
  searchPipeline,
  personLookupGate: ioGate,
  searchSnapshot,
  agentRouteDeps: agentLifecycle.routeDeps,
  privacyPolicyStore: subscriptionsPolicyStore,
  analyticsDb,
  backupService,
  exportService,
  wsServer,
  fleetUpdateService: fleetUpdate,
  hostFleetUpdateService: hostFleetUpdate,
  deviceDoctorService: deviceDoctor,
  syncStatus,
  authFlows,
  importFlows,
  // Pull `gateway.timings.*` (slowRequest, pairingTtl, sessionTtl)
  // through to the routes that consume them — see runtime-settings.ts.
  timings: {
    slowRequestMs: runtime.slowRequestMs,
    pairingTtlMs: runtime.pairingTtlMs,
    sessionTtlMs: runtime.sessionTtlMs,
    sessionRefreshThrottleMs: runtime.sessionRefreshThrottleMs,
  },
  // Externally-reachable HTTPS base URL (gateway.publicBaseUrl); forwarded
  // in auth.begin so OAuth/aggregator sources build their redirect URI as
  // `${publicBaseUrl}/oauth/callback`. See runtime-settings.ts.
  publicBaseUrl: runtime.publicBaseUrl,
  mcpResourceUrls: runtime.mcpResourceUrls,
  indexerModel: indexerLifecycle.modelInfo,
  indexerReadiness: () => indexerStatus.getReadiness(),
  indexerControl: {
    reindexMissing: async () => {
      const proxy = indexerLifecycle.indexerProxy;
      if (!proxy) {
        throw new Error("indexer worker not ready — check /index/stats for state");
      }
      return proxy.reindexMissing();
    },
    rebuild: (mode) => indexerLifecycle.applyEmbedSwap(mode),
    // Route through the worker that owns index.db, including during startup
    // before it is ready for search/admin calls. Returns undefined only when no
    // worker owns the handle, when the direct fallback is safe.
    deleteSourceIndex: (sourceId) => indexerLifecycle.deleteSourceIndex(sourceId),
    wake: () => {
      // Routed through the Scheduler's debounced wake primitive — see
      // `indexerWakeTask` registration below. Drops if the worker
      // isn't ready yet (the wakeable's run() pings the proxy, which
      // is null until startIndexer() finishes).
      scheduler.wake("indexer.wake");
    },
    // Latest docs/sec throughput cached on the proxy from worker cycle
    // updates. null until the worker is up with enough signal — lets
    // /index/stats serve a server-side ETA on first portal load.
    getIndexRate: () => indexerLifecycle.indexerProxy?.indexRatePerSec ?? null,
  },
  peopleControl: {
    // Late-bound: the backfill periodics register below, after
    // createServer. The kicked eval tick is the reconciliation net —
    // the fast lane below usually applies the merge first, and the
    // tick then finds a caught-up watermark and idles.
    wakeMergeEval: () => scheduler.kickPeriodic("backfill.mergeRulesEval"),
    // The user-action fast lane (#1377): the same io → cpu → writer trio
    // the periodic eval runs, but enqueued at "user" priority so a
    // human-issued merge/undo queue-jumps congested background lanes and
    // materializes before the HTTP response. Concurrency with the
    // periodic eval is safe: the apply is OCC-guarded (a stale snapshot
    // is skipped) and the watermark is monotonic. After an effective
    // apply this mirrors the eval tick's follow-through — sweep the
    // candidates the merge collapsed (so the portal's poll sees them
    // gone) and kick the score/counts refreshes that would otherwise
    // wait out their idle backoff (the caught-up eval tick never
    // reaches its own kick chain).
    fastApplyMergeRules: async () =>
      runWithPriority("user", async () => {
        const data = await ioGate.mergeEquivalencesData();
        const snapshot = await cpuGate.computeMergeEquivalences(data);
        const result = await writeGate.upsertMergeEquivalences(snapshot);
        if (result.added + result.changed + result.removed > 0) {
          scheduler.kickPeriodic("backfill.interactionScoresRefresh");
          scheduler.kickPeriodic("backfill.peopleCountsRefresh");
          await writeGate.sweepCollapsedMergeCandidates();
        }
      }),
  },
  modelManager,
  modelsDevCatalog,
  getSystemInfo: () => getSystemInfo(MODELS_DIR),
  getInferenceOverview: inferenceOverviewWithCodex,
  getRecentModels: (capability) =>
    computeRecentModels({
      reference: capability,
      current: configStore.get().inference?.assignments ?? {},
      history: modelHistory.snapshot(),
      resolveValue: (role, value) => inferenceRegistry.resolveValue(role, value),
    }),
  getCodexStatus: codexRuntimeService ? () => codexRuntimeService.snapshot() : undefined,
  refreshCodexStatus: codexRuntimeService ? () => codexRuntimeService.refresh() : undefined,
  setupCodexAgent: codexRuntimeService
    ? (model) => codexRuntimeService.setupAgent(configStore, model)
    : undefined,
  getCodexRuntimeUpdate: codexRuntimeService
    ? () => codexRuntimeService.getRuntimeUpdate()
    : undefined,
  startCodexRuntimeUpdate: codexRuntimeService
    ? (opts) => codexRuntimeService.startRuntimeUpdate(opts)
    : undefined,
  cancelCodexRuntimeUpdate: codexRuntimeService
    ? () => codexRuntimeService.cancelRuntimeUpdate()
    : undefined,
  refreshAnthropicStatus: () => anthropicCatalogService.refresh(),
  startCodexLogin: codexRuntimeService ? () => codexRuntimeService.startDeviceLogin() : undefined,
  getCodexLogin: codexRuntimeService ? () => codexRuntimeService.getLoginFlow() : undefined,
  cancelCodexLogin: codexRuntimeService ? async () => codexRuntimeService.cancelLogin() : undefined,
  logoutCodex: codexRuntimeService ? () => codexRuntimeService.logout() : undefined,
  getConfigHealth: () => inferenceRegistry.configHealth(),
  getReleaseCheck: () => releaseCheckService.snapshot(),
  getBriefsStatus: () => briefsFeatureStatus(inferenceRegistry, chatRoleReadinessDeps),
  getBriefTalkback: () => briefTalkback.port,
  briefsClock: briefsVirtualClock ?? undefined,
  cognitionActivity,
  sweeps: sweepService,
  getSweepsEnabled: () => resolveBrainSettings(configStore.get().brain).sweepsEnabled,
  // The lane's status route reports the knobs it is actually running under.
  // Resolved, not raw: the config routes serve an operator's overrides, so an
  // untouched cap would otherwise read as absent everywhere on the wire.
  io: ioGate,
  getBootstrapSettings: () => {
    const b = resolveBrainSettings(configStore.get().brain);
    return { ...b.bootstrap, recencyWindowMs: b.recencyWindowMs };
  },
  getBudgetSettings: () => resolveBrainSettings(configStore.get().brain).budget,
  // Idempotent: an already-started lane keeps its original instant, so a
  // double-click cannot restate when the operator actually decided. Kick the
  // periodic after the durable write so newly granted consent takes effect
  // without waiting out an idle backoff.
  startBootstrap: async (nowMs: number): Promise<number> => {
    const existing = getCognitionEngineState(db, COGNITION_BOOTSTRAP_STARTED_AT_KEY);
    if (existing !== null) return Number(existing) || nowMs;
    await writeGate.setCognitionEngineState(COGNITION_BOOTSTRAP_STARTED_AT_KEY, String(nowMs));
    scheduler.kickPeriodic("cognition.bootstrap");
    return nowMs;
  },
  probeBackend: (key: string) => inferenceRegistry.probeBackend(key),
  verifyModel: (key, model, role, vopts) => inferenceRegistry.verifyModel(key, model, role, vopts),
  transcribeService,
  ocrService,
  pushTransport,
  mobilePermissionNotifier,
  accessAuthorizationNotifier,
  accessCleanupWake: () => scheduler.kickPeriodic("access.cleanupExpired.tick"),
  eventBus,
  configDir,
  onModelCredentialsChanged: async (fileKey) => {
    // The credentials file just changed on disk; rebuild the active agent
    // so availability flips without a restart. Only the `anthropic` fileKey
    // is wired today; other model-provider fileKeys (when added) will need
    // their own swap hook here.
    if (fileKey === "anthropic") {
      watchJudgeAnthropicCredentialRevision += 1;
      await anthropicCatalogService.refresh();
      await agentLifecycle.applyAgentSwap();
    }
  },
  tlsFingerprintSha256: () => tlsLifecycle.fingerprintSha256(),
  tlsLifecycle,
  // A Tailscale certificate is publicly chained, so its names need no
  // allowlist entry: phones verify them through platform trust at any port.
  publiclyTrustedPairingHosts: () => tlsLifecycle.publiclyTrustedNames(),
  advertisedPairingHost: () => advertiser?.advertisedHost() ?? null,
  certificateRenewsAt: () => tlsLifecycle.nextRenewalAt(),
  systemTrustPairingOrigins: () => [
    ...(runtime.publicBaseUrl ? [runtime.publicBaseUrl] : []),
    ...runtime.pairingSystemTrustOrigins,
    ...(configStore.get().gateway?.pairingSystemTrustOrigins ?? []),
  ],
});

// Now that the subscription service exists — `createServer` hands it back, and
// every anchor repair goes through it. Started here rather than where it was
// built so the walk cannot begin against a service that is still undefined:
// its first retire would silently do nothing while reporting a repair, and the
// same record would be skipped on every boot from then on.
void reconcileWakeAnchors?.();

// Seed the gateway-hosted Web Pages source's display identity (icon/label/
// colors) into sync_state. No collector syncs `web`, so the usual
// sync.status-driven seed never fires for it; without this, native clients
// render a placeholder glyph (#993). Idempotent — setSourceMeta COALESCEs.
await seedWebSourceMeta(writeGate);

// The background-agent backend resolver for the run drainer (resolved fresh
// per run so a live model swap takes effect on the next run).
// Brief judging uses an independent inference lane, including when the parent
// background agent and the judge use the same Codex model and account.
const resolveBriefJudgeBackend = () =>
  resolveRoleBackend("brief-judge", {
    inferenceRegistry,
    codexRuntimeService,
    configDir,
    db,
    maxToolIterations: undefined,
    log,
  });
const briefJudge = new LlmBriefJudge({
  resolveBackend: resolveBriefJudgeBackend,
  recordUsage: (u) => {
    writeGate
      .recordCognitionSpend(
        cognitionSpendDay(Date.now()),
        BRIEF_JUDGE_SPEND_MECHANISM,
        u.modelId,
        {
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
        },
        { countRun: u.countRun },
      )
      .catch((err) => {
        log.warn(
          `Failed to record brief-judge spend: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  },
  log,
});

// Briefs feature gate (experimental). Seeds the
// open-loops system source and starts the Agent Run Queue drainer plus the
// real-time waker only when the feature is active (experimental mode on AND
// a background-agent model assigned); byte-for-byte inert otherwise. The
// decay tasks will start from this same gate once they land.
// The derivation stages whose producer is actually running. Date extraction is
// independently gated, and a stage that never stamps would hold every agent run
// for the full readiness barrier while its drip is nudged for work it will
// never do — so the barrier and the ingest nudge both ask this one question.
const activeDerivationStages = (): readonly DerivationStage[] =>
  DERIVATION_STAGES.filter(
    (stage) =>
      stage.id !== "dates" ||
      (experimentalEnabled() &&
        resolveDateEnrichmentSettings(configStore.get().enrichment).enabled),
  );

// Durable conversational memory and its evidence lifecycle are available in every mode.
const { createInteractiveMemoryProfile, subscribeMemoryInvalidators } =
  await import("./brain/interactive-memory.js");
const { validateConversationAnnotationEvidence } = await import("./sources/omnesis-chat/index.js");
const validateAnnotationEvidence = (documentId: string, quote: string) =>
  validateConversationAnnotationEvidence(
    { readDb: db, loadConversation: (id) => conversationStore.load(id) },
    documentId,
    quote,
  );
agentLifecycle.setInteractiveMemoryProfile(
  createInteractiveMemoryProfile({
    db,
    writeGate,
    getSettings: () => resolveBrainSettings(configStore.get().brain),
    getEntailmentVerifier: () => entailmentService.get(),
    validateAnnotationEvidence,
    log: log.child("memory"),
  }),
);
subscribeMemoryInvalidators({
  db,
  writeGate,
  eventBus,
  ...(briefsVirtualClock ? { clock: briefsVirtualClock } : {}),
  log: log.child("memory"),
});

await bootBriefs({
  registry: inferenceRegistry,
  readiness: chatRoleReadinessDeps,
  writeGate,
  log,
  runQueue: {
    db,
    scheduler,
    backgroundJobs,
    eventBus,
    ...(briefsVirtualClock ? { clock: briefsVirtualClock } : {}),
    activity: cognitionActivity,
    sweeps: sweepService,
    getSettings: () => resolveBrainSettings(configStore.get().brain),
    activeDerivationStages,
    resolveBackend: resolveBackgroundAgentBackend,
    getOperatorInstructions: () => operatorInstructions.promptText(),
    transcriptsDir: cognitionTranscriptsDir(configDir),
    // Collaborators the Cognition Steward's toolset + prompts are assembled from
    // (lazy-loaded inside bootBriefs; nothing here is touched when inert).
    cognition: {
      searchPipeline,
      syncStatus,
      analyticsDb,
      indexDb,
      // Read-worker gate for `lookup_people`; the steward wraps its calls at
      // background priority so background runs never jump ahead of interactive.
      personLookupGate: ioGate,
      getEntailmentVerifier: () => entailmentService.get(),
      validateAnnotationEvidence,
      // Push bar — live-gated by brain.judge.enabled; null ⇒ ship unjudged.
      getBriefJudge: () =>
        resolveBrainSettings(configStore.get().brain).judge.enabled ? briefJudge : null,
      policyStore: subscriptionsPolicyStore,
    },
  },
  talkback: {
    setProfile: (profile) => agentLifecycle.setAnchoredThreadProfile(profile),
    expose: (port) => {
      briefTalkback.port = port;
    },
    getAgentService: () => agentLifecycle.routeDeps.agentService ?? null,
  },
  interactiveWrite: {
    setProfile: (profile) => agentLifecycle.setInteractiveWriteProfile(profile),
  },
  push: pushBroadcaster,
  getLegacySweepOverrides: () => configStore.get().brain?.sweeps ?? {},
});

const configOrchestrator = new ConfigChangeOrchestrator({
  db,
  writeGate,
  getIndexerProxy: () => indexerLifecycle.indexerProxy,
  inferenceRegistry,
  applyEmbedSwap: () => indexerLifecycle.applyEmbedSwap(),
  applyAgentSwap: () => agentLifecycle.applyAgentSwap(),
});
configOrchestrator.attachServer(wsServer);
configOrchestrator.register(configStore);

// Keep the inference registry in sync with config changes so resolve()
// always reflects the latest assignments and backends.
configStore.onChange((_before, after) => {
  inferenceRegistry.loadConfig(after);
});

// Remember replaced model assignments for the picker's "Recently used"
// section. Sidecar-file only — never writes the config, so no loop.
configStore.onChange((before, after) => {
  modelHistory.recordChanges(before, after);
});

// Hot-swap the APNs client when `gateway.apns` is added/changed/removed.
// Lets `omnesis push setup` activate (and `push test` validate) direct push
// without a gateway restart, mirroring the model/cutoff hot-reload paths.
configStore.onChange((before, after) => {
  if (JSON.stringify(before.gateway?.apns) === JSON.stringify(after.gateway?.apns)) return;
  // Single source of truth: rebuild once, point both consumers at it. The
  // push transport takes the new client directly; the needs-auth notifier
  // reads `liveApnsClient` through a thunk.
  liveApnsClient = buildApnsClient(after);
  pushTransport.setApnsClient(liveApnsClient);
  log.info(
    `APNs config changed — iOS push delivery is now ${after.gateway?.apns ? "enabled" : "disabled"}`,
  );
});

configStore.onChange((before, after) => {
  if (JSON.stringify(before.gateway?.fcm) === JSON.stringify(after.gateway?.fcm)) return;
  liveFcmClient = buildFcmClient(after);
  log.info(
    `FCM config changed — Android push delivery is now ${after.gateway?.fcm ? "enabled" : "disabled"}`,
  );
});

// Initial reconcile at boot so a newly-loaded config is projected onto the
// DB before the first WS connection lands.
const bootReport = await reconcileConfig(db, writeGate, config);
if (bootReport.sourcesUpdated > 0) {
  log.info(
    `Config reconcile at boot: ${bootReport.sourcesUpdated} source row${bootReport.sourcesUpdated === 1 ? "" : "s"} updated from file`,
  );
}

// TLS bundle is now resolved earlier in the boot sequence (before
// createServer) so the fingerprint can flow into mountAdminRoutes
// deps for the V3 pairing-payload echo.

// Wire WebSocket support into the Hono app. `createNodeWebSocket` returns
// `upgradeWebSocket` (a Hono middleware) and `injectWebSocket` (attaches
// the `upgrade` handler to the underlying node:http server). The route
// must be registered before `serve()` returns.
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

mountDeviceWsRoute(app, wsServer, upgradeWebSocket);

function startServer() {
  // OMNESIS_BIND lets operators run the gateway behind a reverse proxy
  // that terminates TLS (Caddy, nginx, Tailscale Funnel) by binding
  // loopback only — the proxy handles WAN exposure with its own cert
  // and forwards to localhost. Default `0.0.0.0` keeps LAN reachability
  // working out of the box.
  const bind = process.env.OMNESIS_BIND ?? "0.0.0.0";
  if (reverseProxyTrusted() && !isLoopbackIp(bind)) {
    log.warn(
      `OMNESIS_TRUST_PROXY is set while the gateway binds ${bind}: a client reaching it directly can name its own address in X-Forwarded-For; bind loopback (OMNESIS_BIND=127.0.0.1) behind the proxy`,
    );
  }
  const server = serve({
    fetch: app.fetch,
    port: PORT,
    hostname: bind,
    createServer: createHttpsServer,
    serverOptions: { cert: tlsBundle.cert, key: tlsBundle.key },
  });
  activeServer = server as unknown as HttpsServer;

  // Node's http.Server emits `error` asynchronously for EADDRINUSE. Catch
  // it here so we can print the same friendly message as the Bun path did
  // instead of a raw stack trace + unhandled rejection restart loop.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`Port ${PORT} is already in use. Another Omnesis gateway is likely still running.`);
      log.error(`  omnesis service status            # is a supervised gateway serving this port?`);
      log.error(
        `  lsof -ti :${PORT}                      # otherwise, find the process holding it`,
      );
      log.error(
        "Never start a second gateway on another port against the same config dir: its stores belong to one gateway at a time.",
      );
      process.exit(1);
    }
    log.error(`server error: ${err.message}`);
    process.exit(1);
  });

  injectWebSocket(server);
  httpShutdown.attach(server);
  return server;
}

const server = startServer();
scheduler.schedule(createTlsLifecycleTask(tlsLifecycle));

wsServer.start();

const listenPort =
  typeof server.address() === "object" && server.address() !== null
    ? (server.address() as AddressInfo).port
    : PORT;
log.info(`Listening on https://localhost:${listenPort}, db=${DB_PATH}`);
scheduleSearchCachePrewarm();

// Advertise the gateway on the LAN via mDNS so same-LAN collectors with
// no OMNESIS_GATEWAY_URL auto-discover it, and the portal is reachable at
// https://<hostname>:<port>. Opt-out via `gateway.mdns.enabled =
// false` or `OMNESIS_MDNS_DISABLE=1` (the latter is what the synth E2E
// harness sets so parallel test gateways never multicast).
const mdnsCfg = config.gateway?.mdns;
const mdnsEnabled =
  (mdnsCfg?.enabled ?? DEFAULT_MDNS_ENABLED) && process.env.OMNESIS_MDNS_DISABLE !== "1";
if (mdnsEnabled) {
  const mdnsHostname = mdnsCfg?.hostname ?? DEFAULT_MDNS_HOSTNAME;
  advertiser = new MdnsAdvertiser();
  // The advertiser owns the mDNS log line: it logs the advertised service on
  // success and a warning when it skips (e.g. a host that can't enumerate
  // interfaces). Don't log "advertising" here — start() may have skipped.
  advertiser.start({
    port: listenPort,
    hostname: mdnsHostname,
    serviceName: mdnsCfg?.serviceName ?? osHostname(),
    fingerprintSha256: tlsLifecycle.fingerprintSha256(),
  });
}

await runBootDataMigrations({
  writeGate,
  ioGate,
  log,
  selfConfig: config.self,
  sharedAddressDemotion: config.gateway?.sharedAddressDemotion,
});

// Backfill drip loops as Scheduler-registered PeriodicTasks. Each task
// orchestrates compute → writer via the Scheduler's runners; the heavy
// SQL never lands on the main thread (one task per loop, idle/active
// duty cycle expressed via PeriodicTask.idlePeriodMs).
//
// Interval / batchSize / idleDelay for every task is operator-tunable
// via `gateway.backfill.*` in `omnesis.json`. Defaults — and the
// per-knob rationale that explains them — live in `runtime-settings.ts`.
// Near-dup is the one exception: its config is resolved lazily on every
// tick so a config reload picks up new tunables without re-spawning the
// task graph (the `getNearDupConfig` getter); the backfill scheduler
// cadences themselves still require a gateway restart since
// PeriodicTask reads `periodMs` once at construction.
const backfillBundle = createBackfillTasks(
  {
    writeGate,
    ioGate,
    cpuGate,
    log: log.child("backfill"),
    ...backfillOptsFromRuntime(runtime),
    getNearDupConfig: () => resolveNearDupConfig(configStore.get().nearDuplicates),
    // Token classification is one of the background agent's headless runs, so
    // it uses that assignment. Never auto-assigned, so this is null on an
    // install with no background agent and the pass simply skips. Resolved per
    // sweep — ConfigChangeOrchestrator keeps the registry current, so a
    // reassignment lands without a restart. The task owns what this returns.
    getCompletionProvider: () => {
      const provider = loadCompletionFromResolved(inferenceRegistry.resolve("background-agent"), {
        configDir,
        codexRuntimeService,
        getBackendApiKey: (key) => inferenceRegistry.getBackendApiKey(key),
      });
      return provider ? withSpendRecording(provider, recordCompleterSpend("token-identity")) : null;
    },
    readDb: db,
    backgroundWorkerNice: runtime.backgroundWorkerNice,
    ...(storageEncryption.mainDbKey ? { derivedStoreKey: storageEncryption.mainDbKey } : {}),
  },
  scheduler,
);
const backfillHandles = backfillBundle.tasks.map((t) => scheduler.schedule(t));

// ── Near-dup integration: event-bus buffer + boot algo-bump ───────────
//
// Each doc-upsert event records the doc id in an in-memory buffer; the
// `nearDupInboxFlushTask` below drains it into `near_dup_inbox` in
// coalesced, background-priority batches. Doing the enqueue off the hot
// path is what keeps bulk ingest from parking the writer (#555).
// Eligibility filtering + reason picking live in
// `near-dupes/event-handler.ts`; the FK cascade on the near-dup tables
// handles document deletes automatically (no inbox row needed).
const nearDupInboxBuffer = createNearDupInboxBuffer({ log: log.child("near-dup") });
const offNearDupInbox = subscribeNearDupInbox({
  eventBus,
  buffer: nearDupInboxBuffer,
  getConfig: () => resolveNearDupConfig(configStore.get().nearDuplicates),
});

// Boot-time near-dup algo-bump. If the persisted algorithm version
// disagrees with the code-declared version, bulk-enqueue every
// eligible doc for re-processing. Idempotent: a no-op when versions
// already match.
//
// The DF rebuild is NOT run at boot — `backfill.nearDupDfRefresh`
// fires it asynchronously 30 s after start-up. Until DF lands, the
// compute drip parks at idle (see `nearDupComputeTask`), so the
// inbox queue accumulates safely without producing degenerate
// zero-weight signatures.
{
  const config = resolveNearDupConfig(configStore.get().nearDuplicates);
  if (config.enabled) {
    try {
      const result = await writeGate.bumpNearDupAlgo(config);
      if (result.enqueued > 0) {
        // Prime the BackgroundJob tracker immediately so the portal
        // UI reflects the real inbox depth from t=0 rather than
        // briefly showing "0 remaining" until the first periodic
        // compute tick (~5-7 s later) syncs ground truth.
        backfillBundle.primeTrackers.nearDupCompute.setRemaining(result.enqueued);
        log.info(
          `near-dup boot: algo ${result.bumpedFrom ?? "<fresh>"} -> ${config.algorithm.algoVersion}, ${result.enqueued} docs enqueued`,
        );
      }
    } catch (err) {
      log.error(
        `near-dup boot algo-bump failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Boot-time seed of materialized people counts. Fire-and-forget so it
// doesn't block startIndexer() — the people-counts periodic task does the
// same refresh on every cycle, so a delayed boot-seed is fine.
void (async () => {
  const startMs = Date.now();
  try {
    const rows = await ioGate.peopleCounts();
    const computedMs = Date.now() - startMs;
    const { updated } = await writeGate.upsertPeopleCounts(rows);
    const tookMs = Date.now() - startMs;
    log.info(
      `startup refreshPeopleCounts in ${tookMs}ms (compute=${computedMs}ms, ${updated} of ${rows.length} rows changed)`,
    );
  } catch (err) {
    log.error(
      `startup refreshPeopleCounts failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
})();

// Token-usage flush — periodic drain of the buffer the auth middleware
// fills. One task replaces the inline Map+coalesce in server.ts.
const tokenUsageBundle = tokenUsageFlushTask(
  {
    buffer: tokenUsageBuffer,
    writeGate,
    log: log.child("auth-flush"),
  },
  scheduler,
);
const tokenUsageHandle = scheduler.schedule(tokenUsageBundle.task);

const principalCredentialUsageBundle = principalCredentialUsageFlushTask(
  {
    buffer: principalCredentialUsageBuffer,
    writeGate,
    log: log.child("principal-credential-usage-flush"),
  },
  scheduler,
);
const principalCredentialUsageHandle = scheduler.schedule(principalCredentialUsageBundle.task);

// Near-dup inbox flush — drains the buffer the event-bus subscriber fills
// into coalesced, background-priority `near_dup_inbox` inserts (#555).
const nearDupInboxFlushBundle = nearDupInboxFlushTask(
  {
    buffer: nearDupInboxBuffer,
    writeGate,
    log: log.child("near-dup-flush"),
  },
  scheduler,
);
const nearDupInboxFlushHandle = scheduler.schedule(nearDupInboxFlushBundle.task);

// Derivation backlog + SLA. Reports, per derivation stage, how much is
// outstanding and how long the oldest document has waited — the quantity the
// cognition readiness barrier is written against, so a run claimed on partial
// graph context has a visible cause on the background-jobs page.
const derivationSlaBundle = derivationSlaTasks(
  {
    db,
    log: log.child("derivation-sla"),
    getBarrierMs: () => resolveBrainSettings(configStore.get().brain).derivationBarrierMs,
    isBarrierActive: () => briefsFeatureStatus(inferenceRegistry, chatRoleReadinessDeps).active,
  },
  scheduler,
);
const derivationSlaHandles = derivationSlaBundle.tasks.map((t) => scheduler.schedule(t));

// Ingest wakes the derivation drips, so a document arriving into an empty queue
// is derived promptly rather than after the drips' idle backoff — the wait the
// cognition readiness barrier would otherwise sit through.
subscribeDerivationNudge({ eventBus, scheduler, activeStages: activeDerivationStages });

// Indexer wake — Scheduler debounces the wake signal and pings the
// worker (which still owns the cycle). Replaces the worker-side
// debounce timer in workers/indexer-worker.ts.
const indexerWakeBundle = indexerWakeTask(
  {
    pingWorker: () => indexerLifecycle.indexerProxy?.wake(),
    log: log.child("indexer-wake"),
  },
  scheduler,
);
const indexerWakeHandle = scheduler.registerWakeable(indexerWakeBundle.task);
// Track for shutdown cleanup. (Periodic + wakeable handles get disposed
// when the Scheduler disposes; explicit refs let TypeScript see them
// as live until then.)
void backfillHandles;
void tokenUsageHandle;
void principalCredentialUsageHandle;
void indexerWakeHandle;

// TTL cleanup sweeps. DB periodics cover pairings, sessions, tokens, and
// private notification content (hourly active / 6h idle); the notification
// sweep also runs immediately at startup. In-memory auth/import flow registries
// run every 5min active / 30min idle.
const cleanupBundle = createCleanupTasks(
  {
    writeGate,
    authFlows,
    importFlows,
    log: log.child("cleanup"),
  },
  scheduler,
);
const pushWakeRetryHandle = scheduler.schedule(pushWakeRetryBundle.task);
const cleanupHandles = cleanupBundle.tasks.map((t) => scheduler.schedule(t));
void cleanupHandles;
void pushWakeRetryHandle;

// Disposable operational history is pruned by one bounded background unit per
// tick. The task exists even when disabled (the default), so a live config edit
// can enable or shorten retention without restarting the gateway.
const retentionTranscripts = new FsCognitionTranscriptStore(cognitionTranscriptsDir(configDir));
// A migration that retires a class of runs can delete their rows but not their
// transcript files — it has no filesystem. It leaves the ids behind; this is
// where they are collected, now that the directory is in scope. Not awaited:
// the files are debug artifacts, and a gateway must not wait on their deletion
// to start serving.
void drainTranscriptEvictions(db, retentionTranscripts, writeGate);

const activityRetentionBundle = createActivityRetentionTask(
  {
    writeGate,
    transcripts: retentionTranscripts,
    pruneConversations: (cutoffMs, limit) => agentLifecycle.pruneConversations(cutoffMs, limit),
    getConfig: () => configStore.get(),
    log: log.child("activity-retention"),
  },
  scheduler,
);
const activityRetentionHandle = scheduler.schedule(activityRetentionBundle.task);
void activityRetentionHandle;
configStore.onChange((_before, _after, changedPaths) => {
  if (
    changedPaths.some(
      (path) =>
        path === "/activityRetention" ||
        path.startsWith("/activityRetention/") ||
        path === "/brain/transcriptRetention",
    )
  ) {
    scheduler.kickPeriodic(activityRetentionBundle.task.name);
  }
});

// A source snapshot's omissions are recorded with a deadline, never applied.
// This is what spends the deadline: one bounded batch per tick at background
// priority, so a wholesale absence drains over ticks and stays behind admission
// control instead of parking the writer on a catch-up burst.
const absenceSweepBundle = createAbsenceSweepTask(
  {
    writeGate,
    ioGate,
    indexWriteGate: directIndexWriteGate(indexDb),
    analyticsDb,
    purgeAnnotationsFor: (documentIds) =>
      purgeCognitiveStateThroughGate(db, writeGate, documentIds),
    getMinObservations: () =>
      resolveRuntimeSettings(configStore.get()).snapshotAbsenceMinObservations,
    getMinAgeMs: () => resolveRuntimeSettings(configStore.get()).snapshotAbsenceMinAgeMs,
    deletionGraceMs: resolveRuntimeSettings(configStore.get()).snapshotAbsenceDeletionGraceMs,
    log: log.child("absence"),
  },
  scheduler,
);
const absenceSweepHandle = scheduler.schedule(absenceSweepBundle.task);
void absenceSweepHandle;
configStore.onChange((_before, _after, changedPaths) => {
  if (changedPaths.some((path) => path.startsWith("/gateway/snapshotAbsence"))) {
    scheduler.kickPeriodic(absenceSweepBundle.task.name);
  }
});

// Recover inference backends that were unreachable at boot (or during a
// transient network blip) without a restart or a manual /probe (#1267). The
// per-backend exponential backoff lives in InferenceRegistry.reprobeUnavailable.
const backendReprobeBundle = createBackendReprobeTask(
  {
    registry: inferenceRegistry,
    log: log.child("inference:reprobe"),
    reconcileAgent: async () => {
      await agentLifecycle.reactivateAgentIfAvailable();
    },
  },
  scheduler,
);
const backendReprobeHandles = backendReprobeBundle.tasks.map((t) => scheduler.schedule(t));
void backendReprobeHandles;

const subscriptionDeliveryConfig = config.gateway?.subscriptions;
const optionalEnvInt = (name: string): number | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const subscriptionDeliveryService = new SubscriptionDeliveryService({
  writeGate,
  transport: wsServer,
  getDevice: (deviceId) => getDevice(db, deviceId),
  policyStore: subscriptionsPolicyStore,
  log: log.child("subscriptions:delivery"),
  isEnabled: experimentalVisible,
  reevaluatePendingWatchPolicies: () =>
    subscriptionService?.reevaluatePendingWatchPolicies() ?? Promise.resolve(0),
  reapplyOperatorApprovals: () =>
    subscriptionService?.reapplyOperatorApprovals() ?? Promise.resolve(0),
  config: {
    maxAttempts: subscriptionDeliveryConfig?.maxDeliveryAttempts,
    baseBackoffMs: subscriptionDeliveryConfig?.deliveryBaseBackoffMs,
    maxBackoffMs: subscriptionDeliveryConfig?.deliveryMaxBackoffMs,
  },
});
const subscriptionDeliveriesBundle = createSubscriptionDeliveriesTask(
  {
    service: subscriptionDeliveryService,
    intervalMs: optionalEnvInt("OMNESIS_SUBSCRIPTION_DELIVERY_INTERVAL_MS"),
    idleMs: optionalEnvInt("OMNESIS_SUBSCRIPTION_DELIVERY_IDLE_MS"),
    startDelayMs: optionalEnvInt("OMNESIS_SUBSCRIPTION_DELIVERY_START_DELAY_MS"),
    onError: (error) => {
      log
        .child("subscriptions:delivery")
        .warn(`delivery drain failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  },
  scheduler,
);
const subscriptionDeliveryHandles = subscriptionDeliveriesBundle.tasks.map((task) =>
  scheduler.schedule(task),
);
void subscriptionDeliveryHandles;
const sourcePermissionReminderTask = {
  name: "auth.mobilePermissionReminders",
  runner: "main" as const,
  priority: "background" as const,
  periodMs: sourcePermissionReminderConfig.scanIntervalMs,
  startDelayMs: sourcePermissionReminderConfig.scanIntervalMs,
  latencyBudgetMs: 60_000,
  initialArgs: undefined,
  isIdle: (result: { notified: number }) => result.notified === 0,
  async run() {
    return { kind: "done" as const, value: await mobilePermissionNotifier.scan() };
  },
};
const sourcePermissionReminderHandle = scheduler.schedule(sourcePermissionReminderTask);
void sourcePermissionReminderHandle;
const sourcePermissionReminderJob = periodicJob(sourcePermissionReminderTask, {
  scheduler,
  displayName: "Mobile permission reminders",
  description: "Retries durable mobile source permission-health reminders with backoff.",
  category: "auth",
  tracker: new StatelessTracker(),
});
const answerCompletionDeliveryService = new AnswerCompletionDeliveryService({
  writeGate,
  transport: wsServer,
  getDevice: (id) => getDevice(db, id),
  log: log.child("privacy:completion-delivery"),
});
const answerCompletionDeliveryHandle = scheduler.schedule({
  name: "privacy.completionDeliveryDrain",
  runner: "main",
  priority: "background",
  periodMs: 3_000,
  idlePeriodMs: 30_000,
  startDelayMs: 8_000,
  latencyBudgetMs: 60_000,
  initialArgs: undefined,
  isIdle: (count) => count === 0,
  async run() {
    try {
      const count = await answerCompletionDeliveryService.drainOnce();
      return { kind: "done", value: count };
    } catch (error) {
      log
        .child("privacy:completion-delivery")
        .warn(`delivery drain failed: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: "done", value: 0 };
    }
  },
});
void answerCompletionDeliveryHandle;

// ── Background-jobs registry: register Scheduler-backed jobs ────────
// Worker-hosted jobs (indexer cycle / reconcile / reindex-missing)
// register themselves separately once the indexer proxy is constructed
// inside startIndexer() — the registry is the same instance.
backgroundJobs.registerAll([
  ...backfillBundle.jobs,
  tokenUsageBundle.job,
  principalCredentialUsageBundle.job,
  nearDupInboxFlushBundle.job,
  indexerWakeBundle.job,
  ...cleanupBundle.jobs,
  pushWakeRetryBundle.job,
  activityRetentionBundle.job,
  absenceSweepBundle.job,
  ...backendReprobeBundle.jobs,
  ...subscriptionDeliveriesBundle.jobs,
  sourcePermissionReminderJob,
  ...derivationSlaBundle.jobs,
]);

// Start indexer asynchronously — don't block the HTTP server.
indexerLifecycle.startIndexer().catch((err) => {
  log.error(`Indexer failed to start: ${err instanceof Error ? err.message : String(err)}`);
});

// Single top-level shutdown coordinating indexer + background loops + dbs.
// Order: drain backfill + indexer first (they may emit writes through the
// writer worker in Phase 2+), then dispose the writer worker, then close
// the main-thread DB handles.
//
// Wallclock cap: 60 seconds. If any of the awaited steps wedges (worker
// in a native call ignoring shutdown messages, etc.) the supervisor
// gets a guaranteed exit. Per-stage runners already apply their own
// 5s fallback; this is the umbrella net. Sized to comfortably clear the
// indexer flush-save (its own 20s budget — a large HNSW graph rewrites the
// whole ~GB file) plus the backup/export/agent drains ahead of it and the
// dispose + sidecar encrypt after it, so the clean-exit path wins over the
// force-exit even on a big install; still well under the service manager's
// stop timeout.
const SHUTDOWN_TIMEOUT_MS = GATEWAY_SHUTDOWN_BUDGET_MS;

/**
 * How long a stop waits for the compiles already running.
 *
 * A small fraction of the umbrella above, because a compile is minutes long and
 * the stop is not: waiting for one would spend the whole budget and reach the
 * hard timeout with the databases still open, which trades a clean stop for a
 * compile that gets killed regardless. Ten seconds catches the one that was
 * nearly finished and gives up on the rest, which is the trade worth making.
 */
const COMPILE_DRAIN_TIMEOUT_MS = 10_000;

const doShutdown = async (): Promise<void> => {
  // Stop admitting HTTP requests and WebSocket frames while their services
  // still exist. This drain is bounded so a streaming client cannot consume
  // the entire shutdown budget before the indexer has persisted its graph.
  wsServer.stop();
  const httpDrained = await httpShutdown.close(server, 5_000);
  if (!httpDrained) log.warn("HTTP shutdown drain timed out; remaining connections closed");
  // A warm still scanning competes with the sidecar persist below for I/O and
  // the shutdown budget; its thread is throwaway, so stop it first.
  await searchCacheWarm?.terminate();
  // Stop accepting compiles first, so nothing new starts while the rest of this
  // runs. A compile accepted now cannot finish, and reaches its caller as a
  // dropped connection — which an agent reads as a broken feature and answers by
  // asking again in different words, a different idempotency key by design, so
  // the guard that would have caught the duplicate never fires.
  compilesInFlight.close();
  // Then give what is already running a bounded chance to land. Deliberately a
  // small fraction of the umbrella: a compile runs for minutes, so waiting for
  // one to finish would spend the whole shutdown budget and reach the timeout
  // with the databases still open — trading a clean stop for a compile that
  // gets killed anyway. What this buys is the compile that was nearly done.
  if (compilesInFlight.size > 0) {
    const running = compilesInFlight.size;
    log.info(`draining ${running} in-flight compile(s), up to ${COMPILE_DRAIN_TIMEOUT_MS}ms`);
    const drained = await Promise.race([
      compilesInFlight.whenIdle().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), COMPILE_DRAIN_TIMEOUT_MS)),
    ]).catch(() => false);
    if (!drained) {
      log.warn(
        `${compilesInFlight.size} compile(s) did not finish within ${COMPILE_DRAIN_TIMEOUT_MS}ms; stopping anyway`,
      );
    }
  }
  try {
    await mcpHttpRuntime?.close();
  } catch (err) {
    log.error(`MCP HTTP shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  anthropicCatalogService.stop();
  statusCacheRuntime?.stop();
  // Stop advertising on the LAN first — it's I/O-cheap and releases the
  // multicast socket so a quick restart doesn't collide on it.
  try {
    await advertiser?.stop();
  } catch (err) {
    log.error(
      `mDNS advertiser stop threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }

  // Let an in-flight backup finish before DB handles close — killing the
  // vacuum worker mid-run would strand a manifest-less partial backup dir.
  // Bounded by the overall shutdown timeout below.
  try {
    await backupService.whenIdle();
  } catch (err) {
    log.error(
      `backupService.whenIdle threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }

  // Likewise let an in-flight export finish — killing the export worker
  // mid-run would strand a manifest-less partial export dir.
  try {
    await exportService.whenIdle();
  } catch (err) {
    log.error(
      `exportService.whenIdle threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }

  await agentLifecycle.shutdown();
  // omnesis-notes: flush pending day-doc upserts (a capture that landed
  // within the debounce window must still project), then drop timers.
  if (omnesisNotesRuntime) {
    try {
      await omnesisNotesRuntime.flushAll();
    } catch (err) {
      log.error(
        `omnesisNotesRuntime.flushAll threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
    try {
      omnesisNotesRuntime.dispose();
    } catch (err) {
      log.error(
        `omnesisNotesRuntime.dispose threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }
  // agent-conversations: same shutdown contract — flush pending pushed-turn
  // projections that landed within the debounce window, then drop timers.
  if (agentConversationsRuntime) {
    try {
      await agentConversationsRuntime.flushAll();
    } catch (err) {
      log.error(
        `agentConversationsRuntime.flushAll threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
    try {
      agentConversationsRuntime.dispose();
    } catch (err) {
      log.error(
        `agentConversationsRuntime.dispose threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }
  if (codexRuntimeService) {
    try {
      await codexRuntimeService.dispose();
    } catch (err) {
      log.error(
        `codexRuntimeService.dispose threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  // Near-dup inbox: detach the subscriber so no further docs buffer and stop
  // the periodic flush so it can't drain concurrently, then drain what's
  // pending into the writer while it's still alive. A graceful restart loses
  // nothing; the periodic flush handles steady state (#555).
  try {
    offNearDupInbox();
    for (const h of derivationSlaHandles) h.stop();
    nearDupInboxFlushHandle.stop();
    await nearDupInboxFlushBundle.flushNow();
  } catch (err) {
    log.error(
      `near-dup inbox flush on shutdown threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }

  // Force a final HNSW save FIRST, on its own generous timeout: a large-graph
  // save (usearch has no incremental save — it rewrites the whole ~GB file) can
  // exceed the worker's 5s dispose ack, and if it's cut short the on-disk graph
  // and `usearch_saved_seq` lag the live seq, so the next boot rebuilds (~18 min)
  // instead of restoring. Fail-safe: on error/timeout we log and proceed, and
  // the next boot rebuilds as before.
  try {
    const saved = await indexerLifecycle.flushIndexerSave();
    log.info(`Indexer flush-save on shutdown: ${saved ? "graph persisted" : "not persisted"}`);
  } catch (err) {
    log.warn(
      `Indexer flush-save on shutdown failed (may rebuild next boot): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Indexer next so any in-flight cycle finishes before we close
  // index.db. Scheduler.dispose() then drains in-flight writer/compute
  // ops and tears down both worker threads.
  try {
    await indexerLifecycle.shutdownIndexer();
  } catch (err) {
    log.error(
      `indexer shutdown threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
  try {
    usearchReadHandle.close();
  } catch (err) {
    log.error(`usearchReadHandle.close threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (storageEncryption.enabled) {
    // Persist the active generation's plaintext HNSW graph into its durable
    // encrypted sidecar BEFORE purging the plaintext, so the next boot restores
    // it instead of rebuilding (~18 min for ~800k vectors). Running it in the
    // main process (not the indexer worker's close()) keeps it off the worker's
    // short shutdown-ack budget — it is bounded only by the service manager's
    // stop timeout. Fail-safe: if it throws, no `.enc` is promoted, so the next
    // boot rebuilds from vectors.
    //
    // The fingerprint seq is `usearch_saved_seq` — the seq the on-disk plaintext
    // graph was last SAVED at (stamped by the worker after each save), NOT the
    // live `vector_write_seq`. So the sidecar's seq describes exactly what the
    // file contains, no "clean shutdown" signal required: if the worker's final
    // save was skipped/killed, `usearch_saved_seq` lags the live seq, the boot
    // fingerprint check fails, and the graph rebuilds instead of restoring stale.
    const key = storageEncryption.indexDbKey;
    const { path: activePath } = resolveActiveUsearchTarget(indexDb, configDir);
    const model = getIndexEmbedModel(indexDb);
    const savedSeq = getUsearchSavedSeq(indexDb);
    if (key && model && savedSeq > 0 && existsSync(activePath)) {
      try {
        encryptSidecar(activePath, `${activePath}.enc`, key, {
          vectorWriteSeq: savedSeq,
          embedModel: model.name,
          embedDim: model.dim,
        });
        log.info(`Encrypted HNSW sidecar persisted for restart-restore (saved-seq ${savedSeq})`);
      } catch (err) {
        log.warn(
          `Encrypted HNSW sidecar persist failed (will rebuild next boot): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      log.info(
        `HNSW sidecar not persisted (savedSeq=${savedSeq}, plaintext=${existsSync(activePath)}, model=${model ? "yes" : "no"}); next boot rebuilds`,
      );
    }
    const removed = purgeUsearchSidecars(configDir);
    if (removed > 0) log.info(`Secure storage purged ${removed} HNSW sidecar(s) on shutdown`);
  }
  if (searchWorkerPool) {
    try {
      await searchWorkerPool.dispose();
    } catch (err) {
      log.error(
        `searchWorkerPool.dispose threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    await scheduler.dispose();
  } catch (err) {
    log.error(
      `scheduler.dispose threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
  processVitals.dispose();
  // DB handles last — by this point no scheduled writer task is in
  // flight, so close() is safe. analyticsDb.close() is async — it
  // drains the writeQueue + readers before tearing down its DuckDB
  // pool, so a Ctrl-C during analytics ingest can't `closeSync` a
  // conn mid-transaction.
  try {
    await analyticsDb.close();
  } catch (err) {
    log.error(`analyticsDb.close threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    searchSnapshot.close();
  } catch (err) {
    log.error(`searchSnapshot.close threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The runtime's own connection to the journal, which is not the
    // store's — two writers, two handles, two closes.
    await watchV2EngineHandle?.stop();
  } catch (err) {
    log.error(`watchV2 engine stop threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // Unsubscribes from the bus and closes the journal. After the scheduler has
    // disposed, so no drain is in flight against the handle being closed.
    watchV2?.stop();
  } catch (err) {
    log.error(`watchV2.stop threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    indexDb.close();
  } catch (err) {
    log.error(`indexDb.close threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    db.close();
  } catch (err) {
    log.error(`db.close threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Last: every store is closed, so a replacement gateway may take the dir.
  gatewayLock.release();
};

let shutdownStarted = false;
const shutdown = async (exitCode = 0): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log.info("Shutting down...");
  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    t.unref?.();
  });
  await Promise.race([doShutdown(), timeoutPromise]);
  if (timedOut) {
    log.error(`shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms wallclock cap; exiting with code 1`);
    process.exit(1);
  }
  process.exit(exitCode);
};
coordinatedShutdown = shutdown;

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Spawned by a harness or dev script? Then leave when the spawner does — see
// parent-watchdog.ts for why nothing else can save us from orphaning. Inert
// for a service-managed gateway, which sets no OMNESIS_PARENT_PID.
startParentWatchdogFromEnv(process.env, () => {
  log.warn(
    `Spawning process ${process.env.OMNESIS_PARENT_PID} is gone; exiting rather than orphan`,
  );
  process.exit(0);
});
