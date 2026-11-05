// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sync dispatcher — funnels the four current trigger sites (`syncAll`,
 * `staggeredInitialSync`, the per-source interval timer, and the
 * external `triggerSync` API) through a single
 * `tickSource(source, provider)` method. Extracted from `sync-engine.ts`
 * so the auth-check + state-guard logic
 * lives in exactly one place; adding a fifth trigger (cron, signal,
 * remote-poke) no longer means copying the same five-line preamble.
 *
 * Architecturally:
 *   - `SyncDispatcher` itself is stateless; all per-source state lives
 *     in `SourceRegistry`.
 *   - The actual sync runner (`runSyncSource`, the 200-line page loop)
 *     stays on the engine façade and is injected here as a callback —
 *     the dispatcher decides "should we tick?" and lets the engine
 *     decide "what does a tick do".
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import { blocksSync, type ConnectionState, type SyncReason } from "@omnesis/source-sdk";

/**
 * Say once, wherever a credential is read, that it could not be read.
 *
 * Not a finding about the credential — a failure to read it. Syncing anyway
 * costs one failed round at worst; parking would turn a locked keyring into an
 * outage and ask the operator to re-authenticate something that is fine. It is
 * logged because an operator debugging that keyring has nothing else to go on.
 */
/**
 * Whether a credential state should stop this provider's sources.
 *
 * Two questions, and both have to be yes. A state that blocks says the
 * credential cannot be used; `renewableCredential` says there is a credential
 * an operator could do something about. A local source fails the second, so it
 * is never parked as `needs-auth` — that offers a remedy which does not exist,
 * and the concrete local problem reaches the operator from the sync path.
 */
function shouldPark(
  provider: { credentialState: unknown; renewableCredential: boolean },
  credential: ConnectionState,
): boolean {
  return provider.renewableCredential && blocksSync(credential);
}

function noteUnreadable(providerId: string, credential: ConnectionState): void {
  if (credential.status !== "unknown") return;
  log.info(`Provider ${providerId} credential unreadable (${credential.because}) — syncing anyway`);
}
import { SourceLifecycle } from "./source-lifecycle.js";
import type { SourceRegistry } from "./source-registry.js";
import type { SyncOutcome } from "./source-sync-runner.js";
import type { RegisteredProvider, RegisteredSource } from "./sync-engine-types.js";

const log = createLogger("collector:sync");

/** Strip the optional trailing `*` / `:*` so `gmail:*` and `gmail:` agree. */
function normalizePattern(pattern: string): string {
  return pattern.endsWith(":*") ? pattern.slice(0, -1) : pattern.replace(/\*$/, "");
}

/** Whether a normalized pattern selects a source by its own id or its provider's. */
function patternMatches(normalized: string, sourceId: string, providerId: string): boolean {
  if (normalized === "all" || normalized === "") return true;
  if (sourceId === normalized || providerId === normalized) return true;
  return (
    normalized.endsWith(":") &&
    (sourceId.startsWith(normalized) || providerId.startsWith(normalized))
  );
}

export interface TriggerSyncResult {
  triggered: string[];
  skipped: string[];
  disabled: string[];
  /**
   * Sources whose run in flight was aborted for a restart. The fresh sync
   * fires on that run's terminal transition, not here.
   */
  restarting: string[];
  /**
   * Sources the pattern named that this collector is configured for but is
   * not hosting, with the reason instantiation failed. Distinct from the
   * `error` below, which means the pattern matched nothing at all.
   */
  unhosted: Array<{ sourceId: string; error: string }>;
  error?: string;
}

