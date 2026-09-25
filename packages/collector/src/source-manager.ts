// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isDeepStrictEqual } from "node:util";

import {
  createLogger,
  DEFAULT_CONFIG_DIR,
  toErrorMessage,
  parseSourceKey,
  WsInvalidInputError,
} from "@omnesis/core";
import { AccountId, SourceId, SourceType, trySourceType } from "@omnesis/types";
import { isDrivenByHost } from "@omnesis/source-sdk";
import {
  allDescriptors as defaultDescriptors,
  allDefinitions as defaultDefinitions,
} from "./source-descriptors.js";
import {
  anotherEnabledKeyAddresses,
  buildSourceToProviderMap,
  configKeyAddressesSource,
  isSourceEnabled,
  sourceConfigFingerprint,
  SourceConfigReconciler,
} from "./source-config-reconciler.js";
import { newSourceConfigRefusal, setupSources as runSetupSources } from "./source-instantiator.js";
import type { SourceSetupFailure } from "./source-instantiator.js";
import type { SourceConfig, AttachmentExtractFn, AudioTranscribeFn } from "@omnesis/core";
import type {
  AccountDescriptor,
  DocumentEventProfile,
  GatewayClient,
  SourceDescriptor,
  SourceOrProviderDefinition,
  WidgetOrigins,
  WidgetRendererSpec,
  ImportCallbacks,
  ImportSummary,
} from "@omnesis/source-sdk";
import type { DocumentIngestionContext, MultiDeviceMode, ProviderType } from "@omnesis/types";
import type { CollectorInternalConfig } from "./internal-config.js";
import type { RegisteredSource, SyncEngine } from "./sync-engine.js";

export {
  anotherEnabledKeyAddresses,
  buildSourceToProviderMap,
  configKeyAddressesSource,
  getEnabledProviderIds,
  isSourceEnabled,
  SourceConfigReconciler,
} from "./source-config-reconciler.js";
export { setupSources } from "./source-instantiator.js";

const log = createLogger("collector:sources");

const defaultSourceToProvider = buildSourceToProviderMap(defaultDescriptors);

/** One url-id pattern declared on a source/provider definition. */
type KnownUrlPattern = { regex: string; idGroup?: number };

/**
 * Collect the url-id pattern regexes declared by *every* source definition —
 * added or not. The gateway's link-extraction keep-gate keys on this full
 * known set so a link to a not-yet-added source is kept and resolves once
 * that source is added (#668), instead of being dropped permanently.
 *
 * Exported so both the production push (`SourceManager.pushKnownUrlPatterns`)
 * and the synthetic E2E harness derive the set the same way.
 */
export function collectKnownUrlPatterns(
  definitions: readonly SourceOrProviderDefinition[],
): Array<{ regex: string }> {
  const patterns: Array<{ regex: string }> = [];
  const collect = (urlPatterns: KnownUrlPattern[] | undefined): void => {
    for (const p of urlPatterns ?? []) patterns.push({ regex: p.regex });
  };
  for (const def of definitions) {
    if (def.type === "provider") {
      for (const source of def.sources) collect(source.urlPatterns);
    } else {
      collect(def.urlPatterns);
    }
  }
  return patterns;
}

/**
 * Collect the union of web hosts declared `ownedWebDomains` by *every* source
 * definition — added or not. The gateway serves this union so the
 * browser-capture source (#791) can skip any visited host already owned by a
 * dedicated source, instead of double-ingesting it.
 *
 * Entries are trimmed, lowercased, and de-duplicated. Exported so both the
 * production push (`SourceManager.pushOwnedWebDomains`) and the synthetic E2E
 * harness derive the set the same way.
 */
export function collectOwnedWebDomains(
  definitions: readonly SourceOrProviderDefinition[],
): string[] {
  const out = new Set<string>();
  const collect = (domains: string[] | undefined): void => {
    for (const d of domains ?? []) {
      const host = d.trim().toLowerCase();
      if (host) out.add(host);
    }
  };
  for (const def of definitions) {
    if (def.type === "provider") {
      for (const source of def.sources) collect(source.ownedWebDomains);
    } else {
      collect(def.ownedWebDomains);
    }
  }
  return [...out].sort();
}

/**
 * Collect the `documentEventProfile` declared by *every* source definition —
 * added or not — as `{ sourceType, profile }` entries. The gateway persists
 * them so subscription compilation can learn what each source's documents can
 * be asked about without holding source-specific knowledge itself.
 *
 * Definitions that declare no profile contribute nothing; their documents stay
 * addressable only through the fields every document has. Entries are sorted
 * by source type so a re-push produces a stable set. Exported so both the
 * production push (`SourceManager.pushDocumentEventProfiles`) and the
 * synthetic E2E harness derive it the same way.
 */
export function collectDocumentEventProfiles(
  definitions: readonly SourceOrProviderDefinition[],
): Array<{ sourceType: string; profile: DocumentEventProfile }> {
  const entries: Array<{ sourceType: string; profile: DocumentEventProfile }> = [];
  const collect = (sourceType: string, profile: DocumentEventProfile | undefined): void => {
    if (profile) entries.push({ sourceType, profile });
  };
  for (const def of definitions) {
    if (def.type === "provider") {
      for (const source of def.sources) collect(source.id, source.documentEventProfile);
    } else {
      collect(def.id, def.documentEventProfile);
    }
  }
  return entries.sort((a, b) => a.sourceType.localeCompare(b.sourceType));
}

/** Aggregated widget-vendor origins per CSP fetch directive. */
type AggregatedWidgetOrigins = { script: string[]; frame: string[]; connect: string[] };

/**
 * Collect the union of external widget-vendor origins declared `widgetOrigins`
 * by *every* source definition — added or not. The gateway folds the aggregate
 * into the portal CSP so a `link-widget` source's hosted widget (Plaid Link, …)
 * can load its vendor SDK + iframe in the browser.
 *
 * `widgetOrigins` is a provider-level concern (the SDK is shared across a
 * provider's sources), so for a `ProviderDefinition` it's read once off the
 * provider, not per source entry. Entries are de-duplicated and sorted per
 * directive. Exported so both the production push
 * (`SourceManager.pushWidgetOrigins`) and the synthetic E2E harness derive the
 * set the same way.
 */
export function collectWidgetOrigins(
  definitions: readonly SourceOrProviderDefinition[],
): AggregatedWidgetOrigins {
  const script = new Set<string>();
  const frame = new Set<string>();
  const connect = new Set<string>();
  const collect = (w: WidgetOrigins | undefined): void => {
    if (!w) return;
    for (const s of w.script ?? []) if (s.trim()) script.add(s.trim());
    for (const f of w.frame ?? []) if (f.trim()) frame.add(f.trim());
    for (const c of w.connect ?? []) if (c.trim()) connect.add(c.trim());
  };
  for (const def of definitions) collect(def.widgetOrigins);
  return {
    script: [...script].sort(),
    frame: [...frame].sort(),
    connect: [...connect].sort(),
  };
}

/**
 * Collect the provider-owned browser renderer modules declared by every known
 * `link-widget` source/provider. The gateway serves these modules under a
 * same-origin portal route, and the portal imports by opaque widget `kind`.
 */
