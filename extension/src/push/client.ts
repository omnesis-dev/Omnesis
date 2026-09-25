// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PersistentQueue, type QueueCorruption, type QueueOverflow } from "./queue.js";
import {
  PushObservability,
  clearPushDataLoss,
  clearPushHealth,
  clearPushObservability,
  clearPushServerState,
  type Connectivity,
  type PushFailure,
  type PushHealth,
  type PushRetry,
  type PushServerState,
  type RecentDelivery,
} from "./observability.js";
import {
  DEFAULT_BACKOFF,
  type BackoffConfig,
  type DrainResult,
  type DurableStore,
  type FetchLike,
  type FetchLikeResponse,
  type PageVisit,
  type QueueItem,
} from "./types.js";
import { networkReason, parseEmptyDocumentProbe } from "./delivery-response.js";
import { boundedGatewayReason } from "./response-body.js";
import { PushTransport } from "./transport.js";
import type { DocumentInput } from "@omnesis/types";

export interface PushClientConfig {
  /** Gateway base URL, e.g. `https://gateway.example.ts.net:7600`. No trailing slash. */
  gatewayUrl: string;
  /** `write:web` bearer token minted by the pairing handshake. */
  token: string;
  /** HTTP transport (Node `fetch` in tests, the SW global `fetch` in the extension). */
  fetch: FetchLike;
  /** Durable store backing the persistent queue. */
  store: DurableStore;
  /** Optional backoff overrides; merged over {@link DEFAULT_BACKOFF}. */
  backoff?: Partial<BackoffConfig>;
  /** Injectable clock (epoch-ms) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Maximum delivery attempts per drain pass. Each item is one idempotent HTTP
   * request; bounding the pass limits how long network work can delay a new
   * service-worker event.
   */
  batchSize?: number;
  /** Maximum time one gateway request may occupy the MV3 worker. */
  requestTimeoutMs?: number;
  /** ID of the current MV3 worker session; generations are comparable only within it. */
  observationSessionId?: string;
  /** Monotonic operation generation within one MV3 worker session. */
  observationGeneration?: number;
}

/**
 * How long a rejected item waits before being re-attempted as a probe. The
 * gateway rejects pushes for a removed/paused source with HTTP 200 + a
 * `rejected` body rather than an error, so there's no retry storm — but we keep
 * the rejected item in the queue and re-attempt it on this cadence so that a
 * later re-enable (re-pair / portal resume) is detected automatically and the
 * source resumes flowing without the user touching the extension.
 */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The verdict of a proactive {@link PushClient.probeAuth} — a liveness + auth
 * check that runs independently of whether anything is queued, so an idle
 * extension still detects a revoked credential.
 */
export interface AuthProbeResult {
  /** The gateway answered at all (any HTTP status) — proves it's reachable. */
  reachable: boolean;
  /**
   * The token verdict: `ok` (2xx — authenticates and may write), `failed`
   * (401/403 — revoked/deleted/unscoped, the operator must re-pair), or
   * `unknown` (transport failure or an inconclusive status like 429/5xx, which
   * says nothing about the token).
   */
  auth: "ok" | "failed" | "unknown";
  /** Human-readable detail when `auth` is `failed`, or the transport error. */
  reason?: string;
}

/**
 * Environment-agnostic HTTP push client for the browser-capture source.
 *
 * Responsibilities:
 *   - `enqueueDocument` / `enqueueVisit` append to the persistent queue and
 *     return immediately (capture is never blocked on the network);
 *   - `drain` delivers eligible queued items to the real gateway endpoints
 *     (`POST /documents`, `POST /analytics/ingest`) with a `write:web`
 *     bearer token, honouring `429`/`Retry-After` and `503` with exponential
 *     backoff, and loses nothing across a restart (state lives in the queue's
 *     durable store).
 *
 * It holds no in-memory authoritative state of its own — the queue is the
 * single source of truth — so re-instantiating the client in a new
 * service-worker generation against the same store resumes exactly where the
 * previous generation left off.
 */
export class PushClient {
  private readonly queue: PersistentQueue;
  private readonly backoff: BackoffConfig;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly observability: PushObservability;
  private readonly transport: PushTransport;

