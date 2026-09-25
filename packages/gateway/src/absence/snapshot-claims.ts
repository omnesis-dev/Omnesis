// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError } from "../http/errors.js";

/** What a page says exists, in the one shape the absence machinery reads. */
export interface NormalizedSnapshot {
  /** Every id the page vouches for, across all the partitions it claimed. */
  presentExternalIds: string[] | undefined;
  /**
   * The partitions those ids came from, or `undefined` when the enumeration
   * covers the whole source. See `SnapshotAbsenceScope.claimedPartitions`.
   */
  claimedPartitions: readonly string[] | undefined;
}

export interface SnapshotInput {
  presentExternalIds?: readonly string[];
  presentClaims?: readonly { partition: string; ids: readonly string[] }[];
}

/**
 * Whether a snapshot vouches for the whole source, or only for named parts.
 *
 * A claim-shaped snapshot says nothing about the partitions it did not name,
 * so every consumer that treats "absent from the id set" as evidence of
 * deletion has to ask this first. The absence plan scopes its scan; the
 * replica-restorer verdict cannot scope anything, because a restored item is
 * recorded per device rather than per partition — so it declines to judge at
 * all rather than count an unread partition's item as omitted.
 */
export function vouchesForWholeSource(snapshot: NormalizedSnapshot): boolean {
  return snapshot.claimedPartitions === undefined;
}

/**
 * Collapse the two spellings of a snapshot into one.
 *
 * A whole-source enumeration and a set of per-partition claims answer the same
 * question at two scopes, and the gateway acts on them identically once it
 * knows which documents each vouches for. Normalising here means the absence
 * plan, the writer fallback and the reconcile route each have one path — the
 * alternative is three places that each have to remember the second shape, and
 * the one that forgets silently sweeps documents nobody claimed.
 *
 * Both set is refused rather than resolved. A precedence would be a rule
 * nobody reading a source could predict, and the disagreement it papers over
 * is about what was actually read.
 */
export function normalizeSnapshot(input: SnapshotInput): NormalizedSnapshot {
  const { presentExternalIds, presentClaims } = input;
  if (presentClaims === undefined) {
    return {
      presentExternalIds: presentExternalIds ? [...presentExternalIds] : undefined,
      claimedPartitions: undefined,
    };
  }
  if (presentExternalIds !== undefined) {
    throw new BadRequestError(
      "presentExternalIds and presentClaims are two answers to one question — send one",
    );
  }
  const partitions: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const claim of presentClaims) {
    if (seen.has(claim.partition)) {
      // Two claims for one partition are two answers about the same store. The
      // enumeration that builds them cannot produce this, so it means the list
      // was assembled by hand and one of the two is wrong.
      throw new BadRequestError(`presentClaims names ${claim.partition} twice`);
    }
    seen.add(claim.partition);
    partitions.push(claim.partition);
    for (const id of claim.ids) ids.add(id);
  }
  return { presentExternalIds: [...ids], claimedPartitions: partitions };
}
