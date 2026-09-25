// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SyncEngine — the orchestration shell for the collector's sync surface.
 *
 * Post-#317 (issue #317), the engine is a thin façade over
 * three focused collaborators:
 *
 *   - `SourceRegistry` (`source-registry.ts`) — owns the providers Map +
 *     sourceStatuses Map + push-debounce timers + status-change pub/sub
 *     + the `register / unregister / enable / disable` lifecycle.
 *   - `SyncDispatcher` (`sync-dispatcher.ts`) — owns the canonical
 *     `tickSource(source, provider)` entry that funnels the four trigger
 *     sites (`syncAll`, `staggeredInitialSync`, the per-source interval
 *     timer, the external `triggerSync` API) through a single auth-check
 *     + state-guard preamble. Pre-split, those four sites each
 *     open-coded the same five-line check.
 *   - `SourceSyncRunner` (`source-sync-runner.ts`) — owns the per-source
 *     page loop (was `runSyncSource`), the wall-clock timeout wrapper,
 *     and the structured-vs-document branching.
 *
 * The engine itself still owns:
 *   - In-flight sync promise tracking (`inflightSyncs`) so
 *     `stopSyncLoopAndDrain` can wait for outstanding cursor writes
 *     before SIGINT exits.
 *   - The SyncScheduler / FileWatcherManager wiring + per-source
 *     interval scheduling (`startSyncLoop`, `updateSyncIntervals`,
 *     `startSourceSyncLoops`).
 *   - `setupFileWatchers / setupPushEventsForSource / setupSourceErrorHandler`.
 *   - `refreshAllSourceMeta`.
 *
 * Public API is unchanged. Each of the four files stays under the
 * ~500-line ceiling target.
 */

import { createLogger, toErrorMessage, getSyncIntervalMs } from "@omnesis/core";
import { parseSourceId, SourceId } from "@omnesis/types";
import { blocksSync } from "@omnesis/source-sdk";
import { sourceDisplayMeta } from "./source-display-meta.js";
import { SourceLifecycle } from "./source-lifecycle.js";
import { FileWatcherManager } from "./file-watcher-manager.js";
import { SyncScheduler, formatInterval, MAX_DEFER_MS } from "./sync-scheduler.js";
import {
  DEFAULT_WATCH_DEBOUNCE_MS,
  DEFAULT_PUSH_DEBOUNCE_MS,
  DEFAULT_FILE_POLL_INTERVAL_MS,
  DEFAULT_SYNC_CONCURRENCY,
  DEFAULT_STAGGER_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
} from "./tunables.js";
import { SourceRegistry } from "./source-registry.js";
import { SyncDispatcher, type TriggerSyncResult } from "./sync-dispatcher.js";
import { SourceSyncRunner, type SyncOutcome } from "./source-sync-runner.js";
import type { SourceStatus } from "./source-lifecycle.js";
import type { CollectorInternalConfig } from "./internal-config.js";
import type { GatewayClient, SourceInstance, SyncReason } from "@omnesis/source-sdk";
import type {
  RegisteredProvider,
  RegisteredSource,
  StatusChangeEvent,
} from "./sync-engine-types.js";
import type { SyncRemediation, DocumentIngestionContext } from "@omnesis/types";

export { looksLikeAuthFailure, classifySyncError } from "./error-classifier.js";
export type { SyncErrorKind } from "./error-classifier.js";
export type { SourceStatus } from "./source-lifecycle.js";
export { SourceLifecycle } from "./source-lifecycle.js";
export { ProgressTracker } from "./progress-tracker.js";
export { FileWatcherManager } from "./file-watcher-manager.js";
export { SyncScheduler } from "./sync-scheduler.js";
export type { SyncOutcome, SyncDeferral } from "./source-sync-runner.js";
export type {
  RegisteredProvider,
  RegisteredSource,
  StatusChangeEvent,
} from "./sync-engine-types.js";
export { NEEDS_AUTH_ERROR_PREFIX } from "./sync-engine-types.js";

const log = createLogger("collector:sync");

export class SyncEngine {
  // Tunables now live in `./tunables.ts` so every magic number in the
  // collector is in one searchable spot. The class still keeps the
  // overrides on `opts` for tests + future config-store wiring.

  private readonly scheduler = new SyncScheduler();
  private readonly fileWatchers: FileWatcherManager;
  private readonly registry: SourceRegistry;
  private readonly dispatcher: SyncDispatcher;
  private readonly runner: SourceSyncRunner;

  /**
   * In-flight `syncSource` promises. Populated at method entry, drained
   * at exit. Lets `stopSyncLoopAndDrain` wait for outstanding syncs to
   * settle (cursor write, status emit) before the process exits, so a
   * Ctrl-C during a sync doesn't strand the writes mid-flight.
   */
  private inflightSyncs = new Set<Promise<SyncOutcome>>();
  /**
   * Set by `stopSyncLoop` and cleared by `startSyncLoop`. While it holds, a
   * restart owed to a run that is unwinding is dropped rather than fired:
   * the drain awaits the runs in flight when it began, and a run started
   * from one of their terminal transitions would outlive it.
   */
  private stopping = false;
  /** Preserve source-snapshot order even when callers intentionally do not await publication. */
  private linkDeclarationPushQueue: Promise<void> = Promise.resolve();

