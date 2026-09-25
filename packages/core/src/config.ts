// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { sourceSettingKeys } from "@omnesis/config";
import { DEFAULT_CONFIG_DIR } from "./utils.js";
import { createLogger } from "./logger.js";
import { ensurePrivateDirSync } from "./security-files.js";
import { readSecretTextFileSync, writeSecretTextFileSync } from "./secret-file.js";
import { parseSourceId } from "./ids.js";
import type { SourceId, SourceType, AccountId } from "./ids.js";

const log = createLogger("config");

/**
 * Configuration for a source instance.
 * Keyed by full source ID (e.g. "gmail:user@gmail.com").
 * The source base ID and account ID are parsed from the key.
 */
export interface SourceConfig {
  /** Whether this source is currently enabled */
  enabled: boolean;
  /** Source-specific parameters (e.g. { vaultPath: "/path/to/vault" }) */
  params?: Record<string, string>;
  /** Override sync interval for this source (e.g. "5m", "1h") */
  syncInterval?: string;
  /** Whether to extract text from email attachments (PDFs, etc.) */
  extractAttachments?: boolean;
  /** Maximum attachment size in bytes to download (default: 25MB) */
  attachmentMaxSizeBytes?: number;
  /** MIME types to extract (default: ["application/pdf"]) */
  attachmentTypes?: string[];
  /** Maximum extracted text length in characters (default: 500KB) */
  attachmentMaxTextLength?: number;
  /**
   * Per-source override of `dataRetention.maxAge`. Falls back to
   * `sources.default.maxAge`, then `dataRetention.maxAge` when unset.
   */
  maxAge?: string;
}

/**
 * Parse a source key into its source type and account ID. Thin alias for
 * {@link parseSourceId} that accepts an unbranded `string` — intended for
 * the few code paths that read raw config keys (legacy persisted shapes,
 * un-rebranded snapshots) and haven't yet narrowed the input to `SourceId`.
 * Splitting and SourceType/AccountId validation happen in `parseSourceId`;
 * keep the two impls in lockstep by going through it.
 */
export function parseSourceKey(key: string): { sourceType: SourceType; accountId: AccountId } {
  return parseSourceId(key as SourceId);
}

/**
 * Search configuration — ranking tunables and defaults.
 */
export interface SearchConfig {
  params?: Partial<{
    candidateLimit: number;
    resultLimit: number;
    rrfK: number;
    bm25Weight: number;
    vectorWeight: number;
  }>;
  boosts?: { typeBoosts?: Record<string, number> };
  defaultFilters?: {
    sourceIds?: string[];
    documentTypes?: string[];
    dateFrom?: string;
    dateTo?: string;
    tags?: string[];
  };
  vector?: {
    /** Over-fetch multiplier for HNSW post-filter. Default 10. */
    hnswOverFetch?: number;
  };
  snapshot?: {
    enabled?: boolean;
    refreshIntervalMs?: number;
  };
  readHandle?: {
    mmapBytes?: number;
    cacheSizeBytes?: number;
  };
  /**
   * Per-source-type score prior applied in the boost stage. Configured
   * weights are added to the post-fusion score of any candidate whose
   * `sourceId` starts with the configured prefix, unless the candidate
   * has a strong BM25 hit (rank <= `bm25BypassRank`, default 3). Empty
   * `weights` (the default) leaves search behaviour unchanged.
   */
  sourcePriors?: {
    weights?: Record<string, number>;
    bm25BypassRank?: number;
  };
  /**
   * Family-aware task prefixes for the embedder. Both `nomic-embed-text`
   * and BGE are trained with task-specific prefixes that meaningfully
   * improve retrieval recall. Off by default for safe rollout — flip
   * `enabled: true` AND rebuild the vector index (the stored doc
   * embeddings were produced without prefixes, so query-side prefixes
   * alone would put the query and the corpus into different embedding
   * spaces).
   */
  embedderPrefixes?: {
    enabled?: boolean;
  };
}

/**
 * Data retention configuration.
 */
export interface DataRetentionConfig {
  /** Maximum age of data to ingest/index. E.g. "1y", "6M", "30d" */
  maxAge?: string;
}

/**
 * Indexer configuration — operational tunables only.
 * Model selection lives in the `inference` config block.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IndexerConfig {}

/**
 * Policy config returned by the gateway's GET /config endpoint.
 * The collector fetches this at startup to learn gateway-authoritative settings.
 */
export interface GatewayPolicyConfig {
  dataRetention?: DataRetentionConfig;
}

/**
 * Upper bound on parsed durations. 100 years in ms (~3.15e15) is well
 * inside Number.MAX_SAFE_INTEGER (~9.0e15) and well inside what `Date`
 * can represent (`new Date(8.64e15)` is the documented max). Anything
 * past this is almost certainly a typo (`'9999y'`) and would silently
 * push downstream Date arithmetic into Invalid Date territory.
 */
