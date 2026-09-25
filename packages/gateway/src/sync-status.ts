// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isActionableMobilePermissionState } from "@omnesis/types/mobile-permission-health";
import {
  SourceId,
  tryDeviceId,
  type DeviceId,
  type SyncRemediation,
  type SyncIssueStatus,
  type SourceNotice,
} from "@omnesis/types";
import { syncErrorRemediationCodec } from "./data/json-columns.js";
import type { MobilePermissionHealth } from "@omnesis/types/mobile-permission-health";
import type { StoredSyncState } from "./db.js";

/**
 * In-memory snapshot of per-source sync status. Updated by collector events
 * received over the device WS channel; queried by /admin/sync/status.
 *
 * `deviceId` records which connected collector last reported on this source,
 * so the gateway can route a sync trigger even for sources not registered
 * in the /admin/sources table (legacy CLI add path).
 */
/**
 * `needs-auth` is a distinct error state for *credential* failures
 * (OAuth token revoked / expired refresh-token / source added without
 * credentials yet). UIs surface it with a remediation hint
 * ("run cli -- sources reauth google:user@gmail.com to re-authenticate") rather
 * than the generic red error pill.
 *
 * `rate-limited` is a distinct *deferred* state — the provider asked the
 * collector to back off for a window (e.g. Enable Banking's 6h ASPSP cap),
 * so the source self-heals on its next deferred tick. UIs surface it with the
 * retry note rather than a red error pill.
 */
export type SourceSyncState =
  | "idle"
  | "syncing"
  | "completed"
  | "error"
  | "needs-auth"
  | "rate-limited";

/**
 * Canonical *display* state served by `/admin/sync/status` to portal + CLI.
 * Derived on the server from in-memory events + persisted `sync_state` so
 * both clients render the same pill without re-implementing the mapping.
 *
 * Differences from the in-memory `SourceSyncState`:
 *   - `completed` is collapsed into `synced` — matches what humans expect
 *     to read in the UI.
 *   - `paused` is added — sourced from `source.enabled === false`, not
 *     from a sync event. The wire/DB field is still `enabled` (legacy
 *     name); "paused" is the user-facing label that describes what the
 *     state actually means: sync timer is paused, all data + cursor +
 *     credentials are preserved, ready to resume.
 *   - `idle` means "registered but never successfully synced". A source
 *     that *has* synced before but isn't currently syncing shows `synced`,
 *     even after a gateway restart wipes the in-memory registry.
 */
export type DisplaySyncState =
  | "idle"
  | "syncing"
  | "synced"
  | "error"
  | "paused"
  | "needs-auth"
  | "rate-limited"
  | "permission-degraded"
  | "background-access-missing"
  | "unavailable"
  /**
   * Forward-looking consent-expiry warning. A purely DERIVED state — it
   * is never a persisted `SourceSyncState`, only computed by
   * `deriveDisplayStatus` from the persisted `consent_expires_at` when `now`
   * enters the lead window before the deadline AND the source is otherwise
   * healthy (would read `synced` / `idle`). Distinct from the reactive terminal
   * `needs-auth`: the source is still syncing fine, but the operator should
   * reconnect before the deadline to avoid a future `needs-auth`. Re-consent
   * that pushes the deadline out (or removes it) clears it on the next sync.
   */
  | "auth-expiring"
  /**
   * The source's local data feed appears to have stalled. Like `auth-expiring`,
   * a purely DERIVED state — never a persisted `SourceSyncState` — and equally
   * non-terminal: sync is running fine and the indexed data is intact, but new
   * data has stopped arriving and the operator can fix it in a few seconds.
   *
   * Exists because a source reading a local file that some other program keeps
   * current cannot fail loudly. It opens the file, reads it, finds nothing new,
   * and reports success — forever, while the data behind it is frozen. Nothing
   * in the reactive chain can catch that, because from the gateway's side a
   * dead feed and a quiet fortnight are the same observation.
   *
   * Requires, together: the source declared a `SourceFreshness` expectation,
   * `last_document_at` is older than the window it declared, the collector
   * reported the program that feeds it is definitely not running, and that
   * report is recent enough to still describe reality. Any one of them alone is
   * a false positive — hence the conjunction. See `isSourceFeedStale`.
   */
  | "stale";

