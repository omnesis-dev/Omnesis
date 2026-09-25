// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-source page-loop runner — the body of what used to be
 * `SyncEngine.runSyncSource`. Extracted from `sync-engine.ts`
 * to keep the façade under the ~500-line
 * ceiling.
 *
 * The runner owns the actual cursor-loop:
 *
 *   1. Fetch current cursor from the gateway.
 *   2. Loop while `hasMore`:
 *      - Pick structured-vs-document branch.
 *      - Upsert documents and/or ingest analytics records.
 *      - Maybe the snapshot reconcile (on `presentExternalIds`), which records
 *        what the snapshot omits rather than deleting it.
 *      - Persist the new cursor + meta.
 *      - Update progress.
 *   3. Stamp `lastSyncAt` + `lastSyncStats` on the status.
 *
 * Plus the wall-clock timeout wrapper that pre-clears the `syncing`
 * flag so a stuck provider doesn't pin the source forever.
 *
 * Stateful dependencies (the gateway client, the registry for status +
 * pub/sub) are injected via the constructor; the per-call entry
 * `runOne(source)` is the only public method.
 */

import { randomUUID } from "node:crypto";
import {
  boundSyncIssues,
  createLogger,
  toErrorMessage,
  syncIssueIdentity,
  MAX_SYNC_ISSUES,
} from "@omnesis/core";
import { quotaBucketOf, syncRemediationOf } from "@omnesis/types";
import {
  analyticsSchemaUsesDynamicColumns,
  isAnalyticsLeaseRejection,
  tableWriteRowCount,
  tableWrites,
  type AnalyticsTableSchema,
  type GatewayClient,
  type SnapshotAbsenceOutcome,
  type SyncAbortReason,
  type SyncReason,
  type SyncRun,
  type TableWrite,
  type UpsertWithCursorResponse,
} from "@omnesis/source-sdk";
import { sourceDisplayMeta } from "./source-display-meta.js";
import { assertsPresence, pageSnapshot } from "./page-snapshot.js";
import {
  classifySyncError,
  looksLikeAuthFailure,
  extractRateLimitDeferral,
} from "./error-classifier.js";
import { SourceLifecycle } from "./source-lifecycle.js";
import { ProgressTracker } from "./progress-tracker.js";
import { FeedProcessSupervisor } from "./feed-process-supervisor.js";
import { runWithSyncTimeout } from "./source-sync-attempt.js";
import type {
  DocumentIngestionContext,
  DocumentInput,
  SourceId,
  SyncIssue,
  SyncIssueAssessment,
} from "@omnesis/types";
import type { SourceRegistry } from "./source-registry.js";
import type { RegisteredSource } from "./sync-engine-types.js";

const log = createLogger("collector:sync");

