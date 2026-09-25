// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, parseSourceKey, toErrorMessage } from "@omnesis/core";
import { sourceIdAddresses } from "@omnesis/types";
import type { SourceConfig } from "@omnesis/core";
import type { SourceDescriptor } from "@omnesis/source-sdk";
import type { MultiDeviceMode, ProviderType, SourceType } from "@omnesis/types";
import type { CollectorInternalConfig } from "./internal-config.js";
import type { SourceSetupFailure } from "./source-instantiator.js";
import type { SyncEngine, RegisteredSource } from "./sync-engine.js";

const log = createLogger("collector:sources");

/** Build a map from source base ID → provider ID using descriptors. */
export function buildSourceToProviderMap(
  descriptors: SourceDescriptor[],
): Map<SourceType, ProviderType> {
  const map = new Map<SourceType, ProviderType>();
  for (const d of descriptors) {
    map.set(d.id, d.provider.id);
  }
  return map;
}

/**
 * Whether a single config key addresses a given live source id.
 *
 * This is the matching primitive every other source-key lookup is built on. A
 * bare key (`gmail`) addresses every account under that type; an
 * account-qualified key (`gmail:alice@example.com`) addresses only that account
 * and never a sibling account of the same type. Teardown paths (unregister,
 * disable, credential cleanup) must route through this rather than a
 * `startsWith("<type>:")` prefix test, which would take every sibling down with
 * the one source the caller named.
 *
 * The rule, and why it is total, are in `sourceIdAddresses`. This name stays
 * because a config key is not obviously one of these ids until you know that
 * a key is written at exactly the two specificities a source id has.
 */
export function configKeyAddressesSource(key: string, sourceId: string): boolean {
  return sourceIdAddresses(key, sourceId);
}

/**
 * Check if a source ID is enabled in a set of source configs — i.e. whether any
 * enabled config key addresses it.
 */
export function isSourceEnabled(
  sourceId: string,
  enabledSources: Record<string, SourceConfig>,
): boolean {
  return Object.entries(enabledSources).some(
    ([key, source]) => source?.enabled && configKeyAddressesSource(key, sourceId),
  );
}

/**
 * Whether some OTHER enabled config key still addresses this live source.
 *
 * Teardown is per config key, but one live source instance can be addressed by
 * more than one key (a bare `gmail` alongside `gmail:alice@example.com`). Before
 * unregistering or disabling an instance on behalf of `excludingKey`, callers
 * check here that nothing else is still keeping it alive.
 */
export function anotherEnabledKeyAddresses(
  sources: Record<string, SourceConfig> | undefined,
  sourceId: string,
  excludingKey: string,
): boolean {
  return Object.entries(sources ?? {}).some(
    ([key, cfg]) => key !== excludingKey && cfg?.enabled && configKeyAddressesSource(key, sourceId),
  );
}

/** Get provider base IDs that have enabled sources. */
export function getEnabledProviderIds(
  enabledSources: Record<string, SourceConfig>,
  sourceToProvider: Map<SourceType, ProviderType>,
): Set<string> {
  const providerIds = new Set<string>();
  for (const [key, source] of Object.entries(enabledSources)) {
    if (!source.enabled) continue;
    const { sourceType } = parseSourceKey(key);
    const providerId = sourceToProvider.get(sourceType);
    if (providerId) providerIds.add(String(providerId));
  }
  return providerIds;
}

/**
 * Dependencies for SourceConfigReconciler. The `getConfig` /
 * `getRegisteredKeys` accessors return live references — the manager
 * may swap its `config` object wholesale on hot-reload, so we can't
 * cache the value at construction time.
 */
export interface ReconcilerContext {
  /** Live accessor for the manager's current config. */
  getConfig: () => CollectorInternalConfig;
  /** Live accessor for the registered-keys set. */
  getRegisteredKeys: () => Set<string>;
  engine: SyncEngine;
  /**
   * Set up source instances + providers from a config dict, holding the
   * outcome against `keys` — the keys this call is answerable for. Resolves
   * to the subset that ended with no live instance, each with its reason;
   * those keys are un-latched and reported upstream by the manager, so the
   * next snapshot retries them.
   */
  setupSources: (
    enabledSources: Record<string, SourceConfig>,
    keys: string[],
  ) => Promise<SourceSetupFailure[]>;
  /** Retain an authoritative gateway mode for later re-instantiation paths. */
  setMultiDeviceMode?: (sourceId: string, mode: MultiDeviceMode) => void;
  /** Forget retained mode metadata when the source leaves this collector. */
  clearMultiDeviceMode?: (sourceId: string) => void;
  /** Find currently-registered sources matching a set of config keys. */
  findSourcesForKeys: (
    keys: string[],
    enabledSources: Record<string, SourceConfig>,
  ) => RegisteredSource[];
  /** Persist config to disk; today a no-op (gateway owns the file). */
  saveConfig: () => void;
}