export interface DisplaySyncStatus {
  /** Nonfatal problems from the last completed sync, with stable first-observed times. */
  issues?: SyncIssueStatus[];
  issuesSince?: number;
  sourceId: SourceId;
  deviceId?: DeviceId;
  /**
   * Each member's own status, present only for a source several devices
   * contribute to; the enclosing status is the aggregate across them.
   */
  members?: DisplaySyncStatus[];
  /**
   * On a member of a replicated source: items this device's replica still
   * holds that another member reported deleted. The gateway keeps them until
   * this device agrees; present only when non-zero.
   */
  restoredClaims?: number;
  /**
   * What a person should be told about this status, composed by
   * `buildSourceNotices` from the fields beside it. Clients render these
   * verbatim — as icons beside the device they belong to — instead of
   * interpreting `errorMessage`, `issues`, `coverage` or `restoredClaims`
   * themselves. On a source several devices contribute to, each member carries
   * its own and the aggregate carries none.
   */
  notices?: SourceNotice[];
  /**
   * Full provider ID `<providerType>:<accountId>` (e.g. `google:user@gmail.com`)
   * for sources whose collector reported it on `sync.status`. Renderers (CLI
   * status, portal /sources) group `needs-auth` rows by this so the
   * remediation hint appears once per provider account, not once per source —
   * closes cli-reauth-hint-per-source-instead-of-per-provider.
   */
  providerId?: string;
  state: DisplaySyncState;
  unitName?: string;
  /**
   * Per-source progress payload. Field names match `SyncProgress` (the
   * canonical shape declared in `@omnesis/core`'s `source.ts`) so the
   * collector can pass it through verbatim — no rename / translation
   * step at any boundary. The previous `{ totalDocs, processedDocs,
   * percentage }` shape was a fiction (nothing wrote it) and meant
   * CLI / portal silently read undefined keys, hiding the
   * bootstrap progress bar entirely.
   */
  progress?: {
    phase?: string;
    total?: number;
    processed?: number;
    percentComplete?: number;
    message?: string;
    /**
     * How much upstream history the source holds. `"unknown"` is a real
     * answer — a source that has not established whether it is missing
     * history has not said it is whole.
     */
    coverage?: "complete" | "partial" | "unknown";
    detail?: string;
  };
  /**
   * How much upstream history the source holds, as it last claimed.
   *
   * Beside `progress` rather than inside it: the progress meter is cleared by
   * every terminal transition, so a claim carried there is readable only while
   * the source is mid-sync and gone the moment it finishes. This one survives,
   * and is replaced only when the source claims something different.
   */
  coverage?: "complete" | "partial" | "unknown";
  /** The source's own wording for that claim, when it gave one. */
  coverageDetail?: string;
  startedAt?: number;
  /** ISO timestamp of last successful cursor save (persisted). null = never. */
  lastSyncAt: string | null;
  /**
   * Forward-looking consent / authorization deadline (ISO 8601) the source last
   * reported, when known. Present whenever a deadline is stored —
   * independent of `state`, so a healthy `synced` source can still surface "your
   * connection expires on <date>". When `state === "auth-expiring"` it is the
   * deadline driving the warning. `undefined` means no known deadline.
   */
  consentExpiresAt?: string;
  /**
   * The source's own remediation sentence for `state === "stale"`, authored by
   * the provider package that knows what actually feeds it. Rendered verbatim
   * by portal / iOS / CLI so no shared renderer has to know which program
   * belongs to which source. `undefined` in every other state.
   */
  staleHint?: string;
  /** Last reported error message — present iff state === "error". */
  errorMessage?: string;
  /** ISO timestamp of last error — present iff state === "error". */
  erroredAt?: string;
  /**
   * What the operator has to do before `errorMessage` can clear, when the
   * collector reported the failure with one — an access grant the host keys
   * on the collector's executable, for instance. Present only with
   * `state === "error"`, rendered by portal and CLI as the row's affordance in
   * place of the raw message. Scoped to the reporting device: on a source
   * several devices contribute to, it appears on the member that hit the
   * failure, never on its siblings.
   */
  remediation?: SyncRemediation;
  /**
   * Heartbeat timestamp of the most recent in-memory event for this source.
   * Internal/diagnostic — not used as a user-facing "last activity" anymore.
   */
  lastUpdated?: number;
  /** Last explicit OS capability snapshot; never inferred from source data volume. */
  permissionHealth?: MobilePermissionHealth;
}

