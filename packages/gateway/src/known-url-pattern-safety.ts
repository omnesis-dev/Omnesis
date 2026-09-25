// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { buildCanonicalizerRegistry, type UrlCanonicalizerSpec } from "@omnesis/core";
import { RE2 } from "re2-wasm";

export const MAX_KNOWN_URL_PATTERNS = 50;
export const MAX_KNOWN_URL_PATTERN_LENGTH = 300;
/** Upper bound for one legacy persisted JSON cell before it reaches JavaScript. */
export const MAX_KNOWN_URL_PATTERNS_SERIALIZED_LENGTH = 20_000;

export interface SafeUrlPatternMatcher {
  readonly source: string;
  test(input: string): boolean;
  exec(input: string): Array<string | undefined> | null;
}

interface DisposableRe2Wrapper {
  delete(): void;
  isDeleted(): boolean;
}

const registryMatchers = new WeakMap<ReadonlyMap<string, UrlCanonicalizerSpec>, readonly RE2[]>();
let cachedCanonicalizerRegistry:
  | {
      fingerprint: string;
      registry: Map<string, UrlCanonicalizerSpec>;
    }
  | undefined;
let cachedUrlPatternMatchers:
  | {
      fingerprint: string;
      matchers: ReadonlyArray<{ regex: SafeUrlPatternMatcher }>;
    }
  | undefined;

function disposeRe2(matcher: RE2): void {
  // re2-wasm 1.x does not expose disposal on its TypeScript surface, but its
  // RE2 object owns an Emscripten class handle whose public runtime `delete()`
  // is the only deterministic way to return memory to the fixed WASM heap.
  // The package's generated JS and pinned version both provide this wrapper.
  const wrapper = (matcher as unknown as { wrapper: DisposableRe2Wrapper }).wrapper;
  if (!wrapper.isDeleted()) wrapper.delete();
}

/** Release a matcher returned by `compileSafeUrlPattern`. */
export function disposeSafeUrlPatternMatcher(matcher: SafeUrlPatternMatcher): void {
  disposeRe2(matcher as RE2);
}

/**
 * URL patterns run against document-controlled strings on hot background
 * paths. Reject expressions with unsafe repetition structure before they can
 * block the JS worker through catastrophic backtracking.
 */
export function isSafeKnownUrlPattern(source: string): boolean {
  let matcher: SafeUrlPatternMatcher | undefined;
  try {
    matcher = compileSafeUrlPattern(source);
    return true;
  } catch {
    return false;
  } finally {
    if (matcher) disposeSafeUrlPatternMatcher(matcher);
  }
}

/** Compile with RE2, whose matching time is linear in the input size. */
export function compileSafeUrlPattern(source: string): SafeUrlPatternMatcher {
  return new RE2(source, "iu");
}

/** Canonicalizer rules use the same linear-time RE2 engine at validation and runtime. */
export function isSafeUrlCanonicalizerPattern(source: string): boolean {
  let matcher: SafeUrlPatternMatcher | undefined;
  try {
    matcher = compileSafeUrlPattern(source);
    return true;
  } catch {
    return false;
  } finally {
    if (matcher) disposeSafeUrlPatternMatcher(matcher);
  }
}

/** Build a host registry whose rewrites never use native backtracking RegExp. */
export function buildSafeUrlCanonicalizerRegistry(
  specs: readonly UrlCanonicalizerSpec[],
): Map<string, UrlCanonicalizerSpec> {
  const matchers: RE2[] = [];
  try {
    const registry = buildCanonicalizerRegistry(specs, (rule) => {
      const matcher = new RE2(rule.match, "u");
      matchers.push(matcher);
      return (input) => {
        matcher.lastIndex = 0;
        if (!matcher.test(input)) return null;
        matcher.lastIndex = 0;
        return matcher.replace(input, rule.replacement);
      };
    });
    registryMatchers.set(registry, matchers);
    return registry;
  } catch (error) {
    for (const matcher of matchers) disposeRe2(matcher);
    throw error;
  }
}

/** Release every native matcher owned by a registry built in this module. */
export function disposeSafeUrlCanonicalizerRegistry(
  registry: ReadonlyMap<string, UrlCanonicalizerSpec>,
): void {
  const matchers = registryMatchers.get(registry);
  if (!matchers) return;
  for (const matcher of matchers) disposeRe2(matcher);
  registryMatchers.delete(registry);
}

/** Specs and hosts are sets, but rule order is semantic: the first match wins. */
export function fingerprintUrlCanonicalizerSpecs(specs: readonly UrlCanonicalizerSpec[]): string {
  const canonical = specs
    .map((spec) => ({
      hosts: [...spec.hosts].map((host) => host.toLowerCase()).sort(),
      rules: spec.rules.map((rule) => ({ match: rule.match, replacement: rule.replacement })),
    }))
    .sort((a, b) => {
      const aKey = `${a.hosts.join("\0")}\0${JSON.stringify(a.rules)}`;
      const bKey = `${b.hosts.join("\0")}\0${JSON.stringify(b.rules)}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Reuse one compiled canonicalizer generation per JS worker. On replacement,
 * explicitly destroy the prior generation's native RE2 handles before
 * compiling the replacement, so both stable and changing declarations remain
 * bounded by one generation.
 */
export function getCachedSafeUrlCanonicalizerRegistry(
  specs: readonly UrlCanonicalizerSpec[],
  fingerprint = fingerprintUrlCanonicalizerSpecs(specs),
): Map<string, UrlCanonicalizerSpec> {
  if (cachedCanonicalizerRegistry?.fingerprint === fingerprint) {
    return cachedCanonicalizerRegistry.registry;
  }
  if (cachedCanonicalizerRegistry) {
    disposeSafeUrlCanonicalizerRegistry(cachedCanonicalizerRegistry.registry);
    cachedCanonicalizerRegistry = undefined;
  }
  const next = buildSafeUrlCanonicalizerRegistry(specs);
  cachedCanonicalizerRegistry = { fingerprint, registry: next };
  return next;
}

/**
 * Compile the data-only known-source pattern handoff once per worker and
 * deterministically release the prior generation before replacement.
 */
export function getCachedSafeUrlPatternMatchers(
  sources: readonly string[],
): ReadonlyArray<{ regex: SafeUrlPatternMatcher }> {
  const fingerprint = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
  if (cachedUrlPatternMatchers?.fingerprint === fingerprint) {
    return cachedUrlPatternMatchers.matchers;
  }
  if (cachedUrlPatternMatchers) {
    for (const entry of cachedUrlPatternMatchers.matchers) {
      disposeSafeUrlPatternMatcher(entry.regex);
    }
    cachedUrlPatternMatchers = undefined;
  }
  const next: Array<{ regex: SafeUrlPatternMatcher }> = [];
  for (const source of sources) {
    try {
      next.push({ regex: compileSafeUrlPattern(source) });
    } catch {
      // The HTTP boundary rejects invalid declarations. A malformed legacy
      // handoff is skipped so one source cannot stop reconciliation.
    }
  }
  cachedUrlPatternMatchers = { fingerprint, matchers: next };
  return next;
}
