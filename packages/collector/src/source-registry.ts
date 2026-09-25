// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Source / provider registry — the state-and-lifecycle half of the
 * collector's sync surface. Extracted from
 * `sync-engine.ts` so the orchestration shell stays focused on actually
 * running syncs.
 *
 * Owns:
 *   - the providers Map (keyed by provider.id)
 *   - the sourceStatuses Map (keyed by sourceId)
 *   - the pushDebounceTimers Map (per-source ephemeral)
 *   - the single statusChangeHandler — `emitStatusChange` fans out here
 *
 * Depends on:
 *   - `SyncScheduler` / `FileWatcherManager` — injected so the
 *     state-flip methods (`disableSource`, `unregisterSource`) can
 *     clean up timers + watchers atomically with the state transition.
 *
 * Public methods are what the engine façade re-exposes;
 * `stopSource` / `removeSourceInstance` are intentionally internal.
 *
 * Note: this is the runtime-state registry. The compile-time descriptor
 * registry (`allDescriptors`, `allDefinitions`, …) lives in
 * `source-descriptors.ts` — different concern, different file.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import { parseSourceId, sameQuotaBucket } from "@omnesis/types";
import { SourceLifecycle } from "./source-lifecycle.js";
import {
  buildReauthHint,
  buildRateLimitedHint,
  type RegisteredProvider,
  type RegisteredSource,
  type StatusChangeEvent,
} from "./sync-engine-types.js";
import type { QuotaBucket, QuotaKind, SourceId, SyncRemediation } from "@omnesis/types";
import type { Unsubscribe, SyncAbortReason } from "@omnesis/source-sdk";
import type { SourceStatus } from "./source-lifecycle.js";
import type { FileWatcherManager } from "./file-watcher-manager.js";
import type { SyncScheduler } from "./sync-scheduler.js";

const log = createLogger("collector:sync");

export class SourceRegistry {
  private providers = new Map<string, RegisteredProvider>();
  private sourceStatuses = new Map<string, SourceStatus>();
  /**
   * One controller per source, armed when it is registered and aborted when it
   * is removed or disabled. A sync already paging holds the signal it captured
   * at entry, so the abort reaches a loop that has since lost its registry
   * status — the status map alone cannot do that, because anything
   * re-inserting a status would hand the loop its permission back.
   */
  private syncAborts = new Map<string, AbortController>();
  /**
   * How to stop each source's push and error registrations, by source id.
   * Populated when a source is wired and drained when it stops.
   */
  private pushTeardowns = new Map<string, Unsubscribe[]>();
  /**
   * Sources owed a fresh sync once the run aborted for it has stopped. Set by
   * `requestRestart`, consumed by `takePendingRestart` on that run's terminal
   * transition, and dropped when the source is disabled or removed.
   */
  private pendingRestarts = new Set<string>();
  /**
   * Sources this collector is configured for but is not hosting, because
   * instantiating them threw — an unreadable local database, a provider whose
   * context cannot be built, a discovery pass that finds no account. Keyed by
   * source id, valued by the reason.
   *
   * Deliberately not a {@link SourceStatus}: there is no instance to sync,
   * schedule, abort or dispose, and a status entry would make the source look
   * tickable to everything that walks `getStatuses()`. What it is instead is
   * the collector's own answer to "why is this configured source not here",
   * which is the one question the gateway cannot answer for itself.
   */
  private unhostedSources = new Map<string, { providerId: string; error: string }>();
  private pushDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statusChangeHandler: ((change: StatusChangeEvent) => void) | null = null;