export interface SourceSyncStatus {
  sourceId: SourceId;
  deviceId?: DeviceId;
  /** Full provider ID `<providerType>:<accountId>`. See DisplaySyncStatus. */
  providerId?: string;
  state: SourceSyncState;
  /** Singular unit name as declared by the source (e.g. "visit", "activity", "doc"). */
  unitName?: string;
  /** Same shape as DisplaySyncStatus.progress. See note there. */
  progress?: {
    phase?: string;
    total?: number;
    processed?: number;
    percentComplete?: number;
    message?: string;
    coverage?: "complete" | "partial" | "unknown";
    detail?: string;
  };
  /** See `DisplaySyncStatus.coverage`. */
  coverage?: "complete" | "partial" | "unknown";
  /** See `DisplaySyncStatus.coverageDetail`. */
  coverageDetail?: string;
  startedAt?: number;
  completedAt?: number;
  errorMessage?: string;
  /** See `DisplaySyncStatus.remediation`; taken from the report verbatim. */
  remediation?: SyncRemediation;
  /**
   * The source's freshness claim and the collector's last reading of it, as
   * reported on `sync.status`. Present only for sources that declared one.
   * Lives in memory rather than on disk: the declaration belongs to the running
   * source, and a gateway restart simply re-learns it from the next sync. A
   * stalled feed by definition never touches the files a source watches, so no
   * watch-triggered sync fires and the warning can take up to one sync interval
   * to reappear — acceptable for an advisory signal.
   */
  freshness?: {
    quietPeriodMs: number;
    hint: string;
    /** `undefined` = could not be determined. Never conflate with `false`. */
    processRunning?: boolean;
  };
  lastUpdated: number;
}

export class SyncStatusRegistry {
  /**
   * One entry per (source, reporting device). A source with one member has
   * exactly one entry, so every per-source read below sees what that
   * member reported; a multi-member source aggregates across its entries.
   */
  private statuses = new Map<string, SourceSyncStatus>();
  /**
   * Tombstones for recently-removed sourceIds. Prevents ghost entries when
   * an in-flight sync completes *after* the admin runs `DELETE /admin/sources/:id`
   * — the collector would emit a `sync.completed` event that arrives here
   * after the delete and would otherwise repopulate the registry.
   * TTL'd so a fresh add of the same sourceId works again.
   */
  private tombstones = new Map<string, number>();
  private readonly TOMBSTONE_TTL_MS = 60_000;

  private static key(sourceId: string, deviceId: string | undefined): string {
    return `${sourceId}\u0000${deviceId ?? ""}`;
  }

  /** Every entry reported for a source, in insertion order. */
  private entriesFor(sourceId: string): SourceSyncStatus[] {
    const prefix = `${sourceId}\u0000`;
    const out: SourceSyncStatus[] = [];
    for (const [k, v] of this.statuses) if (k.startsWith(prefix)) out.push(v);
    return out;
  }

