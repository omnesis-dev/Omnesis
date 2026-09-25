// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level registry of the independent roles sources play in URL graph
 * traversal and target selection.
 *
 * The graph walker uses the hub set to suppress noisy URL pivots. A separate
 * fallback-representation set drives URL ownership and `same-resource` repair;
 * the two source roles are intentionally orthogonal.
 *
 * Two layers:
 *
 *   - **Built-in.** Derived generically from gateway-hosted descriptors. The
 *     unified Web Pages source currently declares both `urlHub: true` and
 *     `urlTargetRole: "fallback"`.
 *   - **Collector-declared.** Pushed by the collector at startup via
 *     `POST /admin/url-graph-roles`, derived from each loaded source's
 *     `urlHub: true` field (chrome-bookmarks, browser-history, and `web`
 *     once configured). Stored per declaring device and merged, so one
 *     collector cannot erase roles contributed by another collector.
 *
 * No source-specific knowledge lives in the gateway beyond the
 * gateway-internal `web` seed — the heavy lifting (which collector
 * sources are hubs) lives inside each source package's `defineSource`
 * call.
 */

import { gatewayHostedDescriptors } from "./internal-source-descriptors.js";

/**
 * Gateway-hosted hub seed: the `web` source is populated without a configured
 * collector instance.
 */
const internalDescriptors = gatewayHostedDescriptors();
const BUILT_IN_HUBS: ReadonlySet<string> = Object.freeze(
  new Set(internalDescriptors.filter((d) => d.urlHub).map((d) => d.id)),
);
const BUILT_IN_FALLBACK_REPRESENTATIONS: ReadonlySet<string> = Object.freeze(
  new Set(internalDescriptors.filter((d) => d.urlTargetRole === "fallback").map((d) => d.id)),
);
const BUILT_IN_REFERENCE_ONLY: ReadonlySet<string> = Object.freeze(
  new Set(internalDescriptors.filter((d) => d.urlTargetRole === "reference").map((d) => d.id)),
);

interface UrlGraphRoleDeclaration {
  traversalHubPrefixes: ReadonlySet<string>;
  fallbackRepresentationPrefixes: ReadonlySet<string>;
  referenceOnlyPrefixes: ReadonlySet<string>;
}

const collectorDeclarations = new Map<string, UrlGraphRoleDeclaration>();
const legacyTraversalDeclarations = new Map<string, ReadonlySet<string>>();
let expectedCollectorKeys: ReadonlySet<string> = Object.freeze(new Set<string>());

/** Replace the collector roster that currently has an authenticated WS connection. */
export function setExpectedUrlGraphRoleDeclarers(keys: readonly string[]): void {
  expectedCollectorKeys = Object.freeze(new Set(keys));
  for (const key of collectorDeclarations.keys()) {
    if (key !== "admin" && !expectedCollectorKeys.has(key)) collectorDeclarations.delete(key);
  }
  for (const key of legacyTraversalDeclarations.keys()) {
    if (key !== "admin" && !expectedCollectorKeys.has(key)) legacyTraversalDeclarations.delete(key);
  }
}

/**
 * Replace the collector-declared layer with a fresh list of source-id
 * prefixes. Built-in hubs are untouched. The collector POSTs the full
 * set every boot, so an entry missing from `traversalHubPrefixes` means "no
 * collector source advertises urlHub for this prefix".
 */
export function setUrlGraphRoles(
  declarationKey: string,
  traversalHubPrefixes: readonly string[],
  fallbackRepresentationPrefixes: readonly string[],
  referenceOnlyPrefixes: readonly string[],
): void {
  collectorDeclarations.set(declarationKey, {
    traversalHubPrefixes: Object.freeze(new Set(traversalHubPrefixes)),
    fallbackRepresentationPrefixes: Object.freeze(new Set(fallbackRepresentationPrefixes)),
    referenceOnlyPrefixes: Object.freeze(new Set(referenceOnlyPrefixes)),
  });
  legacyTraversalDeclarations.delete(declarationKey);
}

/**
 * Compatibility declaration used by pre-role collectors. It contributes
 * traversal suppression only and deliberately does not make target-role
 * metadata ready: an old client cannot attest that reference/fallback sets
 * are complete.
 */
export function setLegacyUrlTraversalHubs(
  declarationKey: string,
  traversalHubPrefixes: readonly string[],
): void {
  legacyTraversalDeclarations.set(declarationKey, Object.freeze(new Set(traversalHubPrefixes)));
  collectorDeclarations.delete(declarationKey);
}

/** Whether the collector has supplied the complete descriptor-derived set. */
export function urlGraphRolesReady(): boolean {
  if (expectedCollectorKeys.size > 0) {
    for (const key of expectedCollectorKeys) {
      if (!collectorDeclarations.has(key)) return false;
    }
    return true;
  }
  return collectorDeclarations.size > 0 && legacyTraversalDeclarations.size === 0;
}

function mergedRole(
  builtIn: ReadonlySet<string>,
  select: (declaration: UrlGraphRoleDeclaration) => ReadonlySet<string>,
  includeLegacyTraversal = false,
): ReadonlySet<string> {
  const merged = new Set(builtIn);
  for (const declaration of collectorDeclarations.values()) {
    for (const prefix of select(declaration)) merged.add(prefix);
  }
  if (includeLegacyTraversal) {
    for (const declaration of legacyTraversalDeclarations.values()) {
      for (const prefix of declaration) merged.add(prefix);
    }
  }
  return merged;
}

/**
 * Read the merged hub set (built-in ∪ collector-declared).
 */
export function getUrlTraversalHubSources(): ReadonlySet<string> {
  return mergedRole(BUILT_IN_HUBS, (declaration) => declaration.traversalHubPrefixes, true);
}

/** URL-addressed source documents that are retained fallback representations. */
export function getFallbackUrlRepresentationSources(): ReadonlySet<string> {
  return mergedRole(
    BUILT_IN_FALLBACK_REPRESENTATIONS,
    (declaration) => declaration.fallbackRepresentationPrefixes,
  );
}

/** Sources whose `sourceUrl` is a reference, never the document's URL identity. */
export function getReferenceOnlyUrlSources(): ReadonlySet<string> {
  return mergedRole(BUILT_IN_REFERENCE_ONLY, (declaration) => declaration.referenceOnlyPrefixes);
}

/** Test-only: reset the collector-declared layer to empty. */
export function resetUrlGraphRoles(): void {
  collectorDeclarations.clear();
  legacyTraversalDeclarations.clear();
  expectedCollectorKeys = Object.freeze(new Set<string>());
}
