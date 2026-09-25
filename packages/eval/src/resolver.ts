// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { collectAllUrls } from "./suite.js";
import type { Suite } from "./types.js";

/**
 * Output of `resolveSuite`. `resolvedDocIdGroups[queryIdx][docIdx]` is the
 * list of documentIds that the alias URLs of the docIdx-th expected
 * document map to — usually length 1, occasionally length 0 when the
 * doc isn't in the index, or 2+ if a single normalized URL collides on
 * multiple rows (shouldn't happen, but we keep it informative).
 *
 * `expandedDocCount` reports how many doc groups gained extra docIds via
 * the content-hash sibling expansion (see `expandWithContentHashSiblings`).
 * Used by `omnesis eval doctor` to surface the expansion delta.
 */
export interface ResolvedSuite {
  resolvedDocIdGroups: string[][][];
  unresolved: Array<{ queryId: string; url: string }>;
  /**
   * Total docIds across all alias groups after content-hash expansion
   * (i.e. the sum of group sizes for groups with at least one resolved
   * doc). Equals `resolved_expected_docs` when no siblings exist.
   */
  expandedDocCount: number;
}

export type ResolveUrls = (urls: readonly string[]) => Promise<Map<string, string[]>>;

/**
 * Callback that, given a batch of documentIds, returns each input's
 * complete content-hash sibling group (always including the input
 * itself). Used to auto-expand alias groups so byte-identical
 * duplicates count as valid hits in eval scoring. The CLI builds one
 * that POSTs to `/documents/content-hash-siblings`; tests pass a stub.
 *
 * Contract: for every input id, the returned map MUST contain a key
 * for it, with a list containing at least the input id. The default
 * gateway response satisfies this; the no-op default in
 * `resolveSuite` satisfies it trivially.
 */
export type GetSiblings = (docIds: readonly string[]) => Promise<Map<string, string[]>>;

/**
 * Resolve every expected URL in a suite to its documentId(s) via the
 * injected `resolveUrls` callback (the CLI builds one that POSTs to
 * `/documents/by-url`; tests pass a stub). A URL can resolve to several
 * documentIds — see `lookupDocumentIdsBySourceUrl` in the gateway —
 * because multiple rows can share a `source_url` (the canonical case
 * is an email and its attachments). All matching ids land in the same
 * alias group; the bench then counts a hit if any of those ids appears
 * in the search results.
 *
 * Then, when `getSiblings` is provided, every resolved alias group is
 * extended with every documentId in the index that shares one of its
 * docIds' `content_hash`. This mirrors the search pipeline's
 * `dedupeByContentHash` collapse: if the user uploaded the same PDF
 * to Drive and also received it as a Gmail attachment, the search
 * returns one representative — so either representing the same content
 * should satisfy the query in the eval. Sibling expansion stays within
 * a single alias group; we never merge two groups, since each group
 * represents a distinct "thing the user is looking for".
 *
 * Returns the parallel structure plus an `unresolved` list naming every
 * (query, url) that didn't match a row — the doctor command prints
 * these so the user can fix the fixture.
 */
export async function resolveSuite(
  suite: Suite,
  resolveUrls: ResolveUrls,
  getSiblings?: GetSiblings,
): Promise<ResolvedSuite> {
  const allUrls = collectAllUrls(suite);
  const matches = await resolveUrls(allUrls);

  const resolvedDocIdGroups: string[][][] = [];
  const unresolved: Array<{ queryId: string; url: string }> = [];

  for (const q of suite.queries) {
    const perQuery: string[][] = [];
    for (const doc of q.expectedDocs) {
      const ids = new Set<string>();
      let anyHit = false;
      for (const url of doc.urls) {
        const idsForUrl = matches.get(url);
        if (idsForUrl && idsForUrl.length > 0) {
          for (const id of idsForUrl) ids.add(id);
          anyHit = true;
        }
      }
      if (!anyHit) {
        // Report all alias URLs of the missing doc — usually one;
        // multiple aliases means we couldn't find any of them.
        for (const url of doc.urls) unresolved.push({ queryId: q.id, url });
      }
      perQuery.push([...ids]);
    }
    resolvedDocIdGroups.push(perQuery);
  }

  if (!getSiblings) {
    return {
      resolvedDocIdGroups,
      unresolved,
      expandedDocCount: countResolvedDocs(resolvedDocIdGroups),
    };
  }

  const expanded = await expandWithContentHashSiblings(resolvedDocIdGroups, getSiblings);
  return {
    resolvedDocIdGroups: expanded,
    unresolved,
    expandedDocCount: countResolvedDocs(expanded),
  };
}

/**
 * Given an already-resolved set of alias groups, fetch every input
 * docId's content-hash siblings once (a single batched call), then
 * union the siblings into the originating group. The expansion is
 * strictly per-group: a sibling that shows up via two different input
 * groups gets added to both groups independently, never merged.
 *
 * Exported separately so tests can exercise the expansion logic
 * without going through a full `resolveSuite` URL resolution.
 */
export async function expandWithContentHashSiblings(
  resolvedDocIdGroups: readonly (readonly (readonly string[])[])[],
  getSiblings: GetSiblings,
): Promise<string[][][]> {
  const allIds = new Set<string>();
  for (const perQuery of resolvedDocIdGroups) {
    for (const group of perQuery) {
      for (const id of group) allIds.add(id);
    }
  }
  if (allIds.size === 0) {
    return resolvedDocIdGroups.map((perQuery) => perQuery.map((group) => [...group]));
  }

  const siblingsMap = await getSiblings([...allIds]);
  return resolvedDocIdGroups.map((perQuery) =>
    perQuery.map((group) => {
      // Preserve original ordering, then append every distinct sibling
      // pulled in via this group's docIds. Stays within the group —
      // siblings from another group are not mixed in.
      const seen = new Set<string>(group);
      const out = [...group];
      for (const id of group) {
        const siblings = siblingsMap.get(id) ?? [];
        for (const sibId of siblings) {
          if (seen.has(sibId)) continue;
          seen.add(sibId);
          out.push(sibId);
        }
      }
      return out;
    }),
  );
}

function countResolvedDocs(groups: readonly (readonly (readonly string[])[])[]): number {
  let total = 0;
  for (const perQuery of groups) {
    for (const group of perQuery) total += group.length;
  }
  return total;
}