  /**
   * The entry an event without a device id belongs to: the source's only
   * entry when it has one (a sparse `sync.status` never splits a member's
   * state in two), the anonymous entry otherwise.
   */
  private resolveDeviceId(sourceId: string, deviceId: string | undefined): string | undefined {
    if (deviceId !== undefined) return deviceId;
    const entries = this.entriesFor(sourceId);
    return entries.length === 1 ? entries[0]?.deviceId : undefined;
  }

  update(snapshot: SourceSyncStatus): void {
    const tombstonedAt = this.tombstones.get(snapshot.sourceId);
    if (tombstonedAt && Date.now() - tombstonedAt < this.TOMBSTONE_TTL_MS) {
      return; // drop stale event arriving after a delete
    }
    const deviceId = this.resolveDeviceId(snapshot.sourceId, snapshot.deviceId);
    const key = SyncStatusRegistry.key(snapshot.sourceId, deviceId);
    const existing = this.statuses.get(key);
    this.statuses.set(key, {
      ...existing,
      ...snapshot,
      // Always preserve deviceId + unitName + providerId once known — they
      // don't change between sync events but a sparse sync.status event
      // would otherwise clear them.
      deviceId: snapshot.deviceId ?? existing?.deviceId,
      unitName: snapshot.unitName ?? existing?.unitName,
      providerId: snapshot.providerId ?? existing?.providerId,
      // Same reasoning: a claim about the corpus outlives the run that made
      // it, so an event that says nothing about coverage leaves it standing.
      coverage: snapshot.coverage ?? existing?.coverage,
      coverageDetail: snapshot.coverage ? snapshot.coverageDetail : existing?.coverageDetail,
      // Taken from the snapshot verbatim rather than merged with the previous
      // value: the collector attaches the declaration to every status event, so
      // its ABSENCE is meaningful. A source reconfigured such that it no longer
      // makes a freshness claim (a vault repointed from an app-synced folder to
      // a daemon-synced one) must stop being reported stale, and a `??` fallback
      // would pin the old claim until the gateway restarted.
      freshness: snapshot.freshness,
      // Same rule: the remedy belongs to the failure being reported, and a
      // report without one must not inherit the previous failure's.
      remediation: snapshot.remediation,
      lastUpdated: Date.now(),
    });
  }

  /** Called by /admin/sources POST — clears any stale tombstone so a fresh
   *  registration of the same sourceId isn't silently ignored. */
  clearTombstone(sourceId: SourceId): void {
    this.tombstones.delete(sourceId);
  }

  /** Look up the device whose report currently represents this source. */
  deviceFor(sourceId: SourceId): DeviceId | undefined {
    return this.get(sourceId)?.deviceId;
  }

  remove(sourceId: SourceId): void {
    for (const k of [...this.statuses.keys()]) {
      if (k.startsWith(`${sourceId}\u0000`)) this.statuses.delete(k);
    }
    this.tombstones.set(sourceId, Date.now());
  }

  /** Forget one device's report after it stops hosting a shared source. */
  removeMember(sourceId: SourceId, deviceId: DeviceId): void {
    this.statuses.delete(SyncStatusRegistry.key(sourceId, deviceId));
  }

  /**
   * The source's status across its members: a member mid-sync represents
   * the source while any is syncing, the most recent report otherwise. A
   * single-member source reads exactly what that member reported.
   */
  get(sourceId: SourceId): SourceSyncStatus | undefined {
    const entries = this.entriesFor(sourceId);
    if (entries.length <= 1) return entries[0];
    const latest = (list: SourceSyncStatus[]) =>
      list.reduce((best, s) => (s.lastUpdated > best.lastUpdated ? s : best));
    const syncing = entries.filter((s) => s.state === "syncing");
    return latest(syncing.length > 0 ? syncing : entries);
  }

  /** Each member's own report for a source. */
  listMembers(sourceId: SourceId): SourceSyncStatus[] {
    return this.entriesFor(sourceId);
  }

