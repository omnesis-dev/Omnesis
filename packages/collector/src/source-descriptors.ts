// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, experimentalEnabled } from "@omnesis/core";
import {
  executionModeOf,
  isDrivenByHost,
  resolveProvider,
  memberScopedParamNames,
} from "@omnesis/source-sdk";
import { SourceType, ProviderType, AccountId } from "@omnesis/types";
import { brandDiscoveredAccounts } from "./discovered-accounts.js";
import type {
  AuthResult,
  SourceDescriptor,
  SourceOrProviderDefinition,
  SourceDefinition,
  ProviderDefinition,
  ProviderSourceEntry,
} from "@omnesis/source-sdk";

const log = createLogger("collector:registry");

/**
 * Expected exports from a provider package.
 * All providers export `default` as a SourceDefinition or ProviderDefinition.
 */
interface ProviderModule {
  default?: SourceOrProviderDefinition;
}

// ---------------------------------------------------------------------------
// Descriptor extraction (inlined from removed definition-adapter)
// ---------------------------------------------------------------------------

function sourceDefToDescriptor(def: SourceDefinition): SourceDescriptor {
  const providerInfo = resolveProvider(def);
  return {
    id: SourceType(def.id),
    name: def.name,
    description: def.description,
    provider: { id: ProviderType(providerInfo.id), name: providerInfo.name },
    authType: def.authType,
    acceptsAuthCode: def.acceptsAuthCode,
    experimental: def.experimental,
    widgetOrigins: def.widgetOrigins,
    widgetRenderer: def.widgetRenderer,
    conversational: def.conversational,
    selfIdentity: def.selfIdentity,
    unitName: def.unitName,
    primaryCount: def.primaryCount,
    gatewayHosted: def.gatewayHosted,
    urlHub: def.urlHub,
    urlTargetRole: def.urlTargetRole,
    icon: def.icon,
    attribution: def.attribution,
    params: def.params,
    memberScopedParamNames: memberScopedParamNames(def),
    execution: executionModeOf(def),
    pushBased: !isDrivenByHost(def),
    analyticsSchemas: def.analyticsSchemas,
    documentTemporalProjections: def.documentTemporalProjections,
    documentEventProfile: def.documentEventProfile,
    singleInstance: def.singleInstance,
    multiDevice: def.multiDevice,
    supportedPlatforms: def.supportedPlatforms,
    defaultSyncInterval: def.defaultSyncInterval,
    credentials: def.credentials,
    historyImport: def.historyImport,
    authFlow: def.authFlow
      ? async (params, callbacks, ctx) =>
          brandAuthFlowResult(await def.authFlow!(params, callbacks, ctx))
      : undefined,
    authenticate: def.authenticate
      ? async (session) => brandAuthResult(await def.authenticate!(session))
      : undefined,
    discover: def.discover
      ? async (ctx) => brandDiscoveredAccounts(await def.discover!(ctx))
      : undefined,
    resolveAccountId: def.resolveAccountId,
    cleanupCredentials: def.cleanupCredentials
      ? async (accountId, ctx) => def.cleanupCredentials!(accountId, ctx)
      : undefined,
  };
}

/**
 * Brand an `authFlow` return into the descriptor's `AccountId | AccountId[]`
 * shape. A definition's `authFlow` returns a raw `string` for the common
 * single-account flow, or a `string[]` when one session registers multiple
 * accounts at once.
 */
function brandAuthFlowResult(result: string | string[]): AccountId | AccountId[] {
  return Array.isArray(result) ? result.map(AccountId) : AccountId(result);
}

/**
 * The same seam for the typed entry point.
 *
 * Both providers that will need it derive the id from a third party — an
 * exchange response, an institution's own name — so the id a flow returns is
 * upstream data, and it is about to name a directory. The older entry point
 * has been constrained here since it shipped; leaving the newer one
 * unconstrained would make adopting the contract the thing that removed the
 * check.
 */
function brandAuthResult(result: AuthResult): AuthResult {
  return {
    ...result,
    accounts: result.accounts.map((account) => ({
      ...account,
      accountId: String(AccountId(account.accountId)),
    })),
  };
}

