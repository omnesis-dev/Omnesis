// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { syncPage } from "@omnesis/source-sdk";
import { impairEntries, synthPartitionOf } from "./impairment.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { EdgeDeclaration } from "@omnesis/core";
import type { DocumentInput, SourceId, ProviderId } from "@omnesis/types";
import type { SynthCursor } from "./types.js";

/** Default batch size — two round-trips for the V1 fixture size of 10 docs/source. */
export const SYNTH_BATCH_SIZE = 5;

/**
 * Slice the next batch out of an ordered fixture list using the persisted
 * cursor's `offset`. Returns the slice plus the new cursor + final-page flag.
 */
export function pageFromFixture<T>(
  entries: T[],
  cursor: SynthCursor | null,
  batchSize: number = SYNTH_BATCH_SIZE,
): { batch: T[]; newCursor: SynthCursor; hasMore: boolean; isFinalPage: boolean } {
  const offset = cursor?.offset ?? 0;
  const end = Math.min(offset + batchSize, entries.length);
  const batch = entries.slice(offset, end);
  const hasMore = end < entries.length;
  return {
    batch,
    newCursor: { ...cursor, offset: end },
    hasMore,
    isFinalPage: !hasMore,
  };
}

/**
 * Build a full SyncResult from a fixture array + mapper. Handles cursor
 * advancement and emits `presentExternalIds` on the final page so the gateway
 * exercises the snapshot-reconcile path.
 */
export function syncFromFixture<TEntry>(
  entries: TEntry[],
  cursor: SynthCursor | null,
  mapEntry: (entry: TEntry) => DocumentInput | DocumentInput[],
  opts?: {
    batchSize?: number;
    /**
     * The source this page belongs to. Only used to target a read impairment
     * (see `impairment.ts`); a caller that omits it is still reachable by a `*`
     * rule.
     */
    sourceId?: string;
    /**
     * Optional per-entry declared edges (#430). Emitted alongside the page's
     * documents so a synth source exercises the same `applyDeclaredEdges` path
     * the real provider does (e.g. chrome-bookmarks' `bookmarks → webpage`
     * edge, #895). Edges for the current page's entries only.
     */
    mapEdges?: (entry: TEntry) => EdgeDeclaration | EdgeDeclaration[];
  },
): SyncResult<SynthCursor> {
  // A read that could not see all of the source is the shape this exists to
  // reproduce: the entries it can see are emitted, but the snapshot — the claim
  // to have enumerated everything — is withheld.
  const externalIdOf = (entry: TEntry): string => {
    const mapped = mapEntry(entry);
    return Array.isArray(mapped) ? (mapped[0]?.externalId ?? "") : mapped.externalId;
  };
  // Which partition each entry belongs to, decided over the WHOLE fixture so
  // an entry keeps its partition whether or not this cycle could read it.
  const partitionByEntry = new Map<TEntry, string>();
  entries.forEach((entry, index) => partitionByEntry.set(entry, synthPartitionOf(index)));
  const partitionOf = (entry: TEntry): string => partitionByEntry.get(entry) ?? "";

  const { visible, snapshotAllowed, partitioned } = impairEntries(
    entries,
    opts?.sourceId,
    externalIdOf,
  );
  const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(
    visible,
    cursor,
    opts?.batchSize,
  );
  const documents = batch.flatMap((e) => {
    const result = mapEntry(e);
    const mapped = Array.isArray(result) ? result : [result];
    // Stamped on every synthetic document, always. See `synthPartitionOf`.
    return mapped.map((doc) => ({ ...doc, partitionKey: partitionOf(e) }));
  });
  const mapEdges = opts?.mapEdges;
  const edges = mapEdges
    ? batch.flatMap((e) => {
        const result = mapEdges(e);
        return Array.isArray(result) ? result : [result];
      })
    : undefined;
  // On the final page, emit the snapshot of ALL fixture external IDs so the
  // gateway's reconcile path is exercised. The snapshot must enumerate the
  // entire source-of-truth — emitting only the current page's IDs would
  // trigger spurious deletions of earlier-page docs.
  const idsOf = (e: TEntry): string[] => {
    const result = mapEntry(e);
    return Array.isArray(result) ? result.map((d) => d.externalId) : [result.externalId];
  };
  // Read once, from the same call that produced `visible`. Reading the
  // environment a second time would let a test flipping it mid-cycle produce
  // a page whose claims describe a read that did not happen.
  if (partitioned) {
    // One partition could not be read, so it is simply not claimed. The other
    // vouches for itself in full, which is the whole point: a deletion in a
    // readable partition is found this cycle rather than waiting on a repair.
    const byPartition = new Map<string, string[]>();
    for (const entry of visible) {
      const partition = partitionOf(entry);
      const held = byPartition.get(partition) ?? [];
      held.push(...idsOf(entry));
      byPartition.set(partition, held);
    }
    return syncPage(documents, newCursor, {
      hasMore,
      presentClaims: isFinalPage
        ? [...byPartition].map(([partition, ids]) => ({ partition, ids }))
        : undefined,
      edges,
    });
  }
  const presentExternalIds = isFinalPage && snapshotAllowed ? visible.flatMap(idsOf) : undefined;
  return syncPage(documents, newCursor, {
    hasMore,
    presentExternalIds,
    edges,
  });
}

/** SHA-256 hex digest. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Convenience: build the DocumentInput identifier triplet from sourceId/providerId/externalId. */
export interface DocIdentity {
  sourceId: SourceId;
  providerId: ProviderId;
  externalId: string;
}
