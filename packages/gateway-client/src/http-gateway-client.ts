// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createLogger, toErrorMessage } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import {
  DEFAULT_MAX_BACKPRESSURE_WAITS,
  DEFAULT_OCR_REQUEST_TIMEOUT_MS,
  DEFAULT_OCR_TIMEOUT_COOLDOWN_MS,
  DEFAULT_UPSERT_CHUNK,
  DEFAULT_UPSERT_CHUNK_BYTES,
} from "./tunables.js";
import type {
  AnalyticsPageIngest,
  AccountDescriptor,
  GatewayClient,
  SourceWatermark,
  SyncCursor,
  SyncState,
  SourceStats,
  SourceSyncMeta,
  IndexStats,
  ListDocumentsOptions,
  ListedDocument,
  GatewaySearchQuery,
  GatewaySearchResponse,
  AnalyticsTableSchema,
  AnalyticsCatalogEntry,
  DocumentEventProfile,
  DocumentTemporalProjectionSpec,
  ReconcileResponse,
  SnapshotAbsenceOutcome,
  SnapshotClaim,
  DocumentCountResponse,
  DocumentExistsResponse,
  DeleteAllResponse,
  DocumentIdsResponse,
  DbSizeResponse,
  IngestAnalyticsResponse,
  UpsertWithCursorResponse,
  PendingStructuredPage,
} from "@omnesis/source-sdk";
import type { DocumentInput, AccountId, SourceId, SourceType, ProviderId } from "@omnesis/types";
import type { OmnesisConfig } from "@omnesis/config";
import type { TranscriptionResult, OcrResult, EdgeDeclaration } from "@omnesis/core";

const log = createLogger("collector:http");

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_TIMER_MS = 2_147_483_647;

