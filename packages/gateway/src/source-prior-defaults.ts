// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level registry of source-advertised search-score priors.
 *
 * Each entry maps a source-type prefix (e.g. `"browser-history"`, `"web"`)
 * to an additive search-score adjustment. The search boost stage applies
 * these on top of the configured boosts, then the user's
 * `search.sourcePriors.weights` from `omnesis.json` overrides per key.
 *
 * Two layers:
 *
 *   - **Built-in.** The unified `web` source. It has no configured collector
 *     instance to push the prior, so the gateway seeds `web`'s downweight
 *     itself. The value lives in `web-dataset.ts`
 *     (the gateway-internal write identity), kept in sync with the
 *     `@omnesis/provider-web` descriptor's `defaultSourcePrior`.
 *   - **Collector-declared.** Pushed by the collector at startup via
 *     `POST /admin/source-prior-defaults`, derived from each loaded
 *     source's `defaultSourcePrior` field. Replaced wholesale on each
 *     push. Collector entries win over built-ins so a configured `web`
 *     (or the user's `omnesis.json`) can still override.
 *
 * No source-specific logic lives in the gateway beyond the `web` seed —
 * the heavy lifting (per-source default values) lives inside each source
 * package's `defineSource` call.
 */

import { WEB_DEFAULT_SOURCE_PRIOR, WEB_SOURCE_ID } from "./web-dataset.js";

/**
 * Gateway-hosted source priors. The single entry is the unified `web` source.
 */
const BUILT_IN_PRIORS: Readonly<Record<string, number>> = Object.freeze({
  [WEB_SOURCE_ID]: WEB_DEFAULT_SOURCE_PRIOR,
});

let collectorDeclared: Readonly<Record<string, number>> = Object.freeze({});

/**
 * Replace the collector-declared layer with a fresh list of entries.
 * Built-in priors are untouched. The collector POSTs the full set every
 * boot, so an entry missing from `entries` means "no collector source
 * advertises a default for this prefix".
 */
export function setSourcePriorDefaults(
  entries: ReadonlyArray<{ sourceIdPrefix: string; weight: number }>,
): void {
  const next: Record<string, number> = {};
  for (const e of entries) {
    next[e.sourceIdPrefix] = e.weight;
  }
  collectorDeclared = Object.freeze(next);
}

/**
 * Read the merged defaults (built-in ∪ collector-declared, with
 * collector entries winning on conflict). May be the bare built-in set
 * before the collector has pushed.
 */
export function getSourcePriorDefaults(): Record<string, number> {
  return { ...BUILT_IN_PRIORS, ...collectorDeclared };
}

/** Test-only: reset the collector-declared layer to empty. */
export function resetSourcePriorDefaults(): void {
  collectorDeclared = Object.freeze({});
}