export class SyncDispatcher {
  constructor(
    private readonly registry: SourceRegistry,
    /**
     * The actual sync runner — wraps `runSyncSource` (the 200-line
     * page loop) plus the wall-clock timeout + in-flight tracking
     * that the engine façade still owns. Injected as a callback so
     * the dispatcher doesn't depend on the gateway client / progress
     * tracker / structured-vs-document branching. Resolves to a
     * {@link SyncOutcome} so the dispatcher can pass a rate-limit
     * deferral back to the scheduler.
     */
    private readonly runSync: (
      source: RegisteredSource,
      reason: SyncReason,
    ) => Promise<SyncOutcome>,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // tickSource — the canonical "do a sync if conditions allow" entry
  //
  // The three current internal trigger sites (interval timer in
  // `startSyncLoop` / `updateSyncIntervals` / `startSourceSyncLoops`,
  // the syncAll worker pool, the staggeredInitialSync `setTimeout`)
  // funnel here. Pre-extract they each open-coded the same
  // `state==="syncing"? skip → credentialState() blocks? markNeedsAuth :
  // syncSource` preamble.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Decide whether a source is eligible to sync right now and run it
   * if so. Idempotent: re-entering while a sync is already in flight
   * is a no-op.
   *
   * Returns the runner's {@link SyncOutcome} — `undefined` for the normal
   * cadence (including every skip path), or a `{ retryAfterMs }` deferral
   * when the provider rate-limited the source so the scheduler can back off.
   */
  async tickSource(
    source: RegisteredSource,
    provider: RegisteredProvider,
    // Why this tick fired. The caller knows; by the time the source is invoked
    // nothing else does, which is why every trigger used to look the same.
    reason: SyncReason = "scheduled",
  ): Promise<SyncOutcome> {
    const status = this.registry.getStatus(source.id);
    if (!status || status.state === "disabled") return;
    if (status.state === "syncing") {
      log.debug(`Skipping ${source.id} — already syncing`);
      return;
    }

    const credential = await provider.credentialState();
    if (shouldPark(provider, credential)) {
      this.registry.markNeedsAuth(source, provider.id);
      log.warn(
        `Provider ${provider.id} credential is ${credential.status} — flagged ${source.id} needs-auth`,
      );
      return;
    }
    if (credential.status === "unknown") {
      // Not a finding about the credential — a failure to read it. Syncing
      // anyway costs one failed round at worst; parking would turn a locked
      // keyring into an outage and ask the operator to re-authenticate
      // something that is fine.
      log.info(
        `Provider ${provider.id} credential unreadable (${credential.because}) — syncing anyway`,
      );
    }

    return await this.runSync(source, reason);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Pattern matching + external trigger
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Resolve a glob-ish pattern to a list of matching source IDs.
   * Matches against both source IDs and provider IDs.
   *
   * Examples:
   *   "all"                           — all sources
   *   "gmail:user@gmail.com"          — exact source ID match
   *   "gmail:"                        — all sources with ID starting with "gmail:"
   *   "google:user@gmail.com"         — all sources from provider google:user@gmail.com
   *   "google:"                       — all sources from any google provider
   *
   * Trailing "*" is also accepted (e.g. "gmail:*") for compatibility.
   */
  resolveSourcePattern(pattern: string): string[] {
    const normalized = normalizePattern(pattern);
    const matchingIds: string[] = [];
    for (const status of this.registry.getStatuses()) {
      if (patternMatches(normalized, status.sourceId, status.providerId)) {
        matchingIds.push(status.sourceId);
      }
    }
    return matchingIds;
  }

  /**
   * The pattern's matches among sources configured here that failed to
   * instantiate. Kept out of `resolveSourcePattern` on purpose: every caller
   * of that resolves ids in order to *act* on them, and there is nothing to
   * act on here — only something to report.
   */
  private resolveUnhostedPattern(pattern: string): Array<{ sourceId: string; error: string }> {
    const normalized = normalizePattern(pattern);
    return this.registry
      .unhostedEntries()
      .filter((entry) => patternMatches(normalized, entry.sourceId, entry.providerId))
      .map(({ sourceId, error }) => ({ sourceId, error }));
  }

  /**
   * Trigger an immediate sync for sources matching a pattern.
   *
   * Differs from `tickSource` in that it claims `state = "syncing"`
   * synchronously BEFORE the auth check — without that optimistic
   * claim two rapid `triggerSync` calls would both pass
   * the eligibility check during the `provider.credentialState()`
   * await window and both fire the async chain. The push-debounce +
   * filewatcher debounce upstream make this rare, but the iOS
   * multi-source pulse path can hit it.
   *
   * `runSyncSource` calls `toSyncing` again later — that becomes a
   * no-op for the state assignment, with the progress/lastError clears
   * still useful.
   *
   * With `restart`, the sources are started over: one already syncing has
   * its run aborted through the registry and is owed a fresh sync on that
   * run's terminal transition (reported under `restarting`); one that is
   * idle resets its own state through `onResync` before its sync starts.
   * `onResync` is deliberately not called while a run is still unwinding —
   * a source's in-place reset must not interleave with a page it is still
   * draining — so for a restarted source it runs when the fresh sync fires.
   */
  triggerSync(
    pattern: string,
    opts: { restart?: boolean; reason?: SyncReason } = {},
  ): TriggerSyncResult {
    // A trigger with no stated reason came from a person: every automatic
    // caller names itself.
    const reason: SyncReason = opts.reason ?? (opts.restart ? "resync" : "manual");
    const matchingIds = this.resolveSourcePattern(pattern);
    const unhosted = this.resolveUnhostedPattern(pattern);
    // A pattern that names a source this host could not build is not a pattern
    // that matched nothing — saying so sends the operator hunting for a CLI bug
    // instead of the cause. Set whenever anything was named and not run, so a
    // fan-out reports the one source that would otherwise do nothing silently.
    const unhostedError =
      unhosted.length > 0
        ? unhosted.map((u) => `${u.sourceId} is not running here: ${u.error}`).join("; ")
        : undefined;

    if (matchingIds.length === 0) {
      return {
        triggered: [],
        skipped: [],
        disabled: [],
        restarting: [],
        unhosted,
        error: unhostedError ?? `No sources match: ${pattern}`,
      };
    }

    const triggered: string[] = [];
    const skipped: string[] = [];
    const disabled: string[] = [];
    const restarting: string[] = [];

    for (const sourceId of matchingIds) {
      const status = this.registry.getStatus(sourceId)!;
      if (status.state === "disabled") {
        log.debug(`Skipping triggered sync for ${sourceId} (state: disabled)`);
        disabled.push(sourceId);
        continue;
      }
      if (status.state === "syncing") {
        if (opts.restart) {
          log.info(`Restarting ${sourceId}: aborting the sync in flight`);
          this.registry.requestRestart(sourceId);
          restarting.push(sourceId);
        } else {
          log.debug(`Skipping triggered sync for ${sourceId} (state: syncing)`);
          skipped.push(sourceId);
        }
        continue;
      }

      // Resolve the instance BEFORE the optimistic claim below: a status with
      // no instance behind it would otherwise be left claimed as `syncing`
      // forever, by a sync that never started.
      const source = this.registry.getSourcesById(sourceId)[0];
      if (!source) {
        log.warn(`Cannot sync ${sourceId} — status is registered but no instance is`);
        continue;
      }
      if (source.pushBased) {
        // Its data arrives by being pushed to the gateway, so there is nothing
        // here to run: the factory exists only to satisfy the instance
        // contract and returns an empty page. The scheduler already leaves
        // these alone, and the portal hides the action — but a command from
        // the CLI, a file-watch event or a wake callback reaches this path,
        // and calling `sync()` on one is outside what its contract promises.
        log.debug(`Skipping triggered sync for ${sourceId} — this source is pushed to, not synced`);
        skipped.push(sourceId);
        continue;
      }
      const provider = this.registry.getProviderForSource(source);
      if (!provider) {
        log.warn(`Cannot sync ${sourceId} — no provider owns its instance`);
        continue;
      }

      if (opts.restart) {
        for (const registered of this.registry.getSourcesById(sourceId)) {
          try {
            registered.instance.onResync?.();
          } catch (error) {
            log.warn(`onResync() failed for ${sourceId}: ${toErrorMessage(error)}`);
          }
        }
      }

      // Optimistic claim — see doc-comment above.
      status.state = "syncing";
      triggered.push(sourceId);
      provider
        .credentialState()
        .then((credential) => {
          noteUnreadable(provider.id, credential);
          if (shouldPark(provider, credential)) {
            log.warn(
              `Provider ${provider.id} credential is ${credential.status}, cannot sync ${sourceId}`,
            );
            if (status.state !== "syncing") return;
            // A restart is the operator's own request, answered with the
            // cause; a plain trigger rolls its claim back and leaves the
            // next tick to say so.
            if (opts.restart) this.registry.markNeedsAuth(source, provider.id);
            else SourceLifecycle.toIdle(status, log);
            return;
          }
          void this.runSync(source, reason);
        })
        .catch((error) => {
          log.error(`Triggered sync error for ${sourceId}: ${toErrorMessage(error)}`);
          if (status.state === "syncing") {
            SourceLifecycle.toError(status, toErrorMessage(error), log);
            this.registry.emitStatusChange({
              event: "sync.error",
              sourceId,
              status: { ...status },
            });
          }
        });
    }

    return { triggered, skipped, disabled, restarting, unhosted, error: unhostedError };
  }
}