  list(): SourceSyncStatus[] {
    const seen = new Set<string>();
    const out: SourceSyncStatus[] = [];
    for (const entry of this.statuses.values()) {
      if (seen.has(entry.sourceId)) continue;
      seen.add(entry.sourceId);
      const aggregate = this.get(SourceId(entry.sourceId));
      if (aggregate) out.push(aggregate);
    }
    return out;
  }

  clear(): void {
    this.statuses.clear();
  }
}

/**
 * Derive the canonical display state for a single source by merging the
 * three independent inputs: live in-memory event (if any), persisted
 * `sync_state` row (if any), and the registered source's `enabled` flag
 * (if any).
 *
 * Precedence:
 *   1. `enabled === false`         → "paused"
 *   2. live state === "syncing"    → "syncing" (always wins; can't be persisted)
 *   3. live state === "needs-auth" → "needs-auth"
 *   4. live state === "rate-limited" → "rate-limited" (deferred, self-healing)
 *   5. live state === "error" OR persisted error newer than persisted sync
 *                                  → "error" / "needs-auth" / "rate-limited"
 *                                    (the persisted-error prefix disambiguates)
 *   6. persisted last_synced_at exists → "synced"
 *   7. otherwise                   → "idle"
 *
 * `lastSyncAt` is always the persisted timestamp — never the in-memory
 * `lastUpdated`, which ticks on progress events and would mislead the user.
 */
/**
 * The collector tags credential failures with this prefix on the error
 * message it ships to the gateway (`setSyncError`). Recognising it here
 * means a needs-auth state survives gateway restarts — when in-memory
 * state is gone, deriveDisplayStatus reads the persisted error and
 * still maps it to needs-auth instead of a generic red error pill.
 */
export const NEEDS_AUTH_ERROR_PREFIX = "needs reauth: ";

export function isAuthFailureMessage(message: string | undefined): boolean {
  if (!message) return false;
  return message.startsWith(NEEDS_AUTH_ERROR_PREFIX);
}

/**
 * The collector tags rate-limit deferrals with this prefix on the error
 * message it ships to the gateway. Recognising it here means a rate-limited
 * state survives gateway restarts — when in-memory state is gone,
 * deriveDisplayStatus reads the persisted error and maps it back to
 * `rate-limited` (a self-healing deferral) instead of a generic red error
 * pill. Keep in sync with the collector's `RATE_LIMITED_ERROR_PREFIX`.
 */
export const RATE_LIMITED_ERROR_PREFIX = "rate-limited: ";

export function isRateLimitedMessage(message: string | undefined): boolean {
  if (!message) return false;
  return message.startsWith(RATE_LIMITED_ERROR_PREFIX);
}

/**
 * Lead window before a consent deadline in which a healthy source flips to the
 * forward-looking `auth-expiring` warning. 14 days gives the operator
 * comfortable time to re-consent through the Link widget before the connection
 * actually lapses into the terminal `needs-auth` state. Generic across every
 * open-banking aggregator — the deadline itself is source-reported; only the
 * lead time is a gateway policy.
 */
export const CONSENT_EXPIRY_LEAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How old the collector's last report may be before its feed-process reading is
 * treated as unusable. Generous relative to any sane sync cadence, so an idle
 * source on a slow interval is not disqualified; short enough that a collector
 * which has been gone for hours can no longer drive a warning about a program on
 * a host we are no longer in contact with.
 */
export const FRESHNESS_READING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a stored consent deadline (ISO 8601) has entered the lead window —
 * i.e. `now >= deadline - leadWindow`. A deadline already in the past also
 * qualifies (the warning persists right up to the eventual `needs-auth`).
 * Returns false for an absent or unparseable deadline. `now` is injectable for
 * deterministic tests.
 */
export function isWithinConsentLeadWindow(
  consentExpiresAt: string | null | undefined,
  now: number = Date.now(),
  leadWindowMs: number = CONSENT_EXPIRY_LEAD_WINDOW_MS,
): boolean {
  if (!consentExpiresAt) return false;
  const deadline = Date.parse(consentExpiresAt);
  if (Number.isNaN(deadline)) return false;
  return now >= deadline - leadWindowMs;
}