function providerSourceToDescriptor(
  providerDef: ProviderDefinition,
  sourceDef: ProviderSourceEntry,
): SourceDescriptor {
  const discover = sourceDef.discover ?? providerDef.discover;
  return {
    id: SourceType(sourceDef.id),
    name: sourceDef.name,
    description: sourceDef.description,
    provider: {
      id: ProviderType(providerDef.provider.id),
      name: providerDef.provider.name,
    },
    authType: providerDef.authType,
    acceptsAuthCode: providerDef.acceptsAuthCode,
    // A per-source flag wins over the provider default, so a multi-source
    // provider can mark one source experimental without hiding its siblings.
    experimental: sourceDef.experimental ?? providerDef.experimental,
    widgetOrigins: providerDef.widgetOrigins,
    widgetRenderer: providerDef.widgetRenderer,
    conversational: sourceDef.conversational,
    selfIdentity: sourceDef.selfIdentity,
    unitName: sourceDef.unitName,
    primaryCount: sourceDef.primaryCount,
    gatewayHosted: sourceDef.gatewayHosted,
    urlHub: sourceDef.urlHub,
    urlTargetRole: sourceDef.urlTargetRole,
    icon: sourceDef.icon,
    attribution: sourceDef.attribution,
    params: sourceDef.params,
    memberScopedParamNames: memberScopedParamNames(sourceDef),
    execution: executionModeOf(sourceDef),
    pushBased: !isDrivenByHost(sourceDef),
    analyticsSchemas: sourceDef.analyticsSchemas,
    documentTemporalProjections: sourceDef.documentTemporalProjections,
    documentEventProfile: sourceDef.documentEventProfile,
    supportedPlatforms: sourceDef.supportedPlatforms ?? providerDef.supportedPlatforms,
    // Single-instance-ness follows the provider's account model, so the
    // provider-level flag is the default and an entry may override it in
    // either direction — the same precedence as `experimental` above.
    singleInstance: sourceDef.singleInstance ?? providerDef.singleInstance,
    multiDevice: sourceDef.multiDevice ?? providerDef.multiDevice,
    defaultSyncInterval: sourceDef.defaultSyncInterval,
    credentials: providerDef.credentials,
    historyImport: sourceDef.historyImport,
    authFlow: providerDef.authFlow
      ? async (params, callbacks, ctx) =>
          brandAuthFlowResult(await providerDef.authFlow!(params, callbacks, ctx))
      : undefined,
    authenticate: providerDef.authenticate
      ? async (session) => brandAuthResult(await providerDef.authenticate!(session))
      : undefined,
    discover: discover ? async (ctx) => brandDiscoveredAccounts(await discover(ctx)) : undefined,
    cleanupCredentials: providerDef.cleanupCredentials
      ? async (accountId, ctx) => providerDef.cleanupCredentials!(accountId, ctx)
      : undefined,
  };
}

export function extractDescriptors(def: SourceOrProviderDefinition): SourceDescriptor[] {
  if (def.type === "source") {
    return [sourceDefToDescriptor(def)];
  }
  return def.sources.map((s) => providerSourceToDescriptor(def, s));
}

/**
 * Whether a descriptor should be advertised on the given platform.
 * `supportedPlatforms === undefined` means the source is cross-platform.
 * Synth provider packages set `supportedPlatforms: undefined` explicitly
 * to defeat the spread from their real twin — no env-flag bypass needed
 * here, and a synth package that forgets the override would surface
 * visibly on non-Darwin instead of being masked by the bypass.
 */
export function descriptorSupportsPlatform(
  descriptor: Pick<SourceDescriptor, "supportedPlatforms">,
  platform: NodeJS.Platform,
): boolean {
  if (!descriptor.supportedPlatforms) return true;
  return (descriptor.supportedPlatforms as string[]).includes(platform);
}

/**
 * Whether an experimental descriptor is enabled for the current process.
 *
 * Non-experimental descriptors are always enabled. An experimental one is
 * enabled only when experimental mode is on (`OMNESIS_EXPERIMENTAL=1`).
 * Synthetic mode is handled separately by the caller (it exposes experimental
 * sources unconditionally for tests / demos).
 */
export function descriptorExperimentalEnabled(
  descriptor: Pick<SourceDescriptor, "experimental">,
): boolean {
  if (!descriptor.experimental) return true;
  return experimentalEnabled();
}

/**
 * Whether an experimental descriptor should be hidden from the advertised
 * set for the current process. Synthetic mode (tests / demos) shows
 * everything; otherwise an experimental descriptor is hidden unless
 * `OMNESIS_EXPERIMENTAL` opts it in. Non-experimental descriptors are never
 * hidden. The single decision point the discovery loop applies.
 */
