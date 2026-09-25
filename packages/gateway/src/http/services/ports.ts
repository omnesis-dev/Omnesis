// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ports owned by the HTTP-services layer.
 *
 * ## Layering rule
 *
 * **Routes only call services.** Every read or write a route handler
 * needs lands on a method of `DocumentService` / `PersonService` /
 * `SourceService` / `DeviceService` / `AnalyticsService` /
 * `AuthService` / `StatusCache` (or one of their
 * peers). Routes never import from `data/repositories/*`,
 * `links.js`, `people.js`, or any other domain helper module
 * directly. The single tolerated exception is the `db: Db` direct-handle
 * on `mountStatusRoutes` and a couple of bare-pk `SELECT id FROM ...`
 * spot-checks that have no cross-cutting concern to wrap (see the
 * doc comments at those sites).
 *
 * The win: cross-cutting concerns (caching, audit, request-id
 * correlation, post-read enrichment, slow-request-tail
 * instrumentation) are a one-place change in the relevant service
 * instead of N route-by-route surgery jobs.
 *
 * Services depend on ports they own — not on
 * infrastructure types defined in `scheduler/`. The concrete
 * implementations are wired in `index.ts`; tests can pass a stub
 * shaped to the port.
 */

/**
 * Compute-side gate for the HTTP services. `DocumentService` uses it to
 * run the snapshot-reconcile diff on the IO worker's read handle: each
 * call returns a bounded victim list which the service deletes through
 * small writer ops, keeping whole-source diffs off the writer entirely.
 * The shape is structurally satisfied by the `IoGate` exposed from the
 * scheduler runner — see `scheduler/io-ops.ts` — so wiring is a
 * passthrough.
 */
import type {
  PersonBrowseCursor,
  PersonSortBy,
  PersonSummary,
} from "../../data/repositories/PersonRepository.js";
import type {
  EnrichedMergeCandidatesResult,
  MergeCandidateClusterCursor,
  MergeCandidateVisibility,
} from "../../merge-candidates.js";
import type { LikeSearchArgs, LikeSearchRow } from "../../search/like-search.js";
import type {
  SnapshotAbsencePlan,
  SnapshotAbsencePolicy,
  SnapshotAbsenceScope,
} from "../../data/repositories/AbsenceRepository.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";
import type {
  SourceUrlRecanonicalizationCursor,
  SourceUrlRecanonicalizationPlan,
} from "../../domain/SourceUrlRecanonicalization.js";

export interface IComputeScheduler {
  planSourceUrlRecanonicalization(
    specs: readonly UrlCanonicalizerSpec[],
    cursor?: SourceUrlRecanonicalizationCursor,
  ): Promise<SourceUrlRecanonicalizationPlan>;
  /** Off-writer half of the snapshot reconcile. See `AbsenceRepository`. */
  snapshotAbsencePlan(
    providerId: string,
    sourceId: string,
    presentExternalIds: string[],
    policy: SnapshotAbsencePolicy,
    scope?: SnapshotAbsenceScope,
  ): Promise<SnapshotAbsencePlan>;
  /** Browse people off the main event loop (GET /people). See PersonService.browse. */
  browsePeople(
    query: string,
    limit: number,
    options: { sortBy?: PersonSortBy; after?: PersonBrowseCursor },
  ): Promise<PersonSummary[]>;
  /** Enriched merge-candidate list off the main thread (GET /people/merge-candidates). */
  enrichedMergeCandidates(opts: {
    status: "pending" | "accepted" | "denied";
    limit: number;
    clusterLimit?: number;
    clusterAfter?: MergeCandidateClusterCursor;
    q?: string;
  }): Promise<EnrichedMergeCandidatesResult>;
  /** Per-candidate veto verdicts off the main thread (the visibility diagnostic). */
  mergeCandidateVisibility(opts: {
    status: "pending" | "accepted" | "denied";
  }): Promise<MergeCandidateVisibility[]>;
  /** Legacy LIKE document search off the main thread (GET /documents/search). */
  likeSearchDocuments(args: LikeSearchArgs): Promise<LikeSearchRow[]>;
}