  constructor(config: PushClientConfig) {
    this.queue = new PersistentQueue(config.store);
    this.backoff = { ...DEFAULT_BACKOFF, ...config.backoff };
    this.now = config.now ?? Date.now;
    this.batchSize = config.batchSize ?? 5;
    this.transport = new PushTransport(
      config.gatewayUrl,
      config.token,
      config.fetch,
      config.requestTimeoutMs ?? 4_000,
    );
    this.observability = new PushObservability(
      config.store,
      config.observationSessionId,
      config.observationGeneration,
    );
  }

  /** Current queue depth — surfaced in the popup. */
  queueDepth(): Promise<number> {
    return this.queue.size();
  }

  /** Make retained captures immediately eligible after a successful re-pair. */
  async resetBackoff(): Promise<void> {
    await this.queue.load();
    const items = await this.queue.list();
    await this.queue.replaceAll(items.map((item) => ({ ...item, attempts: 0, notBefore: 0 })));
  }

  /**
   * Enqueue a content-plane document (`web-page`). The doc's `externalId` is
   * derived from the normalized URL, so re-pushing the same page upserts gateway-side. A
   * newer queued snapshot replaces an older snapshot for that external ID;
   * only the latest body/title needs to survive an outage.
   */
  async enqueueDocument(doc: DocumentInput): Promise<void> {
    const id = `doc:${doc.externalId}:${doc.contentHash}:${doc.title}`;
    const item: QueueItem = {
      kind: "document",
      id,
      doc,
      attempts: 0,
      notBefore: 0,
      enqueuedAt: this.now(),
    };
    await this.queue.enqueueReplacing(
      item,
      (queued) => queued.kind === "document" && queued.doc.externalId === doc.externalId,
    );
  }

  /**
   * Enqueue an analytics-plane `page_visits` row. Each dwell-confirmed visit
   * is a distinct event (PK `(url, visited_at)`), so the in-queue `id` keys on
   * both — two visits to the same URL produce two rows.
   */
  async enqueueVisit(visit: PageVisit): Promise<void> {
    const id = `visit:${visit.url}:${visit.visited_at}`;
    const item: QueueItem = {
      kind: "visit",
      id,
      visit,
      attempts: 0,
      notBefore: 0,
      enqueuedAt: this.now(),
    };
    await this.queue.enqueue(item);
  }

