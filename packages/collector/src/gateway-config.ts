// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  isEncryptedSecretFile,
  readSecretJsonFileSync,
  writeSecretJsonFileSync,
  type SourceConfig,
} from "@omnesis/core";
import type { OmnesisConfig, SourceSettings } from "@omnesis/config";
import type { CollectorInternalConfig } from "./internal-config.js";
import type { HttpGatewayClient } from "@omnesis/gateway-client";

const log = createLogger("collector:gateway-config");

/** Max age a cached config stays usable as a boot stopgap. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface FetchContext {
  gateway: HttpGatewayClient;
  configDir: string;
  /** Observe the gateway config revision that was loaded successfully. */
  onLoaded?: (version: number) => void;
  /** Observe a failed refresh while the collector keeps its last-good config. */
  onLoadError?: (error: Error) => void;
}

/**
 * Fetch the omnesis config from the gateway, retrying with exponential
 * backoff until it succeeds. Never throws, never exits — the collector is
 * a daemon that must remain alive through gateway outages.
 *
 * If a cached copy is available and <24h old, it's returned as a stopgap
 * on the first connect failure so the collector can boot without the
 * gateway up. The WS reconnect loop takes over from there; once the gateway
 * comes back up, the watcher broadcasts `config.changed` and the collector
 * re-fetches with {@link fetchFreshConfig}.
 */
export async function fetchConfigWithBackoff(ctx: FetchContext): Promise<OmnesisConfig> {
  const cachePath = cachePathFor(ctx.configDir);
  const cached = readCacheIfFresh(cachePath, ctx.configDir);
  let delay = 1000;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const { config, version } = await fetchFreshConfig(ctx);
      ctx.onLoaded?.(version);
      writeCache(cachePath, config, ctx.configDir);
      return config;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      ctx.onLoadError?.(error);
      const message = error.message;
      if (attempts === 1 && cached) {
        log.warn(
          `Gateway unreachable at boot — using cached config (<24h old). WS reconnect will refresh on connect. (${message})`,
        );
        return cached;
      }
      if (attempts === 1 || attempts % 5 === 0) {
        log.info(`Waiting for gateway (attempt ${attempts}, retrying in ${delay}ms): ${message}`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

/** Fetch the current config — used on boot and on `config.changed` WS events. */
export function fetchFreshConfig(
  ctx: FetchContext,
): Promise<{ config: OmnesisConfig; version: number }> {
  return ctx.gateway.getConfig();
}

/** Fetch and apply a live revision before reporting it as successfully loaded. */
export async function fetchAndApplyFreshConfig(
  ctx: FetchContext,
  apply: (config: OmnesisConfig) => Promise<void>,
): Promise<OmnesisConfig> {
  try {
    const { config, version } = await fetchFreshConfig(ctx);
    await apply(config);
    ctx.onLoaded?.(version);
    return config;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    ctx.onLoadError?.(error);
    throw error;
  }
}

/**
 * Serialize live config refreshes through fetch and application. WebSocket
 * broadcasts may arrive while an earlier HTTP read is still in flight; a
 * single queue prevents an older response from being applied after a newer
 * revision and keeps application failures from poisoning later refreshes.
 */
export function createConfigRefreshQueue(
  ctx: FetchContext,
  apply: (config: OmnesisConfig) => Promise<void>,
): () => Promise<OmnesisConfig> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const refresh = tail.then(() => fetchAndApplyFreshConfig(ctx, apply));
    tail = refresh.then(
      () => undefined,
      () => undefined,
    );
    return refresh;
  };
}

/**
 * Adapter from the new schema (`OmnesisConfig`) to the legacy shape the
 * SourceManager + sync-engine still consume (`CollectorInternalConfig`). This is a
 * bridge — once downstream code is rewritten against `OmnesisConfig` directly,
 * this function goes away.
 *
 * Mapping:
 *   • `sources.default.syncInterval` → `defaultSyncInterval`
 *   • `sources.<id>` + `sources.default` merged → `sources[<id>]`
 *   • `dataRetention`, `search`, `indexer` pass through
 *   • `sources.<id>.enabled` is always `true` on the adapter — real enablement
 *     comes from the `sources.snapshot` WS reconciliation, not the config.
 */
export function toLegacyConfig(config: OmnesisConfig): CollectorInternalConfig {
  const defaults: SourceSettings = config.sources?.default ?? {};
  const out: CollectorInternalConfig = {
    dataRetention: config.dataRetention,
    search: config.search,
    indexer: config.indexer,
  };
  if (defaults.syncInterval !== undefined) {
    out.defaultSyncInterval = defaults.syncInterval;
  }
  const perSource: Record<string, SourceConfig> = {};
  for (const [id, settings] of Object.entries(config.sources ?? {})) {
    if (id === "default") continue;
    perSource[id] = {
      enabled: true,
      ...defaults,
      ...settings,
    };
  }
  if (Object.keys(perSource).length > 0) {
    out.sources = perSource;
  }
  return out;
}

function cachePathFor(configDir: string): string {
  return join(configDir, "cache", "omnesis.cache.json");
}

function readCacheIfFresh(path: string, configDir: string): OmnesisConfig | null {
  if (!existsSync(path)) return null;
  try {
    // Authenticate before migration; a damaged encrypted cache stays intact.
    const obj = readSecretJsonFileSync<{ writtenAt?: number; config?: OmnesisConfig }>(path, {
      configDir,
    });
    if (!obj) return null;
    if (!isEncryptedSecretFile(readFileSync(path, "utf8"))) {
      writeSecretJsonFileSync(path, obj, { configDir });
    }
    const writtenAt = obj.writtenAt ?? 0;
    if (Date.now() - writtenAt > CACHE_MAX_AGE_MS) return null;
    return obj.config ?? null;
  } catch {
    log.warn("Local configuration cache unavailable; fetching configuration from gateway");
    return null;
  }
}

function writeCache(path: string, config: OmnesisConfig, configDir: string): void {
  try {
    const payload = {
      _comment:
        "Managed by the collector — do not edit. Source of truth is omnesis.json on the gateway.",
      writtenAt: Date.now(),
      config,
    };
    writeSecretJsonFileSync(path, payload, { configDir });
  } catch (err) {
    log.warn(
      `Failed to write config cache to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