  constructor(
    private readonly scheduler: SyncScheduler,
    private readonly fileWatchers: FileWatcherManager,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Status-change pub/sub
  // ───────────────────────────────────────────────────────────────────────

  onStatusChange(handler: (change: StatusChangeEvent) => void): void {
    this.statusChangeHandler = handler;
  }

  /**
   * Public so `SyncDispatcher` + the engine's `runSyncSource` (which
   * still lives on the orchestration shell) can emit per-page progress
   * and lifecycle events without reaching through a private callback.
   */
  emitStatusChange(change: StatusChangeEvent): void {
    this.statusChangeHandler?.(change);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Registration
  // ───────────────────────────────────────────────────────────────────────

  registerProvider(provider: RegisteredProvider): void {
    // Source ids whose old instance's run was fenced by this re-registration.
    let fencedIds: Set<SourceId> = new Set();
    const existing = this.providers.get(provider.id);
    if (existing) {
      // Re-registration path: a previously-registered provider is being
      // re-supplied with a fresh `credentialState` callback and fresh
      // source instances (typical trigger: `cli -- sources reauth google:user@gmail.com`
      // after a refresh-token revocation). The OLD source instances hold
      // references to the now-revoked OAuth client; if we keep them
      // around the next sync still hits invalid_grant. Replace the
      // instances with the new ones so the new credentials propagate
      // without a collector restart.
      existing.credentialState = provider.credentialState;
      existing.name = provider.name;
      const newIds = new Set(provider.sources.map((s) => s.id));
      const replacedIds: string[] = [];
      fencedIds = new Set<SourceId>();
      // Replace or append.
      for (const newSource of provider.sources) {
        const idx = existing.sources.findIndex((s) => s.id === newSource.id);
        if (idx >= 0) {
          // Fence any run owned by the old instance before a fresh controller
          // is armed for its replacement below.
          this.abortSync(newSource.id);
          fencedIds.add(newSource.id);
          // Tear down the old source's resources before swap — file
          // watchers, push handlers, dispose() on push-based sources.
          const oldSource = existing.sources[idx];
          try {
            const disposing = oldSource.instance.dispose?.();
            if (disposing) {
              void disposing.catch((err) => {
                log.warn(
                  `Dispose error for ${oldSource.id} during re-register: ${toErrorMessage(err)}`,
                );
              });
            }
          } catch (err) {
            log.warn(
              `Dispose error for ${oldSource.id} during re-register: ${toErrorMessage(err)}`,
            );
          }
          existing.sources[idx] = newSource;
          replacedIds.push(newSource.id);
        } else {
          existing.sources.push(newSource);
        }
      }
      if (replacedIds.length > 0) {
        log.info(
          `Re-registered provider ${provider.id} (refreshed credentials), replaced sources: ${replacedIds.join(", ")}`,
        );
      }
      // Sources NOT included in the new provider are left intact —
      // unregister flows go through `unregisterSource`, not via
      // re-register.
      void newIds; // keep for future "missing source = remove" semantics
    } else {
      this.providers.set(provider.id, provider);
    }
    for (const source of provider.sources) {
      // Registering is the one moment a fresh, un-aborted cancellation signal
      // is correct: this source is here and may sync.
      this.armSync(source.id);
      // Whatever kept this source from being built is over.
      this.unhostedSources.delete(source.id);
      const existingStatus = this.sourceStatuses.get(source.id);
      if (!existingStatus) {
        this.sourceStatuses.set(source.id, {
          sourceId: source.id,
          providerId: source.providerId,
          sourceName: source.name,
          icon: source.icon,
          unitName: source.unitName,
          state: "idle",
          freshness: source.instance.freshness,
        });
      } else {
        // A re-register rebuilds the instance from current config, and the
        // declaration can change with it (a vault repointed from an app-synced
        // to a daemon-synced folder no longer has a process worth probing), so
        // the surviving status picks up the new value rather than keeping the
        // one captured when it was first registered.
        existingStatus.freshness = source.instance.freshness;
      }
      if (existingStatus?.state === "syncing" && fencedIds.has(source.id)) {
        // The abort fence above guarantees the replaced run can never write
        // status again — every guard in the runner rejects it — so its
        // `syncing` claim is provably stale. Heal it here, or every future
        // tick and trigger skips the source as in-flight forever.
        SourceLifecycle.toIdle(existingStatus, log);
      }
      if (existingStatus?.state === "disabled" || existingStatus?.state === "needs-auth") {
        // Disabled → re-enable.
        // Needs-auth → flip back to idle; the re-register signals fresh
        // credentials are in place. The next sync cycle will either
        // succeed (clearing the persisted last_error) or re-mark
        // needs-auth if the new tokens are *also* bad.
        SourceLifecycle.reactivateFromStuck(existingStatus, log);
        // Broadcast the reactivation so the gateway clears needs-auth for
        // EVERY source under this provider at once. A single re-auth
        // refreshes one shared credential that backs all the provider's
        // sources, so the operator should see them all recover together —
        // not watch each one leave needs-auth only as its own staggered
        // sync happens to run. Like `disableSource`, we emit
        // `sync.completed`: the gateway maps it to a clear of the persisted
        // error and drops the source out of the re-auth banner; the
        // follow-up sync (armed by `startSourceSyncLoops`) refreshes the
        // real last-synced timestamp. Without this emit the gateway, a pure
        // event-follower, never learns the source left needs-auth here.
        this.emitStatusChange({
          event: "sync.completed",
          sourceId: source.id,
          status: { ...existingStatus },
        });
      }
    }
    log.info(
      `Registered provider ${provider.id} with sources: ${provider.sources.map((s) => s.id).join(", ")}`,
    );
  }

  /**
   * Record that a configured source could not be instantiated on this host,
   * and say so upstream.
   *
   * The gateway is a pure event-follower: it knows the source exists and which
   * device owns it, but a source that never registers produces no events at
   * all, so it renders `idle` — indistinguishable from healthy-and-waiting.
   * Emitting `sync.error` with the underlying reason is what turns that into a
   * red pill naming the cause — and, when the failure said what the operator
   * has to do about it, the remedy beside it. Skips sources that did come up,
   * so a stale mark can never contradict a live instance.
   */
  markUnhosted(
    sourceId: string,
    providerId: string,
    error: string,
    describe?: { sourceName?: string; unitName?: string; remediation?: SyncRemediation },
  ): void {
    if (this.getSourcesById(sourceId).length > 0) return;
    this.unhostedSources.set(sourceId, { providerId, error });
    this.emitStatusChange({
      event: "sync.error",
      sourceId,
      status: {
        sourceId,
        providerId,
        // The descriptor's wording, because there is no instance to ask. A
        // source that never registered has nothing stored upstream either, so
        // whatever is omitted here is what the operator reads a generic noun
        // for on exactly the row that most needs to be legible.
        sourceName: describe?.sourceName ?? sourceId,
        unitName: describe?.unitName,
        state: "error",
        lastError: error,
        remediation: describe?.remediation,
      },
    });
  }

  /** Every source configured here that failed to instantiate, with its reason. */
  unhostedEntries(): Array<{ sourceId: string; providerId: string; error: string }> {
    return [...this.unhostedSources].map(([sourceId, entry]) => ({ sourceId, ...entry }));
  }

  /**
   * Drop the record for a source that is no longer configured here. Removal
   * paths cannot rely on `unregisterSource` for this: an unhosted source has
   * no status entry, so the loops that walk `getStatuses()` never reach it.
   */
  forgetUnhosted(sourceId: string): void {
    this.unhostedSources.delete(sourceId);
  }

  registerDisabledPlaceholder(
    sourceId: string,
    providerId: string,
    sourceName: string,
    unitName?: string,
  ): void {
    if (this.sourceStatuses.has(sourceId)) return;
    this.sourceStatuses.set(sourceId, {
      sourceId,
      providerId,
      sourceName,
      unitName,
      state: "disabled",
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Lifecycle transitions
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Stop a source's sync timer, file watchers, and push debounce timers.
   * Does NOT remove the source instance from the providers map —
   * disabled sources keep their instance so they can be re-enabled.
   *
   * Public because `setupSourceErrorHandler` (still on the engine
   * façade) calls it when a connection-level error fires; that path
   * needs the same teardown but skips the disabled-state flip.
   */
  // Leaves an in-flight sync running on purpose — see `abortSync`.
  stopSource(sourceId: string): void {
    this.scheduler.clear(sourceId);
    this.fileWatchers.stopForSource(sourceId);
    this.clearPushDebounce(sourceId);
    this.runTeardowns(sourceId);
  }

  /**
   * Signal for a sync of `sourceId`.
   *
   * Never mints one on demand. A sync reads this after several awaits, so an
   * on-demand controller could be created *during* a teardown — after the
   * abort and before the source is gone — handing that sync a fresh,
   * un-aborted signal and letting it write the very page this exists to stop.
   * An id with no armed controller is one that is not syncing, so it gets an
   * already-aborted signal.
   */
  syncSignal(sourceId: string): AbortSignal {
    const controller = this.syncAborts.get(sourceId);
    return controller ? controller.signal : AbortSignal.abort();
  }

  /**
   * Arm cancellation for a source, replacing any spent controller. Called when
   * a source is registered, which is the only moment a fresh, un-aborted
   * signal is correct.
   */
  private armSync(sourceId: string): void {
    this.syncAborts.set(sourceId, new AbortController());
  }

  /**
   * Tell any in-flight sync of `sourceId` to stop. Without this a page loop
   * runs to completion, and the page it was fetching when the source went away
   * is written afterwards — to a source the gateway has already erased.
   *
   * Called by `unregisterSource` and `disableSource`, and deliberately NOT by
   * `stopSource`: that also runs when a source reports a connection error, and
   * a live-socket source can report one while a sync reads happily from the
   * local store that socket already filled. Removal and disable are the cases
   * where the source really is going away.
   */
  abortSync(sourceId: string, reason: SyncAbortReason = "removed"): void {
    // The reason travels on the signal. A source that is told only "stop"
    // cannot tell whether checkpointing what it holds is worth doing or
    // whether everything it holds is about to be deleted anyway.
    this.syncAborts.get(sourceId)?.abort(reason);
  }

  /**
   * Abort the run in flight on `sourceId` so a fresh one can replace it, and
   * record that it is owed one. The controller stays spent until
   * `takePendingRestart` re-arms it, so a run that reaches its signal capture
   * in between finds it aborted and stops: nothing that started before the
   * restart was asked for keeps permission.
   */
  requestRestart(sourceId: string): void {
    this.abortSync(sourceId, "restarting");
    this.pendingRestarts.add(sourceId);
  }

  /**
   * Consume the restart owed to `sourceId`, re-arming its cancellation so the
   * fresh run gets an un-aborted signal. Called on the aborted run's terminal
   * transition, after that run has stopped — the one moment besides
   * registering and re-enabling when a fresh signal is correct. Returns
   * whether a restart was pending; a source disabled or removed in the
   * meantime is owed nothing.
   */
  takePendingRestart(sourceId: string): boolean {
    if (!this.pendingRestarts.delete(sourceId)) return false;
    const status = this.sourceStatuses.get(sourceId);
    if (!status || status.state === "disabled") return false;
    this.armSync(sourceId);
    return true;
  }

  private removeSourceInstances(instances: ReadonlySet<RegisteredSource>): void {
    for (const [, provider] of this.providers) {
      provider.sources = provider.sources.filter((source) => !instances.has(source));
    }
  }

  async disableSource(sourceId: string): Promise<void> {
    this.stopSource(sourceId);
    this.abortSync(sourceId, "disabled");
    this.pendingRestarts.delete(sourceId);

    // Flip to "disabled" synchronously, before the async suspend below, so a
    // connection-error event racing the disable (the error handler ignores
    // sources whose state is already "disabled") can't bounce the source into
    // "error" mid-teardown.
    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      SourceLifecycle.toDisabled(status, log);
      this.emitStatusChange({ event: "sync.completed", sourceId, status: { ...status } });
    }

    // Suspend the live connection. `stopSource` only clears timers/watchers; a
    // push source (WhatsApp Baileys WS) also holds a socket + auto-reconnect
    // loop that keeps running — and reconnecting — while "disabled", and a
    // later re-enable then stacks a second loop that fights it for the single
    // allowed device connection. `suspend()` stops that loop and closes the
    // socket while keeping the instance (and its store/push wiring) so
    // `resume()` on re-enable re-establishes a single fresh connection. A no-op
    // for pull sources, which hold no connection.
    const instances = this.getSourcesById(sourceId).map((rs) => rs.instance);
    for (const instance of instances) {
      try {
        await instance.suspend?.();
      } catch (err) {
        log.warn(`suspend() failed for ${sourceId} during disable: ${toErrorMessage(err)}`);
      }
    }
  }

  /**
   * Re-enable a previously-disabled source — flip the state back to
   * idle and return the matching source instances so the caller
   * (engine façade) can re-arm timers + file watchers via
   * `startSourceSyncLoops`. The registry deliberately stays out of
   * scheduler-wiring.
   *
   * Resumes the live connection of any push source `disableSource` suspended,
   * so it re-establishes a single fresh socket. A no-op for pull sources.
   */
  async enableSource(sourceId: string): Promise<RegisteredSource[]> {
    const sources = this.getSourcesById(sourceId);
    if (sources.length === 0) return [];
    // `disableSource` aborted the controller; re-arm so syncing can resume.
    this.armSync(sourceId);

    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      SourceLifecycle.reactivateFromStuck(status, log);
      if (status.state !== "idle") {
        SourceLifecycle.toIdle(status, log);
      }
    }

    for (const source of sources) {
      try {
        await source.instance.resume?.();
      } catch (err) {
        log.warn(`resume() failed for ${sourceId} during enable: ${toErrorMessage(err)}`);
      }
    }
    return sources;
  }

  /**
   * Unregister a source — stop syncing and remove from status entirely.
   * Awaits `source.dispose()` before tearing down the providers map so
   * push-based sources (WhatsApp Baileys WS, future websocket-using
   * sources) can flush async writers + close sockets cleanly. Order:
   * stop timers → dispose → remove from registry.
   */
  async unregisterSource(sourceId: string): Promise<void> {
    this.stopSource(sourceId);
    const controller = this.syncAborts.get(sourceId);
    this.abortSync(sourceId);
    this.pendingRestarts.delete(sourceId);
    const registered = this.getSourcesById(sourceId);
    for (const source of registered) {
      try {
        await source.instance.dispose?.();
      } catch (err) {
        // Never propagate — a buggy dispose must not block source
        // removal or take the collector down.
        log.warn(`dispose() failed for ${sourceId}: ${toErrorMessage(err)}`);
      }
    }
    this.removeSourceInstances(new Set(registered));
    // A replacement can register while old dispose awaits. Remove status and
    // cancellation state only if no newer instance/controller now owns the id.
    if (this.getSourcesById(sourceId).length === 0) {
      // Don't emit a "sync.completed" status change here — the collector
      // would forward that upstream as a `sync.status` event,
      // repopulating the gateway's SyncStatusRegistry with a ghost entry
      // *after* the removal. The gateway-side `source.removed` WS command
      // already signals removal.
      this.sourceStatuses.delete(sourceId);
      if (this.syncAborts.get(sourceId) === controller) this.syncAborts.delete(sourceId);
      this.unhostedSources.delete(sourceId);
      log.info(`Unregistered source ${sourceId}`);
    } else {
      log.info(`Old unregister for ${sourceId} left its replacement registered`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Status getters / lookups
  // ───────────────────────────────────────────────────────────────────────

  getStatuses(): SourceStatus[] {
    return Array.from(this.sourceStatuses.values());
  }

  getStatus(sourceId: string): SourceStatus | undefined {
    return this.sourceStatuses.get(sourceId);
  }

  isCurrentSource(source: RegisteredSource): boolean {
    return this.getSourcesById(source.id).includes(source);
  }

  getSourcesById(sourceId: string): RegisteredSource[] {
    const result: RegisteredSource[] = [];
    for (const [, provider] of this.providers) {
      for (const source of provider.sources) {
        if (source.id === sourceId) result.push(source);
      }
    }
    return result;
  }

  /**
   * Find the registered provider that owns a given source. Used by the
   * engine when it needs the provider's `credentialState` callback for
   * a sync tick.
   */
  getProviderForSource(source: RegisteredSource): RegisteredProvider | undefined {
    for (const [, provider] of this.providers) {
      if (provider.sources.includes(source)) return provider;
    }
    return undefined;
  }

  /** Live iterator over the providers Map. */
  allProviders(): IterableIterator<RegisteredProvider> {
    return this.providers.values();
  }

  /** Flat iterator over every registered (provider, source) pair. */
  *allSources(): Generator<{ provider: RegisteredProvider; source: RegisteredSource }> {
    for (const provider of this.providers.values()) {
      for (const source of provider.sources) {
        yield { provider, source };
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // State transitions invoked by the sync runner
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Transition a source into the `needs-auth` state and emit the same
   * `sync.error` event the rest of the engine uses for failures — the
   * gateway's onDeviceEvent handler picks up the state and persists
   * the remediation hint via setSyncError so it survives a gateway
   * restart. Idempotent.
   */
  markNeedsAuth(source: RegisteredSource, providerId: string): void {
    let status = this.sourceStatuses.get(source.id);
    if (!status) {
      // A source with no status and no registration was unregistered while a
      // sync was still paging it. Creating one here puts it back: the page
      // loop's between-pages check reads this map, so a resurrected status
      // hands the abandoned loop permission to keep writing to a source the
      // operator removed.
      if (this.getSourcesById(source.id).length === 0) {
        log.debug(`Ignoring needs-auth for ${source.id} — no longer registered`);
        return;
      }
      status = {
        sourceId: source.id,
        providerId,
        sourceName: source.name,
        icon: source.icon,
        unitName: source.unitName,
        state: "needs-auth",
      };
      this.sourceStatuses.set(source.id, status);
    }
    SourceLifecycle.toNeedsAuth(status, buildReauthHint(source.id, providerId), log);
    this.emitStatusChange({
      event: "sync.error",
      sourceId: source.id,
      status: { ...status },
    });
  }

  /**
   * Park every source drawing on the budget a rate limit was counted against.
   *
   * A limit counted per application is shared by every account this
   * installation holds for that provider, so backing off the source that
   * happened to hit it and letting its siblings run spends the same exhausted
   * budget from another direction — each of them discovering the same limit by
   * spending another request on it. A limit counted per account is narrower,
   * and the siblings that share the account are still the ones affected.
   *
   * The source that threw is parked by its caller. This parks the rest, and
   * says how many, because a fleet of sources going quiet at once is otherwise
   * indistinguishable from a fleet with nothing to do.
   */
  markQuotaExhausted(
    origin: RegisteredSource,
    bucket: QuotaBucket,
    retryAfterMs: number,
    providerMessage?: string,
  ): number {
    // The source names the kind of limit; the host works out which sources
    // share it. An explicit id from the source wins, for the case the host
    // cannot derive — two packages behind one registered application.
    const target: QuotaBucket = bucket.id ? bucket : this.quotaBucketOfSource(origin, bucket.kind);
    let parked = 0;
    for (const { source: sibling } of this.allSources()) {
      if (sibling.id === origin.id) continue;
      if (!sameQuotaBucket(target, this.quotaBucketOfSource(sibling, target.kind))) continue;
      const status = this.sourceStatuses.get(sibling.id);
      // A disabled source is not resurrected.
      if (!status || status.state === "disabled") continue;
      // One already parked longer than this limit keeps the longer wait.
      // Overwriting it would release a source early on the strength of a
      // narrower limit some sibling hit, and it would do so silently.
      if (status.state === "rate-limited" && (status.retryAfterMs ?? 0) >= retryAfterMs) continue;
      SourceLifecycle.toRateLimited(
        status,
        buildRateLimitedHint(retryAfterMs, providerMessage),
        retryAfterMs,
        log,
      );
      // Same event `markRateLimited` sends for the source that actually threw.
      // Without it the park is invisible past this process: the gateway shows
      // the source idle while it sits out a back-off it never heard about, and
      // the operator sees a fleet going quiet with nothing to explain it.
      this.emitStatusChange({
        event: "sync.error",
        sourceId: sibling.id,
        status: { ...status },
      });
      parked += 1;
    }
    if (parked > 0) {
      log.warn(
        `Quota exhausted on ${target.kind} ${target.id}: parked ${parked} sibling source(s) ` +
          `for ${retryAfterMs}ms alongside ${origin.id}, rather than letting each spend a ` +
          `request discovering the same limit.`,
      );
    }
    return parked;
  }

  /**
   * The budget a source draws on, for a given kind of limit.
   *
   * An application limit is keyed by the provider, since one registered
   * application serves every account. An account limit is keyed by the account
   * half of the source id, which is what the credential belongs to.
   */
  private quotaBucketOfSource(source: RegisteredSource, kind: QuotaKind): QuotaBucket {
    if (kind === "app") return { kind, id: String(source.providerId) };
    return { kind, id: parseSourceId(source.id).accountId };
  }

  /**
   * Transition a source into the `rate-limited` state — the provider threw
   * a typed rate-limit `SyncError` carrying `retryAfterMs`. Unlike
   * `markNeedsAuth` this is not a failure: progress is preserved and the
   * source self-heals once the back-off elapses. Emits `sync.error` so the
   * same gateway path that persists `needs-auth` hints persists the
   * back-off note too; `deriveDisplayStatus` recognises the
   * `rate-limited: ` prefix and renders the deferred pill (not red error).
   * The scheduler reads the returned `retryAfterMs` to defer the next tick.
   */
  markRateLimited(source: RegisteredSource, retryAfterMs: number, providerMessage?: string): void {
    const status = this.sourceStatuses.get(source.id);
    if (!status) return;
    // Don't resurrect a source the operator disabled mid-sync — a late
    // rate-limit throw must not flip a paused source back to an active state.
    if (status.state === "disabled") return;
    SourceLifecycle.toRateLimited(
      status,
      buildRateLimitedHint(retryAfterMs, providerMessage),
      retryAfterMs,
      log,
    );
    this.emitStatusChange({
      event: "sync.error",
      sourceId: source.id,
      status: { ...status },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Push-debounce timer accessors (the engine's
  // `setupPushEventsForSource` plumbs through here so per-source
  // ephemeral state lives alongside scheduler / file-watcher cleanup)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Remember how to stop a source's push and error registrations.
   *
   * Wired once per source; called when the source stops. Without this a
   * registration outlives the source that made it, and the only thing keeping
   * that harmless is every source replacing its previous callback rather than
   * appending — which the contract never asked for.
   */
  addTeardown(sourceId: string, stop: Unsubscribe): void {
    const existing = this.pushTeardowns.get(sourceId) ?? [];
    existing.push(stop);
    this.pushTeardowns.set(sourceId, existing);
  }

  /** Whether this source's push and error callbacks are already wired. */
  hasTeardown(sourceId: string): boolean {
    return this.pushTeardowns.has(sourceId);
  }

  private runTeardowns(sourceId: string): void {
    const stops = this.pushTeardowns.get(sourceId);
    if (!stops) return;
    this.pushTeardowns.delete(sourceId);
    for (const stop of stops) {
      try {
        stop();
      } catch (err) {
        // A source whose unsubscribe throws must not stop the rest of teardown
        // — the scheduler and file watchers still have to be released.
        log.warn(`${sourceId}: unsubscribing a push registration failed: ${toErrorMessage(err)}`);
      }
    }
  }

  hasPushDebounce(sourceId: string): boolean {
    return this.pushDebounceTimers.has(sourceId);
  }

  setPushDebounce(sourceId: string, timer: ReturnType<typeof setTimeout>): void {
    const existing = this.pushDebounceTimers.get(sourceId);
    if (existing) clearTimeout(existing);
    this.pushDebounceTimers.set(sourceId, timer);
  }

  clearPushDebounce(sourceId: string): void {
    const existing = this.pushDebounceTimers.get(sourceId);
    if (existing) {
      clearTimeout(existing);
      this.pushDebounceTimers.delete(sourceId);
    }
  }

  clearAllPushDebounces(): void {
    for (const [, timer] of this.pushDebounceTimers) {
      clearTimeout(timer);
    }
    this.pushDebounceTimers.clear();
  }
}