const MAX_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Bare-number minimum. We accept plain integer strings as milliseconds
 * for backwards compatibility (legacy `OMNESIS_SYNC_INTERVAL=300000`),
 * but a user typing `'5'` almost certainly meant `'5m'`, not 5 ms — at
 * 5 ms the sync engine pegs a CPU. Refuse anything under 1000 ms when
 * supplied without a unit; force the user to be explicit.
 */
const BARE_NUMBER_MIN_MS = 1000;

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: "30s", "5m", "1h", "1d", "6M", "1y", "500ms", or plain number (ms ≥ 1000).
 *
 * Note: "M" (month) and "y" (year) are 30d / 365d approximations. Fine
 * for retention windows / bootstrap age cutoffs; not appropriate for
 * calendar-precise math.
 */
export function parseDuration(value: string): number {
  let result: number;

  if (/^\d+$/.test(value)) {
    const ms = parseInt(value, 10);
    if (ms < BARE_NUMBER_MIN_MS) {
      throw new Error(
        `Invalid duration: "${value}" — bare numbers below ${BARE_NUMBER_MIN_MS}ms are rejected to prevent unit-confusion (did you mean "${value}m" or "${value}s"?). Specify a unit or use ≥${BARE_NUMBER_MIN_MS} for plain ms.`,
      );
    }
    result = ms;
  } else {
    const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|M|y)$/);
    if (!match) {
      throw new Error(
        `Invalid duration: "${value}". Use e.g. "30s", "5m", "1h", "30d", "6M", "1y", "500ms"`,
      );
    }

    const num = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
      case "ms":
        result = Math.round(num);
        break;
      case "s":
        result = Math.round(num * 1000);
        break;
      case "m":
        result = Math.round(num * 60 * 1000);
        break;
      case "h":
        result = Math.round(num * 60 * 60 * 1000);
        break;
      case "d":
        result = Math.round(num * 24 * 60 * 60 * 1000);
        break;
      case "M":
        result = Math.round(num * 30 * 24 * 60 * 60 * 1000);
        break;
      case "y":
        result = Math.round(num * 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        throw new Error(`Unknown duration unit: "${unit}"`);
    }
  }

  if (result > MAX_DURATION_MS) {
    throw new Error(
      `Duration "${value}" exceeds maximum (100 years). Downstream Date arithmetic would overflow.`,
    );
  }
  return result;
}

/**
 * Resolve the effective `maxAge` string for a source ID. The most specific
 * `sources.*` key that addresses the source wins — an instance-id block
 * (`google-drive:maya@example.com`) over a descriptor-id block
 * (`google-drive`) — then `sources.default.maxAge`, then the global
 * `dataRetention.maxAge`. Returns undefined when none is configured.
 */
export function resolveSourceMaxAge(
  config: {
    dataRetention?: DataRetentionConfig;
    sources?: Record<string, { maxAge?: string }>;
  },
  sourceId: string,
): string | undefined {
  const keys = sourceSettingKeys(sourceId);
  for (let i = keys.length - 1; i >= 0; i--) {
    const perSource = config.sources?.[keys[i]]?.maxAge;
    if (perSource) return perSource;
  }
  const perDefault = config.sources?.default?.maxAge;
  if (perDefault) return perDefault;
  return config.dataRetention?.maxAge;
}

/**
 * Per-source variant of getDataCutoffDate(). Returns the cutoff ISO string
 * for documents from `sourceId`, applying the precedence
 * `sources.<id>.maxAge` > `sources.default.maxAge` > `dataRetention.maxAge`.
 * Returns null when no cutoff applies.
 */
export function getSourceCutoffDate(
  config: {
    dataRetention?: DataRetentionConfig;
    sources?: Record<string, { maxAge?: string }>;
  },
  sourceId: string,
): string | null {
  const maxAge = resolveSourceMaxAge(config, sourceId);
  if (!maxAge) return null;
  const maxAgeMs = parseDuration(maxAge);
  return new Date(Date.now() - maxAgeMs).toISOString();
}

/**
 * Get the data cutoff date based on the maxAge config.
 * Returns null if no maxAge is configured (no limit).
 * Returns an ISO 8601 string representing the oldest allowed date.
 */
export function getDataCutoffDate(config: { dataRetention?: DataRetentionConfig }): string | null {
  const maxAge = config.dataRetention?.maxAge;
  if (!maxAge) return null;

  const maxAgeMs = parseDuration(maxAge);
  return new Date(Date.now() - maxAgeMs).toISOString();
}

// ---------------------------------------------------------------------------
// Token file helpers
// ---------------------------------------------------------------------------

/**
 * Read the auto-generated token file at configDir/token.
 * Returns the trimmed token string or null if the file doesn't exist.
 */