  /**
   * Deliver every currently-eligible queued item, oldest first. Items whose
   * `notBefore` is in the future are skipped (still backing off). Returns a
   * summary plus the soonest-eligible timestamp so the caller can schedule the
   * next wake-up via `chrome.alarms`.
   *
   * Progress is committed after each request, so an interrupted drain resumes
   * from the first unaccounted item on the next wake. The gateway endpoints are
   * idempotent, which also makes a crash between acceptance and the local
   * commit safe to replay.
   */
  async drain(): Promise<DrainResult> {
    await this.queue.load();
    const all = await this.queue.list();
    const now = this.now();

    // Keep ready items beyond this pass's batch in the durable queue. They are
    // still eligible, so the caller immediately schedules another drain rather
    // than treating the batch cap as a reason to discard them.
    const ready = all.filter((i) => i.notBefore <= now);
    const eligible = ready.slice(0, this.batchSize);
    const unprocessed = ready.slice(this.batchSize);
    const deferred = all.filter((i) => i.notBefore > now);

    let delivered = 0;
    let dropped = 0;
    let suppressed = 0;
    const retained: QueueItem[] = [];
    // Track the corpus-affecting signal: did any document deliver (clears a
    // prior auth alarm), and did any push get rejected for auth/scope (surfaced
    // to the popup as a re-pair warning)?
    let docDelivered = false;
    let authReject: string | null = null;
    const permanentFailures: Array<Omit<PushFailure, "count">> = [];
    let retryFailure: PushRetry | null = null;
    const attemptedNonRetryIds = new Set<string>();
    // The gateway's source-state if any push this pass was rejected (the
    // source was removed/paused in Omnesis); cleared by a clean delivery.
    let serverReject: PushServerState["state"] | null = null;
    let serverRejectReason = "";
    // Recent-deliveries (proof-of-life) collected this pass, and whether any
    // attempt failed to even reach the gateway (drives the connectivity snapshot).
    const recentBatch: RecentDelivery[] = [];
    let networkFailed = false;
    let gatewayResponded = false;
    let networkReasonStr: string | undefined;

    for (let index = 0; index < eligible.length; index += 1) {
      const item = eligible[index];
      const outcome = await this.transport.deliver(item);
      if (outcome.kind !== "retry") attemptedNonRetryIds.add(item.id);
      if (outcome.kind !== "retry" || !outcome.network) gatewayResponded = true;
      let stopNotBefore: number | null = null;
      if (outcome.kind === "ok") {
        delivered += 1;
        if (item.kind === "document") {
          docDelivered = true;
          // This log backs “Last page synced”; analytics visits must never
          // evict its document proof-of-life window.
          recentBatch.push(recentFromItem(item, now));
        }
      } else if (outcome.kind === "suppressed") {
        // The user deleted this page for good; the gateway will never store it
        // again. It leaves the queue silently — not a sync, not a failure.
        suppressed += 1;
      } else if (outcome.kind === "rejected") {
        // The source is removed/paused. There's nothing to retry against right
        // now, but keep the item as a probe so a later re-enable resumes flow
        // automatically. Don't bump `attempts` — a source can stay removed
        // indefinitely and must never be poison-dropped for it.
        serverReject = outcome.state;
        serverRejectReason = outcome.reason;
        retained.push({ ...item, notBefore: now + PROBE_INTERVAL_MS });
        stopNotBefore = now + PROBE_INTERVAL_MS;
      } else if (outcome.kind === "drop") {
        if (outcome.status === 401 || outcome.status === 403) {
          // Credentials and scopes can recover after re-pairing or server-side
          // reconciliation. Keep the capture so recovery does not lose the page.
          authReject = outcome.reason;
          retained.push({ ...item, notBefore: now + PROBE_INTERVAL_MS });
          stopNotBefore = now + PROBE_INTERVAL_MS;
        } else {
          dropped += 1;
          permanentFailures.push({
            reason: outcome.reason,
            status: outcome.status,
            kind: item.kind,
            at: now,
          });
        }
      } else {
        // outcome.kind === "retry" — a transient failure. Distinguish an
        // unreachable gateway (network) from a response the gateway returned.
        if (outcome.network) {
          networkFailed = true;
          if (networkReasonStr === undefined) networkReasonStr = outcome.reason;
        }
        const attempts = item.attempts + 1;
        // A long outage is not poison data. Cap the backoff exponent, but retain
        // the capture indefinitely until the gateway recovers.
        const boundedAttempts = Math.min(attempts, this.backoff.maxAttempts);
        const nextRetryAt = now + this.computeDelay(boundedAttempts, outcome.retryAfterMs);
        retained.push({
          ...item,
          attempts: boundedAttempts,
          notBefore: nextRetryAt,
        });
        retryFailure = {
          itemId: item.id,
          kind: item.kind,
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          reason: outcome.reason ?? (outcome.status ? `HTTP ${outcome.status}` : "delivery failed"),
          attempts: boundedAttempts,
          nextRetryAt,
          at: now,
        };
        // Gateway-wide transient failures should probe one item, not walk the
        // entire ready backlog during the same outage.
        stopNotBefore = nextRetryAt;
      }

      const untouched = eligible.slice(index + 1);
      if (stopNotBefore !== null) {
        retained.push(...untouched.map((queued) => ({ ...queued, notBefore: stopNotBefore })));
      }
      // Commit progress after every request. If Chrome evicts the worker, the
      // next wake resumes from the first item not durably accounted for.
      await this.queue.replaceAll([
        ...retained,
        ...(stopNotBefore !== null ? [] : untouched),
        ...(stopNotBefore !== null
          ? unprocessed.map((queued) => ({ ...queued, notBefore: stopNotBefore }))
          : unprocessed),
        ...deferred,
      ]);
      if (stopNotBefore !== null) break;
    }

    const remaining = await this.queue.list();

    // Surface (or clear) the silent auth/scope failure. A fresh 401/403 wins;
    // otherwise a successful document delivery clears any stale alarm. A pass
    // that delivered only visits leaves the snapshot untouched.
    if (authReject !== null) {
      await this.observability.writeHealth({ ok: false, reason: authReject, at: now });
    } else if (docDelivered) {
      await this.observability.writeHealth({ ok: true, at: now });
    }

    for (const failure of permanentFailures) await this.observability.writeFailure(failure);
    if (serverReject !== null) {
      await this.observability.clearRetry();
    } else if (retryFailure) {
      await this.observability.writeRetry(retryFailure);
    } else {
      const previousRetry = await this.getRetry();
      if (
        previousRetry &&
        (!remaining.some((item) => item.id === previousRetry.itemId) ||
          attemptedNonRetryIds.has(previousRetry.itemId))
      ) {
        await this.observability.clearRetry();
      }
    }

    // Surface (or clear) the source's removed/paused state. A fresh rejection
    // wins; otherwise any clean delivery this pass means the source is active
    // again (re-pair / portal resume took effect), so clear it.
    if (serverReject !== null) {
      await this.observability.writeServerState({
        state: serverReject,
        reason: serverRejectReason,
        at: now,
      });
    } else if (delivered > 0) {
      await this.clearServerState();
    }

    // Recent-deliveries log: prepend this pass's deliveries (newest first),
    // capped to a recent window. Only the title + URL are retained — never body.
    // The observability layer serializes its read-modify-write across clients.
    await this.observability.prependRecent(recentBatch.reverse());

    // Connectivity snapshot: any delivery proves the gateway reachable; a pass
    // that delivered nothing and failed every connection (with work queued)
    // proves it unreachable. A mixed pass (some delivered) never flips to
    // offline, so a single blip among successes doesn't flap the UI.
    // `networkFailed` is only ever set inside the eligible-items loop, so a pass
    // with nothing eligible (everything still backed off) leaves the snapshot
    // untouched rather than reporting a false "offline".
    if (delivered > 0 || gatewayResponded) {
      await this.observability.writeConnectivity({ reachable: true, at: now });
    } else if (networkFailed && eligible.length > 0) {
      await this.observability.writeConnectivity({
        reachable: false,
        reason: networkReasonStr,
        at: now,
      });
    }

    return {
      delivered,
      retained: remaining.length,
      dropped,
      suppressed,
      nextEligibleAt: remaining.length ? Math.min(...remaining.map((i) => i.notBefore)) : null,
    };
  }