  private pushDebounceMs: number;

  constructor(
    private gateway: GatewayClient,
    opts?: {
      watchDebounceMs?: number;
      pushDebounceMs?: number;
      filePollIntervalMs?: number;
      syncTimeoutMs?: number;
      ingestionContext?: DocumentIngestionContext;
    },
  ) {
    this.pushDebounceMs = opts?.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
    const syncTimeoutMs = opts?.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.fileWatchers = new FileWatcherManager(
      (sourceId) => {
        this.dispatcher.triggerSync(sourceId, { reason: "file-change" });
      },
      {
        debounceMs: opts?.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
        pollIntervalMs: opts?.filePollIntervalMs ?? DEFAULT_FILE_POLL_INTERVAL_MS,
      },
    );
    this.registry = new SourceRegistry(this.scheduler, this.fileWatchers);
    this.runner = new SourceSyncRunner(
      this.gateway,
      this.registry,
      syncTimeoutMs,
      undefined,
      opts?.ingestionContext,
    );
    this.dispatcher = new SyncDispatcher(this.registry, (source, reason) =>
      this.syncSource(source, reason),
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Façade — delegate to SourceRegistry
  // ───────────────────────────────────────────────────────────────────────

  onStatusChange(handler: (change: StatusChangeEvent) => void): void {
    this.registry.onStatusChange(handler);
  }

  registerProvider(provider: RegisteredProvider): void {
    this.registry.registerProvider(provider);
  }

  registerDisabledPlaceholder(
    sourceId: string,
    providerId: string,
    sourceName: string,
    unitName?: string,
  ): void {
    this.registry.registerDisabledPlaceholder(sourceId, providerId, sourceName, unitName);
  }

  /**
   * Record that a configured source could not be instantiated here, and
   * report the reason upstream. See {@link SourceRegistry.markUnhosted}.
   */
  markUnhosted(
    sourceId: string,
    providerId: string,
    error: string,
    describe?: { sourceName?: string; unitName?: string; remediation?: SyncRemediation },
  ): void {
    this.registry.markUnhosted(sourceId, providerId, error, describe);
  }

  /** Drop the unhosted record for a source that has left this collector. */
  forgetUnhosted(sourceId: string): void {
    this.registry.forgetUnhosted(sourceId);
  }

  /** Every source configured here that failed to instantiate, with its reason. */
  unhostedEntries(): Array<{ sourceId: string; providerId: string; error: string }> {
    return this.registry.unhostedEntries();
  }

  async disableSource(sourceId: string): Promise<void> {
    await this.registry.disableSource(sourceId);
    void this.runner.releaseLease(SourceId(sourceId));
  }

  /**
   * Re-enable a disabled source — flip its state back to idle and
   * re-arm the per-source sync loop. Returns true if the source was
   * found and re-enabled.
   */
  async enableSource(sourceId: string, config: CollectorInternalConfig = {}): Promise<boolean> {
    const sources = await this.registry.enableSource(sourceId);
    if (sources.length === 0) return false;
    await this.startSourceSyncLoops(sources, config);
    return true;
  }

  async unregisterSource(sourceId: string): Promise<void> {
    void this.runner.releaseLease(SourceId(sourceId));
    return this.registry.unregisterSource(sourceId);
  }

  /** Every source registered with this engine, with its provider. */
  registeredSources(): Array<{ provider: RegisteredProvider; source: RegisteredSource }> {
    return [...this.registry.allSources()];
  }

  getStatuses(): SourceStatus[] {
    return this.registry.getStatuses();
  }

  getSourcesById(sourceId: string): RegisteredSource[] {
    return this.registry.getSourcesById(sourceId);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Façade — delegate to SyncDispatcher
  // ───────────────────────────────────────────────────────────────────────

  resolveSourcePattern(pattern: string): string[] {
    return this.dispatcher.resolveSourcePattern(pattern);
  }

  triggerSync(
    pattern: string,
    opts: { restart?: boolean; reason?: SyncReason } = {},
  ): TriggerSyncResult {
    return this.dispatcher.triggerSync(pattern, opts);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Per-cycle orchestration
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Run a single sync cycle for all providers and sources.
   *
   * Concurrency cap: syncs at most `DEFAULT_SYNC_CONCURRENCY` sources
   * in parallel via a fixed-size worker pool — keeps the gateway's
   * writer queue from cratering under a synchronised burst. Per-source
   * latency stays acceptable (each source is ~3-5 HTTP calls / sync)
   * and the gateway sees a steady trickle.
   */
  async syncAll(): Promise<void> {
    const sourcesToSync = await this.collectSourcesToSync();

    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < DEFAULT_SYNC_CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= sourcesToSync.length) return;
            const { source } = sourcesToSync[idx];
            try {
              await this.syncSource(source, "boot");
            } catch (err) {
              log.warn(
                `syncSource(${source.id}) threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  /**
   * Boot-time variant of `syncAll`: spread per-source first syncs over
   * a window instead of running them in parallel. The writer-side load
   * profile is dramatically smoother — at `staggerMs=3000` and 23
   * sources, the gateway sees one new source burst every 3s for ~70s
   * instead of 4 sources hammering it simultaneously from t=0.
   *
   * Trade-off: total wall-clock for "all sources have completed their
   * first sync" goes up (sequential start times), but per-op latency
   * stays low so user requests issued during boot are unaffected. The
   * overall convergence time tends to be *shorter* in practice
   * because the priority-queue contention vanishes.
   */
  async staggeredInitialSync(staggerMs: number): Promise<void> {
    const sourcesToSync = await this.collectSourcesToSync();
    if (sourcesToSync.length === 0) return;
    log.info(
      `Staggered initial sync: ${sourcesToSync.length} source(s), ${staggerMs}ms between starts`,
    );

    const tasks: Promise<void>[] = [];
    for (let i = 0; i < sourcesToSync.length; i++) {
      const { source } = sourcesToSync[i];
      const offsetMs = i * staggerMs;
      tasks.push(
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            try {
              await this.syncSource(source, "boot");
            } catch (err) {
              log.warn(
                `syncSource(${source.id}) threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              resolve();
            }
          }, offsetMs);
        }),
      );
    }
    await Promise.all(tasks);
  }

  /**
   * Shared between `syncAll` + `staggeredInitialSync` — the auth check +
   * push-based filter is identical for both.
   */
  private async collectSourcesToSync(): Promise<
    Array<{ providerId: string; source: RegisteredSource }>
  > {
    const out: Array<{ providerId: string; source: RegisteredSource }> = [];
    for (const provider of this.registry.allProviders()) {
      const credential = await provider.credentialState();
      if (credential.status === "unknown") {
        log.info(
          `Provider ${provider.id} credential unreadable (${credential.because}) — syncing anyway`,
        );
      }
      // A local source has no credential to renew, so a blocking state must
      // not park it — see `shouldPark` in the dispatcher.
      if (provider.renewableCredential && blocksSync(credential)) {
        // Mark every source on this provider as `needs-auth` so the UI
        // surfaces a remediation hint instead of an idle pill (closes
        // source-add-without-credentials-shows-idle-not-error).
        for (const source of provider.sources) {
          this.registry.markNeedsAuth(source, provider.id);
        }
        log.warn(
          `Provider ${provider.id} credential is ${credential.status} — sources flagged needs-auth`,
        );
        continue;
      }
      for (const source of provider.sources) {
        if (source.pushBased) continue; // driven by external push; no local sync
        out.push({ providerId: provider.id, source });
      }
    }
    return out;
  }

  /**
   * Start the sync loop: run an initial sync, then schedule per-source timers.
   *
   * `opts.skipInitialSync` lets E2E tests opt out of the boot-time
   * staggered initial sync — at `staggerMs=3000` with 19 synth sources
   * the stagger alone burns ~54s of `harness.start()` wall-clock,
   * which eats into per-test `beforeAll` budgets and produced
   * deterministic hook-timeout flakes. Tests trigger syncs explicitly
   * via `triggerSyncAndWait`, so the initial sync is redundant for them.
   */
  async startSyncLoop(
    config: CollectorInternalConfig = {},
    opts: { skipInitialSync?: boolean } = {},
  ): Promise<void> {
    this.stopping = false;
    // Compute and store intervals before initial sync so status API shows them immediately
    for (const { source } of this.registry.allSources()) {
      const intervalMs = getSyncIntervalMs(source.id, config);
      const status = this.registry.getStatus(source.id);
      if (status) status.syncIntervalMs = intervalMs;
    }

    // Refresh source metadata (icon/label/contentRetention) for every
    // registered source so code-level updates propagate without waiting
    // for a sync. Covers push-based / idle sources that never flow through
    // setSyncState. Run twice: once before the initial sync (for sources
    // already registered) and once after (for late-registering sources
    // like WhatsApp, which connects asynchronously during instantiation).
    await this.refreshAllSourceMeta();

    if (opts.skipInitialSync) {
      log.info("Skipping initial sync (opts.skipInitialSync=true)");
    } else {
      log.info("Starting initial sync (staggered)");
      await this.staggeredInitialSync(DEFAULT_STAGGER_MS);
    }

    // Second pass catches sources that registered after the first pass.
    await this.refreshAllSourceMeta();

    // Schedule per-source timers — funnel through `dispatcher.tickSource`
    // so the auth-check + state-guard preamble stays single-sourced.
    for (const { provider, source } of this.registry.allSources()) {
      if (source.pushBased) {
        log.info(`Skipping timer scheduling for ${source.id} (push-based)`);
        continue;
      }
      const intervalMs =
        this.registry.getStatus(source.id)?.syncIntervalMs ?? getSyncIntervalMs(source.id, config);

      log.info(`Scheduling ${source.id} every ${formatInterval(intervalMs)}`);

      this.armSourceTimer(source, provider, intervalMs);
    }

    this.setupFileWatchers();
  }

  /**
   * Update sync intervals from a new config. Replaces timers for sources
   * whose interval changed.
   */
  updateSyncIntervals(config: CollectorInternalConfig): void {
    for (const { provider, source } of this.registry.allSources()) {
      const newIntervalMs = getSyncIntervalMs(source.id, config);
      const status = this.registry.getStatus(source.id);
      if (!status) continue;

      const oldIntervalMs = status.syncIntervalMs;
      if (oldIntervalMs === newIntervalMs) continue;

      status.syncIntervalMs = newIntervalMs;

      const hadTimer = this.scheduler.has(source.id);
      if (hadTimer) {
        this.scheduler.clear(source.id);
        this.armSourceTimer(source, provider, newIntervalMs);
      }

      log.info(
        `Updated sync interval for ${source.id}: ${oldIntervalMs}ms → ${newIntervalMs}ms (${formatInterval(newIntervalMs)})`,
      );
    }
  }

  /**
   * Push the current icon/label/urlPatterns for every registered source to
   * the gateway. Idempotent — safe to call on every collector startup.
   */
  /**
   * Push the URL-canonicalizer specs declared by every loaded source
   * to the gateway. Called once at collector startup; the gateway
   * holds the registry in memory and applies it during ingest +
   * lookup. Sending the full list on each boot is intentional — the
   * gateway is the source of truth for what's currently registered,
   * and re-syncing is cheap.
   *
   * After pushing, fires a one-shot recompute of `source_url` so any
   * documents previously ingested without these canonicalizers get
   * re-derived. The recompute is idempotent.
   */
  /**
   * Push the URL-canonicalizer specs declared by every loaded source
   * to the gateway. Public so the caller (main.ts) can trigger it
   * right after `manager.applySourcesSnapshot` returns — providers
   * are registered asynchronously over the WS snapshot, so calling
   * from `startSyncLoop` would race the registry. Idempotent; safe
   * to call repeatedly. After pushing, fires a one-shot recompute
   * of `source_url` so docs previously ingested without these
   * canonicalizers get re-derived.
   */
  async pushUrlCanonicalizers(
    sources: Iterable<{ source: RegisteredSource }> = this.registry.allSources(),
  ): Promise<void> {
    const seen = new WeakSet<object>();
    const canonicalizers: Array<{
      hosts: string[];
      rules: { match: string; replacement: string }[];
    }> = [];
    let totalSources = 0;
    let withSpec = 0;
    for (const { source } of sources) {
      totalSources++;
      const spec = source.urlCanonicalizer;
      if (!spec) continue;
      withSpec++;
      if (seen.has(spec)) continue;
      seen.add(spec);
      canonicalizers.push({
        hosts: [...spec.hosts],
        rules: spec.rules.map((r) => ({ match: r.match, replacement: r.replacement })),
      });
    }
    log.info(
      `pushUrlCanonicalizers: ${totalSources} sources, ${withSpec} with urlCanonicalizer, ${canonicalizers.length} unique specs`,
    );
    if (canonicalizers.length === 0) return;
    try {
      await this.gateway.setUrlCanonicalizers(canonicalizers);
      log.info(
        `Pushed ${canonicalizers.length} URL canonicalizer(s) (${canonicalizers.flatMap((c) => c.hosts).length} host(s)) to gateway`,
      );
      await this.gateway.recomputeSourceUrls().catch((err) => {
        log.warn(
          `recompute-source-urls failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      log.warn(
        `Failed to push URL canonicalizers (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Publish one atomic generation of URL canonicalizers, graph roles, and patterns. */
  async pushLinkDeclarations(
    patterns: Array<{ regex: string }>,
    sources: Iterable<{ source: RegisteredSource }> = this.registry.allSources(),
  ): Promise<void> {
    const canonicalizers: Array<{
      hosts: string[];
      rules: { match: string; replacement: string }[];
    }> = [];
    const seenCanonicalizers = new WeakSet<object>();
    const traversalHubPrefixes = new Set<string>();
    const fallbackRepresentationPrefixes = new Set<string>();
    const referenceOnlyPrefixes = new Set<string>();
    for (const { source } of sources) {
      const prefix = parseSourceId(source.id).sourceType;
      if (source.urlHub) traversalHubPrefixes.add(prefix);
      if (source.urlTargetRole === "fallback") fallbackRepresentationPrefixes.add(prefix);
      if (source.urlTargetRole === "reference") referenceOnlyPrefixes.add(prefix);
      const spec = source.urlCanonicalizer;
      if (!spec || seenCanonicalizers.has(spec)) continue;
      seenCanonicalizers.add(spec);
      canonicalizers.push({
        hosts: [...spec.hosts],
        rules: spec.rules.map((rule) => ({ match: rule.match, replacement: rule.replacement })),
      });
    }
    const declaration = {
      canonicalizers,
      traversalHubPrefixes: [...traversalHubPrefixes].sort(),
      fallbackRepresentationPrefixes: [...fallbackRepresentationPrefixes].sort(),
      referenceOnlyPrefixes: [...referenceOnlyPrefixes].sort(),
      patterns,
    };
    const publication = this.linkDeclarationPushQueue.then(async () => {
      await this.gateway.setLinkDeclarations(declaration);
      await this.gateway.recomputeSourceUrls().catch((err) => {
        log.warn(
          `recompute-source-urls failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    this.linkDeclarationPushQueue = publication.catch(() => undefined);
    await publication;
  }

  /**
   * Push the per-source-type score priors declared by every loaded
   * source to the gateway. Mirrors `pushUrlCanonicalizers` — public so
   * `main.ts` can call right after `applySourcesSnapshot` returns
   * (provider registration is asynchronous over the WS snapshot, so
   * calling from `startSyncLoop` would race the registry). Idempotent;
   * safe to call repeatedly.
   *
   * Each entry maps a source-type prefix (e.g. `"browser-history"`) to
   * its additive search-score adjustment. The gateway merges these
   * collector-declared defaults with whatever the user has set in
   * `omnesis.json` under `search.sourcePriors.weights` (user keys win).
   */
  async pushSourcePriorDefaults(
    sources: Iterable<{ source: RegisteredSource }> = this.registry.allSources(),
  ): Promise<void> {
    // Multi-source providers register the same source-type prefix once
    // per account (e.g. browser-history:chrome and browser-history:safari).
    // We dedupe by prefix so the gateway sees a single entry per type.
    const byPrefix = new Map<string, number>();
    let totalSources = 0;
    for (const { source } of sources) {
      totalSources++;
      const prior = source.defaultSourcePrior;
      if (prior === undefined) continue;
      const prefix = parseSourceId(source.id).sourceType;
      byPrefix.set(prefix, prior);
    }
    const entries = Array.from(byPrefix.entries()).map(([sourceIdPrefix, weight]) => ({
      sourceIdPrefix,
      weight,
    }));
    log.info(
      `pushSourcePriorDefaults: ${totalSources} sources, ${entries.length} declared default(s)`,
    );
    try {
      await this.gateway.setSourcePriorDefaults(entries);
      log.info(`Pushed ${entries.length} source-prior default(s) to gateway`);
    } catch (err) {
      log.warn(
        `Failed to push source-prior defaults (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Push the source-type prefixes whose descriptors declare URL graph roles:
   * traversal hubs, fallback representations, and reference-only documents.
   * Mirrors `pushSourcePriorDefaults` —
   * public so `main.ts` can call right after `applySourcesSnapshot`
   * returns. Idempotent; safe to call repeatedly.
   *
   * Deduped by source-type prefix so multi-account sources
   * (`browser-history:chrome`, `browser-history:safari`, …) register
   * one entry. The gateway merges them with gateway-hosted descriptors. Hub
   * prefixes suppress noisy graph pivots; the two target roles govern URL
   * resolution and retroactive repair independently.
   */
  async pushUrlGraphRoles(
    sources: Iterable<{ source: RegisteredSource }> = this.registry.allSources(),
  ): Promise<void> {
    const traversalHubPrefixes = new Set<string>();
    const fallbackRepresentationPrefixes = new Set<string>();
    const referenceOnlyPrefixes = new Set<string>();
    let totalSources = 0;
    for (const { source } of sources) {
      totalSources++;
      const prefix = parseSourceId(source.id).sourceType;
      if (source.urlHub) traversalHubPrefixes.add(prefix);
      if (source.urlTargetRole === "fallback") fallbackRepresentationPrefixes.add(prefix);
      if (source.urlTargetRole === "reference") referenceOnlyPrefixes.add(prefix);
    }
    const traversalHubList = Array.from(traversalHubPrefixes).sort();
    const fallbackList = Array.from(fallbackRepresentationPrefixes).sort();
    const referenceList = Array.from(referenceOnlyPrefixes).sort();
    log.info(
      `pushUrlGraphRoles: ${totalSources} sources, ${traversalHubList.length} traversal-hub prefix(es), ${fallbackList.length} fallback representation prefix(es), ${referenceList.length} reference-only prefix(es)`,
    );
    try {
      await this.gateway.setUrlGraphRoles(traversalHubList, fallbackList, referenceList);
      log.info(
        `Pushed ${traversalHubList.length} traversal-hub prefix(es), ${fallbackList.length} fallback representation prefix(es), ${referenceList.length} reference-only prefix(es) to gateway`,
      );
    } catch (err) {
      log.warn(
        `Failed to push URL graph roles (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Declare the self-identity hooks of the sources this collector hosts,
   * from `defineSource.selfIdentity`. Mirrors `pushUrlGraphRoles` — public so
   * `main.ts` can call right after `applySourcesSnapshot`. Idempotent.
   *
   * Deduped by source-type prefix so multi-account sources register one entry.
   * The gateway's self-detection pass reads the set to resolve a source's
   * self-authored PersonMentions to the self person without source-name
   * branching.
   */
  async pushSelfIdentitySources(
    sources: Iterable<{ source: RegisteredSource }> = this.registry.allSources(),
  ): Promise<void> {
    const byType = new Map<
      string,
      { sourceType: string; aliasPrefix: string; accountPattern?: string }
    >();
    let totalSources = 0;
    for (const { source } of sources) {
      totalSources++;
      if (!source.selfIdentity) continue;
      const { sourceType } = parseSourceId(source.id);
      byType.set(sourceType, {
        sourceType,
        aliasPrefix: source.selfIdentity.aliasPrefix,
        accountPattern: source.selfIdentity.accountPattern,
      });
    }
    const entries = Array.from(byType.values()).sort((a, b) =>
      a.sourceType.localeCompare(b.sourceType),
    );
    log.info(
      `pushSelfIdentitySources: ${totalSources} sources, ${entries.length} declared hook(s)`,
    );
    try {
      await this.gateway.declareSelfIdentitySources(entries);
      log.info(`Pushed ${entries.length} self-identity hook(s) to gateway`);
    } catch (err) {
      log.warn(
        `Failed to push self-identity sources (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Register every loaded structured source's declared analytics table schemas
   * with the gateway at startup. Mirrors `pushSourcePriorDefaults` — public so
   * `main.ts` can call right after `applySourcesSnapshot` returns. Idempotent.
   *
   * The gateway persists each table's schema in its analytics catalog, but only
   * rewrites that catalog row when a sync actually ingests records. A schema
   * field added after a table was last synced — e.g. the record-citation
   * contract `semanticTimeColumn` + `record` (#757) — would otherwise stay
   * absent from the catalog (and so the `cite_record` path would reject the
   * table as "unknown") until the source next happened to ingest a row. An
   * incremental sync that returns zero new records never re-pushes, so the row
   * could stay stale indefinitely. Pushing the declared schemas on startup
   * refreshes the catalog to the running collector's descriptors with no
   * records required, so the contract is available immediately after a deploy.
   */
  async pushAnalyticsSchemas(): Promise<void> {
    let pushed = 0;
    let failed = 0;
    for (const { source } of this.registry.allSources()) {
      const schemas = source.instance.analyticsSchemas;
      if (!schemas || schemas.length === 0) continue;
      for (const schema of schemas) {
        try {
          // Empty records → the gateway ensures/refreshes the table + catalog
          // row from the schema and inserts nothing.
          await this.gateway.ingestAnalyticsPage({
            tableName: schema.tableName,
            records: [],
            schema,
            sourceId: source.id,
          });
          pushed++;
        } catch (err) {
          failed++;
          log.warn(
            `Failed to register analytics schema ${schema.tableName} for ${source.id} (continuing): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    log.info(
      `Registered ${pushed} analytics table schema(s) with gateway${failed ? ` (${failed} failed)` : ""}`,
    );
  }

  async refreshAllSourceMeta(): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    const setSourceMeta = this.gateway.setSourceMeta?.bind(this.gateway);
    if (!setSourceMeta) {
      log.warn("Gateway does not support cursor-safe source metadata refresh; skipping");
      return;
    }
    for (const { source } of this.registry.allSources()) {
      tasks.push(
        setSourceMeta(source.id, {
          ...sourceDisplayMeta(source),
          contentRetention: source.contentRetention,
        }).catch((err) => {
          log.warn(
            `Failed to refresh meta for ${source.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
      );
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
      log.info(
        `Refreshed source metadata for ${tasks.length} source${tasks.length === 1 ? "" : "s"}`,
      );
    }
  }

  /**
   * Start sync loops for the given sources: every source is scheduled and
   * wired first, then each one is synced once.
   *
   * The two passes matter because the initial syncs are sequential. A
   * collector start hands every configured source to this method in a single
   * call, so scheduling a source only when its turn came would leave the last
   * source in the list without a timer for as long as every source ahead of
   * it takes to bootstrap — tens of minutes across a few dozen sources. A
   * restart inside that window starts the walk over, and a source near the
   * end can go a whole collector lifetime without ever being scheduled.
   * Arming up front costs nothing: the scheduler's first tick is one interval
   * plus jitter away, and a tick that lands while the initial sync is still
   * running is skipped by the dispatcher's state guard.
   */
  async startSourceSyncLoops(
    sources: RegisteredSource[],
    config: CollectorInternalConfig = {},
  ): Promise<void> {
    const scheduled: Array<{
      source: RegisteredSource;
      provider: RegisteredProvider | undefined;
    }> = [];
    for (const source of sources) {
      if (source.pushBased) {
        log.info(`Skipping sync loop for ${source.id} (push-based)`);
        continue;
      }
      const intervalMs = getSyncIntervalMs(source.id, config);
      const status = this.registry.getStatus(source.id);
      if (status) status.syncIntervalMs = intervalMs;

      const provider = this.registry.getProviderForSource(source);

      // Schedule timer — funnel through `dispatcher.tickSource` like
      // `startSyncLoop` does. The auth-check + state-guard preamble
      // stays in exactly one place.
      log.info(`Scheduling ${source.id} every ${formatInterval(intervalMs)}`);

      this.armSourceTimer(source, provider, intervalMs);

      // Set up file watchers, push events, and the connection-error
      // handler. The error handler used to live only in
      // `setupFileWatchers` (which runs once on collector startup), so
      // sources added at runtime — `cli add`, portal, pairing flow —
      // never wired their `onSourceError` callback. WhatsApp logout /
      // future Baileys-style disconnects then silently dropped on the
      // floor instead of surfacing as `sync.error` on portal/cli.
      this.setupFileWatchersForSource(source);
      this.setupPushEventsForSource(source);
      this.setupSourceErrorHandler(source);

      scheduled.push({ source, provider });
    }

    // Initial sync, through the same guarded entry the timer uses: the source
    // is already scheduled, so an unguarded `syncSource` here could run
    // alongside a tick that its interval had already fired.
    //
    // Started together rather than one after another. These are independent
    // sources, and awaiting each in turn puts a newly added one behind
    // whatever its siblings are already doing: add a calendar next to a
    // mailbox that is bootstrapping a hundred thousand messages and the
    // calendar's first sync waits for the mailbox, misses its own start, and
    // does not run until the interval comes round — minutes of looking idle
    // for no reason the operator can see. `tickSource` still carries the state
    // guard, and the engine's concurrency cap still bounds the burst.
    await Promise.allSettled(
      scheduled.map(async ({ source, provider }) => {
        try {
          if (provider) await this.dispatcher.tickSource(source, provider, "scheduled");
          else await this.syncSource(source);
        } catch (err) {
          log.error(`Initial sync failed for ${source.id}: ${toErrorMessage(err)}`);
        }
      }),
    );
  }

  /**
   * Stop all sync timers and file watchers.
   */
  stopSyncLoop(): void {
    this.stopping = true;
    this.scheduler.clearAll();
    this.fileWatchers.stopAll();
    this.registry.clearAllPushDebounces();
  }

  /**
   * Stop timers AND wait for any in-flight `syncSource` promises to
   * settle, with a wallclock cap. Used by `main.ts`'s SIGINT/SIGTERM
   * handler so the collector process doesn't `process.exit` while a
   * cursor write or status emit is in flight — that race left the
   * gateway's `sync_state` un-advanced after a successful page commit
   * and caused duplicate work on the next startup.
   */
  async stopSyncLoopAndDrain(timeoutMs = 30_000): Promise<{ inflight: number; timedOut: boolean }> {
    this.stopSyncLoop();
    const inflight = this.inflightSyncs.size;
    if (inflight === 0) {
      await this.runner.releaseLeases();
      return { inflight: 0, timedOut: false };
    }

    let timedOut = false;
    // Leases are released only once the in-flight pages settled: released
    // earlier, a sibling could take the source while a page still commits.
    // A drain that hits the cap leaves them to lapse.
    const drain = Promise.allSettled(Array.from(this.inflightSyncs)).then(() =>
      this.runner.releaseLeases(),
    );
    const cap = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      t.unref?.();
    });
    await Promise.race([drain, cap]);
    return { inflight, timedOut };
  }

  // ───────────────────────────────────────────────────────────────────────
  // File watcher / push event / source error wiring
  // ───────────────────────────────────────────────────────────────────────

  private setupFileWatchers(): void {
    for (const { source } of this.registry.allSources()) {
      this.setupFileWatchersForSource(source);
      this.setupPushEventsForSource(source);
      this.setupSourceErrorHandler(source);
    }
  }

  /**
   * Wire up push-based sync for a source that declares onPushEvent.
   */
  private setupPushEventsForSource(source: RegisteredSource): void {
    if (!source.instance.onPushEvent) return;
    // Wired once. The previous guard asked whether a debounce timer existed,
    // which is only true between a push and the sync it triggers — so a source
    // registered again before its first push was wired twice.
    if (this.registry.hasTeardown(source.id)) return;

    const stop = source.instance.onPushEvent(() => {
      const timer = setTimeout(() => {
        this.registry.clearPushDebounce(source.id);
        log.info(`Push event received, triggering sync for ${source.id}`);
        this.dispatcher.triggerSync(source.id, { reason: "push" });
      }, this.pushDebounceMs);
      this.registry.setPushDebounce(source.id, timer);
    });
    // A source that returns nothing is wired for the process's lifetime, which
    // is what it was before there was a handle to return.
    if (stop) this.registry.addTeardown(source.id, stop);

    log.info(`Push-based sync enabled for ${source.id}`);
  }

  /**
   * Wire up error reporting for a source that declares onSourceError.
   * When the source reports a connection/auth error, immediately update status.
   */
  private setupSourceErrorHandler(source: RegisteredSource): void {
    if (!source.instance.onSourceError) return;

    const stop = source.instance.onSourceError((error: string) => {
      const status = this.registry.getStatus(source.id);
      if (!status || status.state === "disabled") return;

      log.error(`Source error for ${source.id}: ${error}`);
      SourceLifecycle.toError(status, error, log);
      this.registry.stopSource(source.id);
      this.registry.emitStatusChange({
        event: "sync.error",
        sourceId: source.id,
        status: { ...status },
      });
    });
    if (stop) this.registry.addTeardown(source.id, stop);
  }

  /**
   * Set up file watchers for a single source. Delegates to
   * FileWatcherManager which owns the FS-watch maps + mtime polling.
   */
  private setupFileWatchersForSource(source: RegisteredSource): void {
    this.fileWatchers.setupForSource({
      id: source.id,
      watchPaths: source.instance.watchPaths,
      watchDirectoryPaths: source.instance.watchDirectoryPaths,
      watchFileExtensions: source.instance.watchFileExtensions,
      watchQuietMs: source.instance.watchQuietMs,
      onActive: () => {
        const status = this.registry.getStatus(source.id);
        if (status) status.fileWatchActive = true;
      },
    });
  }

  /**
   * Arm a source's recurring sync timer through the scheduler, funnelling
   * the tick through `dispatcher.tickSource` (the single auth-check +
   * state-guard preamble). The one scheduling path for every trigger site
   * (`startSyncLoop`, `updateSyncIntervals`, `startSourceSyncLoops`) so the
   * rate-limit deferral (#616) is handled identically everywhere: when a
   * tick returns a `{ retryAfterMs }` deferral, push the *next* tick out to
   * `max(interval, retryAfterMs)` via the scheduler's one-shot `deferNext`.
   * The deferral is one-shot — `deferNext` re-arms the steady interval after
   * the deferred tick, so cadence returns to normal automatically.
   */
  private armSourceTimer(
    source: RegisteredSource,
    provider: RegisteredProvider | undefined,
    intervalMs: number,
  ): void {
    this.scheduler.schedule(
      source.id,
      async () => {
        try {
          // Funnel through `tickSource` when we have the provider record
          // (the auth-check + state-guard preamble); fall back to a bare
          // `syncSource` when none is registered. Both return the runner's
          // SyncOutcome so the deferral is honoured either way.
          const outcome = provider
            ? await this.dispatcher.tickSource(source, provider, "boot")
            : await this.syncSource(source);
          if (outcome?.retryAfterMs !== undefined) {
            // Never defer earlier than the normal interval, nor longer than the
            // setTimeout-safe ceiling (a huge Retry-After would otherwise
            // overflow and fire immediately — the opposite of a back-off).
            const delayMs = Math.min(Math.max(intervalMs, outcome.retryAfterMs), MAX_DEFER_MS);
            this.scheduler.deferNext(source.id, delayMs);
            log.info(
              `Deferring next sync for ${source.id} by ${formatInterval(delayMs)} (rate-limited)`,
            );
          }
        } catch (error) {
          log.error(`Sync timer error for ${source.id}: ${toErrorMessage(error)}`);
        }
      },
      intervalMs,
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Sync runner entry — delegates to SourceSyncRunner
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Sync a single source. The actual page loop + wall-clock timeout
   * live on `SourceSyncRunner`; this wrapper records the promise in
   * `inflightSyncs` so shutdown can await it.
   *
   * Returns the runner's {@link SyncOutcome}: `undefined` for the normal
   * cadence, or a `{ retryAfterMs }` deferral when the provider rate-limited
   * the source so the scheduler can back off the next tick.
   */
  async syncSource(source: RegisteredSource, reason: SyncReason = "manual"): Promise<SyncOutcome> {
    const promise = this.runner.runOne(source, reason);
    this.inflightSyncs.add(promise);
    try {
      return await promise;
    } catch (err) {
      // `runOne` already handled this per-source: it flipped the source to
      // `error` / `needs-auth` and emitted status, so the failure is fully
      // accounted for. Swallow it here at the engine boundary so the
      // dispatcher's fire-and-forget invocation can't escalate it into a
      // process-killing unhandled rejection — a single slow or stuck source
      // (e.g. a sync that hits the wall-clock timeout) must never take down
      // the whole collector. See #554.
      log.warn(`Sync for ${source.id} ended with error: ${toErrorMessage(err)}`);
    } finally {
      this.inflightSyncs.delete(promise);
      this.fireRestartIfPending(source);
    }
  }

  /**
   * Fire the restart a `restart` trigger asked for while a run was in
   * flight, now that the run has stopped. The claim that run left behind is
   * released first and reported — an aborted run stops without a transition
   * of its own, and the gateway last saw it syncing — unless a newer run
   * already holds the source, in which case the trigger aborts that one and
   * the restart waits for its turn again. The registry drops the pending
   * restart before the fresh run starts, so a fresh run that fails cannot
   * fire it again. A restart owed while the engine is stopping is dropped:
   * the drain only awaits the runs it found in flight.
   */
  private fireRestartIfPending(source: RegisteredSource): void {
    if (!this.registry.takePendingRestart(source.id)) return;
    if (this.stopping) {
      log.info(`Dropping the restart of ${source.id}: the collector is stopping`);
      return;
    }
    const status = this.registry.getStatus(source.id);
    if (status?.state === "syncing" && !this.runner.isRunning(source.id)) {
      SourceLifecycle.toIdle(status, log);
      this.registry.emitStatusChange({
        event: "sync.aborted",
        sourceId: source.id,
        status: { ...status },
      });
    }
    const result = this.dispatcher.triggerSync(source.id, { restart: true });
    if (result.triggered.length === 0 && result.restarting.length === 0) {
      log.warn(
        `Restart of ${source.id} started no sync: ${result.error ?? "the source is not eligible"}`,
      );
    }
  }
}

// `SourceInstance` reaches the engine only via the registered-source type;
// keep it re-exported so consumers of the engine can still import the
// type from this module.
export type { SourceInstance };
