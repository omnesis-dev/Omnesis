// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  CATALOG,
  createLogger,
  type AnthropicCatalogEntry,
  type BackendStatus,
  type CatalogEntry,
} from "@omnesis/core";

const log = createLogger("gateway:models:anthropic-catalog");

/** Refresh often enough to pick up newly entitled models without a restart. */
export const DEFAULT_ANTHROPIC_CATALOG_REFRESH_MS = 60 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface AnthropicModelRecord {
  id: string;
  display_name: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
  capabilities: {
    thinking: {
      types: {
        adaptive: { supported: boolean };
      };
    };
  } | null;
}

export interface AnthropicModelsClient {
  models: {
    list(
      params?: { limit?: number },
      options?: { signal?: AbortSignal },
    ): AsyncIterable<AnthropicModelRecord>;
  };
}

export interface AnthropicCatalogServiceOptions {
  readApiKey: () => string | null;
  credentialSource?: () => BackendStatus["credentialSource"];
  createClient?: (apiKey: string) => AnthropicModelsClient;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
}

interface RefreshFlight {
  generation: number;
  fingerprint: string;
  controller: AbortController;
  promise: Promise<BackendStatus | undefined>;
}

class AnthropicListResponseError extends Error {}

const BUNDLED_ANTHROPIC = CATALOG.filter(
  (entry): entry is AnthropicCatalogEntry => entry.kind === "anthropic-api",
);

/**
 * Live Anthropic model catalog with bundled fallback.
 *
 * A successful Models API response is authoritative for the current API key.
 * Until then, or after the key changes, the bundled Anthropic entries remain
 * available. A transient failure for the same key retains its last-known-good
 * list so the picker does not flap. In-flight results are generation-guarded:
 * a slow response for an old key can never overwrite the current key's state.
 */
export class AnthropicCatalogService {
  private readonly readApiKey: () => string | null;
  private readonly createClient: (apiKey: string) => AnthropicModelsClient;
  private readonly credentialSource: () => BackendStatus["credentialSource"];
  private readonly refreshIntervalMs: number;
  private readonly requestTimeoutMs: number;

  private generation = 0;
  private credentialFingerprint: string | null = null;
  private liveEntries: AnthropicCatalogEntry[] = [];
  /**
   * Metadata remains useful for assignments after a model disappears from the
   * authoritative picker list. Keep it separately so retired or account-
   * specific assignments retain their request limits without being offered
   * for new assignments.
   */
  private readonly knownEntries = new Map(
    BUNDLED_ANTHROPIC.map((entry) => [entry.id, entry] as const),
  );
  private statusValue: BackendStatus | undefined;
  private inFlight: RefreshFlight | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AnthropicCatalogServiceOptions) {
    this.readApiKey = opts.readApiKey;
    this.credentialSource = opts.credentialSource ?? (() => undefined);
    this.createClient =
      opts.createClient ??
      ((apiKey) =>
        new Anthropic({
          apiKey,
          maxRetries: 1,
          timeout: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        }) as unknown as AnthropicModelsClient);
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_ANTHROPIC_CATALOG_REFRESH_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Start a non-blocking refresh and the periodic refresh timer. */
  start(): void {
    void this.refresh();
    if (this.refreshTimer || this.refreshIntervalMs <= 0) return;
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  /** Stop periodic work and invalidate any in-flight result. */
  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.inFlight?.controller.abort();
    this.generation += 1;
    this.inFlight = null;
  }

  /** Current full catalog, preserving the bundled Anthropic insertion point. */
  catalog(): readonly CatalogEntry[] {
    const anthropicEntries = this.liveEntries.length > 0 ? this.liveEntries : BUNDLED_ANTHROPIC;
    const result: CatalogEntry[] = [];
    let insertedAnthropic = false;
    for (const entry of CATALOG) {
      if (entry.kind !== "anthropic-api") {
        result.push(entry);
      } else if (!insertedAnthropic) {
        result.push(...anthropicEntries);
        insertedAnthropic = true;
      }
    }
    if (!insertedAnthropic) result.push(...anthropicEntries);
    return result;
  }

  /**
   * Look up current or previously discovered metadata for runtime resolution.
   * Historical entries are not returned by {@link catalog}.
   */
  getCatalogEntry(id: string): CatalogEntry | undefined {
    return this.catalog().find((entry) => entry.id === id) ?? this.knownEntries.get(id);
  }

  /** Current Anthropic backend status; absent when no key is configured. */
  status(): BackendStatus | undefined {
    if (!this.statusValue) return undefined;
    const credentialSource = this.credentialSource();
    return {
      ...this.statusValue,
      models: this.statusValue.models ? [...this.statusValue.models] : undefined,
      ...(credentialSource ? { credentialSource } : {}),
    };
  }

  /**
   * Refresh from Anthropic. Same-key callers share one request. This method
   * resolves to a status for UI/manual-refresh callers; discovery failures are
   * represented as `unreachable` rather than thrown.
   */
  refresh(): Promise<BackendStatus | undefined> {
    const apiKey = normalizeApiKey(this.readApiKey());
    if (!apiKey) {
      this.resetForNoCredential();
      return Promise.resolve(undefined);
    }

    const fingerprint = fingerprintKey(apiKey);
    if (fingerprint !== this.credentialFingerprint) {
      this.inFlight?.controller.abort();
      this.generation += 1;
      this.credentialFingerprint = fingerprint;
      this.liveEntries = [];
      this.statusValue = {
        type: "anthropic",
        status: "probing",
        hasApiKey: true,
      };
      this.inFlight = null;
    }

    const generation = this.generation;
    if (this.inFlight?.generation === generation && this.inFlight.fingerprint === fingerprint) {
      return this.inFlight.promise;
    }

    this.statusValue = {
      type: "anthropic",
      status: "probing",
      hasApiKey: true,
      ...(this.liveEntries.length > 0
        ? { models: this.liveEntries.map((entry) => entry.apiModelId) }
        : {}),
    };

    const controller = new AbortController();
    const promise = this.fetchCatalog(apiKey, controller)
      .then((entries) => {
        if (!this.isCurrent(generation, fingerprint)) return this.status();
        this.liveEntries = entries;
        for (const entry of entries) this.knownEntries.set(entry.id, entry);
        this.statusValue = {
          type: "anthropic",
          status: "ok",
          hasApiKey: true,
          models: entries.map((entry) => entry.apiModelId),
        };
        log.info(`Discovered ${entries.length} Anthropic models`);
        return this.status();
      })
      .catch((err: unknown) => {
        if (!this.isCurrent(generation, fingerprint)) return this.status();
        const reason = errorMessage(err);
        this.statusValue = {
          type: "anthropic",
          status: discoveryFailureStatus(err),
          hasApiKey: true,
          reason,
          ...(this.liveEntries.length > 0
            ? { models: this.liveEntries.map((entry) => entry.apiModelId) }
            : {}),
        };
        log.warn(`Anthropic model discovery failed: ${reason}`);
        return this.status();
      });

    const flight = { generation, fingerprint, controller, promise };
    this.inFlight = flight;
    void promise.finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
    });
    return promise;
  }

  private async fetchCatalog(
    apiKey: string,
    controller: AbortController,
  ): Promise<AnthropicCatalogEntry[]> {
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const records: AnthropicModelRecord[] = [];
      const client = this.createClient(apiKey);
      try {
        for await (const model of client.models.list(
          { limit: 100 },
          { signal: controller.signal },
        )) {
          records.push(model);
        }
      } catch (err) {
        if (records.length > 0 && httpStatus(err) === undefined) {
          throw new AnthropicListResponseError(errorMessage(err));
        }
        throw err;
      }
      let entries: AnthropicCatalogEntry[];
      try {
        entries = mapAnthropicModels(records);
      } catch (err) {
        throw new AnthropicListResponseError(errorMessage(err));
      }
      if (entries.length === 0) {
        throw new AnthropicListResponseError("Anthropic returned an empty model list");
      }
      return entries;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isCurrent(generation: number, fingerprint: string): boolean {
    const currentKey = normalizeApiKey(this.readApiKey());
    return (
      generation === this.generation &&
      fingerprint === this.credentialFingerprint &&
      currentKey !== null &&
      fingerprintKey(currentKey) === fingerprint
    );
  }

  private resetForNoCredential(): void {
    if (
      this.credentialFingerprint === null &&
      this.statusValue === undefined &&
      this.liveEntries.length === 0
    ) {
      return;
    }
    this.inFlight?.controller.abort();
    this.generation += 1;
    this.credentialFingerprint = null;
    this.liveEntries = [];
    this.statusValue = undefined;
    this.inFlight = null;
  }
}

