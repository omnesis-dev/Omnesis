// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  DEFAULT_CONFIG_DIR,
  getSourceCutoffDate,
  parseSourceKey,
  toErrorMessage,
} from "@omnesis/core";
import {
  checkContractCompatibility,
  formatConfigIssues,
  hostConfigIssues,
  isDrivenByHost,
  resolveDeclaredPaths,
  nodePathProbe,
  mergeContractDeclarations,
  resolveProvider,
  withVersionedState,
} from "@omnesis/source-sdk";
import { sourceSettingKeys } from "@omnesis/config";
import {
  AccountId,
  ProviderId,
  SourceId,
  sourceAccountOf,
  sourceTypeOf,
  syncRemediationOf,
} from "@omnesis/types";
import { brandDiscoveredAccounts } from "./discovered-accounts.js";
import { getEnabledProviderIds, isSourceEnabled } from "./source-config-reconciler.js";
import { buildProviderHost, buildSourceHost } from "./source-host-builder.js";
import type {
  CreateOptions,
  GatewayClient,
  ProviderDefinition,
  SourceParam,
  SourceDefinition,
  SourceInstance,
  SourceDescriptor,
  SourceOrProviderDefinition,
  ConfigSchema,
  ProviderContextOptions,
  SourceContractDeclaration,
  StateOutcome,
  ConnectionState,
  DiscoveredAccount,
} from "@omnesis/source-sdk";
import type { AttachmentExtractFn, AudioTranscribeFn, SourceConfig } from "@omnesis/core";
import type {
  SyncRemediation,
  DocumentIngestionContext,
  MultiDeviceMode,
  ProviderType,
  SourceType,
} from "@omnesis/types";
import type { CollectorInternalConfig } from "./internal-config.js";
import type { RegisteredProvider, RegisteredSource, SyncEngine } from "./sync-engine.js";

const log = createLogger("collector:sources");

/**
 * Dependencies the instantiator needs from its caller (SourceManager).
 * Bundled into a single object so the per-definition functions stay
 * pure-ish — no implicit `this` lookups, the deps are spelled out.
 */
export interface SourceInstantiatorContext {
  definitions: SourceOrProviderDefinition[];
  descriptors: SourceDescriptor[];
  sourceToProvider: Map<SourceType, ProviderType>;
  config: CollectorInternalConfig;
  gateway: GatewayClient;
  engine: SyncEngine;
  extractAttachment?: AttachmentExtractFn;
  /** Audio transcription function threaded into every source's `CreateOptions`. */
  transcribeAudio?: AudioTranscribeFn;
  /**
   * Collector config directory passed through to every source's
   * `CreateOptions.configDir`. Sources with a durable on-disk store (WhatsApp)
   * root it here so an isolated `OMNESIS_CONFIG_DIR` (tests, parallel
   * instances) is honoured. Falls back to `OMNESIS_CONFIG_DIR` / the default
   * when the caller doesn't set it, matching the collector's own boot-time
   * resolution.
   */
  configDir?: string;
  /** Source-device context passed to every provider normalizer. */
  ingestionContext?: DocumentIngestionContext;
  /** Gateway-persisted modes keyed by full source ID. */
  multiDeviceModes?: ReadonlyMap<string, MultiDeviceMode>;
  /**
   * Keys being created by the current interactive add. Their configured
   * account may precede post-auth discovery; gateway snapshots and reconnects
   * leave this unset so discovery remains authoritative there.
   */
  configDerivedAccountKeys?: ReadonlySet<string>;
}