export function collectWidgetRenderers(
  definitions: readonly SourceOrProviderDefinition[],
): WidgetRendererSpec[] {
  const byKind = new Map<string, WidgetRendererSpec>();
  for (const def of definitions) {
    const renderer = def.widgetRenderer;
    const kind = renderer?.kind?.trim();
    const modulePath = renderer?.modulePath?.trim();
    if (!kind || !modulePath) continue;
    const prior = byKind.get(kind);
    if (prior && prior.modulePath !== modulePath) {
      throw new Error(
        `Conflicting widget renderer declarations for kind '${kind}': ${prior.modulePath} vs ${modulePath}`,
      );
    }
    byKind.set(kind, { kind, modulePath });
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export interface AddSourcesRequest {
  descriptorId: string;
  accountIds: string[];
  params?: Record<string, string>;
}

/**
 * Options for injecting test dependencies into SourceManager.
 * Used by E2E tests to provide mock providers/descriptors without
 * touching real data sources.
 */
export interface SourceManagerOptions {
  /** Override the default definitions */
  definitions?: SourceOrProviderDefinition[];
  /** Override the default source descriptors */
  descriptors?: SourceDescriptor[];
  /** Override the config file save path */
  configPath?: string;
  /** Attachment extraction function (from collector's unpdf wrapper) */
  extractAttachment?: AttachmentExtractFn;
  /**
   * Audio transcription function (forwards bytes to the gateway's
   * `/inference/transcribe`). Wired only when the `stt` experimental feature
   * is enabled — when unset, sources skip voice-note transcription entirely
   * and never download audio.
   */
  transcribeAudio?: AudioTranscribeFn;
  /**
   * Collector config directory threaded into each source's
   * `CreateOptions.configDir` and lifecycle hooks. The production collector
   * passes its resolved boot-time config dir; tests may inject an isolated dir.
   * When unset, SourceManager falls back to `OMNESIS_CONFIG_DIR` / the default.
   */
  configDir?: string;
  /** Source-device context threaded into provider factories. */
  ingestionContext?: DocumentIngestionContext;
}

/**
 * Manages the lifecycle of data sources: add, disable, enable, remove.
 * Owns the config state and coordinates between config file, SyncEngine, and Gateway.
 *
 * All config mutations go through this class. The CLI communicates via HTTP
 * endpoints that delegate to these methods, ensuring atomic operations.
 */

export class SourceManager {
  private config: CollectorInternalConfig;
  private registeredSourceKeys = new Set<string>();
  /** Gateway-assigned local settings, published before source setup yields. */
  private locallyAssignedSources = new Map<string, SourceConfig>();
  private latestSnapshotTask: Promise<void> = Promise.resolve();
  private snapshotRevision = 0;
  private fullSnapshotRevision = 0;
  private singleInstanceAddsInFlight = new Set<string>();
  private sourceAddsInFlight = new Set<string>();
  private _definitions: SourceOrProviderDefinition[];
  private _descriptors: SourceDescriptor[];
  private _sourceToProvider: Map<SourceType, ProviderType>;
  private _configPath: string | undefined;
  private _extractAttachment?: AttachmentExtractFn;
  private _transcribeAudio?: AudioTranscribeFn;
  private _configDir: string | undefined;
  private _ingestionContext: DocumentIngestionContext | undefined;
  /** Gateway-owned mode contract, retained across local re-instantiation. */
  private sourceMultiDeviceModes = new Map<string, MultiDeviceMode>();
  private reconciler: SourceConfigReconciler;

  constructor(
    private engine: SyncEngine,
    private gateway: GatewayClient,
    initialConfig: CollectorInternalConfig,
    opts?: SourceManagerOptions,
  ) {
    this.config = initialConfig;
    this._definitions = opts?.definitions ?? defaultDefinitions;
    this._descriptors = opts?.descriptors ?? defaultDescriptors;
    this._sourceToProvider = opts?.descriptors
      ? buildSourceToProviderMap(opts.descriptors)
      : defaultSourceToProvider;
    this._configPath = opts?.configPath;
    this._extractAttachment = opts?.extractAttachment;
    this._transcribeAudio = opts?.transcribeAudio;
    this._configDir = opts?.configDir;
    this._ingestionContext = opts?.ingestionContext;
    this.reconciler = new SourceConfigReconciler({
      getConfig: () => this.config,
      getRegisteredKeys: () => this.registeredSourceKeys,
      engine: this.engine,
      setupSources: (enabled, keys) => this.setupAndAudit(enabled, keys),
      setMultiDeviceMode: (sourceId, mode) => this.sourceMultiDeviceModes.set(sourceId, mode),
      clearMultiDeviceMode: (sourceId) => this.sourceMultiDeviceModes.delete(sourceId),
      findSourcesForKeys: (keys, enabled) => this.findSourcesForKeys(keys, enabled),
      saveConfig: () => this.saveConfig(),
    });
  }

  /** Get the descriptors this manager was configured with */
  getDescriptors(): SourceDescriptor[] {
    return this._descriptors;
  }

  getKnownUrlPatterns(): Array<{ regex: string }> {
    return collectKnownUrlPatterns(this._definitions);
  }

  /**
   * Push the url-id patterns declared by every KNOWN source type to the
   * gateway — not just the added ones. Supplies the pattern component of the
   * engine's atomic `pushLinkDeclarations` bundle, using sources from
   * the full definition set (`_definitions`, every loaded provider) rather
   * than the registry of instantiated sources. The gateway uses the set as
   * the link-extraction keep-gate so a link to a first-class source the
   * user hasn't added yet (e.g. a Notion URL before Notion is a source)
   * survives and resolves once that source is added and ingested, instead
   * of being dropped permanently (#668).
   *
   * Idempotent; safe to call repeatedly. Fire-and-forget at the call site —
   * the gateway falls back to the registered-pattern set if this fails.
   */
  async pushKnownUrlPatterns(): Promise<void> {
    const patterns = collectKnownUrlPatterns(this._definitions);
    log.info(
      `pushKnownUrlPatterns: ${this._definitions.length} definition(s), ${patterns.length} url-id pattern(s)`,
    );
    try {
      await this.gateway.setKnownUrlPatterns(patterns);
      log.info(`Pushed ${patterns.length} known url-id pattern(s) to gateway`);
    } catch (err) {
      log.warn(`Failed to push known url-id patterns (continuing): ${toErrorMessage(err)}`);
    }
  }

  /**
   * Push the union of every known source type's `ownedWebDomains` to the
   * gateway, which serves it so the browser-capture source (#791) skips any
   * visited host already owned by a dedicated source.
   *
   * Idempotent; safe to call repeatedly. Fire-and-forget at the call site —
   * the gateway falls back to an empty set (skip nothing extra) if this fails.
   */
  async pushOwnedWebDomains(): Promise<void> {
    const domains = collectOwnedWebDomains(this._definitions);
    try {
      await this.gateway.setOwnedWebDomains(domains);
      log.info(`Pushed ${domains.length} owned web domain(s) to gateway`);
    } catch (err) {
      log.warn(`Failed to push owned web domains (continuing): ${toErrorMessage(err)}`);
    }
  }

  /**
   * Push the `documentEventProfile` of every known source type to the gateway,
   * which persists it so subscription compilation can address this source's
   * documents by document type, person role, and metadata field.
   *
   * Idempotent; safe to call repeatedly. Fire-and-forget at the call site —
   * on failure the gateway keeps the previously persisted set, which is the
   * point of persisting it.
   */
  async pushDocumentEventProfiles(): Promise<void> {
    const entries = collectDocumentEventProfiles(this._definitions);
    try {
      await this.gateway.setDocumentEventProfiles(entries);
      log.info(`Pushed ${entries.length} document-event profile(s) to gateway`);
    } catch (err) {
      log.warn(`Failed to push document-event profiles (continuing): ${toErrorMessage(err)}`);
    }
  }

  /**
   * Push the union of external widget-vendor origins declared by every known
   * `link-widget` source's `widgetOrigins` to the gateway, which folds them
   * into the portal's CSP so a source's hosted widget (Plaid Link, …) can load
   * its vendor SDK + iframe in the browser.
   *
   * Idempotent; safe to call repeatedly. Fire-and-forget at the call site — the
   * gateway falls back to a strictly self-hosted CSP (widget blocked) if this
   * fails.
   */
  async pushWidgetOrigins(): Promise<void> {
    const origins = collectWidgetOrigins(this._definitions);
    try {
      await this.gateway.setWidgetOrigins(origins);
      log.info(
        `Pushed widget origins to gateway: ${origins.script.length} script, ${origins.frame.length} frame, ${origins.connect.length} connect`,
      );
    } catch (err) {
      log.warn(`Failed to push widget origins (continuing): ${toErrorMessage(err)}`);
    }
  }

  /**
   * Push the provider-owned renderer modules declared by every known
   * `link-widget` source to the gateway. Fire-and-forget at the call site —
   * the portal will render its generic unsupported-widget fallback if this
   * registration fails.
   */
  async pushWidgetRenderers(): Promise<void> {
    let renderers: WidgetRendererSpec[];
    try {
      renderers = collectWidgetRenderers(this._definitions);
    } catch (err) {
      log.warn(`Failed to collect widget renderers (continuing): ${toErrorMessage(err)}`);
      return;
    }
    try {
      await this.gateway.setWidgetRenderers(renderers);
      log.info(`Pushed ${renderers.length} widget renderer(s) to gateway`);
    } catch (err) {
      log.warn(`Failed to push widget renderers (continuing): ${toErrorMessage(err)}`);
    }
  }

  getConfig(): CollectorInternalConfig {
    return this.config;
  }

  getConfigDir(): string {
    return this._configDir ?? process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  }

  getConfiguredSources(): Record<string, SourceConfig> {
    return this.config.sources ?? {};
  }

  async resolveAccountId(descriptorId: string, params: Record<string, string>): Promise<string> {
    const descriptor = this._descriptors.find((candidate) => String(candidate.id) === descriptorId);
    if (!descriptor?.resolveAccountId) {
      throw new WsInvalidInputError(`${descriptorId} does not derive an account from settings`);
    }
    const prefix = `${descriptorId}:`;
    const existing = [...this.locallyAssignedSources.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, config]) => ({
        accountId: key.slice(prefix.length),
        params: config.params,
      }));
    return String(AccountId(await descriptor.resolveAccountId(params, existing)));
  }

  /**
   * Previously wrote collector configuration to `collector.json`. The gateway
   * now owns the unified config file and the
   * collector is purely a consumer — any runtime mutation that used to call
   * this should go through `PATCH /admin/config` so it hits the file via
   * the gateway's config-store. Kept as a no-op to avoid churning the 5
   * existing call sites inside this class; they'll be dropped alongside the
   * mutation paths when those move to the config-store.
   */
  private saveConfig(): void {
    // no-op — gateway config-store is authoritative for the file.
  }

  // ---------------------------------------------------------------------------
  // Gateway-driven snapshot reconciliation (#166)
  // ---------------------------------------------------------------------------

  /**
   * Apply a sources snapshot pushed by the gateway over WS. Delegates to
   * SourceConfigReconciler which owns the diff + transition logic.
   */
  async applySourcesSnapshot(
    records: Array<{
      id: string;
      type?: string;
      accountId?: string;
      config?: unknown;
      enabled?: boolean;
      multiDeviceMode?: MultiDeviceMode;
    }>,
    opts: { merge?: boolean } = {},
  ): Promise<void> {
    // Publish effective local settings before setup yields. ID resolution and
    // add guards must see the same authoritative path as the pending snapshot.
    this.snapshotRevision++;
    if (!opts.merge) {
      this.fullSnapshotRevision++;
      this.locallyAssignedSources.clear();
    }
    for (const record of records) {
      const config =
        record.config && typeof record.config === "object"
          ? (record.config as Partial<SourceConfig>)
          : {};
      this.locallyAssignedSources.set(record.id, { ...config, enabled: record.enabled !== false });
    }
    const task = this.reconciler.applySnapshot(records, opts);
    this.latestSnapshotTask = task.catch(() => undefined);
    await task;
  }

  // ---------------------------------------------------------------------------
  // API operations (called by HTTP endpoints)
  // ---------------------------------------------------------------------------

  addSources(request: AddSourcesRequest): Promise<{ sourceIds: string[] }> {
    const descriptorId = String(request.descriptorId);
    const descriptor = this._descriptors.find((candidate) => String(candidate.id) === descriptorId);
    const keys = [...new Set(request.accountIds)].map(
      (accountId) => `${descriptorId}:${accountId}`,
    );
    if (
      (descriptor?.singleInstance && this.singleInstanceAddsInFlight.has(descriptorId)) ||
      keys.some((key) => this.sourceAddsInFlight.has(key))
    ) {
      return Promise.reject(
        new Error(`${descriptorId} is already being added on this collector; wait and retry`),
      );
    }
    if (descriptor?.singleInstance) this.singleInstanceAddsInFlight.add(descriptorId);
    for (const key of keys) this.sourceAddsInFlight.add(key);
    return this.addSourcesInternal(request).finally(() => {
      this.singleInstanceAddsInFlight.delete(descriptorId);
      for (const key of keys) this.sourceAddsInFlight.delete(key);
    });
  }

  private async addSourcesInternal(request: AddSourcesRequest): Promise<{ sourceIds: string[] }> {
    if (!this.config.sources) this.config.sources = {};

    // Per-descriptor suggested sync interval — applied at add time so
    // rate-limited sources (Notion) pick a safer default than the global
    // 5m. User can override later by editing the source's config.
    const addDescriptor = this._descriptors.find(
      (d) => String(d.id) === String(request.descriptorId),
    );
    const defaultSyncInterval = addDescriptor?.defaultSyncInterval;

    if (addDescriptor?.resolveAccountId) {
      if (request.accountIds.length !== 1) {
        throw new WsInvalidInputError(`${request.descriptorId} requires one account`);
      }
      const resolved = await this.resolveAccountId(
        String(request.descriptorId),
        request.params ?? {},
      );
      if (request.accountIds[0] !== resolved) {
        throw new WsInvalidInputError(
          `${request.descriptorId} settings resolve to account ${resolved}, not ${request.accountIds[0]}`,
        );
      }
    }

    // What the source says about each account it can see. Discovery is offline
    // and cheap for every provider — it reads a directory — and this is the
    // only place that has both the descriptor and the accounts being added, so
    // it is where the two meet. A source that declares nothing yields nothing,
    // and the gateway falls back to the id exactly as it does today.
    const declaredAccounts = new Map<string, AccountDescriptor>();
    try {
      for (const account of (await addDescriptor?.discover?.({ configDir: this._configDir })) ??
        []) {
        declaredAccounts.set(String(account.id), account);
      }
    } catch (err) {
      // Never fail an add over descriptive metadata. Whatever stopped
      // discovery will stop the sync too, and be reported there with the
      // detail this path does not have.
      log.debug(
        `Could not read account descriptors for ${request.descriptorId}: ${toErrorMessage(err)}`,
      );
    }

    // `singleInstance` is per collector host, not gateway-wide. Enforce it
    // here, at the host that will instantiate the provider, rather than
    // trusting a picker's possibly stale snapshot. This section deliberately
    // contains no await: the reservation below makes two concurrent adds see
    // one another before either request reaches the gateway.
    const distinctAccountIds = [...new Set(request.accountIds)];
    for (const accountId of distinctAccountIds) {
      const key = `${request.descriptorId}:${accountId}`;
      const current = this.locallyAssignedSources.get(key);
      if (current?.enabled === false) {
        throw new WsInvalidInputError(`${key} is paused; resume it before changing its settings`);
      }
      if (!current || !request.params) continue;
      const changed = Object.entries(request.params).some(
        ([name, value]) => current.params?.[name] !== value,
      );
      if (changed) {
        const pathParam = addDescriptor?.params?.find(
          (param) => param.type === "path" && current.params?.[param.name],
        );
        const currentPath = pathParam ? ` for ${current.params![pathParam.name]}` : "";
        throw new WsInvalidInputError(
          `${key} is already configured${currentPath}; update this source's settings explicitly`,
        );
      }
    }
    if (addDescriptor?.singleInstance) {
      if (distinctAccountIds.length !== 1) {
        throw new Error(
          `${request.descriptorId} allows one account per collector; choose exactly one account`,
        );
      }
      const requestedKey = `${request.descriptorId}:${distinctAccountIds[0]}`;
      const prefix = `${request.descriptorId}:`;
      const locallyAssignedKeys = new Set([
        ...this.registeredSourceKeys,
        ...this.engine.unhostedEntries().map((entry) => entry.sourceId),
      ]);
      const conflictingKey = [...locallyAssignedKeys].find(
        (key) => key.startsWith(prefix) && key !== requestedKey,
      );
      if (conflictingKey) {
        throw new Error(
          `${request.descriptorId} already has ${conflictingKey} configured on this collector`,
        );
      }
    }

    // Build the sourceIds + per-key config WITHOUT mutating shared state
    // yet. We register with the gateway first; only after that succeeds do
    // we commit the in-memory mirror + engine setup. Closes
    // cli-add-not-atomic-leaves-source-half-registered: the previous flow
    // ran local setup first and only best-effort'd the gateway upsert,
    // which left the user with creds-on-disk + collector-config-set + no
    // gateway row when the upsert failed (the half-registered state).
    const sourceIds: string[] = [];
    const stagedConfigs: Record<string, SourceConfig> = {};
    for (const accountId of distinctAccountIds) {
      const key = `${request.descriptorId}:${accountId}`;
      sourceIds.push(key);
      const current = this.locallyAssignedSources.get(key);
      stagedConfigs[key] = {
        ...current,
        enabled: true,
        syncInterval: current?.syncInterval ?? defaultSyncInterval,
        params:
          request.params && Object.keys(request.params).length > 0
            ? { ...current?.params, ...request.params }
            : current?.params,
      };
    }

    // Validate each effective config before the gateway hears of it. A repeat
    // add may omit settings already held by this collector; a fresh account
    // still has to supply every required setting.
    for (const key of sourceIds) {
      const refusal = newSourceConfigRefusal(
        this.sourceDefinition(String(request.descriptorId))?.config,
        stagedConfigs[key].params,
        String(request.descriptorId),
      );
      if (refusal) throw new WsInvalidInputError(refusal);
    }

    // A repeated add of an already hosted local source has no work to do.
    // Avoid writing a staged copy after an explicit settings update lands.
    if (
      addDescriptor?.authType === "local" &&
      sourceIds.every(
        (key) =>
          this.registeredSourceKeys.has(key) && this.locallyAssignedSources.get(key)?.enabled,
      )
    ) {
      return { sourceIds };
    }

    // Mark keys as tracked BEFORE the gateway upsert. The gateway broadcasts
    // the updated sources.snapshot over the device WS the moment the upsert
    // lands — before our HTTP response resolves — so the snapshot reconciler
    // can run while we're still awaiting. Unmarked keys would make it set up
    // the same source a second time: two live provider instances for one
    // account, which for a socket-holding provider (WhatsApp) means the two
    // connections mutually evict each other (440 conflict loop). Marked keys
    // make the reconciler skip setup and leave it to us. Rolled back below if
    // the upsert fails, preserving the no-local-state-on-failure contract.
    const reservedKeys = sourceIds.filter((key) => !this.registeredSourceKeys.has(key));
    const snapshotRevisionBeforeUpsert = this.snapshotRevision;
    const fullSnapshotRevisionBeforeUpsert = this.fullSnapshotRevision;
    const assignmentsBeforeUpsert = new Map(
      sourceIds.map((key) => [key, this.locallyAssignedSources.get(key)]),
    );
    for (const key of reservedKeys) this.registeredSourceKeys.add(key);

    // 1. Persist to the gateway FIRST. If this throws we return without
    // touching any local state — the user retries, the discover-based
    // skip-OAuth path picks up the on-disk credentials, and the next
    // /admin/sources/add lands cleanly.
    //
    // The HTTP client retries 503s + transient network errors internally,
    // so by the time bulkUpsertSources throws here it's a hard failure
    // (gateway down / wrong scope / persistent 5xx). Surfacing it is the
    // correct UX — the alternative ("succeed locally and warn the user
    // about orphan drift") was the bug.
    let upsertResult: Awaited<ReturnType<GatewayClient["bulkUpsertSources"]>>;
    const memberConfigIds = new Set<string>();
    try {
      upsertResult = await this.gateway.bulkUpsertSources(
        distinctAccountIds.map((accountId) => {
          const cfg = stagedConfigs[`${request.descriptorId}:${accountId}`];
          const memberParamNames = new Set(
            addDescriptor?.memberScopedParamNames ??
              (addDescriptor?.params ?? [])
                .filter((param) => param.scope === "member")
                .map((param) => param.name),
          );
          const sharedParams: Record<string, string> = {};
          const memberParams: Record<string, string> = {};
          for (const [name, value] of Object.entries(cfg.params ?? {})) {
            (memberParamNames.has(name) ? memberParams : sharedParams)[name] = value;
          }
          const declared = declaredAccounts.get(String(accountId));
          const sharedConfig: SourceConfig = {
            ...cfg,
            params: Object.keys(sharedParams).length > 0 ? sharedParams : undefined,
          };
          const memberConfig =
            memberParamNames.size > 0
              ? Object.keys(memberParams).length > 0
                ? { params: memberParams }
                : {}
              : undefined;
          const id = `${request.descriptorId}:${accountId}`;
          if (memberConfig) memberConfigIds.add(id);
          return {
            type: SourceType(request.descriptorId),
            accountId: AccountId(accountId),
            ...(declared ? { account: declared } : {}),
            config: sharedConfig as unknown as Record<string, unknown>,
            memberConfig,
            enabled: true,
          };
        }),
      );
    } catch (err) {
      // Roll back the early tracking marks — nothing was persisted anywhere.
      for (const key of reservedKeys) this.registeredSourceKeys.delete(key);
      throw new Error(
        `Failed to register source(s) [${sourceIds.join(", ")}] on gateway: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
    // The HTTP call succeeds with per-entry results; a rejected entry
    // (e.g. the account is already hosted by another collector — the
    // gateway refuses the silent adoption, #1513) failed for good and must
    // not become a local instance syncing a source this host doesn't own.
    // Entries that DID land have live gateway rows, so they are committed
    // locally like any successful add; only the rejected keys roll back,
    // and the error thrown at the end names exactly those.
    const missingMemberConfigAck = new Set(
      upsertResult.sources
        .filter((source) => memberConfigIds.has(source.id) && source.memberConfigApplied !== true)
        .map((source) => source.id),
    );
    const acceptedIdSet = new Set(
      upsertResult.sources
        .filter((source) => !missingMemberConfigAck.has(source.id))
        .map((source) => source.id),
    );
    const rejectedKeys = sourceIds.filter((key) => !acceptedIdSet.has(key));
    const acceptedKeys = sourceIds.filter((key) => acceptedIdSet.has(key));
    for (const key of rejectedKeys) {
      if (reservedKeys.includes(key)) this.registeredSourceKeys.delete(key);
      delete stagedConfigs[key];
    }
    if (acceptedKeys.length === 0 && rejectedKeys.length > 0) {
      const memberConfigError = missingMemberConfigAck.size
        ? "gateway did not acknowledge member-local configuration; update the gateway before adding this source"
        : "";
      throw new Error(
        `Failed to register source(s) [${rejectedKeys.join(", ")}]: ${[
          memberConfigError,
          ...upsertResult.errors.map((e) => e.error),
        ]
          .filter(Boolean)
          .join("; ")}`,
      );
    }

    // A gateway snapshot can land while the HTTP upsert is outstanding.
    // Let its queued setup finish before deciding which accepted keys still
    // need setup here.
    if (this.snapshotRevision !== snapshotRevisionBeforeUpsert) {
      let task: Promise<void>;
      do {
        task = this.latestSnapshotTask;
        await task;
      } while (task !== this.latestSnapshotTask);
    }
    if (
      acceptedKeys.some(
        (key) =>
          (this.fullSnapshotRevision !== fullSnapshotRevisionBeforeUpsert &&
            !this.locallyAssignedSources.has(key)) ||
          this.locallyAssignedSources.get(key)?.enabled === false,
      )
    ) {
      for (const key of reservedKeys) {
        if (!this.locallyAssignedSources.has(key)) this.registeredSourceKeys.delete(key);
      }
      throw new Error("Source assignment changed while it was being added; retry the add");
    }

    // 2. Gateway accepted the upsert — now commit the in-memory mirror.
    const snapshotManagedKeys = new Set<string>();
    for (const key of acceptedKeys) {
      const latest = this.locallyAssignedSources.get(key);
      if (
        latest &&
        latest !== assignmentsBeforeUpsert.get(key) &&
        sourceConfigFingerprint(latest) === sourceConfigFingerprint(stagedConfigs[key]) &&
        this.engine.getSourcesById(key).length > 0
      ) {
        snapshotManagedKeys.add(key);
      }
      const effective =
        latest && latest !== assignmentsBeforeUpsert.get(key) ? latest : stagedConfigs[key];
      this.config.sources[key] = effective;
      this.locallyAssignedSources.set(key, effective);
    }

    this.saveConfig();

    // Register and start sync
    const newEnabledSources: Record<string, SourceConfig> = {};
    for (const key of acceptedKeys) {
      if (snapshotManagedKeys.has(key)) continue;
      newEnabledSources[key] = this.config.sources[key];
    }

    // Expand the enabled-sources set to include any *sibling* sources from
    // the SAME provider account that are already configured. This is what
    // makes a re-auth (`cli add <one-source>`) heal every source under the
    // provider — without expansion, `setupProviderDefinition` filters down
    // to just the new source and only re-creates that source's instance,
    // leaving siblings stuck with their stale in-memory tokens until a
    // collector restart.
    //
    // Example: revoking Google access flips gmail + google-calendar +
    // google-contacts + google-drive to needs-auth. Re-running `cli add
    // google-calendar` writes fresh tokens to disk; before this expansion
    // only google-calendar got re-registered, leaving the other 3 stuck.
    //
    // Closes finding: cli-add-reauth-doesnt-propagate-to-sibling-sources.
    const expandedEnabledSources: Record<string, SourceConfig> = { ...newEnabledSources };
    const requestSourceType = trySourceType(request.descriptorId);
    const requestProviderType = requestSourceType
      ? this._sourceToProvider.get(requestSourceType)
      : undefined;
    if (requestProviderType) {
      for (const accountId of request.accountIds) {
        for (const [key, cfg] of Object.entries(this.config.sources)) {
          if (!cfg?.enabled) continue;
          if (expandedEnabledSources[key]) continue;
          if (snapshotManagedKeys.has(key)) continue;
          // Only siblings THIS collector hosts. The config mirror is
          // gateway-global (it names every source on every device), so an
          // unregistered same-provider key here is usually another
          // device's source — instantiating it would sync a source this
          // host doesn't own (#1513), and the reconciler could never
          // clean it up (it only sweeps registered keys).
          if (!this.registeredSourceKeys.has(key)) continue;
          const { sourceType, accountId: siblingAccount } = parseSourceKey(key);
          if (String(siblingAccount) !== accountId) continue;
          const siblingProviderType = this._sourceToProvider.get(sourceType);
          if (siblingProviderType !== requestProviderType) continue;
          expandedEnabledSources[key] = cfg;
        }
      }
    }

    let setupRevision = this.snapshotRevision;
    const unbacked = await this.setupAndAudit(
      expandedEnabledSources,
      acceptedKeys.filter((key) => !snapshotManagedKeys.has(key)),
      new Set(acceptedKeys.filter((key) => !snapshotManagedKeys.has(key))),
    );
    const unbackedByKey = new Map(unbacked.map((failure) => [failure.key, failure]));
    while (this.snapshotRevision !== setupRevision) {
      let task: Promise<void>;
      do {
        task = this.latestSnapshotTask;
        await task;
      } while (task !== this.latestSnapshotTask);
      const changed: Record<string, SourceConfig> = {};
      for (const key of acceptedKeys) {
        const latest = this.locallyAssignedSources.get(key);
        if (!latest || latest.enabled === false) {
          for (const status of this.engine.getStatuses()) {
            if (configKeyAddressesSource(key, status.sourceId)) {
              await this.engine.unregisterSource(status.sourceId);
            }
          }
          if (!latest) {
            delete this.config.sources[key];
            this.registeredSourceKeys.delete(key);
          } else {
            this.config.sources[key] = latest;
          }
          throw new Error("Source assignment changed while it was being added; retry the add");
        }
        if (snapshotManagedKeys.has(key)) continue;
        if (isDeepStrictEqual(expandedEnabledSources[key], latest)) continue;
        this.config.sources[key] = latest;
        expandedEnabledSources[key] = latest;
        changed[key] = latest;
      }
      setupRevision = this.snapshotRevision;
      if (Object.keys(changed).length > 0) {
        const failures = await this.setupAndAudit(changed, Object.keys(changed));
        for (const key of Object.keys(changed)) unbackedByKey.delete(key);
        for (const failure of failures) unbackedByKey.set(failure.key, failure);
      }
    }
    const unbackedKeys = new Set(unbackedByKey.keys());
    const finalUnbacked = [...unbackedByKey.values()];
    const liveKeys = acceptedKeys.filter((key) => !unbackedKeys.has(key));

    // Re-arm timers for EVERY re-registered key, siblings included — the
    // scheduler's closures pin the pre-swap instances, and a tick on one of
    // those hits the stale-instance fence and silently no-ops forever. Same
    // reason reauthProvider re-arms its full matched set. Keys whose setup
    // came back unbacked have no live instance to arm.
    const rearmKeys = Object.keys(expandedEnabledSources).filter((key) => !unbackedKeys.has(key));
    const newSources = this.findSourcesForKeys(rearmKeys, expandedEnabledSources);

    // Start sync loops in the background — don't block the HTTP response.
    // Skip for push-based sources (no sync loop needed).
    const descriptor = this._descriptors.find((d) => String(d.id) === request.descriptorId);
    if (descriptor?.pushBased && liveKeys.length > 0) {
      log.info(
        `Push-based source added: ${liveKeys.join(", ")} (no sync loop; driven by external push)`,
      );
    } else if (newSources.length > 0) {
      this.engine.startSourceSyncLoops(newSources, this.config).catch((err) => {
        log.error(
          `Failed to start sync loops for new sources [${liveKeys.join(", ")}]: ${toErrorMessage(err)}`,
        );
      });
    }

    // Partial failure surfaces AFTER the accepted sources are fully set up:
    // their gateway rows are live either way, so committing them and then
    // reporting exactly which accounts were rejected is honest — silently
    // succeeding would hide the rejection, and rolling everything back
    // would leave the accepted rows to come alive on the next reconnect.
    //
    // A key the gateway accepted but that produced no instance here travels
    // the same route, for the same reason: its row is live, the sources that
    // did come up are worth keeping, and the one that did not must be named —
    // reporting it as added is what leaves an operator with a source that can
    // never sync and no way to find out why.
    if (rejectedKeys.length > 0 || finalUnbacked.length > 0) {
      const memberConfigError = missingMemberConfigAck.size
        ? "gateway did not acknowledge member-local configuration; update the gateway before adding this source"
        : "";
      const failedKeys = [...rejectedKeys, ...finalUnbacked.map((failure) => failure.key)];
      // One failure is already named by `failedKeys`; naming it again in front
      // of its own reason just reads as a stutter.
      const nameEachReason = failedKeys.length > 1;
      const reasons = [
        memberConfigError,
        ...upsertResult.errors.map((e) => e.error),
        ...finalUnbacked.map((failure) =>
          nameEachReason ? `${failure.key}: ${failure.error}` : failure.error,
        ),
      ].filter(Boolean);
      throw new Error(
        liveKeys.length > 0
          ? `Registered ${liveKeys.join(", ")}, but rejected: [${failedKeys.join(", ")}] — ${reasons.join("; ")}`
          : `Failed to register source(s) [${failedKeys.join(", ")}]: ${reasons.join("; ")}`,
      );
    }

    log.info(`Sources added: ${liveKeys.join(", ")}`);
    return { sourceIds: liveKeys };
  }

  /**
   * Run a source's one-time history import (#588) against its live instance —
   * single writer to that source's store. Throws if the source isn't running or
   * doesn't support importing.
   */
  async importHistory(
    sourceId: string,
    values: Record<string, string>,
    callbacks: ImportCallbacks,
  ): Promise<ImportSummary> {
    const [registered] = this.engine.getSourcesById(sourceId);
    if (!registered) throw new Error(`Source ${sourceId} is not running`);
    if (!registered.instance.importHistory) {
      throw new Error(`Source ${sourceId} does not support history import`);
    }
    return registered.instance.importHistory(values, callbacks);
  }

  /**
   * Re-instantiate every configured source under a `(providerType, accountId)`
   * scope so they pick up freshly-rotated tokens from disk.
   *
   * Called by the `cli reauth <provider-id>` flow *after* the OAuth subprocess
   * has already written new credentials to
   * `~/.config/omnesis/<providerType>/<accountId>/tokens.json`. Unlike
   * `addSources`, this method:
   *
   *   - does NOT mutate `config.sources`
   *   - does NOT call `gateway.bulkUpsertSources` (no rows to upsert)
   *   - does NOT reset cursors
   *
   * It walks the configured sources for the provider+account, hands the
   * subset to `doSetupSources` (which calls `engine.registerProvider` —
   * replacing in-memory instances and flipping `needs-auth` → `idle`), then
   * fires `startSourceSyncLoops` to (a) run an immediate sync on the fresh
   * instances so the user gets quick feedback that the new credentials work,
   * and (b) re-schedule the per-source timer with a closure that references
   * the NEW source instance — without that re-schedule, the existing timer's
   * closure stays pinned to the old (revoked-token) source ref and the next
   * scheduled sync still hits invalid_grant.
   */
  async reauthProvider(providerType: string, accountId: string): Promise<{ sourceIds: string[] }> {
    if (!this.config.sources) {
      throw new Error(`No sources configured for provider ${providerType}:${accountId}`);
    }

    const matchingSources: Record<string, SourceConfig> = {};
    const matchingIds: string[] = [];
    for (const [key, cfg] of Object.entries(this.config.sources)) {
      if (!cfg?.enabled) continue;
      const { sourceType, accountId: keyAccount } = parseSourceKey(key);
      if (String(keyAccount) !== accountId) continue;
      const keyProviderType = this._sourceToProvider.get(sourceType);
      if (String(keyProviderType) !== providerType) continue;
      matchingSources[key] = cfg;
      matchingIds.push(key);
    }

    if (matchingIds.length === 0) {
      throw new Error(`No enabled sources match provider ${providerType}:${accountId}`);
    }

    // Re-instantiate via the same code path that `addSources` uses for sibling
    // expansion — `engine.registerProvider` swaps source instances in place,
    // disposing the old ones (their handles to the now-revoked OAuth client)
    // and clearing `needs-auth` status on each row.
    const unbacked = await this.setupAndAudit(matchingSources, matchingIds);

    const refreshedSources = this.findSourcesForKeys(matchingIds, matchingSources);
    if (refreshedSources.length > 0) {
      this.engine.startSourceSyncLoops(refreshedSources, this.config).catch((err) => {
        log.error(
          `Reauth ${providerType}:${accountId}: failed to restart sync loops: ${toErrorMessage(err)}`,
        );
      });
    }

    // A source that could not be rebuilt has not been re-authed, whatever the
    // credentials on disk now say. Reporting it as refreshed is the same
    // silence the add path used to keep.
    if (unbacked.length > 0) {
      throw new Error(
        `Re-auth of ${providerType}:${accountId} left source(s) not running: ${unbacked
          .map((failure) => `${failure.key}: ${failure.error}`)
          .join("; ")}`,
      );
    }

    log.info(
      `Re-authed provider ${providerType}:${accountId}, refreshed sources: ${matchingIds.join(", ")}`,
    );
    return { sourceIds: matchingIds };
  }

  async disableSources(keys: string[]): Promise<void> {
    // Remove keys from tracking BEFORE saving config to prevent hot-reload race
    for (const key of keys) {
      this.registeredSourceKeys.delete(key);
      // A paused source reports nothing. Clearing any failure record here is
      // what the status loop below cannot do — an unhosted source has no status
      // for it to walk.
      this.engine.forgetUnhosted(key);
      if (this.config.sources?.[key]) {
        this.config.sources[key].enabled = false;
      }
      const assigned = this.locallyAssignedSources.get(key);
      if (assigned) this.locallyAssignedSources.set(key, { ...assigned, enabled: false });
    }
    this.saveConfig();

    for (const key of keys) {
      for (const status of this.engine.getStatuses()) {
        if (!configKeyAddressesSource(key, status.sourceId)) continue;
        if (anotherEnabledKeyAddresses(this.config.sources, status.sourceId, key)) continue;

        if (status.state !== "disabled") {
          await this.engine.disableSource(status.sourceId);
          log.info(`Source disabled: ${key} (source ${status.sourceId})`);
        }
      }
    }
  }

  async enableSources(keys: string[]): Promise<void> {
    // Mark keys as tracked BEFORE saving config to prevent hot-reload race
    for (const key of keys) {
      this.registeredSourceKeys.add(key);
      if (this.config.sources?.[key]) {
        this.config.sources[key].enabled = true;
      }
      const assigned = this.locallyAssignedSources.get(key);
      if (assigned) this.locallyAssignedSources.set(key, { ...assigned, enabled: true });
    }
    this.saveConfig();

    // Try to re-enable sources that are still registered (disabled, not removed).
    // Only fall back to full setup for sources that aren't registered at all.
    const keysNeedingSetup: string[] = [];
    const enabledSources: Record<string, SourceConfig> = {};

    for (const key of keys) {
      if (this.config.sources?.[key]) {
        enabledSources[key] = this.config.sources[key];
      }

      // Check if the source is already registered (just disabled)
      const existingSources = this.findSourcesForKeys([key], {
        [key]: enabledSources[key] ?? { enabled: true },
      });

      if (existingSources.length > 0) {
        for (const source of existingSources) {
          // enableSource starts sync in the background — don't block
          this.engine.enableSource(source.id, this.config).catch((err) => {
            log.error(`Failed to enable source ${source.id}: ${toErrorMessage(err)}`);
          });
        }
      } else {
        keysNeedingSetup.push(key);
      }
    }

    // Full setup for sources that aren't registered
    if (keysNeedingSetup.length > 0) {
      const setupSources: Record<string, SourceConfig> = {};
      for (const key of keysNeedingSetup) {
        if (enabledSources[key]) setupSources[key] = enabledSources[key];
      }

      const unbacked = await this.setupAndAudit(setupSources, keysNeedingSetup);

      const newSources = this.findSourcesForKeys(keysNeedingSetup, setupSources);
      if (newSources.length > 0) {
        // Start sync loops in the background — don't block the HTTP response
        this.engine.startSourceSyncLoops(newSources, this.config).catch((err) => {
          log.error(`Failed to start sync loops: ${toErrorMessage(err)}`);
        });
      }

      // Same contract as the add path: a key that produced no instance has
      // not been enabled, and saying otherwise is what leaves a source that
      // looks resumed and never syncs.
      if (unbacked.length > 0) {
        throw new Error(
          `Failed to enable source(s): ${unbacked
            .map((failure) => `${failure.key}: ${failure.error}`)
            .join("; ")}`,
        );
      }
    }
  }

  /**
   * Remove sources: stop syncing them, delete their data from the gateway,
   * then clean up local credentials and config.
   *
   * The order matters. Unregistering comes first so nothing schedules a new
   * sync while the slow remote delete runs — a page that starts during that
   * window lands after the data is gone and re-creates it.
   *
   * The gateway-data delete is best-effort: a 5xx during `deleteAllBySource`
   * gets logged and surfaced via the returned `failures[]` so callers can
   * report partial state to the user. Previously this failure was logged
   * and silently swallowed, so an admin watching `cli sources rm` see a
   * clean exit even when half the documents were stranded.
   */
  async removeSources(
    keys: string[],
  ): Promise<{ deleted: number; failures: Array<{ key: string; error: string }> }> {
    let totalDeleted = 0;
    const failures: Array<{ key: string; error: string }> = [];

    for (const key of keys) {
      // 1. Unregister from engine FIRST, so the source stops being scheduled
      //    before anything slow runs. Deleting the gateway's data can take
      //    tens of seconds on a large source, and every moment the source is
      //    still registered is a moment the scheduler can start a fresh sync
      //    whose pages land after the data is gone.
      //
      //    Unregistering also runs the source's `dispose()`, which closes
      //    WebSockets and flushes async writers (Baileys, future socket-using
      //    sources). It MUST happen before `cleanupCredentials` deletes the
      //    auth directory, otherwise an in-flight Baileys saveCreds debounce
      //    hits ENOENT after the dir is gone and crashes the whole collector.
      //    Awaited so dispose's flush wait actually completes.
      for (const status of [...this.engine.getStatuses()]) {
        if (!configKeyAddressesSource(key, status.sourceId)) continue;

        if (!anotherEnabledKeyAddresses(this.config.sources, status.sourceId, key)) {
          await this.engine.unregisterSource(status.sourceId);
          log.info(`Source removed: ${key} (source ${status.sourceId})`);
        }
      }

      // 2. Delete the gateway's data. The gateway runs the same purge itself
      //    when the removal came from there, so this is what covers a removal
      //    the collector initiated.
      try {
        const deleted = await this.gateway.deleteAllBySource(SourceId(key));
        totalDeleted += deleted;
      } catch (err) {
        const message = toErrorMessage(err);
        log.error(`Failed to delete data for source ${key}: ${message}`);
        failures.push({ key, error: `gateway delete failed: ${message}` });
      }

      // 3. Clean credentials — but only if no sibling source from the same
      //    provider still uses this accountId. Multi-source providers (Notion,
      //    Google, Outlook) share a single per-account credential directory
      //    (e.g. `~/.config/omnesis/notion/<workspace>/tokens.json`). Removing
      //    one source must not nuke tokens that another sibling still depends
      //    on. The previous logic only guarded against same-sourceType reuse,
      //    which missed every cross-source case.
      const { sourceType, accountId } = parseSourceKey(key);
      const descriptor = this._descriptors.find((d) => d.id === sourceType);
      if (descriptor?.cleanupCredentials) {
        const providerId = descriptor.provider.id;
        const siblingStillUses = Object.keys(this.config.sources ?? {}).some((otherKey) => {
          if (otherKey === key) return false;
          const { sourceType: otherType, accountId: otherAccount } = parseSourceKey(otherKey);
          if (otherAccount !== accountId) return false;
          const otherDesc = this._descriptors.find((d) => d.id === otherType);
          return otherDesc?.provider.id === providerId;
        });
        if (siblingStillUses) {
          log.info(
            `Skipping credential cleanup for ${key} — sibling source under provider "${providerId}" still uses account "${accountId}"`,
          );
        } else {
          try {
            await descriptor.cleanupCredentials(accountId, { configDir: this.getConfigDir() });
          } catch (err) {
            // Non-fatal — the source row is gone, the gateway data is
            // gone, but on-disk credentials may linger. Surface so the
            // caller can warn the user without breaking the remove flow.
            const message = toErrorMessage(err);
            log.warn(`cleanupCredentials failed for ${key}: ${message}`);
            failures.push({ key, error: `cleanupCredentials failed: ${message}` });
          }
        }
      }

      // 4. Remove from config
      if (this.config.sources) {
        delete this.config.sources[key];
      }
      this.registeredSourceKeys.delete(key);
      this.locallyAssignedSources.delete(key);
      this.sourceMultiDeviceModes.delete(key);
      this.engine.forgetUnhosted(key);
    }

    this.saveConfig();

    // Note: no mirror to `/admin/sources/:id` DELETE from here. The gateway
    // is authoritative — if `removeSources` runs, the deletion was either
    // initiated by the gateway (via `source.removed` WS command) or by the
    // snapshot reconciler (#166). In both cases the gateway already knows.
    // The collector's token is `read + write:*` on purpose; calling an admin
    // endpoint would only surface a 403.

    if (failures.length > 0) {
      log.warn(
        `Sources removed: ${keys.join(", ")} (${totalDeleted} deleted, ${failures.length} partial failure${failures.length === 1 ? "" : "s"})`,
      );
    } else {
      log.info(`Sources removed: ${keys.join(", ")} (${totalDeleted} deleted)`);
    }
    return { deleted: totalDeleted, failures };
  }

  // ---------------------------------------------------------------------------
  // Hot-reload (for external config changes, e.g. manual edits)
  // ---------------------------------------------------------------------------

  /**
   * Config broadcasts arrive without coordination. Apply them in arrival
   * order so a slower earlier handler cannot overwrite a newer global view.
   */
  async handleConfigChange(newConfig: CollectorInternalConfig): Promise<void> {
    const run = this.configChangeChain.then(() => this.applyConfigChange(newConfig));
    // The chain must survive a failed application, or one thrown error would
    // wedge every later broadcast.
    this.configChangeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private configChangeChain: Promise<void> = Promise.resolve();

  private applyConfigChange(newConfig: CollectorInternalConfig): void {
    // `config.changed` carries the gateway-global file. Its source blocks are
    // not addressed to this collector and may contain a sibling member's
    // machine-local paths. Per-device `sources.snapshot` / `source.updated`
    // payloads own every registered source config; preserve that effective
    // view while adopting global retention, search, indexer and interval
    // settings here. Source-setting edits are projected into the DB and
    // delivered separately as recipient-specific snapshots.
    const effectiveSources = this.config.sources;
    this.config = { ...newConfig, sources: effectiveSources };
    this.engine.updateSyncIntervals(this.config);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Set up sources from a set of enabled source configs. Delegates to
   * the source-instantiator module which owns the factory dispatch.
   */
  private async doSetupSources(
    enabledSources: Record<string, SourceConfig>,
    configDerivedAccountKeys?: ReadonlySet<string>,
  ): Promise<SourceSetupFailure[]> {
    return runSetupSources(
      {
        definitions: this._definitions,
        descriptors: this._descriptors,
        sourceToProvider: this._sourceToProvider,
        config: this.config,
        gateway: this.gateway,
        engine: this.engine,
        extractAttachment: this._extractAttachment,
        transcribeAudio: this._transcribeAudio,
        configDir: this.getConfigDir(),
        ingestionContext: this._ingestionContext,
        multiDeviceModes: this.sourceMultiDeviceModes,
        configDerivedAccountKeys,
      },
      enabledSources,
    );
  }

  /**
   * Set up `enabledSources`, then hold the outcome against the keys the caller
   * is answerable for: every one that ended with no live instance is reported
   * here rather than passing as a success.
   *
   * Two things happen to such a key, and both matter.
   *
   * It is un-latched — dropped from `registeredSourceKeys`, the set that says
   * "this host is running it". That is what makes the next `sources.snapshot`
   * (or a collector restart) see the key as new and try the add again, which
   * is the self-heal: grant the missing permission and the source comes up on
   * its own. The config entry stays, because it is a cache of the gateway's
   * view rather than a claim about what is running here.
   *
   * And it is marked unhosted, so the gateway hears the reason instead of
   * hearing nothing and rendering `idle`.
   *
   * Detection is by instance presence, never by whether a reason was reported:
   * a provider can leave a source unbuilt without throwing, and that is just as
   * much a failed add. A key the config disables is exempt — it has no instance
   * because the operator paused it, and a snapshot re-states every source it
   * knows about, paused ones included. External execution is also exempt: its
   * producer lives elsewhere, so the absence of a collector instance is expected.
   */
  /** The loaded definition of a source type, standalone or inside its provider. */
  private sourceDefinition(sourceType: string) {
    for (const definition of this._definitions) {
      const source =
        definition.type === "provider"
          ? definition.sources.find((entry) => entry.id === sourceType)
          : definition.id === sourceType
            ? definition
            : undefined;
      if (source) return source;
    }
    return undefined;
  }

  private async setupAndAudit(
    enabledSources: Record<string, SourceConfig>,
    keys: string[],
    configDerivedAccountKeys?: ReadonlySet<string>,
  ): Promise<SourceSetupFailure[]> {
    const reported = new Map<string, SourceSetupFailure>();
    for (const failure of await this.doSetupSources(enabledSources, configDerivedAccountKeys)) {
      if (!reported.has(failure.key)) reported.set(failure.key, failure);
    }

    const unbacked: SourceSetupFailure[] = [];
    for (const key of keys) {
      const { sourceType, accountId } = parseSourceKey(key);
      const descriptor = this._descriptors.find((d) => d.id === sourceType);
      // Discovery filters descriptors for platform/experimental visibility;
      // loaded definitions still own execution semantics for configured sources.
      const externallyDriven = this._definitions.some((definition) => {
        const source =
          definition.type === "provider"
            ? definition.sources.find((entry) => entry.id === sourceType)
            : definition.id === sourceType
              ? definition
              : undefined;
        return source !== undefined && !isDrivenByHost(source);
      });
      if (externallyDriven) {
        // This collector cannot assert ingestion health for an external producer.
        // Forget local setup diagnostics without emitting a successful sync.
        this.engine.forgetUnhosted(key);
        continue;
      }
      if (!isSourceEnabled(SourceId(key), enabledSources)) {
        // Paused, or named by a caller this collector has no config for.
        // Either way nothing failed, and any record from a previous attempt is
        // stale — a paused source must not keep reporting an error.
        this.engine.forgetUnhosted(key);
        continue;
      }
      if (this.findSourcesForKeys([key], enabledSources).length > 0 && !reported.has(key)) continue;
      const failure = reported.get(key) ?? {
        key,
        error: "the provider registered no instance for it",
      };
      unbacked.push(failure);
      for (const status of this.engine.getStatuses()) {
        if (configKeyAddressesSource(key, status.sourceId)) {
          await this.engine.unregisterSource(status.sourceId);
        }
      }
      this.registeredSourceKeys.delete(key);
      // Only an account-qualified key names one source. A bare `<type>` key
      // stands for every account of that type, so there is no id to report it
      // under; un-latching it is the whole of what this can do.
      if (!key.includes(":")) continue;
      const providerType = this._sourceToProvider.get(sourceType) ?? sourceType;
      this.engine.markUnhosted(key, `${providerType}:${accountId}`, failure.error, {
        sourceName: descriptor?.name,
        unitName: descriptor?.unitName,
        remediation: failure.remediation,
      });
    }
    return unbacked;
  }

  /**
   * Find registered source instances for a set of config keys.
   * Deduplicates by source ID.
   */
  private findSourcesForKeys(
    keys: string[],
    enabledSources: Record<string, SourceConfig>,
  ): RegisteredSource[] {
    const sources: RegisteredSource[] = [];
    const seen = new Set<string>();

    for (const status of this.engine.getStatuses()) {
      if (seen.has(status.sourceId)) continue;
      const matching = keys.some((k) =>
        isSourceEnabled(status.sourceId, {
          [k]: enabledSources[k] ?? { enabled: true },
        }),
      );
      if (matching) {
        sources.push(...this.engine.getSourcesById(status.sourceId));
        seen.add(status.sourceId);
      }
    }

    return sources;
  }
}