export function mapAnthropicModels(
  records: readonly AnthropicModelRecord[],
): AnthropicCatalogEntry[] {
  const seen = new Set<string>();
  const entries: AnthropicCatalogEntry[] = [];
  for (const record of records) {
    const apiModelId = record.id.trim();
    if (!apiModelId || seen.has(apiModelId)) continue;
    seen.add(apiModelId);
    const displayName = record.display_name.trim() || apiModelId;
    entries.push({
      kind: "anthropic-api",
      id: `anthropic/${apiModelId}`,
      apiModelId,
      name: `${displayName} (Anthropic API)`,
      roles: ["agent"],
      author: "Anthropic",
      license: "Anthropic Commercial Terms",
      description:
        "Cloud model reported by the Anthropic Models API. Requires an Anthropic API key and permission for remote inference.",
      ...(record.max_input_tokens === null
        ? {}
        : {
            // Keep the generic catalog field for existing model-list displays,
            // while preserving the API's input-only semantics for enforcement.
            contextLength: record.max_input_tokens,
            maxInputTokens: record.max_input_tokens,
          }),
      ...(record.max_tokens === null ? {} : { maxOutputTokens: record.max_tokens }),
      ...(record.capabilities === null
        ? {}
        : {
            adaptiveThinking: record.capabilities.thinking.types.adaptive.supported,
          }),
    });
  }
  return entries;
}

function normalizeApiKey(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function errorMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status === 401 || status === 403) return "Anthropic rejected the API key";
  if (status === 429) return "Anthropic rate-limited the model-list request";
  if (status !== undefined) return `Anthropic Models API returned HTTP ${status}`;
  if (err instanceof Error && err.name === "AbortError") {
    return "Anthropic model discovery timed out";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function discoveryFailureStatus(err: unknown): "reachable" | "unreachable" {
  const status = httpStatus(err);
  if (status !== undefined) return status === 401 || status === 403 ? "unreachable" : "reachable";
  return err instanceof AnthropicListResponseError ? "reachable" : "unreachable";
}

function httpStatus(err: unknown): number | undefined {
  return typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number"
    ? err.status
    : undefined;
}