interface SourceSnapshotRecord {
  id: string;
  type?: string;
  accountId?: string;
  config?: unknown;
  enabled?: boolean;
  multiDeviceMode?: MultiDeviceMode;
}

/**
 * Order-insensitive identity of the source settings a provider factory sees.
 * Object key order is not semantic, while array order is; undefined fields
 * disappear on the wire and therefore do not distinguish two snapshots.
 * Enablement is reconciled separately and must not turn a toggle into a
 * provider replacement.
 */
export function sourceConfigFingerprint(config: SourceConfig | undefined): string {
  const { enabled: _enabled, ...settings } = config ?? { enabled: true };
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(settings));
}

/**
 * Reconciles the collector's local source registry against a snapshot
 * pushed by the gateway over WS. Extracted from SourceManager so the
 * diff logic + the local-only enable/disable helpers stay co-located.
 */
export class SourceConfigReconciler {
  constructor(private ctx: ReconcilerContext) {}

  /**
   * Per-reconciler-instance serialization chain. Two `applySnapshot`
   * calls would otherwise race on the shared `config` /
   * `registeredKeys` mutable state — both could read the same
   * `localKeys`, both could append to `config.sources[key]`, both
   * could fire `setupSources` for an overlapping set, and the
   * later-resolving one would write a stale snapshot back via
   * `saveConfig()`. Chaining each call behind the prior one with a
   * `.catch(() => undefined)` join means failures don't poison
   * subsequent calls, but ordering is preserved.
   */
  private applyChain: Promise<void> = Promise.resolve();

  /**
   * Apply a sources snapshot pushed by the gateway. The gateway is
   * authoritative for the source registry — this method reconciles the
   * collector's local state to match.
   *
   * Diff against currently-tracked sources:
   *   - In snapshot but not local → register and start sync.
   *   - Local but not in snapshot → unregister (keep credentials on disk).
   *   - Present in both with different `enabled` → toggle accordingly.
   *
   * Idempotent and safe to call repeatedly. Does NOT push back to the
   * gateway — the snapshot IS the gateway's view.
   *
   * Concurrent calls serialize per-reconciler (see {@link applyChain})
   * — overlapping snapshots from a flapping WS connection or two rapid
   * `sources.snapshot` events in flight would otherwise race on
   * `config.sources` and `registeredKeys`.
   */
  async applySnapshot(
    records: SourceSnapshotRecord[],
    opts: { merge?: boolean } = {},
  ): Promise<void> {
    const next = this.applyChain
      .catch(() => undefined)
      .then(() => this.applySnapshotInner(records, opts));
    // Discard any error so a thrown call doesn't poison successors.
    this.applyChain = next.catch(() => undefined);
    return next;
  }