export function experimentalDescriptorHidden(
  descriptor: Pick<SourceDescriptor, "experimental">,
  synthMode: boolean,
): boolean {
  if (synthMode) return false;
  return !descriptorExperimentalEnabled(descriptor);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface PackageDependencyManifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** Select the provider packages available to the requested runtime mode. */
/**
 * Refuse a registry in which two packages claim one source type.
 *
 * A source type is the key every registry in the tree looks a descriptor up
 * by — the credential cleanup that decides which directory to delete, the
 * config reconciler that decides which provider a key routes to, the icon and
 * label maps in three clients — and every one of them is first-wins or
 * last-wins over an array whose order follows the order package loads happened
 * to resolve in.
 *
 * So a duplicate is not a collision that shows up as a collision. It shows up
 * as one source's credentials being deleted when another is removed, or a
 * config key routed to a provider that never wrote it, and it shows up
 * differently on different boots. Nothing prevented it before, which is only
 * survivable because every source ships from one repository — and the point at
 * which that stops being true is exactly the point at which a silent,
 * boot-dependent failure appears.
 */
export function assertUniqueSourceTypes(descriptors: readonly SourceDescriptor[]): void {
  const owners = new Map<string, string>();
  for (const descriptor of descriptors) {
    const id = String(descriptor.id);
    const owner = String(descriptor.provider.id);
    const previous = owners.get(id);
    if (previous !== undefined) {
      throw new Error(
        `Source registry boot failed: two packages claim the source type "${id}" — ` +
          `providers "${previous}" and "${owner}". A source type is the key every registry ` +
          `looks a descriptor up by, so the duplicate would resolve differently on different ` +
          `boots. Rename one, or namespace it under its provider.`,
      );
    }
    owners.set(id, owner);
  }
}

export function providerPackageNames(
  manifest: PackageDependencyManifest,
  synthMode: boolean,
): string[] {
  const candidates = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...(synthMode ? Object.keys(manifest.devDependencies ?? {}) : []),
  ];
  return [...new Set(candidates)].filter(
    (dependency) =>
      dependency.startsWith("@omnesis/provider-") &&
      (synthMode ? dependency.endsWith("-synth") : !dependency.endsWith("-synth")),
  );
}

/**
 * Discover @omnesis/provider-* packages from the collector's runtime
 * dependencies, or its private development dependencies in synthetic mode,
 * and dynamically import their definitions.
 *
 * Real providers belong in dependencies. Synthetic providers belong in
 * devDependencies so published collector manifests never reference them.
 */