function validateTimerMs(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${MAX_TIMER_MS}`);
  }
  return value;
}

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * A response the gateway sent and we refused to accept — as opposed to a
 * request that never produced one. The two arrive at the same `catch`, and
 * only the transport failure may be named after the request that caused it;
 * this one's message is matched verbatim by callers (`Gateway error 404:`),
 * so it must survive unchanged.
 */
class GatewayResponseError extends Error {}

/**
 * Whether a thrown value is the transport giving out rather than the gateway
 * answering. Read against the whole cause chain: `fetch()` rejects with a bare
 * `TypeError: fetch failed` and names the socket, DNS or TLS failure only in
 * `cause`. `terminated` is a response body that stopped arriving mid-read.
 */
function isTransportFailure(message: string): boolean {
  return (
    message.includes("fetch") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("connect") ||
    message.includes("terminated") ||
    message.includes("other side closed")
  );
}

/**
 * Parse a `Retry-After` header (numeric seconds, as the gateway emits) into a
 * positive millisecond hint. Returns undefined for an absent, non-numeric, or
 * non-positive value.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * HTTP implementation of GatewayClient.
 * Sends documents and sync state to the gateway over REST.
 */
export class HttpGatewayClient implements GatewayClient {
  private readonly ocrRequestTimeoutMs: number;
  private readonly ocrTimeoutCooldownMs: number;
  private readonly sourceWriteEpoch = new AsyncLocalStorage<{
    sourceId: SourceId;
    writeEpoch: number;
  }>();
  private ocrCooldownUntil = 0;
  private readonly beforeRequest?: () => Promise<void>;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    opts?: {
      ocrRequestTimeoutMs?: number;
      ocrTimeoutCooldownMs?: number;
      /** Revalidate peer compatibility before each request, including retries. */
      beforeRequest?: () => Promise<void>;
    },
  ) {
    this.beforeRequest = opts?.beforeRequest;
    this.ocrRequestTimeoutMs = validateTimerMs(
      "ocrRequestTimeoutMs",
      opts?.ocrRequestTimeoutMs ?? DEFAULT_OCR_REQUEST_TIMEOUT_MS,
    );
    this.ocrTimeoutCooldownMs = validateTimerMs(
      "ocrTimeoutCooldownMs",
      opts?.ocrTimeoutCooldownMs ?? DEFAULT_OCR_TIMEOUT_COOLDOWN_MS,
    );
  }

  private async request(path: string, options: RequestInit = {}) {
    let lastError: Error | null = null;
    // Cap backpressure waits separately from retries — at 10 waits
    // of up to 30s each, total cap ≈ 5 min before we give up and
    // let the source-sync iteration error. Prevents an infinite
    // loop if the gateway is permanently overloaded.
    const MAX_BACKPRESSURE_WAITS = DEFAULT_MAX_BACKPRESSURE_WAITS;
    let backpressureWaits = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // A compatibility refusal must not be retried as though it were a
      // transport error, nor send the guarded request — so the guard runs
      // before the request and its refusal propagates verbatim. But the guard
      // makes its own HTTP call, and a dropped socket on *that* is the same
      // blip the request below rides out. Leaving it unhandled is how one
      // closed keep-alive connection ended a sync that had nothing wrong with
      // it, reported as a bare `fetch failed` that named neither the check nor
      // the host.
      try {
        await this.beforeRequest?.();
      } catch (err) {
        const guardMessage = toErrorMessage(err);
        if (attempt < MAX_RETRIES && isTransportFailure(guardMessage)) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          log.warn(
            `Network error on the gateway compatibility check before ${path}: ${guardMessage}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": "omnesis-collector",
            ...options.headers,
          },
        });

        if (!res.ok) {
          const body = await res.text();
          // Backpressure path (C8): gateway returns 503 + Retry-After
          // when its writer-worker queue is full. Honor the header
          // exactly and DON'T count this against the retry budget —
          // queue-full is transient and self-heals as the writer
          // drains; if we count it as a failure, the source-sync
          // gives up and the data sits unsynced for a full interval.
          if (res.status === 503 && backpressureWaits < MAX_BACKPRESSURE_WAITS) {
            backpressureWaits++;
            const retryAfterHeader = res.headers.get("Retry-After");
            const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
            const delay =
              Number.isFinite(retryAfterSec) && retryAfterSec > 0
                ? Math.min(retryAfterSec, 30) * 1000
                : 1000;
            log.info(
              `Gateway 503 backpressure on ${path}, waiting ${delay}ms (Retry-After=${retryAfterHeader ?? "n/a"}, ${backpressureWaits}/${MAX_BACKPRESSURE_WAITS})`,
            );
            await new Promise((r) => setTimeout(r, delay));
            // Don't burn a retry-budget slot on backpressure —
            // it's a transient signal, not a failure. The for
            // loop's increment fires on `continue`, so decrement
            // first to keep `attempt` flat.
            attempt--;
            continue;
          }
          if (attempt < MAX_RETRIES && isRetryable(res.status)) {
            const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
            log.warn(
              `Gateway returned ${res.status} for ${path}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new GatewayResponseError(`Gateway error ${res.status}: ${body}`);
        }

        return res.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof GatewayResponseError) throw lastError;

        // Network errors (fetch throws) are retryable. Read the whole cause
        // chain: `fetch()` rejects with a bare `TypeError: fetch failed` and
        // names the socket, DNS or TLS failure only in `cause`, so matching
        // the top message alone misses everything but the word "fetch".
        const transportMessage = toErrorMessage(lastError);

        if (attempt < MAX_RETRIES && isTransportFailure(transportMessage)) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          log.warn(
            `Network error for ${path}: ${transportMessage}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Name the request. A transport failure's own message is a category
        // ("fetch failed") and its stack holds only undici internals, so an
        // unnamed one reaches the operator as a source in `error` with no way
        // to tell which host stopped answering.
        throw new Error(`Gateway request ${options.method ?? "GET"} ${path} failed`, {
          cause: err,
        });
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  async upsertDocuments(documents: DocumentInput[]): Promise<void> {
    if (documents.length === 0) return;
    const context = this.sourceWriteEpoch.getStore();
    const writeEpochs = context
      ? Object.fromEntries(
          [...new Set(documents.map((document) => document.sourceId))]
            .filter((sourceId) => sourceId === context.sourceId)
            .map((sourceId) => [sourceId, context.writeEpoch]),
        )
      : undefined;
    // Chunk large batches into smaller per-request payloads. Some
    // sources (whatsapp per-day-per-chat, browser-history per-day)
    // submit 100-200 docs in one call —
    // and the gateway's writer worker holds the EXCLUSIVE COMMIT
    // lock for the full duration of one upsert (typically 7-12s
    // for a 200-doc batch on a real DB). With single-in-flight
    // dispatch in the writer-proxy, every other request — including
    // user-priority cli/portal writes — waits at least that long.
    //
    // Splitting into ~UPSERT_CHUNK chunks turns one 12s op into
    // four 3s ops. Same total throughput (gateway-side batched
    // SAVEPOINT amortises the fsync cost across the chunks),
    // but the priority queue gets four preemption points where
    // it can dispatch a higher-priority op. User-perceived
    // latency under collector ingest improves accordingly.
    //
    // Sequential chunking (not parallel) preserves the
    // collector's existing per-source serialisation semantics:
    // a single source-sync produces docs in deterministic order
    // and the gateway sees them in that order.
    //
    // Chunks are also bounded by serialized size: a handful of maximum-size
    // text exports (10 MiB each) in one 50-document chunk would exceed the
    // gateway's request-body ceiling and fail with a non-retryable 413, so a
    // chunk closes when adding the next document would carry it past
    // DEFAULT_UPSERT_CHUNK_BYTES. A document larger than that on its own is
    // still sent alone rather than refused here.
    for (const chunk of chunkDocuments(
      documents,
      DEFAULT_UPSERT_CHUNK,
      DEFAULT_UPSERT_CHUNK_BYTES,
    )) {
      await this.request("/documents", {
        method: "POST",
        body: JSON.stringify({ documents: chunk, writeEpochs }),
      });
    }
  }

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: { language?: string },
  ): Promise<TranscriptionResult | null> {
    // Permanent "no transcript" (a 4xx response, the backend reporting
    // `available: false`, or no speech detected) returns null — the source
    // renders a plain placeholder and the page advances as normal.
    //
    // A *transient* backend failure (5xx, or the gateway momentarily
    // unreachable) instead throws a `SyncError("transient")`. That propagates
    // up through the source's page `pMap`, fails the sync page, and leaves the
    // cursor un-advanced so the page retries next tick — a flaky transcriber
    // doesn't silently drop audio attachments from a durable index.
    //
    // Sends raw bytes (no base64 inflation) with the audio MIME type as
    // Content-Type; the gateway holds them only for the request.
    const qs = opts?.language ? `?language=${encodeURIComponent(opts.language)}` : "";
    const res = await this.inferenceFetch(
      "/inference/transcribe",
      qs,
      audio,
      mimeType,
      "transcribe",
    );
    if (res === null) return null;
    const data = (await res.json()) as {
      available?: boolean;
      text?: unknown;
      language?: unknown;
      durationSec?: unknown;
    };
    if (data.available === false || typeof data.text !== "string") return null;
    return {
      text: data.text,
      language: typeof data.language === "string" ? data.language : undefined,
      durationSec: typeof data.durationSec === "number" ? data.durationSec : undefined,
    };
  }

  async ocr(
    image: Uint8Array,
    mimeType: string,
    opts?: { language?: string; pages?: number[] },
  ): Promise<OcrResult | null> {
    const cooldownRemainingMs = this.ocrCooldownUntil - Date.now();
    if (cooldownRemainingMs > 0) {
      throw new SyncError("transient", "OCR requests paused after a request timeout", {
        retryAfterMs: cooldownRemainingMs,
      });
    }
    // OCR that cannot run (a 4xx response or the backend reporting
    // `available: false`) returns null. Successful OCR with no recognized text
    // returns a non-null result with an empty `text` value.
    //
    // A *transient* backend failure (5xx, or the gateway momentarily
    // unreachable) instead throws a `SyncError("transient")`. The collector's
    // optional OCR boundary converts that to a non-fatal unextracted result;
    // direct callers can still distinguish it from OCR that could not run.
    //
    // Sends raw bytes (no base64 inflation) with the attachment MIME type as
    // Content-Type. A per-request deadline prevents one pathological binary
    // from delaying every source page until an upstream proxy times out.
    const params = new URLSearchParams();
    if (opts?.language) params.set("language", opts.language);
    if (opts?.pages && opts.pages.length > 0) params.set("pages", opts.pages.join(","));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.ocrRequestTimeoutMs);
    timeout.unref();
    try {
      const res = await this.inferenceFetch(
        "/inference/ocr",
        qs,
        image,
        mimeType,
        "OCR",
        controller.signal,
      );
      if (res === null) return null;
      const data = (await res.json()) as {
        available?: boolean;
        text?: unknown;
        language?: unknown;
        pages?: unknown;
        pageTexts?: unknown;
      };
      if (data.available === false || typeof data.text !== "string") return null;
      return {
        text: data.text,
        language: typeof data.language === "string" ? data.language : undefined,
        pages: typeof data.pages === "number" ? data.pages : undefined,
        pageTexts: Array.isArray(data.pageTexts)
          ? data.pageTexts.map((t) => (typeof t === "string" ? t : ""))
          : undefined,
      };
    } catch (err) {
      if (timedOut) {
        this.ocrCooldownUntil = Math.max(
          this.ocrCooldownUntil,
          Date.now() + this.ocrTimeoutCooldownMs,
        );
        throw new SyncError(
          "transient",
          `OCR request timed out after ${this.ocrRequestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * POST raw binary bytes to an `/inference/*` endpoint, applying the shared
   * transport-level transient-vs-permanent policy for OCR/transcription:
   *
   * - 2xx → returns the `Response` so the caller can parse the JSON body.
   * - 4xx (e.g. 404 = backend not enabled, 415 = unsupported type) → returns
   *   `null`. The gateway permanently cannot process this input; successful
   *   extraction with no content is represented by a non-null empty result.
   * - 5xx, or `fetch` rejecting (gateway unreachable, connection reset,
   *   timeout) → throws `SyncError("transient")`; the caller decides whether
   *   its operation is durable/retryable or optional enrichment.
   *
   * Unlike `request()`, this does NOT retry in-band: OCR/transcription bodies
   * can be tens of MB. Re-posting megabytes three times per blip would only
   * amplify the load on a struggling gateway.
   */
  private async inferenceFetch(
    path: string,
    qs: string,
    body: Uint8Array,
    mimeType: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<Response | null> {
    let res: Response;
    try {
      await this.beforeRequest?.();
      res = await fetch(`${this.baseUrl}${path}${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": mimeType || "application/octet-stream",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "omnesis-collector",
        },
        body: body as unknown as BodyInit,
        signal,
      });
    } catch (err) {
      // Fetch rejection is transient; surface it so the caller applies its own
      // durability policy.
      const msg = err instanceof Error ? err.message : String(err);
      throw new SyncError("transient", `${label} backend unreachable: ${msg}`, { cause: err });
    }
    if (res.ok) return res;
    // 5xx, 429 (rate limited) and 408 (request timeout) are transient — the
    // backend is momentarily overloaded or stalled, not permanently unable to
    // extract this input. Surface them so the caller applies its durability
    // policy. Mirrors `isRetryable`.
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      const detail = await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      throw new SyncError(
        "transient",
        `${label} backend error ${res.status}${detail ? `: ${detail}` : ""}`,
        retryAfterMs !== undefined ? { retryAfterMs } : {},
      );
    }
    // Other 4xx — the gateway permanently won't extract this input (backend
    // disabled, unsupported type, bad request). Treat as genuinely-no-content.
    log.debug(`${label} request returned ${res.status} — treating as no content`);
    return null;
  }

  async deleteDocuments(
    providerId: ProviderId,
    sourceId: SourceId,
    externalIds: string[],
  ): Promise<void> {
    if (externalIds.length === 0) return;
    const context = this.sourceWriteEpoch.getStore();
    const writeEpoch = context?.sourceId === sourceId ? context.writeEpoch : undefined;
    await this.request("/documents/delete", {
      method: "POST",
      body: JSON.stringify({ providerId, sourceId, externalIds, writeEpoch }),
    });
  }

  async reconcileSnapshot(
    providerId: ProviderId,
    sourceId: SourceId,
    presentExternalIds: string[],
  ): Promise<number> {
    const data = await this.reconcileSnapshotResponse(providerId, sourceId, presentExternalIds);
    return data.deleted;
  }

  async reconcileSnapshotAbsence(
    providerId: ProviderId,
    sourceId: SourceId,
    presentExternalIds: string[],
  ): Promise<SnapshotAbsenceOutcome | undefined> {
    const data = await this.reconcileSnapshotResponse(providerId, sourceId, presentExternalIds);
    return data.absence;
  }

  private async reconcileSnapshotResponse(
    providerId: ProviderId,
    sourceId: SourceId,
    presentExternalIds: string[],
  ): Promise<ReconcileResponse> {
    const context = this.sourceWriteEpoch.getStore();
    const writeEpoch = context?.sourceId === sourceId ? context.writeEpoch : undefined;
    // Generated outside request(), whose transient retries reuse this exact
    // body. A committed response that is lost in transit must not count the
    // same completed snapshot as fresh absence evidence on the retry.
    const observationId = randomUUID();
    return (await this.request("/documents/reconcile", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        sourceId,
        presentExternalIds,
        writeEpoch,
        observationId,
      }),
    })) as ReconcileResponse;
  }

  async getDocumentCount(sourceId: SourceId): Promise<number> {
    const data = (await this.request(
      `/documents/count/${encodeURIComponent(sourceId)}`,
    )) as DocumentCountResponse;
    return data.count;
  }

  async getSourceStats(sourceId: SourceId): Promise<SourceStats> {
    return this.request(`/documents/stats/${encodeURIComponent(sourceId)}`);
  }

  async getWipeEpoch(sourceId: SourceId): Promise<number | undefined> {
    const data = await this.request(`/sync-state/${encodeURIComponent(sourceId)}`);
    return typeof data.wipeEpoch === "number" ? data.wipeEpoch : undefined;
  }

  async beginSyncAttempt(
    sourceId: SourceId,
    options: { signal?: AbortSignal; attemptId?: string } = {},
  ): Promise<number | undefined> {
    try {
      const data = await this.request(`/sync-state/${encodeURIComponent(sourceId)}/begin`, {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify({ attemptId: options.attemptId }),
      });
      return typeof data.wipeEpoch === "number" ? data.wipeEpoch : undefined;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Gateway error 404:")) {
        return undefined;
      }
      throw error;
    }
  }

  async revokeSyncAttempt(
    sourceId: SourceId,
    writeEpoch?: number,
    attemptId?: string,
  ): Promise<boolean> {
    const data = await this.request(`/sync-state/${encodeURIComponent(sourceId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ writeEpoch, attemptId }),
    });
    return data.revoked === true;
  }

  async claimSyncLease(
    sourceId: SourceId,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ granted: boolean; holder?: string; reason?: string; expiresAt?: number }> {
    try {
      const data = await this.request(`/sync-state/${encodeURIComponent(sourceId)}/lease`, {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify({}),
      });
      return {
        granted: data.granted === true,
        holder: typeof data.holder === "string" ? data.holder : undefined,
        reason: typeof data.reason === "string" ? data.reason : undefined,
        expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
      };
    } catch (error) {
      // A gateway without the lease route hosts one device per source.
      if (error instanceof Error && error.message.startsWith("Gateway error 404:")) {
        return { granted: true };
      }
      throw error;
    }
  }

  async releaseSyncLease(sourceId: SourceId): Promise<boolean> {
    try {
      const data = await this.request(`/sync-state/${encodeURIComponent(sourceId)}/lease`, {
        method: "DELETE",
      });
      return data.released === true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Gateway error 404:")) return false;
      throw error;
    }
  }

  runWithSourceWriteEpoch<T>(
    sourceId: SourceId,
    writeEpoch: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.sourceWriteEpoch.run({ sourceId, writeEpoch }, operation);
  }

  async getSyncState(sourceId: SourceId): Promise<SyncState | null> {
    const data = await this.request(`/sync-state/${encodeURIComponent(sourceId)}`);
    if (!data.cursor) return null;
    return {
      sourceId,
      cursor: data.cursor,
      lastSyncedAt: data.lastSyncedAt,
      hasMeta: data.hasMeta,
      wipeEpoch: data.wipeEpoch,
    };
  }

  async setSyncState(sourceId: SourceId, cursor: SyncCursor, meta?: SourceSyncMeta): Promise<void> {
    await this.request(`/sync-state/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      body: JSON.stringify({ cursor, ...meta }),
    });
  }

  async setSourceMeta(sourceId: SourceId, meta: SourceSyncMeta): Promise<void> {
    await this.request(`/sync-state/${encodeURIComponent(sourceId)}/meta`, {
      method: "POST",
      body: JSON.stringify(meta),
    });
  }

  async getPendingStructuredPage(sourceId: SourceId): Promise<PendingStructuredPage | null> {
    return this.request(`/sync-state/${encodeURIComponent(sourceId)}/pending-page`);
  }

  async prepareStructuredPage(
    sourceId: SourceId,
    page: Omit<PendingStructuredPage, "cursorCommitted"> & { writeEpoch: number },
  ): Promise<PendingStructuredPage> {
    return this.request(`/sync-state/${encodeURIComponent(sourceId)}/pending-page`, {
      method: "POST",
      body: JSON.stringify(page),
    });
  }

  async acknowledgeStructuredPage(
    sourceId: SourceId,
    page: { id: string; writeEpoch: number },
  ): Promise<{ acknowledged: boolean }> {
    return this.request(`/sync-state/${encodeURIComponent(sourceId)}/pending-page`, {
      method: "DELETE",
      body: JSON.stringify(page),
    });
  }

  /**
   * Push the full list of per-source URL canonicalizers to the gateway.
   * Sent at collector startup before the first sync runs; gateway holds
   * the registry in memory and applies it during ingest + URL lookup.
   * Replaces whatever was previously registered.
   */
  async setUrlCanonicalizers(
    canonicalizers: Array<{
      hosts: string[];
      rules: Array<{ match: string; replacement: string }>;
    }>,
  ): Promise<void> {
    await this.request("/admin/url-canonicalizers", {
      method: "POST",
      body: JSON.stringify({ canonicalizers }),
    });
  }

  /** Publish one coherent generation of every declaration that affects URL linking. */
  async setLinkDeclarations(input: {
    canonicalizers: Array<{
      hosts: string[];
      rules: Array<{ match: string; replacement: string }>;
    }>;
    traversalHubPrefixes: string[];
    fallbackRepresentationPrefixes: string[];
    referenceOnlyPrefixes: string[];
    patterns: Array<{ regex: string }>;
  }): Promise<void> {
    await this.request("/admin/link-declarations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Push the full list of per-source-type score priors to the gateway.
   * Sent at collector startup; the gateway merges these with the user's
   * `search.sourcePriors.weights` from `omnesis.json` (user keys win).
   * Replaces the collector-declared layer in full; built-in gateway defaults
   * are unaffected.
   */
  async setSourcePriorDefaults(
    entries: Array<{ sourceIdPrefix: string; weight: number }>,
  ): Promise<void> {
    await this.request("/admin/source-prior-defaults", {
      method: "POST",
      body: JSON.stringify({ entries }),
    });
  }

  /**
   * Push the complete descriptor-derived URL role sets. Sent at collector
   * startup; traversal hubs suppress noisy graph pivots, fallback
   * representations yield inbound URLs to owners while remaining connected,
   * and reference-only documents never claim inbound URLs. Replaces the
   * collector-declared layers atomically.
   */
  async setUrlGraphRoles(
    traversalHubPrefixes: string[],
    fallbackRepresentationPrefixes: string[],
    referenceOnlyPrefixes: string[],
  ): Promise<void> {
    await this.request("/admin/url-graph-roles", {
      method: "POST",
      body: JSON.stringify({
        traversalHubPrefixes,
        fallbackRepresentationPrefixes,
        referenceOnlyPrefixes,
      }),
    });
  }

  /** @deprecated Use setUrlGraphRoles. Retained for older collector clients. */
  async setUrlHubSources(prefixes: string[]): Promise<void> {
    await this.request("/admin/url-hub-sources", {
      method: "POST",
      body: JSON.stringify({ prefixes }),
    });
  }

  /**
   * Declare the self-identity hooks of the sources this collector hosts, from
   * `defineSource.selfIdentity`. Sent on collector startup and after every
   * source add. The gateway merges entries by source type across collectors,
   * so a push never erases a sibling's, and runs its self-detection pass to
   * resolve a source's self-authored PersonMentions to the self person
   * without branching on a source name.
   */
  async declareSelfIdentitySources(
    entries: Array<{ sourceType: string; aliasPrefix: string; accountPattern?: string }>,
  ): Promise<void> {
    await this.request("/admin/self-identity-sources", {
      method: "POST",
      body: JSON.stringify({ entries }),
    });
  }

  /**
   * Push the url-id patterns declared by every KNOWN source type (every
   * loaded source definition's `urlPatterns`), not just the added ones.
   * Sent at collector startup; the gateway holds the set in memory and
   * uses it as the link-extraction keep-gate so a link to a not-yet-added
   * source survives and resolves once that source is ingested.
   * Replaces whatever was previously registered.
   */
  async setKnownUrlPatterns(patterns: Array<{ regex: string }>): Promise<void> {
    await this.request("/admin/known-url-patterns", {
      method: "POST",
      body: JSON.stringify({ patterns }),
    });
  }

  /**
   * Push the union of every KNOWN source type's `ownedWebDomains` (every
   * loaded source definition's declared web hosts), not just the added ones.
   * Sent at collector startup; the gateway holds the set in memory and serves
   * it on the public `GET /owned-web-domains` route so the browser-capture
   * source can skip hosts already owned by another source. Replaces
   * whatever was previously registered.
   */
  async setOwnedWebDomains(domains: string[]): Promise<void> {
    await this.request("/admin/owned-web-domains", {
      method: "POST",
      body: JSON.stringify({ domains }),
    });
  }

  /**
   * Push the `documentEventProfile` of every KNOWN source type (every loaded
   * source definition's declaration), not just the added ones. Sent at
   * collector startup; the gateway persists the set so subscription
   * compilation can project each source's queryable document surface across a
   * restart the collector has not yet reconnected after. Replaces whatever was
   * previously stored.
   */
  async setDocumentEventProfiles(
    entries: Array<{ sourceType: string; profile: DocumentEventProfile }>,
  ): Promise<void> {
    await this.request("/admin/source-document-profiles", {
      method: "POST",
      body: JSON.stringify({ entries }),
    });
  }

  /**
   * Push the union of external widget-vendor origins declared by every KNOWN
   * `link-widget` source (every loaded descriptor's `widgetOrigins`), not just
   * the added ones. Sent at collector startup; the gateway holds the aggregate
   * in memory and folds it into the portal's Content-Security-Policy so a
   * source's hosted widget (Plaid Link, …) can load its vendor SDK + iframe in
   * the browser. Replaces whatever was previously registered.
   */
  async setWidgetOrigins(origins: {
    script: string[];
    frame: string[];
    connect: string[];
  }): Promise<void> {
    await this.request("/admin/widget-origins", {
      method: "POST",
      body: JSON.stringify(origins),
    });
  }

  async setWidgetRenderers(renderers: Array<{ kind: string; modulePath: string }>): Promise<void> {
    await this.request("/admin/widget-renderers", {
      method: "POST",
      body: JSON.stringify({ renderers }),
    });
  }

  /**
   * Re-derive `source_url` on every existing document row using the
   * currently-registered canonicalizers. Idempotent. The collector
   * calls this after registering canonicalizers so documents ingested
   * before the canonicalizers existed get re-canonicalized in place.
   */
  async recomputeSourceUrls(): Promise<void> {
    await this.request("/admin/url-canonicalizers/recompute-source-urls", {
      method: "POST",
      body: "{}",
    });
  }

  async upsertWithCursor(args: {
    pendingPageId?: string;
    providerId: ProviderId;
    sourceId: SourceId;
    documents?: DocumentInput[];
    documentTemporalProjections?: DocumentTemporalProjectionSpec[];
    deletedExternalIds?: string[];
    presentExternalIds?: string[];
    /** See `SyncResult.presentClaims`. Mutually exclusive with the above. */
    presentClaims?: SnapshotClaim[];
    observationId?: string;
    /** Source-declared structural edges for this page. */
    edges?: EdgeDeclaration[];
    hasMore: boolean;
    cursor: SyncCursor;
    /** Wipe epoch read at sync start; lets the gateway reject stale writes. */
    wipeEpoch?: number;
    /** Forward-looking consent deadline (ISO) the source reported this page. */
    consentExpiresAt?: string | null;
    watermark?: SourceWatermark;
    meta?: Omit<SourceSyncMeta, "contentRetention">;
  }): Promise<UpsertWithCursorResponse> {
    return (await this.request("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify(args),
    })) as UpsertWithCursorResponse;
  }

  async listDocuments(
    opts: ListDocumentsOptions,
  ): Promise<{ documents: ListedDocument[]; hasMore: boolean; nextCursor?: string }> {
    const params = new URLSearchParams();
    if (opts.updatedSince) params.set("updatedSince", opts.updatedSince);
    if (opts.excludeSourceIds && opts.excludeSourceIds.length > 0) {
      params.set("excludeSources", opts.excludeSourceIds.join(","));
    }
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    // Gateway expects `?cursor=` (the opaque
    // pageInfo.nextCursor from the previous page). Accept the legacy
    // `afterId` field as an alias for one cycle.
    const cursor = opts.cursor ?? opts.afterId;
    if (cursor) params.set("cursor", cursor);

    const qs = params.toString();
    // Gateway returns the canonical `Page<T>` envelope:
    //   { items: ListedDocument[], pageInfo: { hasMore, limit, nextCursor? } }
    // Re-shape into the `{ documents, hasMore, nextCursor }` tuple the
    // existing collector code expects so we don't have to rewrite every
    // call site (sole user, but iOS/CLI/portal already migrated; the
    // collector consumer surface is the last holdout).
    type PageEnvelope = {
      items: ListedDocument[];
      pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
    };
    const data: PageEnvelope = await this.request(`/documents/list${qs ? `?${qs}` : ""}`);
    return {
      documents: data.items ?? [],
      hasMore: data.pageInfo?.hasMore ?? false,
      nextCursor: data.pageInfo?.nextCursor,
    };
  }

  async checkExistingExternalIds(
    providerId: ProviderId,
    sourceId: SourceId,
    externalIds: string[],
  ): Promise<string[]> {
    if (externalIds.length === 0) return [];
    const data = (await this.request("/documents/exists", {
      method: "POST",
      body: JSON.stringify({ providerId, sourceId, externalIds }),
    })) as DocumentExistsResponse;
    return data.existingIds;
  }

  async deleteAllBySource(sourceId: SourceId): Promise<number> {
    const data = (await this.request(
      `/documents/delete-all/source/${encodeURIComponent(sourceId)}`,
      { method: "POST" },
    )) as DeleteAllResponse;
    return data.deleted;
  }

  async deleteAllByProvider(providerId: ProviderId): Promise<number> {
    const data = (await this.request(
      `/documents/delete-all/provider/${encodeURIComponent(providerId)}`,
      { method: "POST" },
    )) as DeleteAllResponse;
    return data.deleted;
  }

  async listDocumentIds(): Promise<string[]> {
    const data = (await this.request("/documents/ids")) as DocumentIdsResponse;
    return data.ids;
  }

  async getDbSize(): Promise<number | null> {
    const data = (await this.request("/db-size")) as DbSizeResponse;
    return data.sizeBytes;
  }

  async getIndexStats(): Promise<IndexStats | null> {
    try {
      const data = await this.request("/index/stats");
      if (!data.enabled) return null;
      return data as IndexStats;
    } catch {
      return null;
    }
  }

  async search(query: GatewaySearchQuery): Promise<GatewaySearchResponse> {
    return this.request("/search", {
      method: "POST",
      body: JSON.stringify(query),
    });
  }

  async ingestAnalyticsPage(page: AnalyticsPageIngest): Promise<IngestAnalyticsResponse> {
    // A page may upsert records, delete rows, or both — only skip the round
    // trip when there is nothing to do. A schema-only call (empty
    // records, no deletes, schema given) still goes through: it registers or
    // refreshes the table and its catalog row without inserting any rows.
    if (
      page.records.length === 0 &&
      (page.deletedKeys?.length ?? 0) === 0 &&
      (page.deletedIds?.length ?? 0) === 0 &&
      page.presentKeys === undefined &&
      page.presentIds === undefined &&
      !page.schema &&
      !page.pendingPageId
    ) {
      return { ingested: 0 };
    }
    const context = this.sourceWriteEpoch.getStore();
    const inheritedWriteEpoch =
      page.sourceId && context?.sourceId === page.sourceId ? context.writeEpoch : undefined;
    return (await this.request("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: page.tableName,
        pendingPageId: page.pendingPageId,
        writeOrdinal: page.writeOrdinal,
        records: page.records,
        schema: page.schema,
        sourceId: page.sourceId,
        deletedKeys: page.deletedKeys,
        presentKeys: page.presentKeys,
        deletedIds: page.deletedIds,
        deleteKeyColumn: page.deleteKeyColumn,
        presentIds: page.presentIds,
        writeEpoch: page.writeEpoch ?? inheritedWriteEpoch,
        observationId: page.observationId,
      }),
    })) as IngestAnalyticsResponse;
  }

  async getAnalyticsCatalog(): Promise<AnalyticsCatalogEntry[]> {
    const data = await this.request("/analytics/catalog");
    return data.tables ?? [];
  }

  async queryAnalytics(
    sql: string,
    limit?: number,
    sourceId?: string,
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const data = await this.request("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql, limit, sourceId }),
    });
    const columns: string[] = data.columns ?? [];
    const rawRows: unknown[][] = data.rows ?? [];
    // Gateway returns rows as arrays-of-cells; sources are far easier to
    // write against keyed records, so zip here once.
    const rows = rawRows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]!] = row[i];
      }
      return obj;
    });
    return { columns, rows };
  }

  async getConfig(): Promise<{ config: OmnesisConfig; version: number }> {
    return this.request("/config");
  }

  async getAdminConfig(): Promise<{ config: OmnesisConfig; version: number }> {
    return this.request("/admin/config");
  }

  async ping(): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/health`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Admin source registry mirror (migration bridge) ──────────────────────
  //
  // The collector still owns the canonical source list (collector.json) but
  // pushes its state to the gateway so the portal/admin API see a fully
  // registered source set instead of "discovered" ghosts.

  async bulkUpsertSources(
    // The canonical body shape is `BulkUpsertSourcesBody.sources` from
    // `packages/gateway/src/http/schemas/admin.ts`. Mirrored here so the
    // collector doesn't take a runtime dependency on the gateway package;
    // any drift surfaces as a 400 from the schema validator on the
    // gateway side. The branded ID fields are required so a misuse like
    // passing a raw `string` won't compile.
    sources: Array<{
      /** Optional explicit id (overrides type:accountId derivation). */
      id?: SourceId;
      type: SourceType;
      accountId: AccountId;
      /**
       * What the source declares about this account. Omitted when it declares
       * nothing, which is most of them.
       */
      account?: AccountDescriptor;
      config?: Record<string, unknown>;
      memberConfig?: Record<string, unknown>;
      enabled?: boolean;
    }>,
  ): Promise<{
    count: number;
    sources: Array<{ id: string; updated: boolean; memberConfigApplied?: boolean }>;
    /**
     * Per-entry rejections (e.g. the source is hosted by another device).
     * The HTTP call succeeds with partial results; callers registering
     * specific accounts must check their entries actually landed.
     */
    errors: Array<{ entry: unknown; error: string }>;
  }> {
    const path = sources.some((source) => source.memberConfig !== undefined)
      ? "/devices/sources/bulk-upsert-member-config"
      : "/devices/sources/bulk-upsert";
    return this.request(path, {
      method: "POST",
      body: JSON.stringify({ sources }),
    });
  }

  async deleteAdminSource(sourceId: SourceId): Promise<void> {
    // The collector's own tokens may not have admin scope; this route is
    // gated by admin in middleware, so the call may 403 for non-admin
    // collectors. Silent-fail is acceptable — the gateway-side delete only
    // matters for keeping the registry tidy.
    await this.request(`/admin/sources/${encodeURIComponent(sourceId)}`, {
      method: "DELETE",
    });
  }
}

/**
 * Split a batch into request-sized chunks: at most `maxItems` documents and,
 * approximately, at most `maxBytes` of serialized JSON per chunk. Sizes are
 * estimated from each document's serialized length, so the per-request
 * envelope (`writeEpochs`, brackets) adds only a few bytes on top.
 */
export function chunkDocuments<T>(
  documents: readonly T[],
  maxItems: number,
  maxBytes: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const document of documents) {
    const bytes = JSON.stringify(document).length + 1;
    const wouldOverflow =
      current.length > 0 && (current.length >= maxItems || currentBytes + bytes > maxBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(document);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
