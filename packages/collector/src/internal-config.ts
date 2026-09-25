// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collector-internal config shape — the working buffer the collector
 * threads through `SourceManager` / `SourceInstantiator` while it
 * tracks per-source enablement.
 *
 * This is NOT the wire-shape config: the gateway's source-of-truth is
 * `OmnesisConfig` (zod-derived from `omnesisConfigSchema` in
 * `@omnesis/core/config-schema.ts`). The collector receives that over
 * WS, then `gateway-config.toLegacyConfig` adapts it into this local
 * shape — adding `enabled: true` to every source so the manager has
 * something to flip when the user disables a source. Internal-only;
 * never exposed across the package boundary.
 *
 * This type used to live in `@omnesis/core` as the
 * public `LegacyOmnesisConfig` export. Moving it here narrows the core
 * package's surface — the unified `OmnesisConfig` is now the only
 * cross-package config contract — without forcing a deeper collector
 * refactor away from `enabled`-on-config tracking. That refactor is a
 * separate, larger change tracked in #384.
 */

import type { DataRetentionConfig, IndexerConfig, SearchConfig, SourceConfig } from "@omnesis/core";

export interface CollectorInternalConfig {
  defaultSyncInterval?: string;
  obsidian?: { vaults?: string[]; exclude?: string[] };
  dataRetention?: DataRetentionConfig;
  sources?: Record<string, SourceConfig>;
  search?: SearchConfig;
  indexer?: IndexerConfig;
}
