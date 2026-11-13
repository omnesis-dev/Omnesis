// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RepoScopes } from "@omnesis/provider-github";
import { syncFromFixture, type SynthCursor } from "@omnesis/providers-synth-common";
import { syncPage } from "@omnesis/source-sdk";
import type { RepoRow } from "./fixtures.js";
import type { RepoScopeCursor } from "@omnesis/provider-github";
import type { EdgeDeclaration } from "@omnesis/core";
import type { SourceInstance } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

/** Fixture ids listed per page while a refresh attributes the stored documents. */
const LISTED_PER_PAGE = 100;

interface RepoFixtureCursor extends SynthCursor, RepoScopeCursor {
  /** How many fixture entries the refresh in flight has listed. */
  scopeFixtureListed?: number;
}

/**
 * Page a fixture the way the live sources page an account, with the filter
 * protocol run by the real provider's own `RepoScopes`: the tree of owners and
 * repositories, the repository on every document, and the refresh that
 * attributes stored documents by listing them. Only the listing differs — it
 * comes from the fixture instead of GitHub.
 */
export function repoFixtureSource<TEntry extends { repo: string }>(
  sourceId: string,
  repos: RepoRow[],
  entries: TEntry[],
  mapEntry: (entry: TEntry) => DocumentInput,
  mapEdges?: (entry: TEntry) => EdgeDeclaration[],
): SourceInstance<RepoFixtureCursor> {
  return {
    async sync(cursor, opts) {
      const cur: RepoFixtureCursor = { ...(cursor ?? {}) };
      const scope = new RepoScopes(cur, opts);
      const handshake = scope.handshake();
      if (handshake) return handshake;
      const catalogue = scope.startCycle(repos);
      if (catalogue.began || !catalogue.snapshot) delete cur.scopeFixtureListed;
      if (catalogue.catalogueRemaining) return scope.publish(syncPage([], cur, { hasMore: true }));
      const page = syncFromFixture(
        entries,
        cur,
        (entry) => scope.stamp(mapEntry(entry), entry.repo),
        { sourceId, mapEdges },
      );
      let hasMore = page.hasMore;
      if (catalogue.snapshot) {
        const from = cur.scopeFixtureListed ?? 0;
        const listed = entries.slice(from, from + LISTED_PER_PAGE);
        for (const entry of listed) scope.listed(entry.repo, [mapEntry(entry).externalId]);
        cur.scopeFixtureListed = from + listed.length;
        const all = cur.scopeFixtureListed >= entries.length;
        // A read that could not vouch for the whole fixture is not a snapshot,
        // so the refresh waits for one that can.
        const vouched = page.presentExternalIds !== undefined;
        // As in the live sources, a cycle opened on this page closes on a
        // later one: a fixture already paged to its end would otherwise open
        // and close the snapshot in one page, which carries only one phase.
        if (all && !page.hasMore && vouched && !catalogue.began) {
          scope.finishSnapshot([]);
          delete cur.scopeFixtureListed;
        } else if (!all || (catalogue.began && !page.hasMore)) hasMore = true;
      }
      return scope.publish({ ...page, hasMore, cursor: { ...cur, offset: page.cursor.offset } });
    },
  };
}
