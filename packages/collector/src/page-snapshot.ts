// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SnapshotClaim } from "@omnesis/source-sdk";

/** What a page is allowed to assert about what still exists. */
export interface PageSnapshot {
  presentExternalIds?: string[];
  presentClaims?: SnapshotClaim[];
}

/**
 * Decide what a completed page may claim, and refuse what it may not.
 *
 * A snapshot is an instruction to delete everything it does not name, so a
 * page that is not the last one names a fraction of what exists — and acting
 * on it would delete the rest. The gateway refuses this too; the refusal is
 * repeated here so a misbehaving source is visible in the collector's own log,
 * next to the source that produced it.
 *
 * Both spellings are checked in one place because they carry the same
 * authority. The two sync branches each reach this, rather than holding a
 * copy: a check written twice is a check one of the two copies forgets when a
 * third spelling arrives, and the copy that forgets forwards a partial page's
 * claims as a whole-source assertion.
 */
export function pageSnapshot(
  sourceId: string,
  result: {
    hasMore: boolean;
    presentExternalIds?: string[];
    presentClaims?: SnapshotClaim[];
    documents?: readonly { partitionKey?: string }[];
  },
  log: { error: (message: string) => void },
  reportAssessment?: (refusal?: string) => void,
): PageSnapshot {
  const refuse = (message: string): PageSnapshot => {
    log.error(`${sourceId}: ${message}`);
    reportAssessment?.(message);
    return {};
  };
  const asserted = result.presentExternalIds !== undefined || result.presentClaims !== undefined;
  if (!asserted) return {};
  if (result.hasMore) {
    return refuse(
      "Source asserted what exists on a partial page (hasMore=true) — refusing to reconcile to avoid mass-delete. A snapshot or a claim is only valid when the enumeration it describes is complete.",
    );
  }
  if (result.presentExternalIds !== undefined && result.presentClaims !== undefined) {
    return refuse(
      "Source set both presentExternalIds and presentClaims — two answers to one question. Refusing to reconcile; send one.",
    );
  }
  if (result.presentClaims !== undefined) {
    // A claim is only actionable against documents that say which partition
    // they are in, and a document in a partition nobody claimed is one the
    // sweep can never reach. That is a silent hole rather than a loud failure,
    // so it is caught here where both halves are in hand: the page's own
    // documents, and the claims that are supposed to cover them.
    const claimed = new Set(result.presentClaims.map((c) => c.partition));
    const stray = result.documents?.find((d) => !claimed.has(d.partitionKey ?? ""));
    if (stray !== undefined) {
      return refuse(
        `A document in partition "${stray.partitionKey ?? ""}" arrived on a page whose claims name only [${[...claimed].join(", ")}] — refusing to reconcile. Every document a claiming page carries must be in a partition that page claims.`,
      );
    }
  }
  // Sent whether or not this member holds the lease: the gateway reconciles
  // only the holder's snapshot, but reads every member's for the items that
  // member keeps alive against another member's deletion.
  reportAssessment?.();
  return result.presentClaims !== undefined
    ? { presentClaims: result.presentClaims }
    : { presentExternalIds: result.presentExternalIds };
}

/** Whether a page asserted anything the gateway will reconcile against. */
export function assertsPresence(snapshot: PageSnapshot): boolean {
  return snapshot.presentExternalIds !== undefined || snapshot.presentClaims !== undefined;
}
