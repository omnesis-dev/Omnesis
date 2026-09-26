// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { strictRoute } from "./http/scope.js";
type Db = Database.Database;
import { join } from "node:path";
import {
  DEFAULT_PUSH_RELAY_URL,
  DEFAULT_SYNC_LEASE_TTL,
  pickSourceSettings,
  type OmnesisConfig,
} from "@omnesis/config";
import { createLogger, parseDuration, type WsRequestPayload } from "@omnesis/core";
import {
  missingHostedWriteScopes,
  SourceId,
  type DeviceId,
  type DeviceRecord,
} from "@omnesis/types";
import { lookupToken, lookupSession } from "./data/repositories/TokenRepository.js";
import { getDevice } from "./data/repositories/DeviceRepository.js";
import { getSource } from "./data/repositories/SourceRepository.js";
import { getWipeEpoch, listCursorRows } from "./data/repositories/SyncStateRepository.js";
import {
  analyticsClaimNamespace,
  listAnalyticsOmissionCandidates,
} from "./data/repositories/AnalyticsReplicaClaimRepository.js";
import { listClaimedExternalIds } from "./data/repositories/ReplicaDeletionClaimRepository.js";
import { SyncLeaseRegistry } from "./sync-lease.js";
import { SourceWriteEpochFence } from "./source-write-epoch-fence.js";
import { type WriteGate, directWriteGate } from "./write-gate.js";
import {
  directIndexWriteGate,
  workerCoordinatedIndexWriteGate,
  type IndexWriteGate,
} from "./indexer/index-write-gate.js";
import { runWithTiming, newRequestTiming } from "./request-timing.js";
import { type MetricsRegistry, callerKindFromDeviceKind, type CallerKind } from "./metrics.js";
import { runWithPriority, callerKindToPriority, type Priority } from "./priority.js";
import { SchedulerQueueFullError, type SchedulerMetricsSnapshot } from "./scheduler/index.js";
import { resolveRuntimeSettings } from "./runtime-settings.js";
import { type SyncStatusRegistry } from "./sync-status.js";
import { createCollectorDeviceResolver } from "./collector-device-resolver.js";
import { mountBriefsRoutes } from "./brain/http.js";
import { mountBrainAdminRoutes } from "./brain/admin-http.js";
import { mountCognitionRoutes } from "./http/routes/cognition.js";
import { CognitionQueryService } from "./http/services/CognitionQueryService.js";
import { cognitionTranscriptsDir } from "./brain/transcripts.js";
import { mountPushRoutes } from "./http/routes/push.js";
import { type EventBus } from "./events.js";
import { registerModelRoutes } from "./models/routes.js";
import { mountTranscribeRoutes } from "./http/routes/transcribe.js";
import { mountOcrRoutes } from "./http/routes/ocr.js";
import { HttpError, errorResponse } from "./http/errors.js";
import { requestIdMiddleware } from "./http/middleware/request-id.js";
import { requestContextMiddleware } from "./http/middleware/request-context.js";
import { corsMiddleware } from "./http/middleware/cors.js";
import { auditMiddleware } from "./http/middleware/audit.js";
import { EventService } from "./http/services/EventService.js";
import { DocumentService } from "./http/services/DocumentService.js";
import { SourceDataRemovalService } from "./http/services/SourceDataRemovalService.js";
import { AnalyticsSourceModeTransitionAdoption } from "./http/services/AnalyticsSourceModeTransitionAdoption.js";
import { purgeCognitiveStateThroughGate } from "./brain/cognitive-state-cascade.js";
import { PersonService } from "./http/services/PersonService.js";
import { AnalyticsService } from "./http/services/AnalyticsService.js";
import { StatusCache } from "./http/services/StatusCache.js";
import { SourceService } from "./http/services/SourceService.js";
import { AuthService, scheduleSessionRefresh } from "./http/services/AuthService.js";
import { DoctorService } from "./http/services/DoctorService.js";
import { DeviceDoctorService } from "./http/services/DeviceDoctorService.js";
import { PushAdminService } from "./http/services/PushAdminService.js";
import { WatermarkService } from "./http/services/WatermarkService.js";
import {
  SourceUrlRecanonicalizationService,
  planSourceUrlRecanonicalization,
} from "./domain/SourceUrlRecanonicalization.js";
import { PairingService } from "./http/services/PairingService.js";
import { DeviceService } from "./http/services/DeviceService.js";
import { PushRegistrationService } from "./http/services/PushRegistrationService.js";
import { mountStatusRoutes, mountDbSizeRoute } from "./http/routes/status.js";
import { mountPortalRoutes } from "./http/routes/portal.js";
import { mountAdminRoutes } from "./http/routes/admin.js";
import { mountBackupRoutes } from "./http/routes/backup.js";
import { mountExportRoutes } from "./http/routes/export.js";
import { mountModelCredentialsRoutes } from "./http/routes/model-credentials.js";
import {
  mountDocumentCoreRoutes,
  mountDocumentRefsRoute,
  mountDocumentByIdRoute,
  mountSyncStateRoutes,
} from "./http/routes/documents.js";
import { mountDevAnnotationsRoutes } from "./http/routes/dev-annotations.js";
import { mountWebCapturePolicyRoutes } from "./http/routes/web-capture-policy.js";
import { WebCapturePolicyService } from "./sources/web/capture-policy.js";
import { getOwnedWebDomains } from "./owned-web-domains.js";
import { mountWatchV2Routes } from "./http/routes/watch.js";
import { mountDocumentGraphRoute } from "./http/routes/document-graph.js";
import { mountGraphWalkRoute } from "./http/routes/graph.js";
import { mountDocumentTrailRoute } from "./http/routes/document-trail.js";
import { mountNotesRoutes } from "./http/routes/notes.js";
import { bootOmnesisNotes, type OmnesisNotesRuntime } from "./sources/omnesis-notes/index.js";
import { mountAgentMessagesRoutes } from "./http/routes/agent-messages.js";
import {
  bootAgentConversations,
  type AgentConversationsRuntime,
} from "./sources/agent-conversations/index.js";
import { mountSearchRoutes } from "./http/routes/search.js";
import {
  mountAgentRoutes,
  withCallerResolver,
  type AgentConfigSnapshot,
} from "./http/routes/agent.js";
import { createGatewayDirectMcpService } from "./agent/direct-mcp.js";
import { mountPrivacyRoutes } from "./http/routes/privacy.js";
import { mountInstructionsRoutes } from "./http/routes/instructions.js";
import { OperatorInstructionsStore } from "./instructions/store.js";
import { DirectMcpExecutionBoundary } from "./mcp/direct-execution-boundary.js";
import { mountMcpStreamableRoutes, type McpHttpRuntime } from "./http/routes/mcp-streamable.js";
import { mountOAuthAccessRoutes } from "./http/routes/oauth-access.js";
import { mountLegacyMcpCutoverRoute } from "./http/routes/legacy-mcp-cutover.js";
import { AccessService } from "./access/service.js";
import { resolveDeviceAnswerScope } from "./access/device-answer-scope.js";
import { resolveMcpRequestResource, resolveOAuthUrls } from "./access/oauth-urls.js";
import { mountSubscriptionRoutes } from "./http/routes/subscriptions.js";
import { mountNotificationRoutes } from "./http/routes/notifications.js";
import { mountMobilePermissionHealthRoute } from "./http/routes/mobile-permission-health.js";
import { MobilePermissionHealthService } from "./http/services/MobilePermissionHealthService.js";
import { SubscriptionService } from "./subscriptions/index.js";
import { PrivacyPolicyStore } from "./privacy/policy-store.js";
import { PrivacyReviewer } from "./privacy/reviewer.js";
import { createWatchExistenceReviewer } from "./privacy/watch-existence-review.js";
import { mountPeopleRoutes } from "./http/routes/people.js";
import { mountAnalyticsRoutes } from "./http/routes/analytics.js";
import { mountIndexerRoutes } from "./http/routes/indexer.js";
import {
  buildSessionCookieHeader,
  getSessionCookie,
  portalCsrfToken,
  sessionCookieName,
} from "./http/cookies.js";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";
import type { TlsLifecyclePort } from "./http/routes/admin/internals.js";
import type { PushPlan } from "@omnesis/core/push";
import type Database from "better-sqlite3";
import type { BootstrapSettingsView } from "./brain/bootstrap-status.js";
import type { SourcePermissionNotifier } from "./push/producers/source-permission.js";
import type { PushTransport } from "./watch/push-transport.js";
import type { SystemInfo } from "./system-info.js";
import type { ModelManager } from "./models/manager.js";
import type { AnalyticsDb } from "./analytics-db.js";
import type { SearchPipeline } from "./search/pipeline.js";
import type { PersonLookupGate } from "./domain/person-lookup.js";
import type { AuthFlowRegistry } from "./auth-flows.js";
import type { ImportFlowRegistry } from "./import-flows.js";
import type { DeviceWsServer } from "./ws.js";
import type { IComputeScheduler } from "./http/services/ports.js";
import type { ConfigStore } from "./config-store.js";
import type { AppEnv, AuthContext } from "./http/routes/types.js";
import type { CognitionBudgetSettings } from "./brain/cognition/budget.js";

