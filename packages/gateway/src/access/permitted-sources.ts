// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sourceTypeOf } from "@omnesis/types";
import { listSources } from "../data/repositories/SourceRepository.js";
import type { Db } from "../data/types.js";
import type { CorpusAuthorization } from "./corpus-authorization.js";

/**
 * The source ids a restricted authorization may read, resolved against the
 * configured sources.
 *
 * A grant's rule names configured sources only, so a denylist means "every
 * configured source except the listed ones" — never "everything not listed".
 * Documents written by the gateway itself (agent transcripts, open-loop
 * mirrors) have no `sources` row, cannot be named in a rule, and are therefore
 * outside source-list-restricted grants. A per-source filter does not change
 * an all-sources boundary. Every read port checks membership in this
 * set rather than the rule alone, so the three restricted tools agree.
 *
 * `null` for an all-sources boundary: every source is eligible and no
 * set needs to be built.
 */
export function permittedSourceIds(
  db: Db,
  authorization: CorpusAuthorization,
): ReadonlySet<string> | null {
  if (authorization.sourceMode === "all") return null;
  return new Set(
    listSources(db)
      .filter((source) => authorization.allowsSource(source.id))
      .map((source) => source.id),
  );
}

/** Aggregates have no document provenance; expose only whole unfiltered sources. */
export function permittedAnalyticsSourceIds(
  db: Db,
  authorization: CorpusAuthorization,
): ReadonlySet<string> | null {
  const permitted = permittedSourceIds(db, authorization);
  const filtered = new Set(authorization.scopePolicies.map((policy) => policy.sourceId));
  if (!permitted && filtered.size === 0) return null;
  const sources = permitted ?? new Set(listSources(db).map((source) => source.id));
  const filteredTypes = new Set([...filtered].map(sourceTypeOf));
  const result = new Set(
    [...sources].filter((sourceId) => !filtered.has(sourceId) && !filteredTypes.has(sourceId)),
  );
  if (authorization.sourceMode === "all") {
    // Shared analytics tables have a bare type owner. The entire type remains
    // eligible only when no account of that type has a document filter. More
    // restrictive source lists retain their existing exact-account semantics.
    for (const sourceId of sources) {
      const type = sourceTypeOf(sourceId);
      if (!filteredTypes.has(type)) result.add(type);
    }
  }
  return result;
}