/** Replay keeps its key space; only additive account ownership may precede it. */
function replayOwnershipSchemas(
  writes: TableWrite[],
  currentSchemas: AnalyticsTableSchema[],
): AnalyticsTableSchema[] {
  const prerequisites = new Map<string, AnalyticsTableSchema>();
  for (const write of writes) {
    const current = currentSchemas.find((schema) => schema.tableName === write.tableName);
    const columnName = current?.sharedDiscriminatorColumn;
    const frozen = write.schema;
    if (!columnName) continue;
    const parent = current.sharedDiscriminatorParent;
    const frozenParent = frozen?.sharedDiscriminatorParent;
    const sameParent =
      parent?.table === frozenParent?.table &&
      parent?.column === frozenParent?.column &&
      parent?.parentColumn === frozenParent?.parentColumn;
    if (
      !frozen ||
      analyticsSchemaUsesDynamicColumns(frozen) ||
      (frozen.sharedDiscriminatorColumn && frozen.sharedDiscriminatorColumn !== columnName) ||
      (frozenParent && !sameParent)
    ) {
      throw new Error("Pending analytics ownership schema cannot be safely upgraded");
    }
    const declaredColumn = current.columns.find((column) => column.name === columnName);
    const frozenColumn = frozen.columns.find((column) => column.name === columnName);
    if (!declaredColumn || (frozenColumn && frozenColumn.type !== declaredColumn.type)) {
      throw new Error("Pending analytics ownership column is incompatible");
    }
    prerequisites.set(write.tableName, {
      ...frozen,
      sharedDiscriminatorColumn: columnName,
      sharedDiscriminatorParent: parent,
      columns: frozenColumn
        ? frozen.columns
        : [...frozen.columns, { ...declaredColumn, nullable: true }],
    });
  }
  const ordered: AnalyticsTableSchema[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (schema: AnalyticsTableSchema): void => {
    if (visited.has(schema.tableName)) return;
    if (visiting.has(schema.tableName))
      throw new Error("Pending analytics ownership dependency cycle");
    visiting.add(schema.tableName);
    const parent = schema.sharedDiscriminatorParent?.table;
    const prerequisite = parent
      ? (prerequisites.get(parent) ??
        currentSchemas.find((candidate) => candidate.tableName === parent))
      : undefined;
    // A child-only page can outlive the parent's ownership declaration. Register
    // that static parent before asking the gateway to attribute its child rows.
    // Dynamic parent evolution needs a fresh provider enumeration, not recovery.
    if (parent && (!prerequisite || analyticsSchemaUsesDynamicColumns(prerequisite))) {
      throw new Error(
        "Pending analytics ownership requires a static parent schema; update the source declaration before retrying",
      );
    }
    if (prerequisite) visit(prerequisite);
    visiting.delete(schema.tableName);
    visited.add(schema.tableName);
    ordered.push(schema);
  };
  for (const schema of prerequisites.values()) visit(schema);
  return ordered;
}

/**
 * Surface what the gateway made of this page's snapshot.
 *
 * The collector is where a source's own operator looks first, and a snapshot
 * that omitted everything the gateway holds is the shape a bad read takes —
 * a locked database, a lapsed permission, a store mid-migration. Nothing is
 * deleted on the strength of it, but the source has started a clock on its own
 * documents, and the operator has until the deadline to notice.
 */
function reportSnapshotAbsence(
  sourceId: SourceId,
  absence: SnapshotAbsenceOutcome | undefined,
): void {
  if (absence === undefined || (absence.absent === 0 && absence.missing === 0)) return;
  const detail =
    `snapshot named ${absence.snapshot} of ${absence.stored} stored, ` +
    `${absence.absent} absent (${absence.marked} newly marked), ` +
    `${absence.missing} named but not stored`;
  if (absence.stored > 0 && absence.absent === absence.stored) {
    log.warn(
      `${sourceId}: the snapshot omits every stored item the gateway holds — ${detail}. Nothing was deleted; the deadline is cancelled if a later snapshot names the items again.`,
    );
    return;
  }
  log.info(`${sourceId}: ${detail}`);
}

/**
 * Outcome of a single sync run. `void`/`undefined` means "ran to a terminal
 * state (idle / error / needs-auth / disabled); schedule the next tick on the
 * normal cadence". A `{ retryAfterMs }` deferral means "the provider rate-
 * limited us; the source is parked in `rate-limited` — push the next tick out
 * by at least `retryAfterMs`". Only the rate-limit path returns a deferral, so
 * every other code path is byte-for-byte unchanged.
 */
export interface SyncDeferral {
  retryAfterMs: number;
}
export type SyncOutcome = void | SyncDeferral;

/** Floor on the lease heartbeat, so a short lease is not renewed in a busy loop. */
const LEASE_HEARTBEAT_MIN_MS = 5_000;

export class SourceSyncRunner {
  private readonly activeAttempts = new Map<string, string>();
  /** Sources whose sync lease this collector holds, released when it stops. */
  private readonly heldLeases = new Set<SourceId>();
  /** Renewal timers keeping a held lease alive through a long page fetch. */
  private readonly leaseHeartbeats = new Map<SourceId, ReturnType<typeof setInterval>>();

  constructor(
    private readonly gateway: GatewayClient,
    private readonly registry: SourceRegistry,
    private readonly syncTimeoutMs: number,
    private readonly feedProcess: FeedProcessSupervisor = new FeedProcessSupervisor(),
    private readonly ingestionContext?: DocumentIngestionContext,
  ) {}

  /**
   * Give up every sync lease this collector holds — on shutdown, so a
   * sibling's next tick takes the source over without waiting for the lease
   * to lapse.
   */
  async releaseLeases(): Promise<void> {
    await Promise.allSettled([...this.heldLeases].map((sourceId) => this.releaseLease(sourceId)));
  }

  /** Give up one source's lease — it was disabled or removed on this collector. */
  async releaseLease(sourceId: SourceId): Promise<void> {
    this.stopLeaseHeartbeat(sourceId);
    if (!this.heldLeases.delete(sourceId)) return;
    await this.releaseGrantedLease(sourceId);
  }

  private async releaseGrantedLease(sourceId: SourceId): Promise<void> {
    const release = this.gateway.releaseSyncLease;
    if (!release) return;
    try {
      await release.call(this.gateway, sourceId);
    } catch (err) {
      log.debug(`${sourceId}: releasing the sync lease failed: ${toErrorMessage(err)}`);
    }
  }

  /**
   * Keep a held lease alive while a page fetch outlasts it: every committed
   * page renews the lease, but a single slow page would otherwise let it
   * lapse and hand the source to a sibling mid-sync. Re-claiming as the
   * holder renews; the timer stops when the attempt finishes.
   *
   * A refusal is a decision, not a failure, so it arrives as a resolved
   * `{ granted: false }` rather than a throw: the lease is another device's
   * now, every page this run still fetches would be bounced at the write, and
   * `onLost` is what stops the run at the refusal instead of at that write.
   * A renewal that merely fails to reach the gateway is not a refusal — the
   * lease may well still be ours, and the run keeps going until it lapses.
   */
  private startLeaseHeartbeat(
    sourceId: SourceId,
    expiresAt: number | undefined,
    onLost: (holder: string | undefined) => void,
  ): void {
    this.stopLeaseHeartbeat(sourceId);
    const claim = this.gateway.claimSyncLease;
    if (!claim || expiresAt === undefined) return;
    const intervalMs = Math.max(LEASE_HEARTBEAT_MIN_MS, Math.floor((expiresAt - Date.now()) / 2));
    const timer = setInterval(() => {
      claim
        .call(this.gateway, sourceId)
        .then((lease) => {
          if (lease.granted) return;
          this.stopLeaseHeartbeat(sourceId);
          this.heldLeases.delete(sourceId);
          log.warn(
            `${sourceId}: the sync lease moved to ${lease.holder ?? "another device"} (${lease.reason ?? "held"}) — stopping this sync`,
          );
          onLost(lease.holder);
        })
        .catch((err: unknown) => {
          log.debug(`${sourceId}: renewing the sync lease failed: ${toErrorMessage(err)}`);
        });
    }, intervalMs);
    timer.unref?.();
    this.leaseHeartbeats.set(sourceId, timer);
  }

  private stopLeaseHeartbeat(sourceId: SourceId): void {
    const timer = this.leaseHeartbeats.get(sourceId);
    if (timer) clearInterval(timer);
    this.leaseHeartbeats.delete(sourceId);
  }

  private documentsWithIngestionContext(
    documents: DocumentInput[] | undefined,
  ): DocumentInput[] | undefined {
    if (!documents) return undefined;
    if (!this.ingestionContext) return documents;
    return documents.map((document) => ({
      ...document,
      metadata: { ...document.metadata, ingestionContext: this.ingestionContext },
    }));
  }

  /** Whether a run of `sourceId` is in flight on this runner. */
  isRunning(sourceId: string): boolean {
    return this.activeAttempts.has(sourceId);
  }

  /**
   * Run one full sync cycle against a single source, with the
   * wall-clock timeout that keeps a stuck provider from pinning the
   * source forever.
   *
   * Returns a {@link SyncDeferral} only when the provider rate-limited the
   * source (so the scheduler can back off); otherwise resolves to
   * `undefined` for the normal cadence.
   */
  async runOne(source: RegisteredSource, reason: SyncReason = "manual"): Promise<SyncOutcome> {
    if (!this.registry.isCurrentSource(source)) {
      log.info(`Ignoring stale source instance for ${source.id}`);
      return;
    }
    const attemptToken = randomUUID();
    this.activeAttempts.set(source.id, attemptToken);
    const ownsAttempt = () => this.activeAttempts.get(source.id) === attemptToken;
    const isCurrent = () => ownsAttempt() && this.registry.isCurrentSource(source);
    return runWithSyncTimeout({
      source,
      registry: this.registry,
      gateway: this.gateway,
      timeoutMs: this.syncTimeoutMs,
      attemptId: attemptToken,
      isCurrent,
      finish: () => {
        if (!ownsAttempt()) return;
        this.stopLeaseHeartbeat(source.id);
        this.activeAttempts.delete(source.id);
      },
      operation: (signal, onEpochClaimed) =>
        this.runPageLoop(source, signal, attemptToken, onEpochClaimed, {
          reason,
          // The wall clock the host will actually enforce. Two sources race
          // their own timers against it because they could not see it.
          deadline: Date.now() + this.syncTimeoutMs,
        }),
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Page loop body — was `runSyncSource` on the engine façade
  // ───────────────────────────────────────────────────────────────────────

  private async runPageLoop(
    source: RegisteredSource,
    timeoutSignal: AbortSignal,
    attemptToken: string,
    onEpochClaimed: (epoch: number) => void,
    runInfo: { reason: SyncReason; deadline: number },
  ): Promise<SyncOutcome> {
    if (!this.registry.isCurrentSource(source)) {
      log.info(`Ignoring stale source instance for ${source.id}`);
      return;
    }
    // Aborted when a lease renewal comes back refused, so the in-flight page
    // fetch stops at the moment the lease was lost rather than at the write
    // the gateway would bounce.
    const leaseLost = new AbortController();
    let leaseLostHolder: string | undefined;
    // Capture this instance's lifecycle signal before any await. Unregistering
    // aborts it; a replacement instance gets a fresh signal that this stale
    // loop can never borrow.
    const lifecycleSignal = this.registry.syncSignal(source.id);
    const signal = AbortSignal.any([lifecycleSignal, timeoutSignal, leaseLost.signal]);
    const status = this.registry.getStatus(source.id);
    if (!status || status.state === "disabled") return;

    // Note that the collector sends every member's snapshot, lease or no
    // lease, and the gateway decides whose counts: a non-holder's is read for
    // the items it keeps alive rather than acted on. The authority lives
    // there, not here.
    const mode = source.multiDeviceMode;
    const isStructuredSource =
      !!source.instance.syncStructured &&
      !!source.instance.analyticsSchemas &&
      Array.isArray(source.instance.analyticsSchemas);
    if (
      (mode === "handoff" || mode === "replicated") &&
      isStructuredSource &&
      !this.gateway.ingestAnalyticsPage
    ) {
      const message =
        "gateway client does not expose analytics page responses required for lease fencing";
      SourceLifecycle.toError(status, message, log);
      this.registry.emitStatusChange({
        event: "sync.error",
        sourceId: source.id,
        status: { ...status },
      });
      return;
    }
    if ((mode === "handoff" || mode === "replicated") && this.gateway.claimSyncLease) {
      const lease = await this.gateway.claimSyncLease(source.id, { signal });
      if (
        signal.aborted ||
        this.activeAttempts.get(source.id) !== attemptToken ||
        !this.registry.isCurrentSource(source)
      ) {
        const activeAttempt = this.activeAttempts.get(source.id);
        if (lease.granted && (activeAttempt === undefined || activeAttempt === attemptToken)) {
          await this.releaseGrantedLease(source.id);
        }
        return;
      }
      if (lease.granted) {
        this.heldLeases.add(source.id);
        this.startLeaseHeartbeat(source.id, lease.expiresAt, (holder) => {
          leaseLostHolder = holder;
          leaseLost.abort("lease-lost" satisfies SyncAbortReason);
        });
      } else if (mode === "handoff") {
        // Another device syncs the source: this tick is skipped before it
        // starts, so no status event is reported — a skipped tick is
        // neither a completion nor an error of the holder's sync. A
        // triggered tick marked the source syncing before it ran; that
        // claim is rolled back so the next tick is not skipped as in-flight
        // — only when the claim is this attempt's, so a run that started in
        // the meantime keeps its own.
        this.heldLeases.delete(source.id);
        if (status.state === "syncing" && this.activeAttempts.get(source.id) === attemptToken) {
          SourceLifecycle.toIdle(status, log);
        }
        log.info(
          `${source.id}: another device holds the sync lease (${lease.holder ?? "unknown"}, ${lease.reason ?? "held"}) — skipping this tick`,
        );
        return;
      } else {
        this.heldLeases.delete(source.id);
        log.debug(
          `${source.id}: syncing without the sync lease — the snapshot reconcile is left to ${lease.holder ?? "its holder"}`,
        );
      }
    }

    SourceLifecycle.toSyncing(status, log);
    this.registry.emitStatusChange({
      event: "sync.started",
      sourceId: source.id,
      status: { ...status },
    });

    // The lease went to another device while a page was in flight (a page
    // longer than the lease's grace): the run stops with the cause on record.
    const stopLeaseLost = (holder: string | undefined): void => {
      this.heldLeases.delete(source.id);
      if (this.activeAttempts.get(source.id) === attemptToken && status.state === "syncing") {
        SourceLifecycle.toError(
          status,
          `lost the sync lease to ${holder ?? "another device"} mid-sync`,
          log,
        );
        this.registry.emitStatusChange({
          event: "sync.error",
          sourceId: source.id,
          status: { ...status },
        });
      }
    };

    const stopDeletionDeferred = (holder: string | undefined): void => {
      this.heldLeases.delete(source.id);
      if (this.activeAttempts.get(source.id) === attemptToken && status.state === "syncing") {
        SourceLifecycle.toIdle(status, log);
        this.registry.emitStatusChange({
          event: "sync.deferred",
          sourceId: source.id,
          status: { ...status },
        });
      }
      log.info(
        `${source.id}: deletion page retained for replay while ${holder ?? "another replica"} holds deletion authority`,
      );
    };

    /**
     * Stop the run when the lease was lost under it, wherever the loss is
     * noticed — before a fetch, after one, or in the error the aborted fetch
     * threw. Returns whether the caller should give up.
     */
    const stoppedOnLostLease = (): boolean => {
      if (!leaseLost.signal.aborted) return false;
      stopLeaseLost(leaseLostHolder);
      return true;
    };

    const stopSuperseded = (): void => {
      if (this.activeAttempts.get(source.id) === attemptToken && status.state === "syncing") {
        SourceLifecycle.toError(status, "sync attempt superseded by a newer run", log);
        this.registry.emitStatusChange({
          event: "sync.error",
          sourceId: source.id,
          status: { ...status },
        });
      }
    };

    const startTime = Date.now();
    /**
     * Distinct documents this run wrote, by external id. A page count would
     * say the same thing twice for a source that writes a document and later
     * rewrites it in the same run — a mailbox that stores headers first and
     * bodies on a second pass reported every message twice.
     */
    const writtenDocuments = new Set<string>();
    /**
     * Analytics rows written, kept apart from documents. Folding them into
     * one count reported a source whose documents each carry a row at twice
     * its size, and a page of child rows (an activity's laps and splits) as
     * that many activities.
     */
    let totalRows = 0;
    let totalDeleted = 0;
    /**
     * What this run cost that it survived, summed across its pages.
     *
     * On the run rather than on the progress meter, which every terminal
     * transition clears — the same reason the coverage claim had to move.
     */
    let issues: SyncIssue[] = [];
    let issuesEvaluated = false;
    let sourceIssuesEvaluated = false;
    const runtimeAssessments = new Map<string, SyncIssueAssessment>();
    const reportSnapshotAssessment = (message?: string, subject = "Document snapshot"): void => {
      issuesEvaluated = true;
      const assessment: SyncIssueAssessment = {
        code: "invalid-snapshot",
        scope: "partition",
        subject: subject.slice(0, 512),
      };
      runtimeAssessments.set(syncIssueIdentity(assessment), assessment);
      if (message === undefined) return;
      issues = boundSyncIssues([
        ...issues,
        {
          code: "invalid-snapshot",
          scope: "partition",
          kind: "unknown",
          count: 1,
          subject,
          message,
          remediation: {
            summary: "The source emitted an invalid snapshot",
            steps: [
              "Update or repair the source so it asserts presence only after a complete enumeration.",
            ],
            restartRequired: false,
          },
        },
      ]);
    };
    let pageCount = 0;

    /**
     * What the host knows about this run, rebuilt per page because the page
     * index and the lease role are the parts that move. `start` is left as the
     * host's best guess and replaced by the state wrapper, which is the only
     * thing that has decoded the cursor by the time the source is called.
     */
    const runOf = (): SyncRun => ({
      id: attemptToken,
      reason: runInfo.reason,
      start: "resume",
      page: pageCount,
      deadline: runInfo.deadline,
      ...(source.multiDeviceMode
        ? { role: this.heldLeases.has(source.id) ? ("holder" as const) : ("member" as const) }
        : {}),
    });
    let seenTables: Set<string> | undefined;
    const progress = new ProgressTracker((s) => {
      if (signal.aborted || this.activeAttempts.get(source.id) !== attemptToken) return;
      this.registry.emitStatusChange({
        event: "sync.progress",
        sourceId: source.id,
        status: { ...s },
      });
    });
    try {
      const attemptEpoch = await this.gateway.beginSyncAttempt?.(source.id, {
        signal,
        attemptId: attemptToken,
      });
      if (signal.aborted || !this.registry.isCurrentSource(source)) return;
      if (attemptEpoch !== undefined) {
        // Gateway claim order is authoritative for overlapping runs. Only a
        // live instance may reclaim local authority; replacement/unregister
        // aborts its captured lifecycle signal before this point.
        this.activeAttempts.set(source.id, attemptToken);
        onEpochClaimed(attemptEpoch);
      }
      const state = await this.gateway.getSyncState(source.id);
      if (
        signal.aborted ||
        this.activeAttempts.get(source.id) !== attemptToken ||
        !this.registry.isCurrentSource(source)
      ) {
        return;
      }
      let cursor = state?.cursor ?? null;
      // Echoed back on every cursor write so the gateway can reject this
      // sync's writes if the source is wiped (resync) while it's in flight.
      //Undefined against an older gateway → no check there.
      //
      // Read separately when there is no cursor: a wipe clears the cursor, so
      // the bootstrap that follows one — the sync most likely to be racing
      // another wipe — would otherwise carry no epoch and skip the check.
      const wipeEpoch =
        attemptEpoch ?? state?.wipeEpoch ?? (await this.gateway.getWipeEpoch(source.id));
      if (
        signal.aborted ||
        this.activeAttempts.get(source.id) !== attemptToken ||
        !this.registry.isCurrentSource(source)
      ) {
        return;
      }
      // Push meta on every sync so icon/label changes in code propagate
      // without manual sync_state surgery. Payload is a few KB per source and
      // only travels once per sync cycle. What the fields mean, and why the
      // family is carried beside the source's own, is in `sourceDisplayMeta`.
      const metaForGateway = sourceDisplayMeta(source);
      let pendingStructuredPage = isStructuredSource
        ? await this.gateway.getPendingStructuredPage?.(source.id)
        : undefined;
      // Startup schema announcement is best-effort and can race this runner.
      // A journal replay needs ownership metadata before either data or snapshot
      // writes, without consuming the journal's ordered mutation receipts.
      if (pendingStructuredPage) {
        const prerequisites = replayOwnershipSchemas(
          tableWrites(pendingStructuredPage.result.analytics),
          source.instance.analyticsSchemas ?? [],
        );
        for (const schema of prerequisites) {
          if (signal.aborted || !this.registry.isCurrentSource(source) || stoppedOnLostLease())
            return;
          const response = await this.gateway.ingestAnalyticsPage({
            tableName: schema.tableName,
            records: [],
            schema,
            sourceId: source.id,
            writeEpoch: wipeEpoch,
          });
          if (isAnalyticsLeaseRejection(response)) {
            stopLeaseLost(response.holder);
            return;
          }
          if (response.rejected || response.deletionDeferred) {
            throw new Error("Pending analytics ownership prerequisite was not accepted");
          }
        }
      }
      let hasMore = true;
      while (hasMore) {
        // Check if source was disabled/unregistered while we were syncing.
        // Re-read from the map because disableSource() may have changed the state
        // since we last checked (the local `status` ref is the same object).
        const currentStatus = this.registry.getStatus(source.id);
        if (!currentStatus || currentStatus.state === "disabled") {
          log.info(`Sync aborted for ${source.id} — source disabled`);
          return;
        }
        if (stoppedOnLostLease()) return;
        if (signal.aborted) {
          log.info(`Sync aborted for ${source.id} — source removed, disabled or restarting`);
          return;
        }

        // Route to structured or unstructured sync
        if (isStructuredSource) {
          const syncStructured = () =>
            source.instance.syncStructured!(cursor, { signal, run: runOf() });
          let result =
            pendingStructuredPage?.result ??
            (wipeEpoch !== undefined && this.gateway.runWithSourceWriteEpoch
              ? await this.gateway.runWithSourceWriteEpoch(source.id, wipeEpoch, syncStructured)
              : await syncStructured());
          if (stoppedOnLostLease()) return;
          // Checked AFTER the fetch, not only before it. The fetch is the long
          // part, so a removal almost always lands during one — and writing its
          // result is what re-creates rows for a source that is already gone.
          if (signal.aborted) {
            log.info(
              `Discarding a page fetched for ${source.id} — source removed or disabled mid-sync`,
            );
            return;
          }
          pageCount++;

          if (!pendingStructuredPage && this.gateway.prepareStructuredPage) {
            if (wipeEpoch === undefined)
              throw new Error("A durable structured page requires a write epoch");
            const schemas = new Map(
              source.instance.analyticsSchemas?.map((schema) => [schema.tableName, schema]),
            );
            const analytics = tableWrites(result.analytics).map((write) => {
              if (write.schema) schemas.set(write.tableName, write.schema);
              return { ...write, schema: schemas.get(write.tableName) };
            });
            pendingStructuredPage = await this.gateway.prepareStructuredPage(source.id, {
              id: randomUUID(),
              writeEpoch: wipeEpoch,
              result: {
                ...result,
                documents: this.documentsWithIngestionContext(result.documents),
                analytics,
              },
              meta: metaForGateway,
              documentTemporalProjections: source.documentTemporalProjections,
            });
            result = pendingStructuredPage.result;
          }

          // A page names every table it fills, in the order it wants them
          // written. Empty writes are already dropped by `tableWrites`, so a
          // source composing its page from optional parts costs no round trip
          // for the parts it skipped.
          const writes = tableWrites(result.analytics);
          const snapshotWrites: TableWrite[] = [];
          for (const [writeOrdinal, write] of writes.entries()) {
            // Either spelling of a snapshot is the same assertion, so the
            // guard has to see both: a partial page naming what is present
            // asks the gateway to delete everything the rest of the walk has
            // not reached yet.
            const vouches = write.presentKeys !== undefined || write.presentIds !== undefined;
            if (vouches) {
              if (result.hasMore) {
                reportSnapshotAssessment(
                  "A partial analytics page asserted a complete snapshot; deletion detection was withheld.",
                  write.tableName,
                );
                log.error(
                  `${source.id}: source vouched for what ${write.tableName} holds on a partial page (hasMore=true) — refusing analytics reconciliation`,
                );
              } else {
                // Sent whether or not this member holds the lease: the gateway
                // reconciles only the holder's snapshot, but reads every
                // member's for the rows that member keeps alive against another
                // member's deletion.
                reportSnapshotAssessment(undefined, write.tableName);
                snapshotWrites.push(write);
              }
            }
            // Cursor-committed journals retain only their post-commit work.
            // Replaying rows here could undo a newer member's writes.
            if (pendingStructuredPage?.cursorCommitted) continue;
            // Prefer the schema the page carries, and otherwise look the
            // table up in the instance's static declarations — but only the
            // first time this sync sees the table, since the gateway only
            // needs it to create or evolve the table once.
            //
            // Analytics ingest is to DuckDB — a separate database from
            // SQLite, so it cannot join the cursor transaction below. The
            // durable page and write ordinal identify each operation across
            // retries; gateway receipts keep a completed write from running
            // twice. Snapshot evidence follows the SQLite cursor commit.
            if (!seenTables) seenTables = new Set<string>();
            const schema =
              write.schema ??
              (!seenTables.has(write.tableName)
                ? source.instance.analyticsSchemas?.find((s) => s.tableName === write.tableName)
                : undefined);
            seenTables.add(write.tableName);
            const analyticsResult = await this.gateway.ingestAnalyticsPage({
              tableName: write.tableName,
              records: write.records ?? [],
              schema,
              sourceId: source.id,
              deletedKeys: write.deletedKeys,
              deletedIds: write.deletedIds,
              deleteKeyColumn: write.deleteKeyColumn,
              // Snapshot evidence is deliberately committed only after the
              // SQLite cursor transaction below succeeds. DuckDB row upserts
              // are replay-safe; absence observations are not evidence of a
              // completed source snapshot until the cursor advances.
              presentKeys: undefined,
              writeEpoch: wipeEpoch,
              pendingPageId: pendingStructuredPage?.id,
              writeOrdinal: pendingStructuredPage ? writeOrdinal : undefined,
            });
            {
              if (isAnalyticsLeaseRejection(analyticsResult)) {
                stopLeaseLost(analyticsResult.holder);
                return;
              }
              // A fresh row deletion this member may not lead was withheld.
              // The cursor stays where it is — the SQLite page below is not
              // sent — so the tick replays once the holder has led it; the
              // durable page keeps the exact output for retry, and completed
              // table writes are recognized by their generation receipts.
              if (mode === "replicated" && analyticsResult.deletionDeferred) {
                stopDeletionDeferred(analyticsResult.holder);
                return;
              }
            }
            totalRows += write.records?.length ?? 0;
          }

          // What this page may assert about what still exists. See
          // `pageSnapshot` for why the guard lives in one place.
          const snapshot = pageSnapshot(source.id, result, log, reportSnapshotAssessment);

          // Atomic SQLite write — documents + (no tombstones in the
          // structured branch) + snapshot reconcile + cursor in one
          // gateway-side transaction. If this throws, the cursor stays at
          // its prior value and the next cycle replays the stored page.
          // The journal remains after the cursor commit until every snapshot
          // is acknowledged, so losing a response cannot lose that work.
          const writeResult: UpsertWithCursorResponse = pendingStructuredPage?.cursorCommitted
            ? { ingested: 0, reconciledDeleted: 0, indexCleanedRows: 0 }
            : await this.gateway.upsertWithCursor({
                pendingPageId: pendingStructuredPage?.id,
                providerId: source.providerId,
                sourceId: source.id,
                documents: pendingStructuredPage
                  ? result.documents
                  : this.documentsWithIngestionContext(result.documents),
                // Preserve the declaration's three wire states: `undefined` means
                // this source has never declared document projections (so the
                // gateway skips all projection work), a non-empty array declares
                // slots, and an explicit `[]` retires a prior declaration.
                documentTemporalProjections: pendingStructuredPage
                  ? pendingStructuredPage.documentTemporalProjections
                  : source.documentTemporalProjections,
                // Incremental document tombstones for hybrid sources (e.g. a
                // cancelled calendar event) — the structured twin of the
                // unstructured branch's deletion path. (Analytics-row deletion via
                // `result.deletedIds` is forwarded separately on the structured
                // write path above.)
                deletedExternalIds:
                  result.deletedExternalIds && result.deletedExternalIds.length > 0
                    ? result.deletedExternalIds
                    : undefined,
                ...snapshot,
                observationId: assertsPresence(snapshot)
                  ? (pendingStructuredPage?.id ?? `${wipeEpoch ?? "legacy"}:${attemptToken}`)
                  : undefined,
                edges: result.edges,
                hasMore: result.hasMore,
                cursor: result.cursor,
                wipeEpoch,
                // Forward the source's forward-looking consent deadline so the
                // gateway persists it and can warn ahead of expiry. Pass through
                // verbatim — `undefined` leaves the stored value untouched, `null`
                // clears it (re-consent that no longer expires).
                consentExpiresAt: result.consentExpiresAt,
                // V1 is source-level: only a terminal page can establish a
                // coverage claim. Existing providers remain useful and honest via
                // the generic observation fallback until they opt into a stronger
                // provider-reported guarantee.
                watermark: result.hasMore
                  ? undefined
                  : (result.watermark ?? { guarantee: "observation" }),
                meta: pendingStructuredPage ? pendingStructuredPage.meta : metaForGateway,
              });
          if (writeResult.rejectedAsRemoved) {
            log.info(`Sync stopped because ${source.id} was removed at the gateway`);
            await this.registry.disableSource(source.id);
            return;
          }
          if (writeResult.rejected) {
            if (writeResult.reason === "lease") {
              if (mode === "replicated" && writeResult.deletionDeferred) {
                stopDeletionDeferred(writeResult.holder);
                return;
              }
              stopLeaseLost(writeResult.holder);
              return;
            }
            log.info(`Sync attempt for ${source.id} was superseded; stopping stale page loop`);
            stopSuperseded();
            return;
          }
          for (const [snapshotIndex, write] of snapshotWrites.entries()) {
            // The source snapshot becomes evidence only after its SQLite page
            // and cursor commit. A retry of this post-commit request carries
            // the same observation id, so a lost HTTP response cannot count
            // the same completed snapshot twice. Two tables sharing that id is
            // fine: the receipt is scoped by table as well as by source.
            const observationId =
              pendingStructuredPage?.id ?? `${wipeEpoch ?? "legacy"}:${attemptToken}`;
            const analyticsResult = await this.gateway.ingestAnalyticsPage({
              tableName: write.tableName,
              records: [],
              sourceId: source.id,
              presentKeys: write.presentKeys,
              presentIds: write.presentIds,
              deleteKeyColumn: write.deleteKeyColumn,
              writeEpoch: wipeEpoch,
              observationId,
              pendingPageId: pendingStructuredPage?.id,
              writeOrdinal: pendingStructuredPage ? writes.length + snapshotIndex : undefined,
            });
            if (isAnalyticsLeaseRejection(analyticsResult)) {
              // Keep the cursor-committed journal: a later authorized run
              // finishes this observation before fetching new upstream data.
              stopLeaseLost(analyticsResult.holder);
              return;
            }
            reportSnapshotAbsence(source.id, analyticsResult.absence);
          }
          if (pendingStructuredPage) {
            const acknowledged = await this.gateway.acknowledgeStructuredPage!(source.id, {
              id: pendingStructuredPage.id,
              writeEpoch: wipeEpoch!,
            });
            if (!acknowledged.acknowledged) {
              stopSuperseded();
              return;
            }
            pendingStructuredPage = null;
          }
          // structured-branch counter
          if (result.documents?.length) {
            for (const doc of result.documents) writtenDocuments.add(doc.externalId);
          }
          // Collected whether or not the page produced anything: a page that
          // skipped a whole folder is exactly the page with something to say
          // and nothing to show.
          if (result.issues !== undefined) {
            issuesEvaluated = true;
            sourceIssuesEvaluated = true;
            issues = boundSyncIssues([...issues, ...result.issues]);
          }
          totalDeleted += writeResult.tombstonedDeleted ?? result.deletedExternalIds?.length ?? 0;
          reportSnapshotAbsence(source.id, writeResult.absence);

          cursor = result.cursor;

          if (result.progress) {
            // Per-cycle progress: `total` is the queue size for this sync
            // cycle and `processed` is what we've drained from it. Bootstrap
            // and incremental use the same accounting — a sync is a sync,
            // the only difference is queue size.
            progress.reportPage(status, result.progress, writtenDocuments.size);
          }

          log.debug(
            `${source.id} page ${pageCount}: ${tableWriteRowCount(result.analytics)} records to ` +
              `${writes.map((w) => w.tableName).join(", ") || "no table"}, hasMore=${result.hasMore}`,
          );
          hasMore = result.hasMore;
        } else {
          const sync = () => source.instance.sync(cursor, { signal, run: runOf() });
          const result =
            wipeEpoch !== undefined && this.gateway.runWithSourceWriteEpoch
              ? await this.gateway.runWithSourceWriteEpoch(source.id, wipeEpoch, sync)
              : await sync();
          if (stoppedOnLostLease()) return;
          if (signal.aborted) {
            log.info(
              `Discarding a page fetched for ${source.id} — source removed or disabled mid-sync`,
            );
            return;
          }
          pageCount++;

          // What this page may assert about what still exists. See
          // `pageSnapshot` for why the guard lives in one place.
          const snapshot = pageSnapshot(source.id, result, log, reportSnapshotAssessment);

          // Atomic per-page write — closes the at-least-once gap.
          //Documents + tombstones + snapshot reconcile +
          // cursor advance all commit (or all roll back) in one gateway
          // SQLite transaction. Cursor lag on partial failure is no
          // longer possible.
          const writeResult = await this.gateway.upsertWithCursor({
            providerId: source.providerId,
            sourceId: source.id,
            documents: this.documentsWithIngestionContext(result.documents),
            documentTemporalProjections: source.documentTemporalProjections,
            deletedExternalIds:
              result.deletedExternalIds.length > 0 ? result.deletedExternalIds : undefined,
            ...snapshot,
            observationId: assertsPresence(snapshot)
              ? `${wipeEpoch ?? "legacy"}:${attemptToken}`
              : undefined,
            edges: result.edges,
            hasMore: result.hasMore,
            cursor: result.cursor,
            wipeEpoch,
            // Forward the source's forward-looking consent deadline. See
            // the structured branch above for the verbatim-pass-through rationale.
            consentExpiresAt: result.consentExpiresAt,
            watermark: result.hasMore
              ? undefined
              : (result.watermark ?? { guarantee: "observation" }),
            meta: metaForGateway,
          });
          if (writeResult.rejectedAsRemoved) {
            log.info(`Sync stopped because ${source.id} was removed at the gateway`);
            await this.registry.disableSource(source.id);
            return;
          }
          if (writeResult.rejected) {
            if (writeResult.reason === "lease") {
              if (mode === "replicated" && writeResult.deletionDeferred) {
                stopDeletionDeferred(writeResult.holder);
                return;
              }
              stopLeaseLost(writeResult.holder);
              return;
            }
            log.info(`Sync attempt for ${source.id} was superseded; stopping stale page loop`);
            stopSuperseded();
            return;
          }
          for (const doc of result.documents) writtenDocuments.add(doc.externalId);
          totalDeleted += writeResult.tombstonedDeleted ?? result.deletedExternalIds.length;
          reportSnapshotAbsence(source.id, writeResult.absence);

          cursor = result.cursor;

          // Update progress — per-cycle accounting. `total` = items in this
          // cycle's queue (e.g. notes modified since last cursor); `processed`
          // = items drained so far this cycle. Bootstrap and incremental
          // share this model — a sync is a sync, the only difference is
          // queue size.
          if (result.issues !== undefined) {
            issuesEvaluated = true;
            sourceIssuesEvaluated = true;
            issues = boundSyncIssues([...issues, ...result.issues]);
          }

          if (result.progress) {
            progress.reportPage(status, result.progress, writtenDocuments.size);
          }

          log.debug(
            `${source.id} page ${pageCount}: ${result.documents.length} docs (total ${writtenDocuments.size}, hasMore: ${result.hasMore}, progress: ${result.progress?.processed ?? "—"}/${result.progress?.total ?? "—"})`,
          );

          hasMore = result.hasMore;

          // Avoid hot-looping when a push-based source reports
          // hasMore but has no data yet (waiting for data to arrive)
          if (hasMore && result.documents.length === 0) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }

      // Take the feed-process reading BEFORE the timeout guard below. It is an
      // advisory signal that reads nothing from `status`, and awaiting it after
      // the guard would reopen the very window the guard closes: the wall-clock
      // timeout could fire during the probe, flip the source to `error`, and
      // this path would then emit `sync.completed` over it.
      //
      // Failures are swallowed rather than left to the enclosing try: the
      // cursor is already committed and the sync has succeeded, so an
      // unanswerable advisory question must never mark it errored.
      let feedProcessRunning: boolean | undefined;
      let feedProcessLaunchFailing: boolean | undefined;
      try {
        const reading = await this.feedProcess.observe(source.instance.freshness);
        feedProcessRunning = reading.running;
        feedProcessLaunchFailing = reading.launchFailing;
      } catch (err) {
        log.warn(`Freshness probe failed for ${source.id}: ${toErrorMessage(err)}`);
      }

      // Guard against a timed-out sync resurrecting from the dead. If
      // the wall-clock timeout in `runOne` fired, the status is
      // already past `syncing` (error / disabled / a fresher syncing
      // started by the next tick). Don't clobber that. The background
      // promise eventually settles, this branch just no-ops.
      if (
        signal.aborted ||
        this.activeAttempts.get(source.id) !== attemptToken ||
        !this.registry.isCurrentSource(source) ||
        status.state !== "syncing"
      ) {
        log.warn(
          `Sync for ${source.id} completed after the wall-clock timeout fired (state is ${status.state}); not overwriting status`,
        );
        return;
      }
      SourceLifecycle.toIdle(status, log);
      status.lastSyncAt = new Date().toISOString();
      status.lastSyncStats = {
        documents: writtenDocuments.size,
        deleted: totalDeleted,
        pages: pageCount,
        durationMs: Date.now() - startTime,
      };
      status.feedProcessRunning = feedProcessRunning;
      status.feedProcessLaunchFailing = feedProcessLaunchFailing;
      // An incremental tick may not assess enumeration at all. Only an explicit
      // report (including []) replaces durable warnings on the gateway.
      if (!sourceIssuesEvaluated && issues.length >= MAX_SYNC_ISSUES) {
        const omitted = issues.slice(MAX_SYNC_ISSUES - 1);
        issues = [
          ...issues.slice(0, MAX_SYNC_ISSUES - 1),
          {
            code: "additional-runtime-snapshot-issues",
            scope: "partition",
            kind: "unknown",
            count: omitted.reduce(
              (sum, issue) => Math.min(Number.MAX_SAFE_INTEGER, sum + issue.count),
              0,
            ),
            message:
              "Additional invalid snapshot diagnostics were omitted from this report; inspect collector diagnostics.",
          },
        ];
      }
      status.issues = issuesEvaluated ? issues : undefined;
      // A runtime snapshot check assesses one plane/table, not every warning
      // the provider ever reported. Explicit provider reports remain complete
      // assessments; otherwise name only the exact keys inspected this run.
      const reportedKeys = new Set(issues.map(syncIssueIdentity));
      status.issueAssessments =
        !sourceIssuesEvaluated && runtimeAssessments.size > 0
          ? [...runtimeAssessments.values()]
              .sort(
                (a, b) =>
                  Number(reportedKeys.has(syncIssueIdentity(b))) -
                  Number(reportedKeys.has(syncIssueIdentity(a))),
              )
              .slice(0, MAX_SYNC_ISSUES - 1)
              .concat({ code: "additional-runtime-snapshot-issues", scope: "partition" })
          : undefined;
      this.registry.emitStatusChange({
        event: "sync.completed",
        sourceId: source.id,
        status: { ...status },
      });

      const unit = source.unitName ?? "docs";
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const parts = [`+${writtenDocuments.size} ${unit}`];
      if (totalRows > 0) parts.push(`+${totalRows} rows`);
      if (totalDeleted > 0) parts.push(`-${totalDeleted}`);
      parts.push(`${pageCount} pages`);
      parts.push(`${durationSec}s`);
      log.info(`Sync complete for ${source.id}: ${parts.join(", ")}`);
    } catch (error) {
      if (timeoutSignal.aborted || this.activeAttempts.get(source.id) !== attemptToken) return;
      // The source was removed, disabled or restarted under the fetch:
      // whatever the fetch threw on its way out is the abort, not a failure
      // of the source, and the status is the lifecycle's to set.
      if (lifecycleSignal.aborted) {
        log.info(`Sync aborted for ${source.id} — source removed, disabled or restarting`);
        return;
      }
      // A refused renewal aborts the fetch, so the error here is whatever the
      // source raised on its way out. The lost lease is the real cause.
      // Checked before the composed-signal guard below, which would otherwise
      // swallow the loss as a plain removal.
      if (stoppedOnLostLease()) return;
      const currentStatus = this.registry.getStatus(source.id);
      if (
        signal.aborted ||
        !this.registry.isCurrentSource(source) ||
        !currentStatus ||
        currentStatus.state === "disabled"
      ) {
        log.info(`Ignoring sync failure for ${source.id} — source removed or disabled`);
        return;
      }
      // Rate-limit deferral: a provider threw a typed rate-limit `SyncError`
      // carrying a positive `retryAfterMs` — anywhere from seconds to hours
      // (Coinbase's 60s, Granola's Retry-After, Enable Banking's 6h ASPSP cap).
      // This is NOT a failure: the source is healthy, the upstream is just
      // temporarily off-limits. Park it in `rate-limited` (progress preserved)
      // and return a structured deferral so the scheduler backs off to
      // `max(interval, retryAfterMs)` instead of retry-storming.
      // Only the typed-with-retryAfterMs shape lands here; an untyped
      // "rate limited (429)" error or a rate-limit `SyncError` *without*
      // `retryAfterMs` falls through to the generic `error` path below.
      const deferral = extractRateLimitDeferral(error);
      if (deferral) {
        // Stamp partial-success metrics like the error path does, so a
        // rate-limit mid-bootstrap still reflects what landed.
        status.lastSyncAt = new Date().toISOString();
        status.lastSyncStats = {
          documents: writtenDocuments.size,
          deleted: totalDeleted,
          pages: pageCount,
          durationMs: Date.now() - startTime,
        };
        this.registry.markRateLimited(source, deferral.retryAfterMs, toErrorMessage(error));
        log.warn(
          `Sync rate-limited for ${source.id}: deferring next tick by ${deferral.retryAfterMs}ms (${toErrorMessage(error)})`,
        );
        // A limit the source named a budget for is not this source's alone.
        // Every sibling drawing on that budget is already over it, and letting
        // each of them find out costs one more request against a limit that is
        // the reason they are waiting.
        const bucket = quotaBucketOf(error);
        if (bucket) {
          this.registry.markQuotaExhausted(
            source,
            bucket,
            deferral.retryAfterMs,
            toErrorMessage(error),
          );
        }
        return deferral;
      }
      // Credential-failure errors get the needs-auth treatment so the
      // UI surfaces a remediation hint instead of a generic red error
      // pill. Covers OAuth refresh-token expiry / revocation across
      // google/strava/outlook/notion without each provider needing
      // bespoke transition logic.
      if (looksLikeAuthFailure(error)) {
        const providerId = source.providerId;
        this.registry.markNeedsAuth(source, providerId);
        log.warn(`Sync auth failure for ${source.id}: ${toErrorMessage(error)}`);
        // A device that cannot authenticate cannot sync the source: give the
        // lease up so a sibling's next tick takes the source over instead of
        // waiting for the lease to lapse and its incumbent window to pass.
        await this.releaseLease(source.id);
      } else {
        // Stamp partial-success metrics before the lifecycle transition
        // so the UI can distinguish "failed at page 1" from "failed
        // after 50 pages". Previously `lastSyncStats` / `lastSyncAt`
        // only updated on the happy path, leaving the dashboard pinned
        // on whatever the most-recent successful cycle reported.
        status.lastSyncAt = new Date().toISOString();
        status.lastSyncStats = {
          documents: writtenDocuments.size,
          deleted: totalDeleted,
          pages: pageCount,
          durationMs: Date.now() - startTime,
        };
        SourceLifecycle.toError(status, toErrorMessage(error), log, syncRemediationOf(error));
        this.registry.emitStatusChange({
          event: "sync.error",
          sourceId: source.id,
          status: { ...status },
        });

        log.error(
          `Sync failed for ${source.id} after ${pageCount} pages / ${writtenDocuments.size} docs: ${toErrorMessage(error)}`,
        );

        // A permission failure is this host's, and it will not clear on its
        // own: the file, the folder or the grant is out of reach here. Holding
        // the lease would leave the source's deletions unreconciled on every
        // host, because only the holder may reconcile a snapshot. Give it up
        // so a sibling that can read the source takes it over.
        if (classifySyncError(error) === "permission") {
          await this.releaseLease(source.id);
        }
      }
    }
  }
}

// `metadata.sourceUrl` is forwarded verbatim to the gateway — sources
// emit the openable user-facing URL, which is what portals, the agent,
// and triggers display. The gateway separately canonicalizes into the
// `documents.source_url` column at write time (see DocumentRepository),
// using the per-host canonicalizer registry the collector pushed at
// startup. That column is the dedup key and what `/documents/by-url`
// queries against; metadata stays presentation-only.