async function discoverProviders(): Promise<{
  definitions: SourceOrProviderDefinition[];
  descriptors: SourceDescriptor[];
}> {
  // Read collector's package.json to find provider dependencies.
  const pkgPath = join(import.meta.dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageDependencyManifest;
  // OMNESIS_SYNTHETIC=1 swaps the real provider set out for the synthetic
  // counterparts. The synth packages are named `@omnesis/provider-*-synth` and
  // each shadows its real twin by registering under the same `providerType` /
  // `sourceType`. Production builds set no env var and load only real packages.
  // The shared helper `@omnesis/providers-synth-common` (note the plural) is
  // intentionally outside the `@omnesis/provider-` prefix and is never picked
  // up by this filter.
  const synthMode = process.env.OMNESIS_SYNTHETIC === "1";
  const providerPackages = providerPackageNames(pkg, synthMode);
  if (synthMode) {
    log.warn(
      `OMNESIS_SYNTHETIC=1 — loading synthetic providers only: ${providerPackages.join(", ")}`,
    );
  }

  const allDefinitions: SourceOrProviderDefinition[] = [];
  const allDescriptors: SourceDescriptor[] = [];
  const failures: Array<{ pkg: string; error: string }> = [];
  const skipped: Array<{ pkg: string; reason: string }> = [];
  const hiddenExperimental: string[] = [];

  await Promise.all(
    providerPackages.map(async (pkgName) => {
      try {
        const mod = (await import(pkgName)) as ProviderModule;
        if (!mod.default || (mod.default.type !== "source" && mod.default.type !== "provider")) {
          log.warn(`Provider ${pkgName} has no valid default export, skipping`);
          skipped.push({ pkg: pkgName, reason: "no valid default export" });
          return;
        }

        const def = mod.default;
        // Definitions remain loaded even when their descriptors are
        // platform-filtered out below: the engine still needs to look
        // up a definition by sourceId to instantiate any source that
        // somehow ends up in user config (e.g. an omnesis.json copied
        // from another OS). Only descriptors are gated so the "Add
        // Source" picker doesn't offer unreachable sources.
        allDefinitions.push(def);

        const descriptors = extractDescriptors(def);
        for (const descriptor of descriptors) {
          if (!descriptorSupportsPlatform(descriptor, process.platform)) {
            skipped.push({
              pkg: pkgName,
              reason: `${descriptor.id}: not supported on ${process.platform} (supportedPlatforms=${(descriptor.supportedPlatforms ?? []).join(",")})`,
            });
            continue;
          }
          // Experimental sources stay hidden until opted in. The definition
          // is still loaded above, mirroring the platform filter — only the
          // descriptor is gated, so the "Add Source" picker and the add /
          // instantiate path don't see an unreachable source.
          if (experimentalDescriptorHidden(descriptor, synthMode)) {
            hiddenExperimental.push(String(descriptor.id));
            continue;
          }
          allDescriptors.push(descriptor);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to load provider ${pkgName}: ${message}`);
        failures.push({ pkg: pkgName, error: message });
      }
    }),
  );

  // Conflict guard: real and synth must never co-register. If two definitions
  // claim the same providerType, the engine would route sync to whichever was
  // registered second, with the source IDs of the first. The env-flag filter
  // already prevents this, but defending against future regressions is cheap.
  const seenProviderTypes = new Map<string, string>();
  for (const def of allDefinitions) {
    const pid = def.type === "provider" ? def.provider.id : (def.provider?.id ?? def.id);
    if (seenProviderTypes.has(pid)) {
      throw new Error(
        `Source registry boot failed: duplicate providerType "${pid}" — already provided by a previously-loaded package. Real and synth providers must not co-exist; check OMNESIS_SYNTHETIC handling.`,
      );
    }
    seenProviderTypes.set(pid, pid);
  }

  assertUniqueSourceTypes(allDescriptors);

  // Boot guard: if every provider failed to load, the collector would
  // happily start with an empty source registry — the gateway sees no
  // available sources, the user sees no error, and they spend the next
  // hour wondering why nothing syncs. Fail loud instead.
  if (providerPackages.length > 0 && allDefinitions.length === 0) {
    const failureSummary = failures.map((f) => `  ${f.pkg}: ${f.error}`).join("\n");
    const skippedSummary = skipped.map((s) => `  ${s.pkg}: ${s.reason}`).join("\n");
    throw new Error(
      `Source registry boot failed: declared ${providerPackages.length} provider package${
        providerPackages.length === 1 ? "" : "s"
      } in collector's package.json but loaded zero. Failures:\n${failureSummary || "  (none)"}\nSkipped:\n${skippedSummary || "  (none)"}`,
    );
  }

  if (failures.length > 0) {
    log.warn(
      `${allDefinitions.length}/${providerPackages.length} providers loaded; ${failures.length} failed: ${failures.map((f) => f.pkg).join(", ")}`,
    );
  } else {
    log.info(
      `Loaded ${allDefinitions.length}/${providerPackages.length} providers (${allDescriptors.length} sources)`,
    );
  }

  if (hiddenExperimental.length > 0) {
    log.info(
      `Hiding ${hiddenExperimental.length} experimental source(s): ${hiddenExperimental.join(", ")} — set OMNESIS_EXPERIMENTAL=1 to enable`,
    );
  }

  return { definitions: allDefinitions, descriptors: allDescriptors };
}

// Discover at module load time (top-level await)
const discovered = await discoverProviders();

/** All provider/source definitions, auto-discovered from @omnesis/provider-* packages. */
export const allDefinitions: SourceOrProviderDefinition[] = discovered.definitions;

/** All available source descriptors, derived from definitions. */
export const allDescriptors: SourceDescriptor[] = discovered.descriptors;

/**
 * Find a source descriptor by its ID.
 */
export function findDescriptor(id: string): SourceDescriptor | undefined {
  return allDescriptors.find((d) => d.id === id);
}

/**
 * Get all descriptors grouped by provider.
 */
export function descriptorsByProvider(): Map<string, SourceDescriptor[]> {
  const map = new Map<string, SourceDescriptor[]>();
  for (const d of allDescriptors) {
    const existing = map.get(d.provider.id) ?? [];
    existing.push(d);
    map.set(d.provider.id, existing);
  }
  return map;
}