  private async applySnapshotInner(
    records: SourceSnapshotRecord[],
    opts: { merge?: boolean } = {},
  ): Promise<void> {
    const { ctx } = this;
    const config = ctx.getConfig();
    const registeredKeys = ctx.getRegisteredKeys();
    const incoming = new Map<string, SourceConfig>();
    for (const r of records) {
      if (!r.id) continue;
      if (r.multiDeviceMode !== undefined) {
        ctx.setMultiDeviceMode?.(r.id, r.multiDeviceMode);
        for (const source of ctx.engine.getSourcesById(r.id)) {
          source.multiDeviceMode = r.multiDeviceMode;
        }
      }
      const cfg =
        r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : {};
      incoming.set(r.id, {
        ...(cfg as Partial<SourceConfig>),
        enabled: r.enabled !== false,
      } as SourceConfig);
    }

    if (!config.sources) config.sources = {};
    const localKeys = new Set(registeredKeys);

    const toAdd: string[] = [];
    const toRemove: string[] = [];
    const toToggleOn: string[] = [];
    const toToggleOff: string[] = [];
    const toReplace: string[] = [];

    for (const [key, cfg] of incoming) {
      if (!localKeys.has(key)) {
        toAdd.push(key);
        continue;
      }
      const wasEnabled = config.sources[key]?.enabled !== false;
      const nowEnabled = cfg.enabled !== false;
      if (wasEnabled && !nowEnabled) toToggleOff.push(key);
      else if (!wasEnabled && nowEnabled) toToggleOn.push(key);
      else if (
        wasEnabled &&
        nowEnabled &&
        sourceConfigFingerprint(config.sources[key]) !== sourceConfigFingerprint(cfg)
      ) {
        toReplace.push(key);
      }
    }
    // `merge` treats the records as additive — a partial statement like a
    // single `source.added` record — so keys absent from it are left alone.
    // Without it the list is the device's authoritative full set and any
    // registered key missing from it is unregistered.
    if (!opts.merge) {
      for (const key of localKeys) {
        if (!incoming.has(key)) toRemove.push(key);
      }
      // A source this host tried and failed to run is not in `localKeys` — the
      // failed attempt un-latched it so a later snapshot would retry. That also
      // hides it from the sweep above, so without this a source the gateway has
      // since taken away keeps its cached config and its failure record here,
      // and the collector goes on reporting a source it no longer holds.
      for (const { sourceId } of ctx.engine.unhostedEntries()) {
        if (!incoming.has(sourceId) && !toRemove.includes(sourceId)) toRemove.push(sourceId);
      }
    }

    // Apply removals first so config slots are free for any name reuse.
    for (const key of toRemove) {
      try {
        await this.unregisterLocally(key);
        ctx.clearMultiDeviceMode?.(key);
      } catch (err) {
        log.warn(`applySnapshot: failed to remove ${key}: ${toErrorMessage(err)}`);
      }
    }

    // Apply additions
    if (toAdd.length > 0) {
      const newConfigs: Record<string, SourceConfig> = {};
      for (const key of toAdd) {
        const cfg = incoming.get(key)!;
        config.sources[key] = cfg;
        newConfigs[key] = cfg;
        registeredKeys.add(key);
      }

      try {
        const unbacked = await ctx.setupSources(newConfigs, toAdd);
        for (const failure of unbacked) {
          log.warn(`applySnapshot: ${failure.key} was not set up: ${failure.error}`);
        }
      } catch (err) {
        log.error(`applySnapshot: doSetupSources failed: ${toErrorMessage(err)}`);
      }

      const newRegistered = ctx.findSourcesForKeys(toAdd, newConfigs);
      // setupSources may have instantiated the descriptor's bundled mode.
      // Replace it before arming the first sync loop.
      for (const key of toAdd) {
        const mode = records.find((record) => record.id === key)?.multiDeviceMode;
        if (mode === undefined) continue;
        for (const source of ctx.engine.getSourcesById(key)) source.multiDeviceMode = mode;
      }
      if (newRegistered.length > 0) {
        // Fire-and-forget: initial syncs can be slow on large backlogs.
        ctx.engine.startSourceSyncLoops(newRegistered, ctx.getConfig()).catch((err) => {
          log.error(`applySnapshot: failed to start sync loops: ${toErrorMessage(err)}`);
        });
      }
    }

    // Apply toggles
    for (const key of toToggleOff) {
      const cfg = incoming.get(key)!;
      config.sources[key] = cfg;
      for (const status of ctx.engine.getStatuses()) {
        if (!configKeyAddressesSource(key, status.sourceId)) continue;
        // A sibling config entry may still enable this instance (a bare
        // `gmail` key alongside `gmail:alice@example.com`), in which case the
        // instance stays up.
        if (anotherEnabledKeyAddresses(config.sources, status.sourceId, key)) continue;
        if (status.state !== "disabled") {
          await ctx.engine.disableSource(status.sourceId);
          log.info(`applySnapshot: disabled ${status.sourceId}`);
        }
      }
    }
    for (const key of toToggleOn) {
      const cfg = incoming.get(key)!;
      config.sources[key] = cfg;
      try {
        await this.enableSourcesLocally([key]);
      } catch (err) {
        log.warn(`applySnapshot: failed to enable ${key}: ${toErrorMessage(err)}`);
      }
    }

    // A provider instance captures its effective source config in create().
    // The key stays registered, so a changed same-id snapshot must explicitly
    // replace the instance and restart its loop. Snapshot applications are
    // serialized by applyChain, making one replacement per distinct config.
    if (toReplace.length > 0) {
      const replacements: Record<string, SourceConfig> = {};
      for (const key of toReplace) {
        const cfg = incoming.get(key)!;
        config.sources[key] = cfg;
        replacements[key] = cfg;
      }
      for (const failure of await ctx.setupSources(replacements, toReplace)) {
        log.warn(`applySnapshot: ${failure.key} was not rebuilt: ${failure.error}`);
      }
      const refreshed = ctx.findSourcesForKeys(toReplace, replacements);
      if (refreshed.length > 0) {
        await ctx.engine.startSourceSyncLoops(refreshed, config);
      }
    }

    // Even settings that do not require provider replacement (including a
    // disabled source's params) remain the authoritative cached snapshot.
    for (const [key, cfg] of incoming) {
      if (!registeredKeys.has(key) || toAdd.includes(key)) continue;
      config.sources[key] = cfg;
    }

    // Persist the latest view as a local cache.
    ctx.saveConfig();

    if (
      toAdd.length ||
      toRemove.length ||
      toToggleOn.length ||
      toToggleOff.length ||
      toReplace.length
    ) {
      log.info(
        `applySnapshot reconciled: +${toAdd.length} -${toRemove.length} ` +
          `on=${toToggleOn.length} off=${toToggleOff.length} replaced=${toReplace.length}`,
      );
    } else {
      log.debug(`applySnapshot: no changes (${incoming.size} source(s) already in sync)`);
    }
  }

