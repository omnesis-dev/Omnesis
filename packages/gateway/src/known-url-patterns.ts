// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level registry of the URL-id patterns declared by *every known
 * source type*, not just the ones the user has added.
 *
 * This is the superset companion to `getCachedUrlIdPatterns()` (which reads
 * `sync_state.url_patterns` and therefore only knows currently-added
 * sources). Link extraction uses it to decide whether an unresolved `url`
 * link is worth keeping (#668): a target that matches a known source type's
 * pattern is kept unresolved and resolves later via the reconcile path once
 * that source is added and ingested — even if the source isn't added *yet*.
 * Only truly-external targets (matching no known source type) are dropped.
 *
 * Pushed by the collector at startup via `POST /admin/known-url-patterns`,
 * derived from each loaded source definition's `urlPatterns` (the collector
 * loads every provider definition regardless of whether the user added it).
 * Re-posting fully replaces the previous list. Same shape and plumbing as
 * `url-canonicalizers.ts` / `url-graph-roles.ts`.
 *
 * In-memory only — it's data the collector knows authoritatively and
 * re-pushes every boot, so there's nothing to persist. Before the collector
 * pushes, the set is empty and the keep decision falls back to the
 * registered-pattern set alone (the pre-#668 behaviour).
 *
 * No source-specific logic lives here — the gateway treats patterns as
 * opaque regex strings. Per-source URL knowledge lives in each source
 * package's `urlPatterns` on `defineSource(...)`.
 */

import {
  compileSafeUrlPattern,
  disposeSafeUrlPatternMatcher,
  isSafeKnownUrlPattern,
  type SafeUrlPatternMatcher,
} from "./known-url-pattern-safety.js";

/** A compiled known pattern: the matcher plus the original source string. */
interface CompiledKnownPattern {
  regex: SafeUrlPatternMatcher;
  /** The original regex string as pushed — `getKnownUrlPatternSources()`
   *  returns it verbatim (`RegExp.source` re-escapes, so it's lossy). */
  source: string;
}

const declarations = new Map<string, ReadonlyArray<CompiledKnownPattern>>();
let expectedCollectorKeys: ReadonlySet<string> = Object.freeze(new Set<string>());

export function setExpectedKnownUrlPatternDeclarers(keys: readonly string[]): void {
  expectedCollectorKeys = Object.freeze(new Set(keys));
  for (const key of declarations.keys()) {
    if (key !== "admin" && !expectedCollectorKeys.has(key)) {
      disposePatterns(declarations.get(key) ?? []);
      declarations.delete(key);
    }
  }
}

function disposePatterns(patterns: ReadonlyArray<CompiledKnownPattern>): void {
  for (const pattern of patterns) disposeSafeUrlPatternMatcher(pattern.regex);
}

/**
 * Replace the registry with a fresh list of url-id pattern regex strings.
 * The HTTP boundary validates every regex first. Compilation is atomic here
 * too: a malformed direct/internal call throws before replacing a valid set.
 */
export function setKnownUrlPatterns(
  declarationKey: string,
  patterns: readonly { regex: string }[],
): void {
  if (patterns.some((pattern) => !isSafeKnownUrlPattern(pattern.regex))) {
    throw new Error("invalid or potentially unsafe known URL pattern");
  }
  const previous = declarations.get(declarationKey) ?? [];
  // Replacing an existing Map value preserves deterministic declarer order.
  // Publish an empty generation before releasing the old native handles so a
  // failed rebuild cannot leave deleted matchers reachable.
  declarations.set(declarationKey, []);
  disposePatterns(previous);
  const next: CompiledKnownPattern[] = [];
  try {
    for (const pattern of patterns) {
      next.push({ regex: compileSafeUrlPattern(pattern.regex), source: pattern.regex });
    }
    declarations.set(declarationKey, next);
  } catch (error) {
    disposePatterns(next);
    throw error;
  }
}

/** Whether the collector has supplied the complete known-source pattern set. */
export function knownUrlPatternsReady(): boolean {
  if (expectedCollectorKeys.size > 0) {
    for (const key of expectedCollectorKeys) {
      if (!declarations.has(key)) return false;
    }
    return true;
  }
  return declarations.size > 0;
}

function mergedPatterns(): CompiledKnownPattern[] {
  const merged = new Map<string, CompiledKnownPattern>();
  for (const declaration of declarations.values()) {
    for (const pattern of declaration) merged.set(pattern.source, pattern);
  }
  return [...merged.values()];
}

/**
 * Read the compiled known-pattern set, for matching. May be empty before
 * the collector has pushed.
 */
export function getKnownUrlPatterns(): ReadonlyArray<{ regex: SafeUrlPatternMatcher }> {
  return mergedPatterns();
}

/**
 * Read the original (pushed) regex strings — for the debug GET endpoint, so
 * it faithfully round-trips what the collector sent.
 */
export function getKnownUrlPatternSources(): string[] {
  return mergedPatterns().map((p) => p.source);
}

/** Test-only: reset the registry to empty. */
export function resetKnownUrlPatterns(): void {
  for (const patterns of declarations.values()) disposePatterns(patterns);
  declarations.clear();
  expectedCollectorKeys = Object.freeze(new Set<string>());
}