/**
 * Whether a source's local data feed looks stalled rather than merely quiet.
 *
 * Several conditions must hold together, and the conjunction is the whole design.
 * Each signal alone is a false-positive machine: a task manager going quiet for
 * a fortnight is ordinary, and quitting an app for an afternoon is ordinary.
 * Only "nothing new for longer than this source considers plausible, AND the
 * program that feeds it is not running" identifies the case where the operator
 * has data stranded on another device and a few seconds of work to free it.
 *
 * Three deliberate silences, all erring toward saying nothing:
 *
 * - `processRunning === undefined` never warns. The collector reports it when
 *   it could not determine the answer (unsupported platform, probe failure),
 *   and a warning manufactured from our own blind spot is worse than none.
 * - `lastDocumentAt === null` never warns. That is equally what a brand-new
 *   source looks like before its first sync lands, and accusing a source of
 *   being stale seconds after it was added would be nonsense.
 * - A reading older than `FRESHNESS_READING_MAX_AGE_MS` never warns, because a
 *   collector we have not heard from in hours is describing a host we are no
 *   longer in contact with (see the inline note on `readingAt`).
 */
export function isSourceFeedStale(
  freshness: SourceSyncStatus["freshness"],
  lastDocumentAt: string | null | undefined,
  now: number = Date.now(),
  /**
   * When the collector last reported on this source. A reading older than
   * `FRESHNESS_READING_MAX_AGE_MS` is not trusted — see below.
   */
  readingAt?: number,
): boolean {
  if (!freshness) return false;
  if (freshness.processRunning !== false) return false;
  // A reading is a claim about what was true on the collector's host at the
  // moment it was taken. If the collector itself has gone away — the likely
  // failure in a two-machine install — the last "not running" reading sits in
  // memory unchanged while `last_document_at` keeps aging, and the source would
  // eventually accuse the operator of having quit an app when the real problem
  // is that nothing is syncing at all. Distrusting an old reading means that
  // case stays silent here and surfaces as what it is.
  if (readingAt !== undefined && now - readingAt > FRESHNESS_READING_MAX_AGE_MS) return false;
  if (!lastDocumentAt) return false;
  const last = Date.parse(lastDocumentAt);
  if (Number.isNaN(last)) return false;
  return now - last > freshness.quietPeriodMs;
}