  /**
   * Internal: unregister a source locally without touching the gateway.
   * Mirrors `removeSources` but skips the gateway DELETE + data deletion —
   * the snapshot path doesn't intend to wipe documents, just stop syncing.
   * Credentials stay on disk so re-adding the source is fast.
   */
  private async unregisterLocally(key: string): Promise<void> {
    const { ctx } = this;
    const config = ctx.getConfig();
    const registeredKeys = ctx.getRegisteredKeys();
    for (const status of [...ctx.engine.getStatuses()]) {
      if (!configKeyAddressesSource(key, status.sourceId)) continue;
      if (anotherEnabledKeyAddresses(config.sources, status.sourceId, key)) continue;
      await ctx.engine.unregisterSource(status.sourceId);
    }
    if (config.sources) delete config.sources[key];
    registeredKeys.delete(key);
    // An unhosted source has no status entry, so the loop above never reaches
    // it; clear its record explicitly or it outlives the source.
    ctx.engine.forgetUnhosted(key);
  }

  /** Internal: enable previously-registered sources without gateway sync. */
  private async enableSourcesLocally(keys: string[]): Promise<void> {
    const { ctx } = this;
    const config = ctx.getConfig();
    const registeredKeys = ctx.getRegisteredKeys();
    if (!config.sources) return;
    for (const key of keys) {
      registeredKeys.add(key);
      if (config.sources[key]) config.sources[key].enabled = true;

      const existing = ctx.findSourcesForKeys([key], {
        [key]: config.sources[key] ?? { enabled: true },
      });
      if (existing.length > 0) {
        for (const s of existing) {
          ctx.engine.enableSource(s.id, config).catch((err) => {
            log.error(`Failed to enable source ${s.id}: ${toErrorMessage(err)}`);
          });
        }
      } else {
        // Not registered yet — fall through to full setup.
        const newConfigs: Record<string, SourceConfig> = {
          [key]: config.sources[key] ?? { enabled: true },
        };
        for (const failure of await ctx.setupSources(newConfigs, [key])) {
          log.warn(`applySnapshot enable: ${failure.key} was not set up: ${failure.error}`);
        }
        const newSources = ctx.findSourcesForKeys([key], newConfigs);
        if (newSources.length > 0) {
          ctx.engine.startSourceSyncLoops(newSources, config).catch((err) => {
            log.error(`applySnapshot enable: failed to start sync: ${toErrorMessage(err)}`);
          });
        }
      }
    }
  }
}