export function readTokenFile(configDir?: string): string | null {
  const dir = configDir ?? DEFAULT_CONFIG_DIR;
  const tokenPath = join(dir, "token");
  try {
    const content = (readSecretTextFileSync(tokenPath, { configDir: dir }) ?? "").trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the auth token using the following priority:
 * 1. OMNESIS_TOKEN env var
 * 2. Token file at configDir/token
 * 3. null (no token found)
 */
export function resolveToken(configDir?: string): string | null {
  const envToken = process.env.OMNESIS_TOKEN;
  if (envToken) return envToken;

  return readTokenFile(configDir);
}

/**
 * Read the collector-specific token at configDir/collector-token.
 * The collector self-pairs against the gateway on first startup using the
 * bootstrap admin token, then writes its own scoped (`read,write:*`) token
 * here so subsequent runs don't carry the admin token around.
 */
export function readCollectorTokenFile(configDir?: string): string | null {
  const dir = configDir ?? DEFAULT_CONFIG_DIR;
  const tokenPath = join(dir, "collector-token");
  try {
    const content = (readSecretTextFileSync(tokenPath, { configDir: dir }) ?? "").trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Persist the collector-specific token to configDir/collector-token.
 * Uses the root-key-wrapped secret-file helper when an install root key
 * exists, and otherwise retains the legacy owner-only plaintext file.
 */
export function writeCollectorTokenFile(token: string, configDir?: string): string {
  const dir = configDir ?? DEFAULT_CONFIG_DIR;
  const tokenPath = join(dir, "collector-token");
  ensurePrivateDirSync(dir);
  writeSecretTextFileSync(tokenPath, token, { configDir: dir });
  return tokenPath;
}

export const DEFAULT_SYNC_INTERVAL_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Sync interval resolution
// ---------------------------------------------------------------------------

/**
 * Per-config-instance memoization of `getSyncIntervalMs(sourceId, config)`.
 *
 * The scheduler / sync engine hits `getSyncIntervalMs` once per source per
 * tick (one tick is ~minutes); for a 30-source setup that's 30
 * `Object.entries` scans + duration re-parses per tick. The function is
 * pure with respect to `(sourceId, config)`, so we cache per-config in a
 * WeakMap. The config store replaces the whole config object on reload, so
 * a new object identity naturally invalidates the cache — no manual flush
 * needed.
 *
 * The env-var fallback is also cached on a config-less symbol key so a
 * source resolved purely from `OMNESIS_SYNC_INTERVAL` doesn't re-parse on
 * every call.
 */
type SyncIntervalConfig = { defaultSyncInterval?: string; sources?: Record<string, SourceConfig> };
const syncIntervalCache = new WeakMap<SyncIntervalConfig, Map<string, number>>();

/**
 * Get the sync interval in ms for a specific source.
 *
 * Resolution order:
 * 1. Exact source config match (e.g. sources["gmail:user@gmail.com"].syncInterval)
 * 2. Base source type match (e.g. sources matching base type "gmail")
 * 3. config.defaultSyncInterval
 * 4. OMNESIS_SYNC_INTERVAL env var
 * 5. Hardcoded 5 minutes
 */
export function getSyncIntervalMs(sourceId: SourceId, config: SyncIntervalConfig): number {
  let perConfig = syncIntervalCache.get(config);
  if (!perConfig) {
    perConfig = new Map();
    syncIntervalCache.set(config, perConfig);
  }
  const cached = perConfig.get(sourceId);
  if (cached !== undefined) return cached;

  const result = computeSyncIntervalMs(sourceId, config);
  perConfig.set(sourceId, result);
  return result;
}

function computeSyncIntervalMs(sourceId: SourceId, config: SyncIntervalConfig): number {
  const sources = config.sources;

  if (sources) {
    // Exact match by source ID
    if (sources[sourceId]?.syncInterval) {
      return parseDuration(sources[sourceId].syncInterval!);
    }

    // Source type match (strip account suffix)
    const { sourceType } = parseSourceId(sourceId);
    if (String(sourceType) !== String(sourceId)) {
      // Look for any source with matching base type that has a syncInterval
      for (const [key, source] of Object.entries(sources)) {
        const { sourceType: keyBase } = parseSourceKey(key);
        if (keyBase === sourceType && source.syncInterval) {
          return parseDuration(source.syncInterval);
        }
      }
    }
  }

  // Config default
  if (config.defaultSyncInterval) {
    return parseDuration(config.defaultSyncInterval);
  }

  // Env var. Use parseDuration so `OMNESIS_SYNC_INTERVAL=5m` works the
  // same as the config-file fallback above. Pre-fix the env path used
  // `parseInt`, which silently mapped `5m` → 5 ms (sync engine hammered
  // every 5 ms). parseDuration also accepts plain integers as ms, so
  // existing `OMNESIS_SYNC_INTERVAL=300000` setups keep working. A
  // malformed value falls through to the default with a warn rather
  // than throwing on first sync.
  const envVal = process.env.OMNESIS_SYNC_INTERVAL;
  if (envVal) {
    try {
      return parseDuration(envVal);
    } catch (err) {
      log.warn(
        `Invalid OMNESIS_SYNC_INTERVAL='${envVal}' (${err instanceof Error ? err.message : String(err)}); falling back to default ${DEFAULT_SYNC_INTERVAL_MS}ms`,
      );
    }
  }

  return DEFAULT_SYNC_INTERVAL_MS;
}