export function deriveDisplayStatus(
  sourceId: SourceId,
  inMem: SourceSyncStatus | undefined,
  persisted: StoredSyncState | undefined,
  registered: { enabled: boolean } | undefined,
  /** Injectable clock for deterministic consent-expiry derivation in tests. */
  now: number = Date.now(),
  permissionHealth?: MobilePermissionHealth,
): DisplaySyncStatus {
  const lastSyncAt = persisted?.last_synced_at ?? null;
  const persistedErroredAt = persisted?.errored_at ?? null;
  const persistedError = persisted?.last_error ?? null;
  const consentExpiresAt = persisted?.consent_expires_at ?? undefined;

  let state: DisplaySyncState;
  let errorMessage: string | undefined;
  let erroredAt: string | undefined;
  let remediation: SyncRemediation | undefined;

  if (registered?.enabled === false) {
    state = "paused";
  } else if (inMem?.state === "syncing") {
    state = "syncing";
  } else if (inMem?.state === "needs-auth") {
    state = "needs-auth";
    errorMessage = inMem.errorMessage;
    erroredAt =
      persistedErroredAt ??
      (inMem.lastUpdated ? new Date(inMem.lastUpdated).toISOString() : undefined);
  } else if (inMem?.state === "rate-limited") {
    // Deferred, self-healing — render the back-off note, not a red error.
    state = "rate-limited";
    errorMessage = inMem.errorMessage;
    erroredAt =
      persistedErroredAt ??
      (inMem.lastUpdated ? new Date(inMem.lastUpdated).toISOString() : undefined);
  } else if (inMem?.state === "error") {
    state = "error";
    errorMessage = inMem.errorMessage;
    remediation = inMem.remediation;
    // Prefer the persisted timestamp when present (matches what's on disk);
    // fall back to the in-memory event time.
    erroredAt =
      persistedErroredAt ??
      (inMem.lastUpdated ? new Date(inMem.lastUpdated).toISOString() : undefined);
  } else if (persistedError && persistedErroredAt) {
    // No fresh in-memory state (e.g. after gateway restart) — fall back to
    // the persisted error if it's the most recent thing on disk. Distinguish
    // credential-failure and rate-limit-deferral messages from generic errors
    // so UIs render the needs-auth / rate-limited pill (with its hint) instead
    // of a generic red.
    state = isAuthFailureMessage(persistedError)
      ? "needs-auth"
      : isRateLimitedMessage(persistedError)
        ? "rate-limited"
        : "error";
    errorMessage = persistedError;
    erroredAt = persistedErroredAt;
    if (state === "error" && persisted?.last_error_remediation) {
      remediation =
        syncErrorRemediationCodec.parseWithFallback(persisted.last_error_remediation, {
          rowId: `${sourceId}/${persisted.device_id}`,
        }) ?? undefined;
    }
  } else if (lastSyncAt) {
    state = "synced";
  } else {
    state = "idle";
  }

  // Forward-looking consent-expiry. Layered AFTER the reactive chain so it
  // only ever upgrades an otherwise-healthy source (`synced` / `idle`) — it never
  // masks `syncing`, `paused`, the terminal `needs-auth`/`error`, or a
  // self-healing `rate-limited`. A purely derived, non-persisted display state:
  // when the stored deadline enters the lead window the source still syncs fine,
  // but the operator should reconnect before it lapses into a real `needs-auth`.
  if (
    (state === "synced" || state === "idle") &&
    isWithinConsentLeadWindow(consentExpiresAt, now)
  ) {
    state = "auth-expiring";
  }

  if (
    (state === "synced" || state === "idle") &&
    permissionHealth &&
    !permissionHealth.reportStale &&
    isActionableMobilePermissionState(permissionHealth.state)
  ) {
    state = permissionHealth.state;
  }

  // Stalled local feed. Layered on the same terms as `auth-expiring`: it only
  // ever upgrades an otherwise-healthy source, so it can never mask a real
  // failure, a sync in flight, or a source the operator deliberately paused.
  // Checked after `auth-expiring` and deliberately not allowed to override it —
  // a lapsing credential is the more urgent of the two, and a source can't
  // meaningfully be told to fix both at once.
  let staleHint: string | undefined;
  if (
    (state === "synced" || state === "idle") &&
    isSourceFeedStale(inMem?.freshness, persisted?.last_document_at, now, inMem?.lastUpdated)
  ) {
    state = "stale";
    staleHint = inMem?.freshness?.hint;
  }

  return {
    sourceId,
    // A persisted row names the device it was stamped for, so an error that
    // outlives the collector's report — across a gateway restart — stays
    // attributed to the member that hit it rather than to nobody. The shared
    // row (`""`) names no device; a row whose id does not parse names none.
    deviceId: inMem?.deviceId ?? tryDeviceId(persisted?.device_id ?? "") ?? undefined,
    providerId: inMem?.providerId,
    state,
    unitName: inMem?.unitName,
    progress: inMem?.progress,
    coverage: inMem?.coverage ?? inMem?.progress?.coverage,
    coverageDetail: inMem?.coverageDetail ?? inMem?.progress?.detail,
    startedAt: inMem?.startedAt,
    lastSyncAt,
    // Surface the deadline whenever one is stored — independent of `state`, so a
    // healthy `synced` source can show "expires on <date>" before it warns.
    consentExpiresAt,
    staleHint,
    errorMessage,
    erroredAt,
    remediation,
    lastUpdated: inMem?.lastUpdated,
    permissionHealth,
  };
}