const log = createLogger("gateway:http");

// ── Auth model ──────────────────────────────────────────────────────────────
//
// The outer auth middleware (below) only parses the bearer token / portal
// session cookie and stores the result on the request context — it does NOT
// reject. Every individual route declares its policy at the mount site via
// `scope.public()`/`.read()`/`.admin()`/`.writeAny()`/`.readBulk()`
// (see `http/scope.ts`). The `strictRoute()` wrapper
// applied to the app at construction time throws at registration if any
// mount is missing a guard — that's the fail-closed gate.

export function createServer(
  db: Db,
  dbPath?: string,
  opts?: {
    /** Transport lifecycle admission, shared by HTTP and WebSocket upgrades. */
    requestAdmission?: MiddlewareHandler<AppEnv>;
    /**
     * The single-writer gate (`WriterWorkerProxy` in production,
     * `directWriteGate(db)` in tests). Every write against omnesis.db
     * MUST go through this object.
     */
    writeGate?: WriteGate;
    /**
     * Optional compute gate — when provided, snapshot-reconcile pre-checks
     * if any deletions are needed on the io worker before paying the
     * writer-queue cost.
     */
    ioGate?: IComputeScheduler;
    /**
     * Optional metrics sink. When provided, every authenticated
     * request is recorded into the registry keyed by
     * (route template, caller kind). Exposed at GET /admin/metrics.
     */
    metrics?: MetricsRegistry;
    processVitals?: {
      snapshot(windowSeconds: number): import("./process-vitals.js").ProcessVitalsSnapshot;
    };
    /**
     * Optional Scheduler — only the `snapshot(windowSec)` surface is used,
     * so tests can pass a minimal stub.
     */
    scheduler?: {
      snapshot(windowSeconds: number): SchedulerMetricsSnapshot;
      pauseBackground(): void;
      resumeBackground(): void;
      isBackgroundPaused(): boolean;
      kickPeriodicAndWait(taskName: string, timeoutMs?: number): Promise<unknown>;
      quiescePeriodics(): void;
      beginUserAdmission?(): import("./scheduler/admission.js").AdmissionHold;
    };
    /**
     * Optional background-jobs registry.
     */
    backgroundJobs?: import("./background-jobs/index.js").BackgroundJobsRegistry;
    /**
     * Optional token-usage accumulator. The auth middleware calls
     * `note(tokenId, deviceId)` on every authenticated request; the
     * Scheduler-driven `auth.flushTokenUsage` PeriodicTask drains it
     * every 5s into one writer call per pending token.
     */
    tokenUsageBuffer?: import("./scheduler/tasks/auth.js").TokenUsageBuffer;
    /** Successful principal OAuth auth beacons, flushed asynchronously by the Scheduler. */
    principalCredentialUsageBuffer?: import("./scheduler/tasks/auth.js").PrincipalCredentialUsageBuffer;
    onDocumentsUpserted?: (sourceId: string, count: number) => void;
    /**
     * Receives the omnesis-notes quick-capture runtime when it boots. Supplying
     * this lifecycle owner also boots the runtime eagerly; without one, boot is
     * deferred until the first notes request. The composition root keeps it for
     * the shutdown sequence — `flushAll()` then `dispose()` — so a capture that
     * landed within the debounce window before SIGTERM still lands as a corpus
     * document. Any non-test caller that may serve `/notes` must supply this
     * callback and perform the same shutdown sequence.
     */
    onOmnesisNotesRuntime?: (runtime: OmnesisNotesRuntime) => void;
    onAgentConversationsRuntime?: (runtime: AgentConversationsRuntime) => void;
    /**
     * Receives the subscription service once it is built. The composition root
     * keeps it so the delivery loop — constructed later, and the only thing
     * that runs on a timer after a privacy-policy edit — can re-evaluate
     * pending watches.
     */
    onSubscriptionService?: (service: SubscriptionService) => void;
    /** Receives the started status cache so the composition root can stop it before closing DBs. */
    onStatusCache?: (cache: StatusCache) => void;
    /**
     * Low-disk write guard. Free MB on the gateway DB volume below
     * which `DocumentService` rejects ingestion with 507. Resolved by
     * `index.ts` from `runtime-settings.ts` (env > config > default 500).
     * Omitted in tests → guard inert.
     */
    minFreeDiskMb?: number;
    /**
     * Sub-batch size for the document-ingest event-loop yield. Resolved by
     * `index.ts` from `runtime-settings.ts` (config `gateway.ingestYieldBatch`,
     * default 250). Omitted in tests → services use the default.
     */
    ingestYieldBatch?: number;
    config?: OmnesisConfig;
    configStore?: ConfigStore;
    /**
     * The operator's `OMNESIS.md`. Defaults to one over `configDir` when that
     * is wired; without either, `/admin/instructions` reports the feature
     * unavailable and every agent prompt carries no operator section.
     */
    operatorInstructions?: OperatorInstructionsStore;
    pushPlan?: {
      getRelaySettings(): { enabled: boolean; url: string; visible?: boolean };
      getFcmProjectId(): Promise<string | undefined>;
    };
    indexDb?: Db;
    /**
     * The Watch V2 shadow runtime's admin surface, when the subsystem is on.
     * Undefined outside experimental mode — the routes are not mounted at all.
     */
    watchV2Routes?: import("./http/routes/watch.js").WatchV2RoutesDeps;
    searchPipeline?: SearchPipeline;
    /** Read-worker gate for the Direct MCP `lookup_people` port. */
    personLookupGate?: PersonLookupGate;
    /** Test/embedding override for the fixed Direct MCP façade. */
    directMcpService?: import("./agent/direct-mcp.js").DirectMcpService;
    /** Receives the stateless MCP HTTP runtime for graceful shutdown. */
    onMcpHttpRuntime?: (runtime: McpHttpRuntime) => void;
    /** Demo agent service. Routes 503 when undefined. */
    agentService?: import("./agent/service.js").AgentService;
    /** Human-readable reason the agent is unavailable. Surfaced in the 503 message. */
    agentDisabledReason?: string;
    /** Shared mutable deps object for agent routes. The caller mutates its properties to hot-swap the agent service at runtime without a restart. */
    agentRouteDeps?: import("./http/routes/agent.js").AgentRoutesDeps;
    /** Subscription service override (tests or a model-backed compiler). */
    subscriptionService?: SubscriptionService;
    /** Shared policy authority for fallback subscription wiring. */
    privacyPolicyStore?: PrivacyPolicyStore;
    /** Agent config snapshot. Used as fallback when `agentRouteDeps` is not provided. */
    agentConfig?: AgentConfigSnapshot;
    analyticsDb?: AnalyticsDb;
    wsServer?: DeviceWsServer;
    /** Shared fleet-doctor coordinator. Production passes the WS lifecycle singleton. */
    deviceDoctorService?: DeviceDoctorService;
    /** Shared device update service, including reconnect/result lifecycle state. */
    fleetUpdateService?: import("./http/services/FleetUpdateService.js").FleetUpdateService;
    /** Portal-session-only gateway-host update orchestration. */
    hostFleetUpdateService?: import("./http/services/HostFleetUpdateService.js").HostFleetUpdateService;
    syncStatus?: SyncStatusRegistry;
    authFlows?: AuthFlowRegistry;
    importFlows?: ImportFlowRegistry;
    /**
     * Metadata about the embedding model the indexer loads.
     */
    indexerModel?: {
      name: string;
      path: string;
      present: boolean;
      modelsDir: string;
    };
    /**
     * Indexer worker readiness. Used by the portal's search view.
     */
    indexerReadiness?: () =>
      | { status: "spawning"; message?: string }
      | { status: "loading-model"; message?: string; stage?: string; progress?: number }
      | { status: "ready" }
      | { status: "failed"; reason: string }
      | { status: "disabled"; reason: string };
    /**
     * Operator-facing trigger for the indexer's on-demand passes.
     */
    indexerControl?: {
      reindexMissing: () => Promise<{ indexed: number; errors: number }>;
      rebuild?: (mode?: import("./indexer/indexer-lifecycle.js").EmbedSwapMode) => Promise<void>;
      wake?: () => void;
      /**
       * Delete a source's index data through the worker that owns index.db,
       * including while it is still starting. Returns undefined only when no
       * worker owns the handle, so the caller can safely use the direct path.
       */
      deleteSourceIndex?: (sourceId: string) => Promise<number> | undefined;
      /** Latest docs/sec indexing throughput, or null when unknown. */
      getIndexRate?: () => number | null;
    };
    /**
     * People-graph control hooks. `wakeMergeEval` kicks the merge-rules
     * eval periodic task so user-issued merge mutations (rule create /
     * candidate accept / cluster merge / rule delete) materialize in
     * `people.merged_into` within seconds instead of waiting out the
     * task's idle backoff. `fastApplyMergeRules` goes further: it
     * recomputes + applies the equivalences at the calling request's
     * priority, so a human-issued merge lands before the response even
     * when the background lanes are congested.
     */
    peopleControl?: {
      wakeMergeEval?: () => void;
      fastApplyMergeRules?: () => Promise<void>;
    };
    /**
     * Model manager. When provided, mounts the `/admin/models/*` and
     * `/admin/system-info` routes.
     */
    modelManager?: ModelManager;
    /** Bundled and gateway-refreshed Models.dev model metadata and provider logos. */
    modelsDevCatalog?: import("./models/models-dev-catalog.js").ModelsDevCatalog;
    /** Snapshot getter for `/admin/system-info`. Required when modelManager is provided. */
    getSystemInfo?: () => SystemInfo;
    /** Inference overview getter — used by model routes. */
    getInferenceOverview?: () => import("@omnesis/core").InferenceOverview;
    /**
     * Inference config-health getter — the degraded (typo'd / dangling) role
     * assignments + a one-line summary. Surfaced on `/status` so a capability
     * silently disabled by a bad assignment becomes a named, queryable signal.
     */
    getConfigHealth?: () => import("@omnesis/core").ConfigHealth;
    /** Last successful install-aware release check, or null before one succeeds. */
    getReleaseCheck?: () => import("@omnesis/core/release-check").ReleaseCheckSnapshot | null;
    /**
     * Briefs feature-gate getter (experimental) — advertised as the `briefs`
     * field on `GET /status` so clients can tell feature-hidden from
     * shown-but-needs-a-model. Omitted ⇒ advertised inactive.
     */
    getBriefsStatus?: () => import("./brain/index.js").BriefsFeatureStatus;
    getBriefTalkback?: () =>
      | import("./brain/talkback/talkback-service.js").BriefTalkbackPort
      | null;
    /** Replay-only settable briefs decision clock (backtest mirror). */
    briefsClock?: import("./brain/virtual-clock.js").MutableClock;
    /**
     * The Cognition Steward drainer's live-run registry, shared by the composition
     * root so `/admin/brain/runs` can flag the run executing right now.
     */
    cognitionActivity?: import("./brain/admin-http.js").RunActivityReader;
    sweeps?: import("./brain/sweeps/service.js").SweepService;
    getSweepsEnabled?: () => boolean;
    /** Resolved `brain.bootstrap` knobs, read live, for the lane's status route. */
    getBootstrapSettings?: () => BootstrapSettingsView;
    getBudgetSettings?: () => CognitionBudgetSettings;
    startBootstrap?: (now: number) => Promise<number>;
    /** The io worker, so the bootstrap backlog scan runs off the main loop. */
    io?: import("./brain/bootstrap-status.js").BootstrapBacklogReader &
      import("./brain/bootstrap-status.js").BootstrapTimelineReader;
    /** Probe one HTTP backend (auth'd) and update its cached status — used by the probe route. */
    probeBackend?: (
      key: string,
    ) => Promise<{ status: "ok" | "reachable" | "unreachable"; models: string[]; reason?: string }>;
    /** Behaviorally verify one (backend, model, role) — used by the verify route. */
    verifyModel?: (
      key: string,
      model: string,
      role: import("@omnesis/core").CapabilityRole,
      opts?: { force?: boolean },
    ) => Promise<import("@omnesis/core").CapabilityVerdict>;
    /** Built-in Codex backend status and device-login hooks, mounted with model routes. */
    getCodexStatus?: () => import("@omnesis/core").CodexBackendStatus;
    refreshCodexStatus?: () => Promise<import("@omnesis/core").CodexBackendStatus>;
    setupCodexAgent?: (
      model: string,
    ) => Promise<import("./models/codex-agent-setup.js").CodexAgentSetupResult>;
    getCodexRuntimeUpdate?: () => Promise<import("@omnesis/core").CodexRuntimeUpdateSnapshot>;
    startCodexRuntimeUpdate?: (opts: {
      dryRun: boolean;
    }) => Promise<import("@omnesis/core").CodexRuntimeUpdateSnapshot>;
    cancelCodexRuntimeUpdate?: () => Promise<import("@omnesis/core").CodexRuntimeUpdateSnapshot>;
    /** Refresh the Anthropic Models API catalog on demand. */
    refreshAnthropicStatus?: () => Promise<import("@omnesis/core").BackendStatus | undefined>;
    /**
     * "Recently used" entries for a reference capability (served by
     * `GET /admin/models/recent/:capability`). Optional; the route answers
     * with no entries when unwired.
     */
    getRecentModels?: (
      capability: import("@omnesis/core").CapabilityRole,
    ) => import("./models/recent-models.js").RecentModelsResult;
    startCodexLogin?: () => Promise<import("@omnesis/core").CodexLoginFlow>;
    getCodexLogin?: () => import("@omnesis/core").CodexLoginFlow | null;
    cancelCodexLogin?: () => Promise<{
      ok: true;
      canceled: boolean;
      flow: import("@omnesis/core").CodexLoginFlow | null;
    }>;
    logoutCodex?: () => Promise<{
      ok: true;
      status: import("@omnesis/core").CodexBackendStatus;
    }>;
    /**
     * Speech-to-text service. When provided, mounts `POST /inference/transcribe`
     * (gated behind the `stt` experimental feature). The collector calls it to
     * transcribe source audio (e.g. WhatsApp voice notes) during sync.
     */
    transcribeService?: import("./transcribe/index.js").TranscribeService;
    /**
     * OCR service. When provided, mounts `POST /inference/ocr` (gated behind
     * the `ocr` experimental feature). The collector calls it to recognize
     * text in image / scanned-PDF attachments during sync.
     */
    ocrService?: import("./ocr/index.js").OcrService;
    /**
     * Online-backup service. When provided, mounts the
     * `/admin/backup*` routes.
     */
    backupService?: import("./http/services/BackupService.js").BackupService;
    /**
     * Portable data-export service. When provided, mounts the
     * `/admin/export*` routes.
     */
    exportService?: import("./http/services/ExportService.js").ExportService;
    /**
     * The push transport. When provided, the APNs status/test routes mount
     * and document/analytics writes publish on the event bus for the watch
     * runtime to read.
     */
    pushTransport?: PushTransport;
    /** Built-in durable source-permission reminder producer. */
    mobilePermissionNotifier?: SourcePermissionNotifier;
    /** Generic, content-free wake for a validated pending MCP authorization. */
    accessAuthorizationNotifier?: import("./access/authorization-notifier.js").AccessAuthorizationNotifier;
    /** Asks the expired-access sweep to re-read when it should next wake. */
    accessCleanupWake?: () => void;
    /**
     * Optional in-process event bus override. Defaults to the singleton
     * exported from events.ts; tests can pass a fresh bus to avoid
     * cross-test leakage.
     */
    eventBus?: EventBus;
    /**
     * Gateway-host config dir (where model-provider credential files
     * live). When provided, mounts `/admin/model-credentials/*` routes.
     * Optional so tests that don't exercise model-provider config can
     * skip wiring it.
     */
    configDir?: string;
    /**
     * The gateway's last measured on-disk footprint, for `/status` and the
     * doctor. Optional so test gateways need not walk a config dir.
     */
    getDiskUsage?: () => DiskUsageSnapshot | null;
    /**
     * Called after a model-provider credential file is written or
     * cleared. The gateway uses this to rebuild the affected provider in
     * place — flipping availability without a restart.
     */
    onModelCredentialsChanged?: (fileKey: string) => Promise<void> | void;
    /**
     * Resolved gateway-process timing budgets (subset surfaced to the
     * HTTP layer). Populated by `index.ts` from `runtime-settings.ts`;
     * tests that don't exercise these paths can omit it and get the
     * defaults below.
     */
    timings?: {
      /** Slow-request log/metrics threshold, ms. 0 disables. */
      slowRequestMs?: number;
      /** Default TTL applied to `/admin/devices/pair` when the body omits ttlMs. */
      pairingTtlMs?: number;
      /** Portal session-cookie TTL, ms. */
      sessionTtlMs?: number;
      /** Minimum interval between sliding portal-session refresh writes, ms. */
      sessionRefreshThrottleMs?: number;
    };
    /**
     * SHA-256 fingerprint (hex, lowercase, no colons) of the TLS leaf
     * cert the gateway is currently serving. Echoed by
     * `/admin/devices/pair` so the CLI can mint a V3 QR pairing payload
     * — iOS pins the fingerprint on first connect (TOFU). Optional only
     * so unit tests that build a server without TLS wiring can omit it.
     */
    tlsFingerprintSha256?: string | (() => string);
    /** The served certificate's lifecycle, for `/admin/tls`. */
    tlsLifecycle?: TlsLifecyclePort;
    /** HTTPS origins allowed in explicitly system-trusted V4 pairing payloads. */
    systemTrustPairingOrigins?: readonly string[] | (() => readonly string[]);
    /** Hosts the served certificate covers with a publicly trusted chain, at any port. */
    publiclyTrustedPairingHosts?: () => readonly string[];
    /** The `.local` name the gateway advertises with only real LAN addresses, or null. */
    advertisedPairingHost?: () => string | null;
    /** When the served certificate will next be replaced by the gateway, or null. */
    certificateRenewsAt?: () => Date | null;
    /**
     * Externally-reachable HTTPS base URL of this gateway (no trailing
     * slash). Forwarded to a collector's `auth.begin` so a source's
     * `authFlow` can build `${publicBaseUrl}/oauth/callback`. Populated by
     * `index.ts` from `runtime-settings.ts`; unset keeps the local-only
     * `localhost:3003` callback fallback.
     */
    publicBaseUrl?: string;
    /** Exact externally reachable MCP protected-resource URLs. */
    mcpResourceUrls?: readonly string[];
    /**
     * Gateway listen port. Used solely to scope the portal session
     * cookie name per-port (see `sessionCookieName(port)` in
     * `http/cookies.ts`) so two gateways on the same host don't
     * overwrite each other's `__omnesis_session` cookie in the browser.
     * Omit in tests that don't exercise the portal cookie path.
     */
    port?: number;
    /**
     * Search snapshot handle for /admin/search-snapshot/*. Pass-through
     * to the admin routes; only present when `search.snapshot.enabled`
     * is true in config. Narrow shape so server.ts doesn't import the
     * concrete handle class.
     */
    searchSnapshot?: {
      refresh(): Promise<number>;
      stats(): {
        readonly openedAt: number;
        readonly refreshCount: number;
        readonly lastRefreshAt: number | null;
        readonly lastRefreshDurationMs: number;
        readonly refreshErrors: number;
      };
    };
  },
) {
  const app = strictRoute(new Hono<AppEnv>());

  if (opts?.requestAdmission) app.use("*", opts.requestAdmission);
  app.use("*", requestIdMiddleware());

  // CORS — mounted before onError so it answers preflight even for
  // unauthenticated requests AND so CORS headers are present on error
  // responses. Reads live config through a thunk (off when unset, so a
  // createServer without a configStore is simply inert).
  app.use(
    "*",
    corsMiddleware(() => opts?.configStore?.get().gateway?.cors),
  );

  // Centralized error mapping. Every route handler can either:
  //
  //   1. THROW an HttpError subclass (BadRequestError, NotFoundError,
  //      BadGatewayError, ServiceUnavailableError, …) — preferred. The
  //      onError below maps it to the canonical envelope:
  //          { error, code, detail? } at err.status.
  //   2. Throw something else — falls through to the sanitized 500
  //      branch (no err.message leak; requestId for correlation).
  //
  // Two transient writer-side failure modes get explicit 503 +
  // Retry-After=1 mappings so the collector's http client recognises
  // them as backpressure rather than escalating:
  //
  //   - SchedulerQueueFullError — the priority queue's hard cap was
  //     hit. Self-heals as the writer drains.
  //   - SQLITE_READONLY — write attempted against the read-only
  //     handle (transient during shutdown / failover).
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return errorResponse(c, err);
    }
    if (err instanceof HTTPException) {
      // Most commonly: validate(json) middleware encountered a malformed
      // JSON body — Hono throws HTTPException(400, { message: "Malformed
      // JSON in request body" }). Surface as a structured 400 envelope
      // matching the rest of the validation layer.
      //
      // Logged for the same reason `errorResponse` logs its refusals: a
      // client whose requests the gateway refuses must be diagnosable from
      // the gateway's own journal.
      const reqId = (c.get("requestId") as string | undefined) ?? "?";
      log.warn(
        `${err.status} BAD_REQUEST on ${c.req.method} ${c.req.path} [req=${reqId}]: ${err.message}`,
      );
      return c.json({ error: err.message || "request error", code: "BAD_REQUEST" }, err.status);
    }
    if (err instanceof SchedulerQueueFullError) {
      log.warn(`scheduler queue full on ${c.req.method} ${c.req.path}: ${err.message}`);
      return c.json(
        {
          error: "writer queue full — try again in a moment",
          code: "QUEUE_FULL",
          detail: { op: err.taskName, priority: err.priority },
        },
        503,
        { "Retry-After": "1" },
      );
    }
    const sqliteCode = (err as { code?: string }).code;
    const looksLikeReadonly =
      sqliteCode === "SQLITE_READONLY" ||
      err.message?.includes("SQLITE_READONLY") ||
      err.message?.includes("attempt to write a readonly database");
    const reqId = (c.get("requestId") as string | undefined) ?? "?";
    if (looksLikeReadonly) {
      log.error(`SQLITE_READONLY on ${c.req.method} ${c.req.path} [req=${reqId}]: ${err.message}`);
      return c.json(
        { error: "gateway db temporarily read-only — try again", code: "SQLITE_READONLY" },
        503,
        { "Retry-After": "1" },
      );
    }
    // Sanitized 500. Don't leak err.message or stack to
    // the client; log the full stack server-side and surface only the
    // request id (already resolved as `reqId` above for the
    // SQLITE_READONLY branch) so an operator can correlate.
    log.error(
      `unhandled error in ${c.req.method} ${c.req.path} [req=${reqId}]: ${err.stack ?? err.message}`,
    );
    return c.json(
      {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        ...(reqId !== "?" ? { requestId: reqId } : {}),
      },
      500,
    );
  });

  // Single-writer gate. Falls back to directWriteGate(db) when the
  // caller didn't provide one.
  const w: WriteGate = opts?.writeGate ?? directWriteGate(db);
  const accessService = new AccessService(db, w);

  // Per-port session cookie name — see `sessionCookieName` in
  // `http/cookies.ts`. The auth middleware (below) and the portal routes
  // both read/write this exact name; threading it through a single const
  // here keeps them in lock-step.
  const cookieName = sessionCookieName(opts?.port);
  const sessionMaxAgeS =
    opts?.timings?.sessionTtlMs !== undefined
      ? Math.max(1, Math.floor(opts.timings.sessionTtlMs / 1000))
      : undefined;

  // Typed gate for `index.db` writes. Built once
  // here from the long-lived writable handle the gateway opened at
  // boot; `DocumentService` + `SourceService` consume the gate
  // instead of reaching into `indexer/db.ts` directly. The model-
  // swap path uses its own brief-reopen helper from
  // `indexer/index-write-gate.ts` since the indexer worker (the
  // long-lived single writer) gets disposed before that op fires.
  //
  // `deleteIndexBySource` is the one op that must not race the worker's
  // backfill, so it routes through the worker (serialized, owning the usearch
  // handle) when one is running, falling back to the direct path otherwise.
  const indexWriteGate: IndexWriteGate | undefined = opts?.indexDb
    ? workerCoordinatedIndexWriteGate(opts.indexDb, (sourceId) =>
        opts?.indexerControl?.deleteSourceIndex?.(sourceId),
      )
    : undefined;

  // ── Services ──────────────────────────────────────────────────────────
  const sourceWriteEpochFence = new SourceWriteEpochFence();
  const eventService = new EventService(
    db,
    opts?.eventBus,
    !!opts?.pushTransport,
    opts?.ingestYieldBatch,
  );
  // One removal service for every multi-store wipe: the document routes'
  // source/provider wipes and SourceService's stream removals on detach,
  // move and per-device resync.
  const sourceDataRemoval = new SourceDataRemovalService({
    db,
    writeGate: w,
    indexWriteGate,
    analyticsDb: opts?.analyticsDb,
    sourceWriteEpochFence,
    purgeAnnotationsFor: (documentIds) => purgeCognitiveStateThroughGate(db, w, documentIds),
  });
  const documentService = new DocumentService({
    db,
    writeGate: w,
    events: eventService,
    ingestYieldBatch: opts?.ingestYieldBatch,
    configStore: opts?.configStore,
    config: opts?.config,
    indexWriteGate,
    analyticsDb: opts?.analyticsDb,
    ioGate: opts?.ioGate,
    sourceWriteEpochFence,
    sourceDataRemoval,
    indexerWake: opts?.indexerControl?.wake,
    onDocumentsUpserted: opts?.onDocumentsUpserted,
    // Low-disk ingestion guard. Inert unless both the DB path and a
    // threshold are wired (production always wires both; most tests omit).
    gatewayDbPath: dbPath,
    minFreeDiskBytes:
      opts?.minFreeDiskMb !== undefined ? opts.minFreeDiskMb * 1024 * 1024 : undefined,
  });
  const personService = new PersonService(
    db,
    w,
    {
      wakeMergeEval: opts?.peopleControl?.wakeMergeEval,
      fastApplyMergeRules: opts?.peopleControl?.fastApplyMergeRules,
    },
    opts?.ioGate,
  );
  const deviceService = new DeviceService(db);
  const pushRegistrationService = new PushRegistrationService({
    devices: deviceService,
    writeGate: w,
    getConfig: opts?.configStore ? () => opts.configStore!.get() : undefined,
    getRelaySettings:
      opts?.pushPlan?.getRelaySettings ??
      (() => ({ enabled: false, url: DEFAULT_PUSH_RELAY_URL, visible: false })),
    getFcmProjectId: opts?.pushPlan?.getFcmProjectId ?? (() => Promise.resolve(undefined)),
    onDeviceChanged: () => statusCache.bump(),
  });
  const analyticsService = opts?.analyticsDb
    ? new AnalyticsService(
        opts.analyticsDb,
        opts?.eventBus,
        !!opts?.pushTransport,
        (sourceId, cursorRow) => getWipeEpoch(db, sourceId, cursorRow),
        sourceWriteEpochFence,
        () => {
          const settings = resolveRuntimeSettings(opts?.configStore?.get() ?? opts?.config);
          return {
            minObservations: settings.snapshotAbsenceMinObservations,
            minAgeMs: settings.snapshotAbsenceMinAgeMs,
            maxMarksPerSnapshot: settings.snapshotAbsenceMaxMarksPerSnapshot,
          };
        },
        {
          cursorRows: (sourceId) => listCursorRows(db, sourceId),
          omissionCandidates: (sourceId, tableName, deviceId) =>
            listAnalyticsOmissionCandidates(db, sourceId, tableName, deviceId),
          claimedKeys: (sourceId, tableName, keyValues) =>
            listClaimedExternalIds(db, analyticsClaimNamespace(tableName), sourceId, keyValues),
          judgeTombstones: (args) => w.judgeAnalyticsTombstones(args),
          recordPresence: (args) => w.recordAnalyticsPresence(args),
          recordRestorerOmissions: (args) => w.recordAnalyticsRestorerOmissions(args),
        },
        opts?.minFreeDiskMb === undefined || dbPath === undefined
          ? undefined
          : {
              dbPath,
              minFreeBytes: opts.minFreeDiskMb * 1024 * 1024,
            },
      )
    : null;
  const statusCache = new StatusCache(db, opts?.analyticsDb);
  // SourceService + AuthService are instantiated below, after the closure
  // helpers (notifySourceChange, syncSourceSettingsToConfig,
  // createOrReplaceDeviceForPair) are defined.

  // Slow-request tracer + metrics recorder. Resolved upstream in
  // runtime-settings.ts (env > config > default); the default below
  // covers tests that construct `createServer` directly.
  const SLOW_REQUEST_MS = opts?.timings?.slowRequestMs ?? 500;
  // Device-kind lookup cache. Typical installs have <10 paired devices and
  // even 1000 would be ~50KB — the eviction cost (LRU bookkeeping or a
  // hand-rolled FIFO cap) is greater than the keep cost. Unbounded Map
  // suffices; new devices are added on first lookup and never reclaimed
  // (deletions are rare and don't accumulate stale entries since the
  // device id never collides).
  const deviceKindCache = new Map<string, string | null>();
  function deviceKindFor(deviceId: DeviceId): string | null {
    const cached = deviceKindCache.get(deviceId);
    if (cached !== undefined) return cached;
    const dev = getDevice(db, deviceId);
    const kind = dev?.kind ?? null;
    deviceKindCache.set(deviceId, kind);
    return kind;
  }

  const tokenUsageBuffer = opts?.tokenUsageBuffer;
  const principalCredentialUsageBuffer = opts?.principalCredentialUsageBuffer;

  app.use("*", async (c, next) => {
    const startMs = Date.now();
    const timing = newRequestTiming();
    await runWithTiming(timing, async () => {
      await next();
    });
    const tookMs = Date.now() - startMs;
    const auth = c.get("auth") as AuthContext | undefined;

    let callerKind: CallerKind = "unknown";
    let callerLabel = "no-device";
    if (auth?.deviceId) {
      const kind = deviceKindFor(auth.deviceId);
      callerKind = callerKindFromDeviceKind(kind ?? undefined);
      callerLabel = kind ? `${auth.deviceId.slice(0, 8)} (${kind})` : auth.deviceId;
    } else {
      const ua = c.req.header("User-Agent");
      if (ua) callerLabel = `ua="${ua}"`;
    }

    const wq = timing.writerQueueMs;
    const wx = timing.writerExecMs;
    const calls = timing.writerCalls;

    if (opts?.metrics) {
      const route = c.req.routePath || c.req.path;
      opts.metrics.recordRequest(route, callerKind, {
        ts: Date.now(),
        totalMs: tookMs,
        writerQueueMs: wq,
        writerExecMs: wx,
        writerCalls: calls,
        status: c.res.status,
      });
    }

    if (SLOW_REQUEST_MS > 0 && tookMs >= SLOW_REQUEST_MS) {
      const other = Math.max(0, tookMs - wq - wx);
      const breakdown =
        calls > 0
          ? ` (wq=${wq}ms wx=${wx}ms other=${other}ms calls=${calls})`
          : ` (other=${other}ms calls=0)`;
      const reqId = (c.get("requestId") as string | undefined) ?? "?";
      log.warn(
        `slow ${c.req.method} ${c.req.path} in ${tookMs}ms${breakdown} [${callerLabel}] [req=${reqId}]`,
      );
    }
  });

  // Auth middleware: parse the Bearer token / portal session cookie and stash
  // the result on the context. Scope enforcement happens per-route via the
  // mount-site `scope.*()` guards (see `http/scope.ts`); this middleware
  // never 401s or 403s on its own.
  app.use("*", async (c, next) => {
    let auth: AuthContext | null = null;

    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const rawToken = authHeader.slice(7);
      const oauthUrls = resolveOAuthUrls(c.req.url, opts?.publicBaseUrl, opts?.mcpResourceUrls);
      const principal =
        c.req.path === "/mcp" && oauthUrls
          ? (() => {
              const resource = resolveMcpRequestResource(c.req.url, oauthUrls.supportedResources);
              return resource ? accessService.lookupAccessToken(rawToken, resource) : null;
            })()
          : null;
      if (principal) {
        auth = {
          authMethod: "principal-oauth",
          deviceId: null,
          tokenId: null,
          scopes: [],
          accessTokenId: principal.accessTokenId,
          principalId: principal.principalId,
          principalName: principal.principalName,
          grantId: principal.grantId,
          grantRevision: principal.grantRevision,
          credentialId: principal.credentialId,
          oauthClientId: principal.oauthClientId,
          executionDeviceId: principal.executionDeviceId,
          capabilities: principal.capabilities,
          expiresAt: principal.expiresAt,
        };
        principalCredentialUsageBuffer?.note(principal.credentialId);
      } else {
        const info = lookupToken(db, rawToken);
        if (info) {
          let scopes = info.scopes;
          const device = getDevice(db, info.deviceId);
          if (device) {
            const missing = missingHostedWriteScopes(scopes, device.kind);
            if (missing.length > 0) {
              const reconciled = await w
                .reconcileDeviceTokenScopes(info.id, device.kind)
                .catch((err: unknown) => {
                  log.warn(
                    `Failed to reconcile scopes for ${device.name} (${device.kind}): ${err instanceof Error ? err.message : String(err)}`,
                  );
                  return null;
                });
              if (reconciled) {
                scopes = reconciled;
                log.info(
                  `Granted ${device.name} (${device.kind}) missing scopes: ${missing.join(", ")}`,
                );
              }
            }
          }
          auth = { authMethod: "bearer", deviceId: info.deviceId, tokenId: info.id, scopes };
          tokenUsageBuffer?.note(info.id, info.deviceId);
        }
      }
    }

    if (!auth) {
      const sessionId = getSessionCookie(c.req.header("Cookie"), cookieName);
      if (sessionId) {
        const { info: session, expired } = lookupSession(db, sessionId);
        if (session) {
          auth = {
            authMethod: "portal-session",
            deviceId: null,
            credentialDeviceId: session.credentialDeviceId,
            tokenId: session.tokenId,
            scopes: session.scopes,
            csrfToken: portalCsrfToken(sessionId),
          };
          // A paired Portal has its own device and its cookie traffic is useful
          // activity evidence for that row. A raw-token login instead borrows a
          // CLI/collector credential; never attribute browser traffic to that
          // credential owner's device.
          if (session.portalDeviceId !== null) {
            tokenUsageBuffer?.note(session.tokenId, session.portalDeviceId);
          }
          if (c.req.path !== "/portal/api/login" && c.req.path !== "/portal/api/logout") {
            const refreshed = scheduleSessionRefresh(
              w,
              sessionId,
              session.lastActiveAt,
              opts?.timings?.sessionTtlMs,
              opts?.timings?.sessionRefreshThrottleMs,
            );
            if (refreshed) {
              c.header(
                "Set-Cookie",
                buildSessionCookieHeader(sessionId, sessionMaxAgeS, cookieName),
              );
            }
          }
        } else if (expired) {
          void Promise.resolve(
            runWithPriority("background", () => w.purgeExpiredSession(sessionId)),
          ).catch(() => {
            /* beacon, ignore */
          });
        }
      }
    }

    if (auth) c.set("auth", auth);
    return next();
  });

  app.use("*", requestContextMiddleware());

  // Per-token / per-endpoint access logging — runs after auth +
  // request-context so `c.get("auth")` is populated. Off by default;
  // bails cheaply when unset.
  app.use(
    "*",
    auditMiddleware(() => opts?.configStore?.get().gateway?.audit),
  );

  // Priority middleware — runs after auth, derives a writer-queue
  // priority class from the calling device's kind (cli/portal/
  // ios → user; collector → realtime; unknown → realtime), and
  // installs it as the AsyncLocalStorage default for any
  // writer-proxy `call()` issued downstream.
  app.use("*", async (c, next) => {
    const auth = c.get("auth") as AuthContext | undefined;
    if (!auth) {
      // Truly unauthenticated (health, pairing, login) — no priority tag,
      // and it must not engage admission control.
      return next();
    }
    // A session-cookie (portal) caller carries no deviceId but is
    // unambiguously a human at a browser → user priority. Device-token
    // callers resolve from their device kind.
    const priority: Priority = auth.deviceId
      ? callerKindToPriority(callerKindFromDeviceKind(deviceKindFor(auth.deviceId) ?? undefined))
      : "user";

    // While a user-priority request is in flight, defer NEW background work
    // (admission control). Realtime collector ingest never engages it.
    if (priority === "user" && opts?.scheduler?.beginUserAdmission) {
      const hold = opts.scheduler.beginUserAdmission();
      try {
        await runWithPriority(priority, () => next());
      } finally {
        hold.release();
      }
      return;
    }
    await runWithPriority(priority, () => next());
  });

  // ── Closure helpers shared across route modules ─────────────────────

  function notifySourceChange<K extends "source.added" | "source.removed" | "source.updated">(
    type: K,
    deviceId: DeviceId,
    payload: WsRequestPayload<K>,
  ): void {
    if (!opts?.wsServer) return;
    void opts.wsServer.sendCommand(deviceId, type, payload).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not connected")) {
        log.debug(
          `${type} queued skipped (device ${deviceId} offline) — client will resync on reconnect`,
        );
      } else {
        log.warn(`Failed to dispatch ${type} to device ${deviceId}: ${msg}`);
      }
    });
  }

  /**
   * Mirror a source's settings to the unified config file. Pass `null` to
   * erase the block (source removed). Random non-schema keys in the DB
   * config column are filtered out so validation doesn't reject the patch.
   */
  async function syncSourceSettingsToConfig(
    id: string,
    dbConfig: Record<string, unknown> | null | undefined,
    required = false,
  ): Promise<void> {
    if (!opts?.configStore) return;
    let res;
    try {
      res = await opts.configStore.update((current) => {
        // Deferred mode-transition publication must observe the source only
        // after it acquires ConfigStore's mutex. A concurrent PATCH or DELETE
        // may have committed since SQLite finalization returned.
        const resolvedConfig =
          dbConfig === undefined ? (getSource(db, SourceId(id))?.config ?? null) : dbConfig;
        const settings = resolvedConfig === null ? null : pickSourceSettings(resolvedConfig);
        const sources = { ...current.sources };
        if (settings === null) {
          delete sources[id];
        } else {
          sources[id] = settings;
        }
        const next = { ...current, sources };
        if (Object.keys(sources).length === 0) {
          const { sources: _removed, ...withoutSources } = next;
          return withoutSources;
        }
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Config file sync for ${id} failed: ${message}`);
      if (required) throw error;
      return;
    }
    if (!res.ok) {
      const message = res.errors.map((e) => `${e.path} ${e.message}`).join("; ");
      log.warn(`Config file sync for ${id} rejected: ${message}`);
      if (required) throw new Error(`Config file sync for ${id} rejected: ${message}`);
    }
  }

  // ─── Collector device resolution for admin source actions ───────────────
  //
  // Three variants. Each returns a `DeviceId` or a Hono `Response` to be
  // returned verbatim. Error responses carry a stable `code` field
  // (UPPERCASE_SNAKE) that CLI / portal clients switch on:
  //
  //   - 400 AMBIGUOUS_DEVICE         multiple collectors match
  //   - 400 NO_CAPABLE_DEVICE        no online collector hosts the type
  //   - 400 DEVICE_CANNOT_HOST_TYPE  explicit device declared caps but not the type
  //   - 400 NO_MATCHING_SOURCE       reauth: no source matches accountId
  //   - 404 DEVICE_NOT_FOUND         explicit deviceId malformed / absent
  //   - 404 DEVICE_NOT_COLLECTOR     explicit deviceId resolves to a non-collector
  //   - 404 NO_COLLECTOR_PAIRED      no collector device exists
  //   - 503 DEVICE_NOT_CONNECTED     explicit collector / required collector offline
  //   - 503 NO_COLLECTOR_ONLINE      collectors paired but none connected

  function jsonErr(
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): Response {
    return new Response(JSON.stringify({ code, error: message, ...(extra ?? {}) }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    resolveCollectorDeviceId,
    resolveCollectorDeviceIdForType,
    resolveCollectorDeviceIdForReauth,
    createOrReplaceDeviceForPair,
    deviceForSource,
  } = createCollectorDeviceResolver({
    db,
    wsServer: opts?.wsServer,
    syncStatus: opts?.syncStatus,
    jsonErr,
    writeGate: w,
  });

  const syncLease = new SyncLeaseRegistry({
    ttlMs: () =>
      parseDuration(opts?.configStore?.get().multiDevice?.leaseTtl ?? DEFAULT_SYNC_LEASE_TTL),
    isOnline: (deviceId) => opts?.wsServer?.isConnected(deviceId) ?? false,
  });
  const sourceService = new SourceService({
    db,
    writeGate: w,
    statusCache,
    wsServer: opts?.wsServer,
    syncStatus: opts?.syncStatus,
    indexWriteGate,
    sourceDataRemoval,
    sourceWriteEpochFence,
    sourceModeTransitionAdoption: opts?.analyticsDb
      ? new AnalyticsSourceModeTransitionAdoption({
          db,
          analyticsDb: opts.analyticsDb,
          writeEpochFence: sourceWriteEpochFence,
        })
      : undefined,
    syncLease,
    listDevices: () => deviceService.listDevices(),
    notifySourceChange,
    syncSourceSettingsToConfig,
  });

  const mobilePermissionHealthService = new MobilePermissionHealthService({
    writeGate: w,
    notifier: opts?.mobilePermissionNotifier,
  });

  // Finish any data purge a previous run left half-done. Nothing else would:
  // the source row is already gone, so no sync, scheduler tick or user action
  // ever visits those rows again. A no-op on the overwhelmingly common boot
  // where no removal was interrupted.
  sourceService.resumePendingRemovals();

  const pairingService = new PairingService({
    db,
    writeGate: w,
    statusCache,
    sourceService,
    wsServer: opts?.wsServer,
  });

  const authService = new AuthService({
    db,
    writeGate: w,
    statusCache,
    sessionTtlMs: opts?.timings?.sessionTtlMs,
    sessionRefreshThrottleMs: opts?.timings?.sessionRefreshThrottleMs,
    createOrReplaceDeviceForPair: async (name, _kind, caps) =>
      createOrReplaceDeviceForPair(name, "portal", caps),
  });

  // Synchronous prime + background refresh tick.
  opts?.onStatusCache?.(statusCache);
  statusCache.start();

  // ── Routes ──────────────────────────────────────────────────────────
  mountMobilePermissionHealthRoute(app, mobilePermissionHealthService);

  // Status block 1: /health, /config, /admin/config*, /status
  mountStatusRoutes(app, {
    db,
    dbPath,
    config: opts?.config,
    configStore: opts?.configStore,
    configDir: opts?.configDir,
    indexDb: opts?.indexDb,
    statusCache,
    deviceService,
    getConfigHealth: opts?.getConfigHealth,
    getReleaseCheck: opts?.getReleaseCheck,
    getBriefsStatus: opts?.getBriefsStatus,
    getDiskUsage: opts?.getDiskUsage,
  });

  // Model manager + system info routes (admin scope). Registered only
  // when the gateway was wired with a manager.
  if (
    opts?.modelManager &&
    opts?.configStore &&
    opts?.getSystemInfo &&
    opts?.getInferenceOverview &&
    opts?.probeBackend &&
    opts?.verifyModel
  ) {
    registerModelRoutes(app, {
      modelManager: opts.modelManager,
      modelsDevCatalog: opts.modelsDevCatalog,
      configStore: opts.configStore,
      getSystemInfo: opts.getSystemInfo,
      getInferenceOverview: opts.getInferenceOverview,
      probeBackend: opts.probeBackend,
      verifyModel: opts.verifyModel,
      getCodexStatus: opts.getCodexStatus,
      refreshCodexStatus: opts.refreshCodexStatus,
      setupCodexAgent: opts.setupCodexAgent,
      getCodexRuntimeUpdate: opts.getCodexRuntimeUpdate,
      startCodexRuntimeUpdate: opts.startCodexRuntimeUpdate,
      cancelCodexRuntimeUpdate: opts.cancelCodexRuntimeUpdate,
      refreshAnthropicStatus: opts.refreshAnthropicStatus,
      startCodexLogin: opts.startCodexLogin,
      getCodexLogin: opts.getCodexLogin,
      cancelCodexLogin: opts.cancelCodexLogin,
      logoutCodex: opts.logoutCodex,
      getRecentModels: opts.getRecentModels,
    });
  }

  // Speech-to-text route (gated behind the `stt` experimental feature inside
  // the handler). Mounted only when a transcribe service was wired.
  if (opts?.transcribeService) {
    mountTranscribeRoutes(app, { transcribeService: opts.transcribeService });
  }

  // OCR route (gated behind the `ocr` experimental feature inside the handler).
  // Mounted only when an OCR service was wired.
  if (opts?.ocrService) {
    mountOcrRoutes(app, { ocrService: opts.ocrService });
  }

  // OAuth's authenticated Portal APIs must be registered before the Portal SPA's
  // `/portal/*` catch-all. Otherwise a real client reaches the HTML shell instead
  // of the JSON approval endpoints even though the route-level tests pass.
  mountOAuthAccessRoutes(app, accessService, {
    publicBaseUrl: opts?.publicBaseUrl,
    mcpResourceUrls: opts?.mcpResourceUrls,
    authorizationNotifier: opts?.accessAuthorizationNotifier,
    onAuthorizationPending: opts?.accessCleanupWake,
    onDeviceLevelChanged: () => statusCache.bump(),
    gatewayPort: opts?.port,
    tlsFingerprintSha256: opts?.tlsFingerprintSha256,
  });
  mountLegacyMcpCutoverRoute(app, {
    getDevice: (deviceId) => getDevice(db, deviceId),
    revokeToken: (tokenId) => w.revokeToken(tokenId),
  });

  // Portal block (redirect, source-meta, login/logout/session, SPA static)
  mountPortalRoutes(app, {
    db,
    portalRoot: join(import.meta.dirname, "..", "portal"),
    authService,
    sourceService,
    sessionTtlMs: opts?.timings?.sessionTtlMs,
    sessionCookieName: cookieName,
  });

  // /db-size — registered between portal and admin in the original.
  mountDbSizeRoute(app, { dbPath });

  // Online backup. Mounted only when the gateway wired a service
  // (production); route tests inject their own.
  if (opts?.backupService) {
    mountBackupRoutes(app, { backupService: opts.backupService });
  }

  // Portable data export. Same wiring contract as backup.
  if (opts?.exportService) {
    mountExportRoutes(app, { exportService: opts.exportService });
  }

  // Model-provider credentials (gateway-host). Mounted before the
  // generic admin block so its specific routes resolve before any
  // greedier `/admin/*` matcher could intercept them.
  if (opts?.configDir) {
    mountModelCredentialsRoutes(app, {
      configDir: opts.configDir,
      onCredentialsChanged: opts.onModelCredentialsChanged,
    });
  }

  // Backs GET /admin/doctor. It folds the same bundle `omnesis doctor`
  // gathers over HTTP straight from in-process state, so the portal's
  // report and the CLI's are the same computation.
  // The app-bound push plan a phone would get today, for the doctor and the
  // push status alike; null for a phone that never announced its app.
  const planForPhone = (device: DeviceRecord): PushPlan | null =>
    (device.kind === "ios" || device.kind === "android") && device.capabilities.pushAppId
      ? pushRegistrationService.planForDevice(device, {
          platform: device.kind,
          appId: device.capabilities.pushAppId,
        })
      : null;
  const doctorService = new DoctorService({
    configDir: opts?.configDir,
    dbPath,
    getDiskUsage: opts?.getDiskUsage,
    configStore: opts?.configStore,
    statusCache,
    sourceService,
    wsServer: opts?.wsServer,
    indexStats: {
      db,
      indexDb: opts?.indexDb,
      configStore: opts?.configStore,
      config: opts?.config,
      indexerModel: opts?.indexerModel,
      indexerReadiness: opts?.indexerReadiness,
      getIndexRate: opts?.indexerControl?.getIndexRate,
    },
    getSystemInfo: opts?.getSystemInfo,
    getInferenceOverview: opts?.getInferenceOverview,
    getReleaseCheck: opts?.getReleaseCheck,
    getTlsLifecycle: opts?.tlsLifecycle ? () => opts.tlsLifecycle!.snapshot() : undefined,
    processVitals: opts?.processVitals,
    agentAuthorizations: () => accessService.agentDeviceAuthorizations(),
    pushPlanForDevice: planForPhone,
    ...(opts?.sweeps
      ? {
          sweeps: () => {
            const resolved = opts.sweeps!.resolve();
            return {
              laneEnabled: opts.getSweepsEnabled?.() ?? false,
              enabledCount: resolved.sweeps.filter((sw) => sw.enabled).length,
              issues: resolved.issues,
              digestWindowConflicts: opts.sweeps!.digestWindowConflicts(resolved.sweeps),
            };
          },
        }
      : {}),
  });
  const deviceDoctorService =
    opts?.deviceDoctorService ??
    new DeviceDoctorService({
      db,
      writeGate: w,
      wsServer: () => opts?.wsServer,
    });
  const watermarkService = new WatermarkService(db);
  const sourceUrlRecanonicalization = new SourceUrlRecanonicalizationService({
    plan: opts?.ioGate?.planSourceUrlRecanonicalization
      ? (specs, cursor) => opts.ioGate!.planSourceUrlRecanonicalization(specs, cursor)
      : async (specs, cursor) => planSourceUrlRecanonicalization(db, specs, cursor),
    apply: (cursor, mutations) => w.applySourceUrlRecanonicalizationPage(cursor, mutations),
    finish: (cursor) => w.finishSourceUrlRecanonicalization(cursor),
  });

  // Admin block (metrics, devices, tokens, sources core, sync/status,
  // sources/auth, /oauth/callback, /devices/pair).
  mountAdminRoutes(app, {
    db,
    writeGate: w,
    accessService,
    sourceUrlRecanonicalization,
    getConfig: opts?.configStore ? () => opts.configStore!.get() : undefined,
    pushPlan: opts?.pushPlan,
    statusCache,
    sourceService,
    deviceService,
    pushRegistrationService,
    indexDb: opts?.indexDb,
    wsServer: opts?.wsServer,
    authFlows: opts?.authFlows,
    importFlows: opts?.importFlows,
    metrics: opts?.metrics,
    processVitals: opts?.processVitals,
    scheduler: opts?.scheduler,
    backgroundJobs: opts?.backgroundJobs,
    pairingTtlMs: opts?.timings?.pairingTtlMs,
    publicBaseUrl: opts?.publicBaseUrl,
    resolveCollectorDeviceId,
    resolveCollectorDeviceIdForType,
    resolveCollectorDeviceIdForReauth,
    deviceForSource,
    pairingService,
    tlsFingerprintSha256: opts?.tlsFingerprintSha256,
    tlsLifecycle: opts?.tlsLifecycle,
    systemTrustPairingOrigins:
      opts?.systemTrustPairingOrigins ?? (opts?.publicBaseUrl ? [opts.publicBaseUrl] : []),
    publiclyTrustedPairingHosts: opts?.publiclyTrustedPairingHosts,
    advertisedPairingHost: opts?.advertisedPairingHost,
    certificateRenewsAt: opts?.certificateRenewsAt,
    gatewayPort: opts?.port,
    searchSnapshot: opts?.searchSnapshot,
    doctorService,
    deviceDoctorService,
    fleetUpdateService: opts?.fleetUpdateService,
    hostFleetUpdateService: opts?.hostFleetUpdateService,
    watermarkService,
  });

  // Documents core (CRUD, count/stats/recent, list/ids/exists).
  mountDocumentCoreRoutes(app, {
    db,
    writeGate: w,
    documentService,
    sourceService,
    indexDb: opts?.indexDb,
  });

  // The capture policy every paired browser enforces (shared pause, excluded
  // domains, owned domains, privacy rules, pages deleted for good).
  mountWebCapturePolicyRoutes(
    app,
    new WebCapturePolicyService({
      db,
      writeGate: w,
      sourceService,
      documentService,
      ownedDomains: getOwnedWebDomains,
      onChanged: () => statusCache.bump(),
    }),
  );

  // Developer annotations (OMNESIS_DEV_MODE): the operator → engineer
  // data-quality feedback channel. Each handler 404s unless dev mode is on.
  mountDevAnnotationsRoutes(app, { db, writeGate: w });

  // Watch V2's shadow runtime. Mounted only when the subsystem exists, and
  // gated again inside so a runtime toggle does not need a restart.
  if (opts?.watchV2Routes) mountWatchV2Routes(app, opts.watchV2Routes);

  // Search routes (must come BEFORE /documents/:id since /documents/search
  // would otherwise be shadowed).
  mountSearchRoutes(app, {
    db,
    searchPipeline: opts?.searchPipeline,
    indexerReadiness: opts?.indexerReadiness,
    // Read-worker gate — routes the legacy LIKE scan off the main event loop.
    ioGate: opts?.ioGate,
  });

  // Canonical Direct MCP tools are built independently of the configured
  // agent model and served only through the standard MCP endpoint.
  const directMcpService =
    opts?.directMcpService ??
    (opts?.searchPipeline && opts.analyticsDb
      ? createGatewayDirectMcpService({
          db,
          searchPipeline: opts.searchPipeline,
          analyticsDb: opts.analyticsDb,
          syncStatus: opts.syncStatus,
          personLookupGate: opts.personLookupGate,
        })
      : undefined);
  const directMcpBoundary = directMcpService
    ? new DirectMcpExecutionBoundary(directMcpService)
    : undefined;

  /**
   * Which agent integration a paired device is, read from the device's own
   * declared capability. Shared by the routes that need to know who is asking:
   * the subscription routes, to aim a wake, and the agent routes, to decide
   * which audience a session's tools answer.
   */
  const harnessOf = (deviceId: string): string | null =>
    getDevice(db, deviceId as DeviceId)?.capabilities?.agentIntegration?.harness ?? null;

  const agentDeps = withCallerResolver(
    opts?.agentRouteDeps ?? {
      agentService: opts?.agentService,
      disabledReason: opts?.agentDisabledReason,
      agentConfig: opts?.agentConfig,
    },
    harnessOf,
  );
  // An injected `deviceAnswerScope` (a test double) takes precedence.
  agentDeps.deviceAnswerScope ??= (deviceId, tokenId) =>
    resolveDeviceAnswerScope(db, deviceId, tokenId);
  mountAgentRoutes(app, agentDeps);
  const mcpHttpRuntime = mountMcpStreamableRoutes(app, {
    notesRuntime: () => getOmnesisNotesRuntime(),
    directBoundary: directMcpBoundary,
    answerDeps: agentDeps,
    isAgentIntegrationDevice: (deviceId) => {
      const device = getDevice(db, deviceId);
      return (
        device?.kind === "agent" &&
        device.revokedAt === null &&
        device.capabilities.agentIntegration !== undefined
      );
    },
    publicBaseUrl: opts?.publicBaseUrl,
    mcpResourceUrls: opts?.mcpResourceUrls,
    recordMcpToolInvocation: (input) => accessService.recordMcpToolInvocation(input),
    recordDirectAuditEvent: async (input) => {
      await w.appendDirectAuditEvent(input);
    },
  });
  opts?.onMcpHttpRuntime?.(mcpHttpRuntime);
  mountPrivacyRoutes(app, agentDeps);
  // OMNESIS.md. Defaulted from `configDir` the same way the privacy policy
  // store is below, so a server built with a config directory serves it
  // without the composition root having to pass the store twice.
  const instructionsStore =
    opts?.operatorInstructions ??
    (opts?.configDir ? new OperatorInstructionsStore(opts.configDir) : undefined);
  mountInstructionsRoutes(app, instructionsStore ? { store: instructionsStore } : {});
  const subscriptionService =
    opts?.subscriptionService ??
    (opts?.configDir
      ? new SubscriptionService({
          db,
          writeGate: w,
          policyStore:
            opts.privacyPolicyStore ?? new PrivacyPolicyStore(opts.configDir, { db, writeGate: w }),
          reviewWatchExistence: createWatchExistenceReviewer(
            agentDeps.privacyReviewer ?? new PrivacyReviewer({ resolveBackend: () => null }),
          ),
        })
      : undefined);
  if (subscriptionService) opts?.onSubscriptionService?.(subscriptionService);
  mountSubscriptionRoutes(app, {
    service: subscriptionService,
    getAnswerService: () => agentDeps.answerService,
    // The same authoring path the operator's own compile route takes, so a
    // watch means one thing regardless of who asked for it.
    ...(opts?.watchV2Routes
      ? {
          authorWatch: (input) => opts.watchV2Routes!.author(input),
          // The same object the operator's compile route reads, so both entry
          // points stop accepting at the same moment.
          compiles: opts.watchV2Routes.compiles,
          harnessOf,
          retireAuthoredWatch: (subscriptionId, revision) =>
            opts.watchV2Routes!.retireAuthoredWatch(subscriptionId, revision),
        }
      : {}),
  });
  mountNotificationRoutes(app, {
    claim: (deviceId) => w.claimNotification({ deviceId, now: Date.now() }),
    confirm: (deviceId, deliveryId) =>
      w.confirmNotification({ deviceId, deliveryId, now: Date.now() }),
  });

  // /documents/:id/refs + /links/stats — registered after search but
  // before people in the original.
  mountDocumentRefsRoute(app, { db, documentService });

  // /documents/:id/graph — multi-edge-type subgraph for the portal's
  // graph-debug page. Registered before the /documents/:id catch-all so
  // the greedy matcher doesn't intercept it.
  mountDocumentGraphRoute(app, { db, analyticsDb: opts?.analyticsDb });
  mountDocumentTrailRoute(app, { db });
  // POST /graph/walk — the unified graph-traversal primitive.
  mountGraphWalkRoute(app, { db, analyticsDb: opts?.analyticsDb });

  // People + interleaved /documents/:id/people + /documents/people-bulk +
  // people/merge-rules + people/merge-candidates.
  mountPeopleRoutes(app, { personService });

  // /documents/:id catch-all — registered AFTER people routes in the
  // original (line 3007), so the greedy :id matcher doesn't intercept
  // /documents/:id/refs etc.
  mountDocumentByIdRoute(app, { db });

  // /sync-state/:sourceId GET + POST.
  mountSyncStateRoutes(app, { documentService, sourceService });

  // omnesis-notes — the "tell the brain" quick-capture source. Booted here
  // because it writes day documents through DocumentService.ingest (which
  // emits document.upserted for the briefs
  // waker and wakes the indexer) — the direct WriteGate path would skip
  // both. NOT agent-gated: capture works with no chat agent configured.
  let omnesisNotesRuntime: OmnesisNotesRuntime | undefined;
  const getOmnesisNotesRuntime = (): OmnesisNotesRuntime => {
    if (omnesisNotesRuntime) return omnesisNotesRuntime;
    omnesisNotesRuntime = bootOmnesisNotes({
      writeGate: w,
      readDb: db,
      ingest: (docs) => documentService.ingest(docs),
      deleteByIds: (providerId, sourceId, externalIds) =>
        documentService.deleteByIds(providerId, sourceId, externalIds),
    });
    return omnesisNotesRuntime;
  };
  if (opts?.onOmnesisNotesRuntime) {
    const runtime = getOmnesisNotesRuntime();
    opts.onOmnesisNotesRuntime(runtime);
  }
  mountNotesRoutes(app, { runtime: getOmnesisNotesRuntime });

  // agent-conversations: the pushed-transcript ingest surface for the managed
  // OpenClaw / Hermes plugins. Generally available — a paired harness ingests
  // its transcripts on any gateway, whether or not the Watch runtime is on.
  const agentConversationsRuntime: AgentConversationsRuntime = bootAgentConversations({
    writeGate: w,
    readDb: db,
    ingest: (docs) => documentService.ingest(docs),
    deleteByIds: (providerId, sourceId, externalIds) =>
      documentService.deleteByIds(providerId, sourceId, externalIds),
  });
  opts?.onAgentConversationsRuntime?.(agentConversationsRuntime);
  mountAgentMessagesRoutes(app, { runtime: agentConversationsRuntime });

  // /briefs/* + /loops* (experimental; feed/triage survive a parked background model).
  mountBriefsRoutes(app, {
    db,
    analyticsDb: opts?.analyticsDb,
    writeGate: w,
    getStatus: opts?.getBriefsStatus,
    clock: opts?.briefsClock,
    getTalkback: opts?.getBriefTalkback,
  });

  // /admin/brain/* — the operator inspection surface the `omnesis
  // briefs` CLI drives (same live feature gate: 404 unless active).
  mountBrainAdminRoutes(app, {
    db,
    writeGate: w,
    getStatus: opts?.getBriefsStatus,
    transcriptsDir: opts?.configDir ? cognitionTranscriptsDir(opts.configDir) : undefined,
    clock: opts?.briefsClock,
    activity: opts?.cognitionActivity,
    sweeps: opts?.sweeps,
    getSweepsEnabled: opts?.getSweepsEnabled,
    getBootstrapSettings: opts?.getBootstrapSettings,
    getBudgetSettings: opts?.getBudgetSettings,
    startBootstrap: opts?.startBootstrap,
    io: opts?.io,
  });

  // /admin/cognition/spend — per-mechanism spend telemetry. Deliberately
  // NOT behind the Briefs feature gate: spend is passive accounting that
  // exists even when the briefs surfaces are off.
  mountCognitionRoutes(app, { query: new CognitionQueryService(db) });

  // /index/stats GET + /admin/index/reindex-missing POST.
  mountIndexerRoutes(app, {
    db,
    indexDb: opts?.indexDb,
    configStore: opts?.configStore,
    config: opts?.config,
    indexerModel: opts?.indexerModel,
    indexerControl: opts?.indexerControl,
    indexerReadiness: opts?.indexerReadiness,
  });

  // /sql, /analytics/*, /sqlite/*, /analytics/activity/:table.
  mountAnalyticsRoutes(app, {
    db,
    analyticsService,
    sourceService,
  });

  // Push status / test, used by `omnesis push status|test`. Shares the
  // live client the watch runtime pushes through, so a hot-reloaded
  // `gateway.apns` is reflected at once.
  if (opts?.pushTransport) {
    mountPushRoutes(
      app,
      new PushAdminService({
        db,
        pushTransport: opts.pushTransport,
        getSettings: () => opts.configStore?.get().gateway,
        getRelaySettings: opts.pushPlan?.getRelaySettings,
        planForDevice: planForPhone,
        writeGate: w,
        onDeviceChanged: () => statusCache.bump(),
        configDir: opts?.configDir,
      }),
    );
  }

  return app;
}