/** The config dir to thread into `CreateOptions.configDir`. */
function resolveConfigDir(ctx: SourceInstantiatorContext): string {
  return ctx.configDir ?? process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

/**
 * The settings that apply to one source instance: every `sources.*` block
 * whose key addresses it, composed most-specific-last, so a field set on
 * `<type>` holds for every account under that type and a field set on
 * `<type>:<account>` overrides it for that one. Returns undefined when no
 * block addresses the source.
 */
function resolveSourceConfig(
  ctx: SourceInstantiatorContext,
  sourceId: SourceId,
): SourceConfig | undefined {
  let resolved: SourceConfig | undefined;
  for (const key of sourceSettingKeys(sourceId)) {
    const block = ctx.config?.sources?.[key];
    if (!block) continue;
    resolved = resolved ? { ...resolved, ...block } : block;
  }
  return resolved;
}

/**
 * A member-local parameter is an operator-supplied description of this
 * collector's environment (for example an alternate database path). When at
 * least one account-matching availability-proof value is present and every
 * such supplied value validates, it is stronger evidence than parameterless
 * auto-discovery: the source may deliberately live outside the provider's
 * default search location.
 *
 * This exception is deliberately unavailable to shared/source-scoped params,
 * so an account copied from another device still has to be discovered here.
 */
function hasUsableMemberLocalConfig(
  params: readonly SourceParam[] | undefined,
  config: SourceConfig | undefined,
  accountId: string,
): boolean {
  const memberParams = params?.filter((param) => param.scope === "member") ?? [];
  let hasExplicitValue = false;
  for (const param of memberParams) {
    if (param.provesLocalAvailabilityForAccount !== accountId) continue;
    const value = config?.params?.[param.name];
    if (value === undefined) {
      if (param.required) return false;
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0 || !param.validate) return false;
    try {
      if (param.validate(value)) return false;
    } catch {
      return false;
    }
    hasExplicitValue = true;
  }
  return hasExplicitValue;
}

/**
 * Route audio for a source by its `conversational` flag (not by name). A
 * conversation source (WhatsApp, iMessage) gets the `transcribeAudio` fn so it
 * transcribes voice notes inline; a document source (email) instead gets
 * `includeAudioTypes` so its audio attachments join the allow-list and flow
 * through the shared extractor as a child doc. When no `transcribeAudio` fn is
 * wired both are inert. Keeps the inline-vs-child decision driven by the
 * descriptor flag, with no source-specific branching.
 */
function resolveAudioRouting(
  ctx: SourceInstantiatorContext,
  conversational: boolean | undefined,
): { transcribeAudio?: AudioTranscribeFn; includeAudioTypes: boolean } {
  const sttEnabled = ctx.transcribeAudio !== undefined;
  return {
    transcribeAudio: sttEnabled && conversational ? ctx.transcribeAudio : undefined,
    includeAudioTypes: sttEnabled && !conversational,
  };
}

/**
 * Process-lifetime set of source keys we've already warned about, so a
 * snapshot reconcile that re-fires `setupSources` doesn't spam the log.
 * Keyed by the literal config key so per-account variants are tracked
 * independently.
 */
const warnedOrphanKeys = new Set<string>();

/**
 * For a configured source key with no descriptor in the registry, walk
 * the loaded definitions to find the underlying source declaration.
 * Used to surface a more informative warning (e.g. "the source declares
 * supportedPlatforms=[darwin]") when the source exists but was filtered
 * for the current platform.
 */
function findSupportedPlatformsForSourceType(
  definitions: SourceOrProviderDefinition[],
  sourceType: SourceType,
): string[] | undefined {
  for (const def of definitions) {
    if (def.type === "source") {
      if (def.id === String(sourceType)) return def.supportedPlatforms;
    } else {
      for (const entry of def.sources) {
        if (entry.id === String(sourceType)) {
          return entry.supportedPlatforms ?? def.supportedPlatforms;
        }
      }
    }
  }
  return undefined;
}

/**
 * Whether the source declaration for `sourceType` is marked experimental.
 * Definitions stay loaded even when their descriptors are gated out, so a
 * configured-but-gated experimental source can be diagnosed precisely
 * (rather than mistaken for a removed provider).
 */
function isExperimentalSourceType(
  definitions: SourceOrProviderDefinition[],
  sourceType: SourceType,
): boolean {
  for (const def of definitions) {
    if (def.type === "source") {
      if (def.id === String(sourceType)) return def.experimental === true;
    } else if (def.sources.some((entry) => entry.id === String(sourceType))) {
      return def.experimental === true;
    }
  }
  return false;
}

/**
 * Warn once per process for each configured source that has no
 * descriptor in the registry. Two flavours: source is platform-gated
 * (most actionable — likely a config file copied from another OS), or
 * source is genuinely unknown (typo, removed provider package).
 */
/**
 * Apply a source's declared state versioning to the instance it created.
 *
 * The wrapper is where an old bookmark is migrated forward, a bookmark from a
 * newer build is refused rather than overwritten, and an unreadable one stops
 * being indistinguishable from a first run. A source that declares no state
 * spec is returned untouched.
 *
 * Every resolution is logged. A source that silently starts over looks exactly
 * like a source that suddenly has a lot of new data, and the difference is
 * paid for in upstream requests.
 */
/**
 * Decide whether this build can run a package at all, before instantiating it.
 *
 * A source declares the authoring generation it targets and the host behaviour
 * it cannot work correctly without. Checking that here rather than letting the
 * source run degraded is the whole point of the declaration: a host that
 * ignored a required deletion capability would keep syncing and simply never
 * detect a deletion, which is indistinguishable from a source with nothing to
 * delete.
 *
 * Returns the reason to refuse, or null to proceed.
 */
function contractRefusal(
  providerContract: SourceContractDeclaration | undefined,
  entryContract: SourceContractDeclaration | undefined,
  where: string,
): string | null {
  const merged = mergeContractDeclarations(providerContract, entryContract);
  return checkContractCompatibility(merged, where)?.message ?? null;
}

/**
 * Parse a source's stored settings against its declared schema.
 *
 * Returns the typed value, or a message naming what is wrong. A source that
 * declares no schema gets `undefined` and keeps reading `sourceConfig`
 * directly, exactly as before.
 *
 * Failing here rather than at first use is the point: a misconfigured source
 * that starts and then throws on its third page looks like a broken source,
 * while one that never starts and says which field is wrong looks like what it
 * is.
 */
function parseDeclaredConfig(
  schema: ConfigSchema | undefined,
  sourceConfig: SourceConfig | undefined,
  where: string,
): { ok: true; value?: Record<string, unknown> } | { ok: false; error: string } {
  if (!schema) return { ok: true };
  const result = schema.parse(sourceConfig?.params ?? {});
  if (!result.ok) {
    return { ok: false, error: `${where}: ${formatConfigIssues(result.issues)}` };
  }
  const value = result.value as Record<string, unknown>;
  // Host-side checks run here rather than inside `parse`, because `parse` is
  // pure and also runs in clients that have no filesystem. This is the same
  // place the hand-written validators it replaces used to run, and it is the
  // backstop for the per-field checks a form runs while the operator types: a
  // configuration can also arrive from a hand-edited file that no form saw.
  const hostIssues = hostConfigIssues(schema, value, nodePathProbe);
  if (hostIssues.length > 0) {
    return { ok: false, error: `${where}: ${formatConfigIssues(hostIssues)}` };
  }
  // A source receives its paths resolved. What is stored stays as the operator
  // typed it; what the factory opens is what the checks above just confirmed.
  return { ok: true, value: resolveDeclaredPaths(schema, value, nodePathProbe) };
}

/**
 * Why settings offered for a new source cannot be accepted, or null.
 *
 * Runs before the source exists anywhere. Refused later, at setup, the
 * gateway already holds the source, and the operator is left with one that
 * never starts and reports an error on every tick. A key the source does not
 * declare is refused here too: stored, it would sit in the configuration
 * unread, looking like a setting that does nothing. Configuration already
 * stored is not held to that, since it may carry keys a source has since
 * stopped reading.
 */
export function newSourceConfigRefusal(
  schema: ConfigSchema | undefined,
  params: SourceConfig["params"],
  where: string,
): string | null {
  if (!schema) return null;
  const undeclared = Object.keys(params ?? {}).filter(
    (name) => !Object.prototype.hasOwnProperty.call(schema.fields, name),
  );
  if (undeclared.length > 0) {
    return `${where}: unknown setting ${undeclared.map((name) => `"${name}"`).join(", ")}`;
  }
  const parsed = parseDeclaredConfig(schema, { enabled: true, params }, where);
  return parsed.ok ? null : parsed.error;
}

/**
 * How a provider's credential state is read.
 *
 * A provider that declares nothing is reported connected: it has no credential
 * to be in a state about, and neither does one whose context could not be
 * built, which is a failure the setup path has already reported.
 *
 * A local source is not exempted here. It gets to say that its store is
 * unreadable, which is worth saying; what it does not get is to be stopped by
 * its own answer, because "re-authenticate" is not a remedy for a database
 * that is not there. That distinction lives on `renewableCredential`, so the
 * state stays true and only the consequence changes.
 */
function buildCredentialState(
  def: ProviderDefinition,
  context: unknown,
): () => Promise<ConnectionState> {
  if (context !== undefined && def.credentialState) {
    return () => def.credentialState!(context);
  }
  return () => Promise.resolve<ConnectionState>({ status: "connected" });
}

function applyStateContract(
  instance: SourceInstance,
  spec: Parameters<typeof withVersionedState>[1],
  sourceId: string,
  log: { info: (m: string) => void; warn: (m: string) => void },
): SourceInstance {
  return withVersionedState(instance, spec, {
    sourceId,
    onResolve: (outcome: StateOutcome) => {
      if (outcome.kind === "migrated") {
        log.info(`${sourceId}: migrated sync state from version ${outcome.from} to ${outcome.to}`);
      } else if (outcome.kind === "rebootstrap") {
        log.warn(
          `${sourceId}: starting over because its saved sync state could not be read — ${outcome.reason}`,
        );
      }
    },
    onRefuse: (reason) => {
      log.warn(`${sourceId}: refusing to sync — ${reason}. The saved state is left untouched.`);
    },
    onUnencodable: () => {
      log.warn(
        `${sourceId}: returned a cursor its own state declaration rejects, so it was saved ` +
          `unstamped and the next run will treat it as the oldest version. The decoder must ` +
          `accept every cursor this source returns, mid-cycle ones included.`,
      );
    },
  });
}

export function warnAboutUnreachableConfiguredSources(
  ctx: SourceInstantiatorContext,
  enabledSources: Record<string, SourceConfig>,
): void {
  for (const [key, source] of Object.entries(enabledSources)) {
    if (!source.enabled) continue;
    if (warnedOrphanKeys.has(key)) continue;
    const { sourceType } = parseSourceKey(key);
    if (ctx.sourceToProvider.has(sourceType)) continue;

    const supported = findSupportedPlatformsForSourceType(ctx.definitions, sourceType);
    if (supported && supported.length > 0) {
      log.warn(
        `Configured source '${key}' is not available on ${process.platform}: the source declares supportedPlatforms=[${supported.join(",")}]. ` +
          `Likely cause: omnesis.json was copied from another OS. The source will be skipped on this host.`,
      );
    } else if (isExperimentalSourceType(ctx.definitions, sourceType)) {
      // The definition is loaded but its descriptor was gated out — the
      // source is experimental and OMNESIS_EXPERIMENTAL doesn't enable it.
      log.warn(
        `Configured source '${key}' is experimental and currently hidden; it will be skipped. ` +
          `Set OMNESIS_EXPERIMENTAL=1 to enable it.`,
      );
    } else {
      log.warn(
        `Configured source '${key}' has no descriptor in the registry; it will be skipped. ` +
          `Likely cause: the provider package was removed or the source ID changed.`,
      );
    }
    warnedOrphanKeys.add(key);
  }
}

/**
 * Reset the orphan-warning dedupe state. Test-only.
 */
export function resetOrphanWarningsForTesting(): void {
  warnedOrphanKeys.clear();
}

/**
 * A source key that was asked for but produced no live instance, together
 * with the reason. Instantiation failures are per-account and per-source —
 * an unreadable local database, a provider whose `createContext` throws, a
 * discovery pass that finds no account — and each one leaves a configured
 * source with nothing behind it. Callers need the reason to report the
 * failure instead of a bare "the source is not running".
 */
export interface SourceSetupFailure {
  /** Full source id, `<sourceType>:<accountId>`. */
  key: string;
  /** Message from whatever prevented the instance from existing. */
  error: string;
  /** What the operator has to do about it, when the failure said. */
  remediation?: SyncRemediation;
}

/** The failure one caught throw costs a key, with its remedy when it carries one. */
function setupFailure(key: string, err: unknown): SourceSetupFailure {
  const remediation = syncRemediationOf(err);
  return { key, error: toErrorMessage(err), ...(remediation ? { remediation } : {}) };
}

/**
 * The full source ids under `def` for one account that `enabledSources`
 * asks for. Used to attribute an instantiation failure to the exact keys it
 * cost, since the throw itself only names the provider and the account.
 */
function enabledKeysForProviderAccount(
  def: ProviderDefinition,
  accountId: string,
  enabledSources: Record<string, SourceConfig>,
): string[] {
  const keys: string[] = [];
  for (const sourceDef of def.sources) {
    const sourceId = `${sourceDef.id}:${accountId}`;
    if (isSourceEnabled(SourceId(sourceId), enabledSources)) keys.push(sourceId);
  }
  return keys;
}

/**
 * Every enabled key that `def` is responsible for, across all accounts.
 * Used when the failure happens before accounts are known — a `discover()`
 * that throws costs every key under the definition, and none of them can be
 * attributed to a particular account.
 */
function enabledKeysForDefinition(
  def: SourceOrProviderDefinition,
  enabledSources: Record<string, SourceConfig>,
): string[] {
  const ownedTypes = new Set(
    def.type === "source" ? [def.id] : def.sources.map((sourceDef) => sourceDef.id),
  );
  const keys: string[] = [];
  for (const key of Object.keys(enabledSources)) {
    // A bare `<type>` key enables every account of that type but names none,
    // so there is no full source id to attribute the failure to. A key whose
    // account half is empty names none either, and branding it below would
    // throw and abandon the rest of the config.
    if (!sourceAccountOf(key)) continue;
    if (!ownedTypes.has(sourceTypeOf(key))) continue;
    if (!isSourceEnabled(SourceId(key), enabledSources)) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * Set up sources from a set of enabled source configs.
 * Creates RegisteredProvider/RegisteredSource directly from definitions.
 *
 * Returns one {@link SourceSetupFailure} per key that was asked for and got
 * no instance. Instantiation failures are contained here — one broken
 * provider must not stop the others from coming up — but they are no longer
 * silent: the caller decides whether an absent instance is a failed add, a
 * reconcile to retry, or (during a bulk boot) merely something to log.
 */
export async function setupSources(
  ctx: SourceInstantiatorContext,
  enabledSources: Record<string, SourceConfig>,
): Promise<SourceSetupFailure[]> {
  warnAboutUnreachableConfiguredSources(ctx, enabledSources);
  const enabledProviderIds = getEnabledProviderIds(enabledSources, ctx.sourceToProvider);
  const failures: SourceSetupFailure[] = [];

  for (const def of ctx.definitions) {
    const providerBaseId = def.type === "provider" ? def.provider.id : resolveProvider(def).id;
    if (!enabledProviderIds.has(providerBaseId)) continue;

    try {
      if (def.type === "source") {
        failures.push(...(await setupSourceDefinition(ctx, def, enabledSources)));
      } else {
        failures.push(...(await setupProviderDefinition(ctx, def, enabledSources)));
      }
    } catch (err) {
      // Reached only for a throw outside the per-account guards below —
      // in practice a `discover()` that rejects, which costs every key the
      // definition owns.
      log.error(`Failed to set up provider ${providerBaseId}: ${toErrorMessage(err)}`);
      for (const key of enabledKeysForDefinition(def, enabledSources)) {
        failures.push(setupFailure(key, err));
      }
    }
  }
  return failures;
}

/**
 * Set up sources from a SourceDefinition (single-source package).
 * Returns the keys it was asked for that got no instance, with the reason.
 */
async function setupSourceDefinition(
  ctx: SourceInstantiatorContext,
  def: SourceDefinition,
  enabledSources: Record<string, SourceConfig>,
): Promise<SourceSetupFailure[]> {
  const failures: SourceSetupFailure[] = [];
  const providerInfo = resolveProvider(def);
  // Accounts come from two places:
  //   1. def.discover() — used by sources that find accounts via local
  //      state (e.g., apple-notes reading NoteStore.sqlite).
  //   2. The enabledSources config keys — used by sources where the
  //      account comes from user-supplied params (e.g., obsidian-notes'
  //      vaultPath, whatsapp-import's phone). These have no discover()
  //      and would silently skip registration if we only used branch 1.
  // Normalised here rather than at each use: a source with nothing to say
  // about an account returns its id, one that knows who it belongs to returns
  // a descriptor, and everything downstream should see one shape.
  const discovered = brandDiscoveredAccounts(
    (await def.discover?.({ configDir: resolveConfigDir(ctx) })) ?? [],
  );
  // An account named only in configuration has no descriptor to speak of: the
  // operator wrote its id and nothing else is known about it.
  const configDerived: DiscoveredAccount[] = [];
  const prefix = `${def.id}:`;
  for (const key of Object.keys(enabledSources)) {
    if (!key.startsWith(prefix)) continue;
    if (!enabledSources[key]?.enabled) continue;
    const id = AccountId(key.slice(prefix.length));
    if (!discovered.some((a) => String(a.id) === String(id))) {
      const sourceConfig = resolveSourceConfig(ctx, SourceId(key)) ?? enabledSources[key];
      if (
        !def.discover ||
        ctx.configDerivedAccountKeys?.has(key) ||
        hasUsableMemberLocalConfig(def.params, sourceConfig, String(id))
      ) {
        configDerived.push({ id });
      } else {
        failures.push({
          key,
          error: `${resolveProvider(def).name} did not discover the configured account on this host; choose a device where that account is available`,
        });
      }
    }
  }
  const accounts = [...discovered, ...configDerived];
  // Nothing to instantiate. Either no key named this source, or every
  // gateway-assigned account was absent from discovery and is already named in
  // `failures` above.
  if (accounts.length === 0) return failures;

  for (const account of accounts) {
    const accountId = account.id;
    try {
      const sourceId = SourceId(`${def.id}:${accountId}`);
      const providerId = ProviderId(`${providerInfo.id}:${accountId}`);

      if (!isSourceEnabled(sourceId, enabledSources)) continue;

      const sourceConfig = resolveSourceConfig(ctx, sourceId);
      // Per-source cutoff: the most specific `sources.*` key that addresses
      // the source, then sources.default.maxAge, then dataRetention.maxAge.
      // Source instances cache this at construction time; gateway ingest
      // enforces the live value as the authoritative gate, so a stale
      // source-side cutoff just leaks API calls, not docs.
      const dataCutoff = ctx.config
        ? (getSourceCutoffDate(ctx.config, sourceId) ?? undefined)
        : undefined;
      const refusal = contractRefusal(undefined, def.contract, `source '${def.id}'`);
      if (refusal) {
        log.warn(`Skipping ${sourceId}: ${refusal}`);
        failures.push({ key: String(sourceId), error: refusal });
        continue;
      }
      const parsedConfig = parseDeclaredConfig(def.config, sourceConfig, String(sourceId));
      if (!parsedConfig.ok) {
        log.warn(`Skipping ${sourceId}: ${parsedConfig.error}`);
        failures.push({ key: String(sourceId), error: parsedConfig.error });
        continue;
      }
      const audio = resolveAudioRouting(ctx, def.conversational);
      const configDir = resolveConfigDir(ctx);
      const host = buildSourceHost({
        providerBaseId: String(providerInfo.id),
        accountId: String(accountId),
        configDir,
        ingestionContext: ctx.ingestionContext,
        extractAttachment: ctx.extractAttachment,
        transcribeAudio: audio.transcribeAudio,
        includeAudioTypes: audio.includeAudioTypes,
        sourceId: String(sourceId),
        sourceType: def.id,
        gateway: ctx.gateway,
        declaresAnalytics: Array.isArray(def.analyticsSchemas),
      });
      const options: CreateOptions = {
        accountId,
        sourceId,
        providerId,
        dataCutoff,
        sourceConfig,
        // The collector is generic over every source, so it cannot see the
        // connection between this value and the schema that produced it. It
        // parsed the value against that very schema one statement ago, which
        // is the guarantee the type cannot carry across the erasure.
        config: parsedConfig.value as never,
        host,
        // Deprecated, still supplied while providers migrate onto `host`.
        extractAttachment: ctx.extractAttachment,
        transcribeAudio: audio.transcribeAudio,
        includeAudioTypes: audio.includeAudioTypes,
        configDir,
        ingestionContext: ctx.ingestionContext,
      };
      // A source the host does not drive is never instantiated: it declares no
      // factory, and building one would mean inventing something for it to
      // return. It stays in the registry so the status view, the analytics
      // catalog and the watch vocabulary still know it exists.
      if (!isDrivenByHost(def)) continue;
      const create = def.create;
      if (!create) continue;
      const instance = applyStateContract(
        // Same erasure as `config` above: the factory's parameter is typed by
        // the schema this definition declares, which the collector cannot name.
        await create(options as Parameters<typeof create>[0]),
        def.contract?.state,
        String(sourceId),
        log,
      );

      const registeredProvider: RegisteredProvider = {
        id: providerId,
        name: providerInfo.name,
        credentialState: instance.credentialState
          ? () => instance.credentialState!()
          : () => Promise.resolve<ConnectionState>({ status: "connected" }),
        renewableCredential: def.authType !== "local",
        sources: [
          {
            id: sourceId,
            // Three answers to "what do we call this account", most recent
            // first. The instance's is resolved while the source runs (a
            // nickname fetched mid-sync); the descriptor's was declared at
            // discovery, when the operator made the connection; the
            // definition's names the family and is the fallback. Without the
            // middle rung the descriptor's `label` was a field with no
            // producer and no reader, which is the same as not having it.
            name: instance.label ?? account.label ?? def.name,
            account: Object.entries(account).some(
              ([key, value]) => key !== "id" && value !== undefined,
            )
              ? account
              : undefined,
            providerId,
            // Per-instance icon (e.g. browser-history selects chrome/safari/…
            // based on accountId) takes precedence over the definition-level
            // icon. The collector's refreshAllSourceMeta pushes this up
            // keyed by the full sourceId.
            icon: instance.icon ?? def.icon,
            family: { name: def.name, icon: def.icon },
            urlPatterns: def.urlPatterns,
            urlCanonicalizer: def.urlCanonicalizer,
            defaultSourcePrior: def.defaultSourcePrior,
            urlHub: def.urlHub,
            urlTargetRole: def.urlTargetRole,
            conversational: def.conversational,
            selfIdentity: def.selfIdentity,
            unitName: def.unitName,
            instance,
            pushBased: def.pushBased,
            contentRetention: def.contentRetention,
            documentTemporalProjections: def.documentTemporalProjections,
            multiDeviceMode: ctx.multiDeviceModes?.get(sourceId) ?? def.multiDevice?.mode,
          },
        ],
      };

      ctx.engine.registerProvider(registeredProvider);
    } catch (err) {
      log.warn(`Skipping ${def.id}:${accountId}: ${toErrorMessage(err)}`);
      failures.push(setupFailure(`${def.id}:${accountId}`, err));
    }
  }
  return failures;
}

/**
 * Set up sources from a ProviderDefinition (multi-source package).
 * Returns the keys it was asked for that got no instance, with the reason.
 */
async function setupProviderDefinition(
  ctx: SourceInstantiatorContext,
  def: ProviderDefinition,
  enabledSources: Record<string, SourceConfig>,
): Promise<SourceSetupFailure[]> {
  const failures: SourceSetupFailure[] = [];
  const accounts = brandDiscoveredAccounts(
    (await def.discover?.({ configDir: resolveConfigDir(ctx) })) ?? [],
  );

  // Discovery is authoritative for gateway snapshots and reconnects: if this
  // host discovers a different account, the per-account loop deliberately
  // skips it so local data is never attached to another account's source id.
  // A fresh interactive add explicitly names its accepted keys below because
  // discovery may not expose newly stored credentials until setup completes.
  const providerDiscoveredAccounts = new Set(accounts.map((account) => String(account.id)));
  const locallyAuthorizedKeys = new Set<string>();
  for (const key of enabledKeysForDefinition(def, enabledSources)) {
    const { accountId } = parseSourceKey(key);
    if (providerDiscoveredAccounts.has(String(accountId))) continue;
    const sourceDef = def.sources.find(
      (entry) => entry.id === String(parseSourceKey(key).sourceType),
    );
    const sourceConfig = resolveSourceConfig(ctx, SourceId(key)) ?? enabledSources[key];
    if (
      ctx.configDerivedAccountKeys?.has(key) ||
      hasUsableMemberLocalConfig(sourceDef?.params, sourceConfig, String(accountId))
    ) {
      // Keep this exception keyed to the exact source. The shared provider
      // context may be created for the account, but a sibling source must not
      // inherit account authorization it did not earn itself.
      locallyAuthorizedKeys.add(key);
      if (!accounts.some((candidate) => String(candidate.id) === String(accountId))) {
        // Named only by configuration, so there is no descriptor to carry.
        accounts.push({ id: AccountId(String(accountId)) });
      }
    } else {
      failures.push({
        key,
        error: `${def.provider.name} did not discover the configured account on this host; choose a device where that account is available`,
      });
    }
  }
  if (accounts.length === 0) {
    if (failures.length === 0) {
      for (const key of enabledKeysForDefinition(def, enabledSources)) {
        failures.push({ key, error: `${def.provider.id} discovered no account on this host` });
      }
    }
    return failures;
  }

  // A child may narrow provider discovery when sibling sources depend on
  // different host-local stores. Resolve each enabled override once, before
  // creating shared provider contexts, then apply it inside the account loop.
  // An override is a narrowing contract: provider discovery still owns the
  // accounts for which a shared context can be created.
  const childDiscoveredAccounts = new Map<string, Set<string>>();
  const childDiscoveryFailed = new Set<string>();
  for (const sourceDef of def.sources) {
    if (!sourceDef.discover) continue;
    const sourceConfigured = Object.entries(enabledSources).some(
      ([key, config]) =>
        config.enabled && (key === sourceDef.id || key.startsWith(`${sourceDef.id}:`)),
    );
    if (!sourceConfigured) continue;
    try {
      childDiscoveredAccounts.set(
        sourceDef.id,
        new Set(
          brandDiscoveredAccounts(
            await sourceDef.discover({ configDir: resolveConfigDir(ctx) }),
          ).map((account) => String(account.id)),
        ),
      );
    } catch (err) {
      childDiscoveryFailed.add(sourceDef.id);
      for (const key of enabledKeysForDefinition(def, enabledSources)) {
        if (parseSourceKey(key).sourceType !== sourceDef.id) continue;
        failures.push(setupFailure(key, err));
      }
    }
  }

  for (const account of accounts) {
    const accountId = account.id;
    let hasAvailableSource = false;
    for (const sourceDef of def.sources) {
      const sourceId = SourceId(`${sourceDef.id}:${accountId}`);
      if (!isSourceEnabled(sourceId, enabledSources)) continue;
      if (childDiscoveryFailed.has(sourceDef.id)) continue;
      if (
        !providerDiscoveredAccounts.has(String(accountId)) &&
        !locallyAuthorizedKeys.has(String(sourceId))
      ) {
        continue;
      }
      const availableAccounts = childDiscoveredAccounts.get(sourceDef.id);
      const sourceConfig = resolveSourceConfig(ctx, sourceId) ?? enabledSources[String(sourceId)];
      if (
        availableAccounts &&
        !availableAccounts.has(String(accountId)) &&
        !locallyAuthorizedKeys.has(String(sourceId)) &&
        !hasUsableMemberLocalConfig(sourceDef.params, sourceConfig, String(accountId))
      ) {
        failures.push({
          key: String(sourceId),
          error: `${sourceDef.name} is not available for the configured account on this host; choose a device where that source is available`,
        });
        continue;
      }
      hasAvailableSource = true;
    }
    if (!hasAvailableSource) continue;

    try {
      const providerId = ProviderId(`${def.provider.id}:${accountId}`);
      // Provider-level shared options. dataCutoff here is the global
      // fallback; each individual source overrides with its per-source
      // cutoff below.
      //
      const configDir = resolveConfigDir(ctx);
      const providerHost = buildProviderHost({
        providerBaseId: def.provider.id,
        accountId: String(accountId),
        configDir,
        ingestionContext: ctx.ingestionContext,
        extractAttachment: ctx.extractAttachment,
      });
      // Provider-level shared options. `dataCutoff` here is the global
      // fallback; each source overrides it with its own below.
      //
      // No source id: a provider context belongs to an account, not to a
      // source. Passing one meant synthesising a placeholder that was
      // immediately replaced before any source factory saw it, which is a
      // value that exists only to satisfy a type.
      const baseOptions: ProviderContextOptions = {
        accountId,
        providerId,
        dataCutoff: ctx.config ? (getSourceCutoffDate(ctx.config, "") ?? undefined) : undefined,
        host: providerHost,
        // Deprecated, still supplied while providers migrate onto `host`.
        extractAttachment: ctx.extractAttachment,
        transcribeAudio: ctx.transcribeAudio,
        configDir,
        ingestionContext: ctx.ingestionContext,
      };
      const context = await def.createContext?.(baseOptions);

      const credentialStateFn = buildCredentialState(def, context);

      const registeredSources: RegisteredSource[] = [];
      for (const sourceDef of def.sources) {
        if (!isDrivenByHost(sourceDef)) continue;
        const create = sourceDef.create;
        if (!create) continue;
        const sourceId = SourceId(`${sourceDef.id}:${accountId}`);
        if (!isSourceEnabled(sourceId, enabledSources)) continue;
        if (childDiscoveryFailed.has(sourceDef.id)) continue;
        if (
          !providerDiscoveredAccounts.has(String(accountId)) &&
          !locallyAuthorizedKeys.has(String(sourceId))
        ) {
          continue;
        }
        const availableAccounts = childDiscoveredAccounts.get(sourceDef.id);
        const sourceConfig = resolveSourceConfig(ctx, sourceId) ?? enabledSources[String(sourceId)];
        if (
          availableAccounts &&
          !availableAccounts.has(String(accountId)) &&
          !locallyAuthorizedKeys.has(String(sourceId)) &&
          !hasUsableMemberLocalConfig(sourceDef.params, sourceConfig, String(accountId))
        ) {
          continue;
        }

        const sourceDataCutoff = ctx.config
          ? (getSourceCutoffDate(ctx.config, sourceId) ?? undefined)
          : undefined;
        const entryRefusal = contractRefusal(
          def.contract,
          sourceDef.contract,
          `source '${sourceDef.id}'`,
        );
        if (entryRefusal) {
          // One entry's refusal is its own. A provider's sources declare
          // different capabilities, and refusing a sibling that asked for
          // nothing would take down sources this build can run perfectly well.
          log.warn(`Skipping ${sourceId}: ${entryRefusal}`);
          failures.push({ key: String(sourceId), error: entryRefusal });
          continue;
        }
        const parsedEntryConfig = parseDeclaredConfig(
          sourceDef.config,
          sourceConfig,
          String(sourceId),
        );
        if (!parsedEntryConfig.ok) {
          log.warn(`Skipping ${sourceId}: ${parsedEntryConfig.error}`);
          failures.push({ key: String(sourceId), error: parsedEntryConfig.error });
          continue;
        }
        // Audio routing is per-source within a provider (`conversational` is a
        // source-entry flag), so it overrides the provider-level `baseOptions`.
        const audio = resolveAudioRouting(ctx, sourceDef.conversational);
        // One source's instantiation is its own. A provider's sources read
        // different things — a different local database, a different scope —
        // and a failure to build one says nothing about its siblings. Letting
        // it escape would drop every source under the provider, including ones
        // the operator never configured.
        let instance: SourceInstance;
        try {
          instance = applyStateContract(
            await create(
              {
                ...baseOptions,
                sourceId,
                sourceConfig,
                config: parsedEntryConfig.value as never,
                dataCutoff: sourceDataCutoff,
                transcribeAudio: audio.transcribeAudio,
                includeAudioTypes: audio.includeAudioTypes,
                host: buildSourceHost({
                  providerBaseId: def.provider.id,
                  accountId: String(accountId),
                  configDir,
                  ingestionContext: ctx.ingestionContext,
                  extractAttachment: ctx.extractAttachment,
                  transcribeAudio: audio.transcribeAudio,
                  includeAudioTypes: audio.includeAudioTypes,
                  sourceId: String(sourceId),
                  sourceType: sourceDef.id,
                  gateway: ctx.gateway,
                  declaresAnalytics: Array.isArray(sourceDef.analyticsSchemas),
                }),
              },
              context,
            ),
            // A source entry declares its own state; two sources sharing one
            // account still persist unrelated bookmarks, so the provider-level
            // declaration is not a fallback for them.
            sourceDef.contract?.state,
            String(sourceId),
            log,
          );
        } catch (err) {
          // Reported, not just logged: a source skipped here has a live gateway
          // row and nothing running behind it, so the caller has to hear which
          // key was dropped and why.
          log.warn(`Skipping ${sourceId}: ${toErrorMessage(err)}`);
          failures.push(setupFailure(String(sourceId), err));
          continue;
        }
        registeredSources.push({
          id: sourceId,
          // The same three rungs as `setupSourceDefinition` above.
          name: instance.label ?? account.label ?? sourceDef.name,
          account: Object.entries(account).some(
            ([key, value]) => key !== "id" && value !== undefined,
          )
            ? account
            : undefined,
          providerId,
          icon: instance.icon ?? sourceDef.icon,
          family: { name: sourceDef.name, icon: sourceDef.icon },
          urlPatterns: sourceDef.urlPatterns,
          urlCanonicalizer: sourceDef.urlCanonicalizer,
          defaultSourcePrior: sourceDef.defaultSourcePrior,
          urlHub: sourceDef.urlHub,
          urlTargetRole: sourceDef.urlTargetRole,
          conversational: sourceDef.conversational,
          selfIdentity: sourceDef.selfIdentity,
          unitName: sourceDef.unitName,
          instance,
          pushBased: sourceDef.pushBased,
          contentRetention: sourceDef.contentRetention,
          documentTemporalProjections: sourceDef.documentTemporalProjections,
          multiDeviceMode:
            ctx.multiDeviceModes?.get(sourceId) ??
            sourceDef.multiDevice?.mode ??
            def.multiDevice?.mode,
        });
      }

      if (registeredSources.length === 0) {
        if (context !== undefined) {
          try {
            await def.disposeContext?.(context);
          } catch (err) {
            // The source factory failures above are the actionable setup
            // failures. Cleanup is best-effort here and must not duplicate or
            // replace them if a provider's disposer also fails.
            log.warn(
              `Failed to dispose unused ${def.provider.id}:${accountId} context: ${toErrorMessage(err)}`,
            );
          }
        }
        continue;
      }

      const registeredProvider: RegisteredProvider = {
        id: providerId,
        name: def.provider.name,
        credentialState: credentialStateFn,
        renewableCredential: def.authType !== "local",
        sources: registeredSources,
      };

      ctx.engine.registerProvider(registeredProvider);
    } catch (err) {
      // Provider-level: `createContext` threw, so nothing under this account
      // can be built. Costs every enabled key on the account, not just one.
      log.warn(`Skipping ${def.provider.id}:${accountId}: ${toErrorMessage(err)}`);
      for (const key of enabledKeysForProviderAccount(def, accountId, enabledSources)) {
        failures.push(setupFailure(key, err));
      }
    }
  }
  return failures;
}