  /** Backoff interval for a given attempt count, honouring an explicit Retry-After. */
  private computeDelay(attempts: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs >= 0) {
      return Math.min(Math.max(retryAfterMs, this.backoff.baseMs), this.backoff.maxMs);
    }
    const exp = this.backoff.baseMs * Math.pow(this.backoff.factor, attempts - 1);
    return Math.min(exp, this.backoff.maxMs);
  }

  getHealth(): Promise<PushHealth | null> {
    return this.observability.getHealth();
  }

  getFailure(): Promise<PushFailure | null> {
    return this.observability.getFailure();
  }

  getRetry(): Promise<PushRetry | null> {
    return this.observability.getRetry();
  }

  getQueueCorruption(): Promise<QueueCorruption | null> {
    return this.observability.getQueueCorruption();
  }

  getQueueOverflow(): Promise<QueueOverflow | null> {
    return this.observability.getQueueOverflow();
  }

  getServerState(): Promise<PushServerState | null> {
    return this.observability.getServerState();
  }

  clearServerState(): Promise<void> {
    return this.observability.clearServerState();
  }

  getRecentDeliveries(): Promise<RecentDelivery[]> {
    return this.observability.getRecentDeliveries();
  }

  getConnectivity(): Promise<Connectivity | null> {
    return this.observability.getConnectivity();
  }

  getLastCheckedAt(): Promise<number | null> {
    return this.observability.getLastCheckedAt();
  }

  /**
   * Proactively verify the token + gateway, independently of the queue.
   *
   * Posts an **empty** document batch (`{ documents: [] }`) with the stored
   * bearer token. That request writes nothing but traverses the exact auth path
   * a real push does, so its status is an authoritative liveness verdict:
   *   - `2xx` — the gateway authenticated this empty request and stamps the
   *     liveness beacon. It does not clear a page-upload error: an empty batch
   *     does not prove that a real source-scoped document can be written.
   *   - `401/403` — the token is revoked/deleted/unscoped (e.g. the device was
   *     removed in the portal). Written to the SAME push-health snapshot a
   *     rejected-document drain uses, so the toolbar badge turns red and the
   *     popup shows the "re-pair this browser" warning — the one action the user
   *     must take — even with an empty queue.
   *   - transport failure — a connectivity fact, not an auth verdict: records
   *     the gateway offline and leaves the auth-health snapshot untouched (a
   *     transient outage must never masquerade as a revoked token).
   *
   * The scope specificity of `write:web` is covered separately (pair-time
   * validation + the popup's `scopeOk` check), so an empty batch — which skips
   * the per-source scope enforcement — is the right shape here: it isolates the
   * one thing the passive model missed, token *validity*, from scope.
   *
   * Deliberately does NOT touch the removed/paused server-state snapshot: an
   * empty batch carries no source to be rejected, so it can neither set nor
   * clear that condition (only a real delivery can).
   */
  async probeAuth(): Promise<AuthProbeResult> {
    const now = this.now();
    let res: FetchLikeResponse;
    try {
      res = await this.transport.probeEmptyDocuments();
    } catch (err) {
      const reason = networkReason(err);
      await this.observability.writeConnectivity({ reachable: false, reason, at: now });
      return { reachable: false, auth: "unknown", reason };
    }

    // The gateway answered, whatever the status — it's reachable, and this
    // counts as a completed liveness check (throttles the idle probe cadence).
    await this.observability.writeConnectivity({ reachable: true, at: now });

    if (res.status >= 200 && res.status < 300) {
      if (await parseEmptyDocumentProbe(res)) {
        await this.observability.writeChecked(now);
        return { reachable: true, auth: "ok" };
      }
      const reason = "Invalid gateway liveness response";
      await this.observability.writeConnectivity({
        reachable: true,
        degraded: true,
        reason,
        at: now,
      });
      return { reachable: true, auth: "unknown", reason };
    }

    if (res.status === 401 || res.status === 403) {
      let reason = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(await res.text()) as { error?: string };
        if (parsed?.error) reason = boundedGatewayReason(parsed.error);
      } catch {
        // non-JSON error body — keep the status-line reason.
      }
      await this.observability.writeHealth({ ok: false, reason, at: now });
      await this.observability.writeChecked(now);
      return { reachable: true, auth: "failed", reason };
    }

    // Any other status (429/5xx/…) is inconclusive about the token — the
    // gateway is up but busy/erroring. Leave the auth-health snapshot as-is.
    const reason = `HTTP ${res.status}`;
    await this.observability.writeConnectivity({
      reachable: true,
      degraded: true,
      reason,
      at: now,
    });
    return { reachable: true, auth: "unknown", reason };
  }

  /**
   * Run {@link probeAuth} only if the last check is older than `maxAgeMs`,
   * returning `null` when skipped. The service worker calls this on an idle
   * drain pass so a paired-but-quiet extension still re-validates its token on a
   * bounded cadence, without probing on every one-minute tick.
   */
  async probeAuthIfStale(maxAgeMs: number): Promise<AuthProbeResult | null> {
    const at = await this.getLastCheckedAt();
    if (at !== null && this.now() - at < maxAgeMs) return null;
    return this.probeAuth();
  }
}

/** Build a recent-deliveries entry from a delivered queue item (title + URL only). */
function recentFromItem(
  item: Extract<QueueItem, { kind: "document" }>,
  at: number,
): RecentDelivery {
  // The human-readable address lives in `metadata.sourceUrl`; `externalId` is
  // content-addressed and therefore only a fallback for display.
  const url = item.doc.metadata?.sourceUrl ?? item.doc.externalId;
  return { title: item.doc.title ?? "", url, kind: "document", at };
}

/** Remove captures belonging to an old/unpaired gateway identity. */
export async function clearPushQueue(store: DurableStore): Promise<void> {
  await new PersistentQueue(store).clear();
}

export { clearPushDataLoss, clearPushHealth, clearPushObservability, clearPushServerState };
export { parseRetryAfter } from "./transport.js";
export type { Connectivity, PushFailure, PushHealth, PushRetry, PushServerState, RecentDelivery };
