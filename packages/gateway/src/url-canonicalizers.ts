// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level URL-canonicalizer registry.
 *
 * Sources declare per-host URL-canonicalization rules in their
 * `defineSource` / provider entry (see `urlCanonicalizer` on
 * `SourceDefinition`). The collector reads them out of each loaded
 * source definition and ships them to the gateway in the atomic
 * `POST /admin/link-declarations` bundle at startup; this module owns the
 * gateway-side, per-collector store.
 *
 * The registry is in-memory only — it's data the collector knows
 * authoritatively, re-pushed every time the collector boots, so there's
 * no need to persist it. Contributions are merged by collector so one
 * collector cannot erase a sibling's host rules. On gateway boot the registry is empty; calls
 * to `normalizeUrl` get only the generic pass until the collector
 * registers its canonicalizers. The eval toolkit assumes a running
 * collector, so in practice the registry is populated before any
 * `/documents/by-url` call lands.
 *
 * No source-specific logic lives here — only the dispatch shape. The
 * actual canonicalizer specs come from `packages/providers/<name>/src/`.
 */

import {
  buildSafeUrlCanonicalizerRegistry,
  disposeSafeUrlCanonicalizerRegistry,
} from "./known-url-pattern-safety.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";

const declarations = new Map<string, readonly UrlCanonicalizerSpec[]>();
let expectedCollectorKeys: ReadonlySet<string> = Object.freeze(new Set<string>());
let currentSpecs: readonly UrlCanonicalizerSpec[] = [];
let currentRegistry: ReadonlyMap<string, UrlCanonicalizerSpec> = new Map();

function mergedSpecs(
  candidate: ReadonlyMap<string, readonly UrlCanonicalizerSpec[]>,
): UrlCanonicalizerSpec[] {
  const rulesByHost = new Map<string, { identity: string; rules: UrlCanonicalizerSpec["rules"] }>();
  for (const key of [...candidate.keys()].sort()) {
    for (const spec of candidate.get(key) ?? []) {
      const identity = JSON.stringify(spec.rules);
      for (const rawHost of spec.hosts) {
        const host = rawHost.trim().toLowerCase();
        const existing = rulesByHost.get(host);
        if (existing && existing.identity !== identity) {
          throw new Error(`conflicting URL canonicalizer declarations for host ${host}`);
        }
        rulesByHost.set(host, { identity, rules: spec.rules });
      }
    }
  }
  const hostsByRules = new Map<string, { hosts: string[]; rules: UrlCanonicalizerSpec["rules"] }>();
  for (const [host, entry] of [...rulesByHost.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const group = hostsByRules.get(entry.identity) ?? { hosts: [], rules: entry.rules };
    group.hosts.push(host);
    hostsByRules.set(entry.identity, group);
  }
  return [...hostsByRules.values()];
}

function rebuildRegistry(): void {
  const nextSpecs = mergedSpecs(declarations);
  const previous = currentRegistry;
  currentSpecs = [];
  currentRegistry = new Map();
  disposeSafeUrlCanonicalizerRegistry(previous);
  currentRegistry = buildSafeUrlCanonicalizerRegistry(nextSpecs);
  currentSpecs = nextSpecs;
}

/** Replace the explicit admin layer. Kept as the direct/test-facing API. */
export function setUrlCanonicalizers(specs: readonly UrlCanonicalizerSpec[]): void {
  setUrlCanonicalizersForDeclarer("admin", specs);
}

/** Replace one collector's contribution without erasing sibling collectors. */
export function setUrlCanonicalizersForDeclarer(
  declarationKey: string,
  specs: readonly UrlCanonicalizerSpec[],
): void {
  const candidate = new Map(declarations);
  candidate.set(declarationKey, specs);
  const nextSpecs = mergedSpecs(candidate);
  const previous = currentRegistry;
  currentSpecs = [];
  currentRegistry = new Map();
  disposeSafeUrlCanonicalizerRegistry(previous);
  currentRegistry = buildSafeUrlCanonicalizerRegistry(nextSpecs);
  currentSpecs = nextSpecs;
  declarations.set(declarationKey, specs);
}

/** Prune declarations from collectors that are no longer paired and active. */
export function setExpectedUrlCanonicalizerDeclarers(keys: readonly string[]): void {
  expectedCollectorKeys = Object.freeze(new Set(keys));
  let changed = false;
  for (const key of declarations.keys()) {
    if (key !== "admin" && !expectedCollectorKeys.has(key)) {
      declarations.delete(key);
      changed = true;
    }
  }
  if (changed) rebuildRegistry();
}

/** Read the current registry. May be empty if the collector hasn't pushed yet. */
export function getUrlCanonicalizers(): ReadonlyMap<string, UrlCanonicalizerSpec> {
  return currentRegistry;
}

/**
 * Read the current canonicalizer specs as a plain array. Use this
 * when the value has to cross a worker-thread boundary (the registry
 * is per-process module state — the worker has its own empty copy —
 * so call sites that run inside a worker must receive the specs as a
 * call argument from the main thread).
 */
export function getUrlCanonicalizerSpecs(): readonly UrlCanonicalizerSpec[] {
  return currentSpecs;
}

/** Test-only: reset the registry to empty. */
export function resetUrlCanonicalizers(): void {
  disposeSafeUrlCanonicalizerRegistry(currentRegistry);
  declarations.clear();
  expectedCollectorKeys = Object.freeze(new Set<string>());
  currentSpecs = [];
  currentRegistry = new Map();
}
