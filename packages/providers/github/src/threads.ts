// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { syncPage } from "@omnesis/source-sdk";
import {
  THREADS_RENDER_VERSION,
  collectDiscussionRefTexts,
  collectIssueRefs,
  collectThreadRefTexts,
  discussionToDocument,
  threadToDocument,
} from "./normalizer.js";
import {
  DISCUSSION_COMMENTS_PAGE_QUERY,
  PR_REVIEWS_PAGE_QUERY,
  THREAD_COMMENTS_PAGE_QUERY,
  buildDiscoveryQuery,
  buildDiscussionBatchQuery,
  buildRefKindsQuery,
  buildThreadBatchQuery,
} from "./queries.js";
import { commitExternalId, parsePendingRef, pendingRef, threadExternalId } from "./types.js";
import { reconcileMissingRepos, resolveRepoList } from "./repo-selection.js";
import {
  gapRepo,
  resumeRepoSnapshot,
  startRepoSnapshot,
  withRepoSnapshot,
} from "./repo-snapshot.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { EdgeDeclaration, SourceConfig } from "@omnesis/core";
import type { SyncResult } from "@omnesis/source-sdk";
import type { GithubClient } from "./client.js";
import type { DiscoveryConnection } from "./queries.js";
import type {
  GithubThreadsCursor,
  ThreadConnection,
  ThreadKind,
  GqlCommentPage,
  GqlDiscussion,
  GqlPullRequest,
  GqlReview,
  GqlThread,
  LaneKind,
  LaneState,
  PendingRef,
  RepoThreadState,
} from "./types.js";

const log = createLogger("source:github");

/**
 * Safety margin subtracted from a watermark before it is passed as `since`.
 * GitHub timestamps are second-granular, so a small overlap guarantees the
 * server-side filter never clips the boundary second.
 */
export const INCREMENTAL_MARGIN_MS = 60 * 1000;

/**
 * Snapshot cadence: once per 24h the lanes walk the full history (no
 * `since`) and emit `presentExternalIds` — the only way to catch deleted or
 * transferred threads, since GitHub has no tombstones.
 */
export const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Issues/PRs materialized per GraphQL batch query. */
const THREAD_BATCH = 10;
/** Discussions materialized per GraphQL batch query. */
const DISCUSSION_BATCH = 5;
/** Prefer draining `pending` over starting another repo beyond this size. */
const MAX_PENDING_BEFORE_MATERIALIZE = 500;
/** Hard ceiling on the pending queue — beyond it discovery drops refs loudly. */
const MAX_PENDING = 50_000;
/**
 * Distinct `#N` shorthand refs looked up per GraphQL query. Each ref costs two
 * aliased fields, so this bounds one query's size; a batch referencing more
 * numbers than this is resolved over as many queries as it takes.
 */
const MAX_REFS_PER_QUERY = 100;
/**
 * Refs in one batch beyond which the extra round trips are worth surfacing.
 * Every query is a chance to meet the rate limit and park the source, so a
 * batch this dense is a plausible explanation for a slow or stalled sync.
 */
const NOTABLE_REFS_PER_BATCH = 5 * MAX_REFS_PER_QUERY;
/** Pagination cap when a single thread's comments overflow the batch query. */
const MAX_OVERFLOW_PAGES = 30;
/**
 * API-page budget for one discovery `sync()` call. A repo's five idle lanes
 * cost one request each, so incremental discovery usually fits in a single
 * call — which matters because the sync runner sleeps 2s after every empty
 * page. A budget-exhausted lane resumes next call.
 */
const MAX_LANE_PAGES_PER_CALL = 30;

export function shouldEnterSnapshotMode(
  cursor: Pick<GithubThreadsCursor, "snapshotMode" | "lastSnapshotAt"> | null | undefined,
  now: () => number = Date.now,
  intervalMs: number = SNAPSHOT_INTERVAL_MS,
): boolean {
  if (cursor?.snapshotMode) return true;
  if (!cursor?.lastSnapshotAt) return true;
  return now() - new Date(cursor.lastSnapshotAt).getTime() >= intervalMs;
}

function marginBefore(wm: string | undefined, marginMs = INCREMENTAL_MARGIN_MS) {
  if (!wm) return undefined;
  return new Date(new Date(wm).getTime() - marginMs).toISOString();
}

/**
 * Whether a listed row still needs materializing, judged against the cutoff
 * pinned when the lane STARTED — never against a watermark advanced during
 * the walk. GitHub's `sort=updated` offset pagination is not monotonic (rows
 * can arrive hundreds of positions out of order), so any freshness rule that
 * depends on listing order silently skips real updates; this one is a pure
 * function of the row's own timestamp.
 */
function isFresh(
  cutoff: string | undefined,
  cutoffIds: number[] | undefined,
  timestamp: string,
  id: number,
): boolean {
  if (!cutoff || timestamp > cutoff) return true;
  if (timestamp === cutoff) return !(cutoffIds ?? []).includes(id);
  return false;
}

/**
 * Track the max timestamp (and the ids sharing its exact second) seen by the
 * in-flight lane. Folded into the repo state only when the lane completes,
 * so an interrupted walk re-runs against the old cutoff instead of losing
 * whatever the interruption skipped.
 */
function trackLaneMax(lane: LaneState, timestamp: string, id: number): void {
  if (!lane.newWm || timestamp > lane.newWm) {
    lane.newWm = timestamp;
    lane.newAtIds = [id];
  } else if (timestamp === lane.newWm && !(lane.newAtIds ?? []).includes(id)) {
    (lane.newAtIds ??= []).push(id);
  }
}

function parentNumberFromApiUrl(url: string | undefined): number | undefined {
  const m = /\/(?:issues|pulls)\/(\d+)$/.exec(url ?? "");
  return m ? Number(m[1]) : undefined;
}

export interface GithubThreadsSourceOptions {
  client: GithubClient;
  providerId: ProviderId;
  sourceId: SourceId;
  /** Sibling commits source of the same account, for PR→commit edges. */
  commitsSourceId: SourceId;
  accountId: string;
  dataCutoff?: string;
  /** Raw per-source config (repo allow/exclude filters). */
  sourceConfig?: SourceConfig;
  /** Override for the daily snapshot cadence. */
  snapshotIntervalMs?: number;
  now?: () => number;
}

/**
 * Issues, pull requests, and discussions — one document per thread.
 *
 * Each `sync()` call performs one bounded unit of work and commits it via the
 * returned cursor, so any failure loses at most one unit:
 *
 * 1. cycle start — resolve the repo list, queue discovery, decide snapshot;
 * 2. discovery — per repo, five lanes (GraphQL issues, pull requests and
 *    discussions; REST issue-comments-since and review-comments-since)
 *    collect fresh thread refs into `pending`. The comment lanes exist
 *    because editing a comment does not bump the parent's `updated_at`;
 * 3. materialization — batches of pending refs are fetched whole over GraphQL
 *    and re-rendered as complete documents;
 * 4. cycle end — a snapshot cycle emits `presentExternalIds` so deletions and
 *    transfers sweep. A snapshot that skipped a repository emits nothing: the
 *    walk knows it did not look everywhere. A snapshot that looked everywhere
 *    is published whatever its size — how believable the result is, is the
 *    gateway's judgement, and withholding here would cancel the deletion
 *    rather than delay it.
 */
export class GithubThreadsSource {
  private readonly opts: GithubThreadsSourceOptions;
  private readonly now: () => number;

  constructor(opts: GithubThreadsSourceOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async sync(cursor: GithubThreadsCursor | null): Promise<SyncResult<GithubThreadsCursor>> {
    try {
      return await this.runSync(cursor);
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError("unknown", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }

  private async runSync(
    cursor: GithubThreadsCursor | null,
  ): Promise<SyncResult<GithubThreadsCursor>> {
    const cur: GithubThreadsCursor = { ...(cursor ?? {}), renderVersion: THREADS_RENDER_VERSION };
    const pending: PendingRef[] = [...(cur.pending ?? [])];
    const pendingSet = new Set(pending);

    // Cycle start.
    if (cur.discoveryQueue === undefined && !cur.lane && pending.length === 0) {
      const repoList = await resolveRepoList(
        this.opts.client,
        this.opts.sourceConfig as Record<string, unknown> | undefined,
      );
      cur.discoveryQueue = [...repoList];
      cur.snapshotMode = shouldEnterSnapshotMode(
        cur,
        this.now,
        this.opts.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS,
      );
      const reconciled = reconcileMissingRepos({
        repoList,
        knownRepos: Object.keys(cur.repos ?? {}),
        missing: cur.missingRepos,
        snapshot: cur.snapshotMode,
        dropRepoState: (repo) => delete cur.repos?.[repo],
      });
      cur.missingRepos = reconciled.missing;
      cur.snapshotRepos = cur.snapshotMode ? [...repoList, ...reconciled.swept] : undefined;
      cur.snapshot = cur.snapshotMode
        ? startRepoSnapshot(cur.snapshotRepos ?? [], reconciled)
        : undefined;
      log.info(
        `Cycle start: ${repoList.length} repos, snapshot=${cur.snapshotMode ? "yes" : "no"}`,
      );
      if (repoList.length === 0) return this.finishCycle(cur, [], []);
      return syncPage([], cur, { hasMore: true });
    }

    // Discovery: a bounded slice of lane pages per call. At the hard pending
    // cap the lane pauses (kept on the cursor) and materialization drains —
    // freshness is a pure function of the row, so resuming mid-listing later
    // is safe.
    if (
      (cur.lane ||
        ((cur.discoveryQueue?.length ?? 0) > 0 &&
          pending.length < MAX_PENDING_BEFORE_MATERIALIZE)) &&
      pending.length < MAX_PENDING
    ) {
      await this.runDiscoverySlice(cur, pending, pendingSet);
      cur.pending = pending;
      return syncPage([], cur, { hasMore: true });
    }

    // Materialization.
    if (pending.length > 0) {
      const { docs, edges } = await this.materializeBatch(pending);
      cur.pending = pending;
      const moreWork =
        pending.length > 0 || (cur.discoveryQueue?.length ?? 0) > 0 || cur.lane !== undefined;
      if (!moreWork) return this.finishCycle(cur, docs, edges);
      return syncPage(docs, cur, { hasMore: true, edges });
    }

    return this.finishCycle(cur, [], []);
  }

  private repoState(cur: GithubThreadsCursor, repo: string): RepoThreadState {
    cur.repos ??= {};
    cur.repos[repo] ??= {};
    return cur.repos[repo];
  }

  private finishCycle(
    cur: GithubThreadsCursor,
    docs: DocumentInput[],
    edges: EdgeDeclaration[],
  ): SyncResult<GithubThreadsCursor> {
    const wasSnapshot = cur.snapshotMode === true;
    const enumeration = resumeRepoSnapshot(cur);
    cur.discoveryQueue = undefined;
    cur.lane = undefined;
    cur.snapshotMode = false;
    cur.snapshotRepos = undefined;
    cur.snapshot = undefined;
    cur.pending = undefined;

    if (wasSnapshot) {
      cur.lastSnapshotAt = new Date(this.now()).toISOString();
      const issue = enumeration.withheldIssue();
      const issues = issue ? [issue] : [];
      if (!enumeration.complete) {
        // At least one repository was not enumerated. Its documents would be
        // absent from a whole-account snapshot and swept, so that form is
        // withheld — but the repositories that WERE read to the end are still
        // vouched for by name, and deletions inside them are found this cycle
        // rather than waiting on a repair that may never come.
        log.warn(enumeration.withheldReason() ?? "Snapshot withheld");
        const claims = enumeration.claims();
        if (claims.length === 0) return syncPage(docs, cur, { hasMore: false, edges, issues });
        log.info(
          `Claiming ${claims.length} repositories read in full — deletions are detected inside them and deferred for the rest.`,
        );
        return syncPage(docs, cur, { hasMore: false, edges, presentClaims: claims, issues });
      }
      const present = enumeration.result();
      // A snapshot that enumerated nothing where threads previously existed is
      // suspicious, and is deliberately still published — see commits.ts for
      // the same reasoning. Withholding is not a delay here, it is an absent
      // signal: the gateway marks nothing and no deadline runs, so an account
      // whose threads were genuinely all closed out and deleted would never
      // reconcile. Magnitude belongs to the gateway; completeness, reported
      // through `incomplete` above, belongs here.
      log.info(`Snapshot complete: ${present?.length ?? 0} threads present`);
      return syncPage(docs, cur, {
        hasMore: false,
        issues,
        presentExternalIds: present ?? [],
        edges,
        watermark: { guarantee: "snapshot", observedAt: cur.lastSnapshotAt },
      });
    }
    return syncPage(docs, cur, { hasMore: false, edges });
  }

  // -------------------------------------------------------------------------
  // Discovery lanes
  // -------------------------------------------------------------------------

  private addPending(
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
    lane: LaneState,
    ref: PendingRef,
  ) {
    if (pendingSet.has(ref)) return;
    if (pending.length >= MAX_PENDING) {
      // Backstop only — the discovery branch pauses the lane at the cap
      // before this triggers. Not marked as seen anywhere: the lane's
      // watermark is withheld on a drop (lane.dropped), so the ref is
      // rediscovered by the next cycle.
      if (!lane.dropped) {
        log.error(`Pending queue at cap (${MAX_PENDING}) — deferring refs to the next cycle`);
      }
      lane.dropped = true;
      return;
    }
    pending.push(ref);
    pendingSet.add(ref);
  }

  /**
   * Run discovery lane pages until the current repo's lanes complete or the
   * per-call page budget runs out. A snapshot issues walk (the one long walk)
   * commits after every page so a mid-walk failure loses one page at most.
   *
   * A repo whose enumeration fails with a permission/unknown error (deleted,
   * grant revoked, feature disabled) is skipped rather than wedging the
   * source; during a snapshot it is recorded as that repository's gap, so the
   * rest of the account still reconciles.
   */
  private async runDiscoverySlice(
    cur: GithubThreadsCursor,
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
  ): Promise<void> {
    let budget = MAX_LANE_PAGES_PER_CALL;
    while (budget > 0) {
      if (!cur.lane) {
        const repo = cur.discoveryQueue?.shift();
        if (!repo) return;
        this.startLane(cur, repo, "issues");
      }
      const lane = cur.lane;
      if (!lane) return;
      try {
        budget -= 1;
        await this.runLaneStep(cur, lane, pending, pendingSet);
      } catch (err) {
        if (err instanceof SyncError && (err.kind === "permission" || err.kind === "unknown")) {
          log.warn(`Skipping ${lane.kind} lane for ${lane.repo}: ${err.message}`);
          // The rest of this repo's lanes are skipped with it, so the whole
          // repository is a gap even when only one of its lanes failed.
          gapRepo(cur, lane.repo, `${lane.kind} lane failed (${err.message})`);
          cur.lane = undefined;
          continue;
        }
        throw err;
      }
      // Full-history snapshot walks commit page-by-page, so a mid-walk
      // failure re-runs one page rather than a whole slice.
      if (cur.snapshotMode && cur.lane) return;
    }
  }

  private startLane(cur: GithubThreadsCursor, repo: string, kind: LaneKind): void {
    const state = this.repoState(cur, repo);
    const snapshot = cur.snapshotMode === true;
    const nowIso = new Date(this.now()).toISOString();
    switch (kind) {
      case "issues":
        cur.lane = { repo, kind, cutoff: state.issuesWm, cutoffIds: state.issuesAtWm };
        return;
      case "pulls":
        cur.lane = { repo, kind, cutoff: state.pullsWm, cutoffIds: state.pullsAtWm };
        return;
      case "comments":
      case "reviewComments": {
        // First pass over a repo puts every thread in pending already — start
        // the comment-edit lanes at "now" instead of walking all history.
        if (!state.commentsWm) state.commentsWm = nowIso;
        if (!state.reviewCommentsWm) state.reviewCommentsWm = nowIso;
        const wm = kind === "comments" ? state.commentsWm : state.reviewCommentsWm;
        const at = kind === "comments" ? state.commentsAtWm : state.reviewCommentsAtWm;
        cur.lane = { repo, kind, page: 1, since: marginBefore(wm), cutoff: wm, cutoffIds: at };
        return;
      }
      case "discussions":
        cur.lane = { repo, kind, cutoff: state.discussionsWm, cutoffIds: state.discussionsAtWm };
        return;
    }
  }

  /** Fold the completed lane's observed max back into the repo watermark. */
  private commitLaneWatermark(lane: LaneState, state: RepoThreadState): void {
    if (lane.dropped) {
      log.warn(`Lane ${lane.kind} for ${lane.repo} dropped refs — watermark withheld`);
      return;
    }
    if (!lane.newWm) return;
    const read: Record<LaneKind, [string | undefined, number[] | undefined]> = {
      issues: [state.issuesWm, state.issuesAtWm],
      pulls: [state.pullsWm, state.pullsAtWm],
      comments: [state.commentsWm, state.commentsAtWm],
      reviewComments: [state.reviewCommentsWm, state.reviewCommentsAtWm],
      discussions: [state.discussionsWm, state.discussionsAtWm],
    };
    const [wm, at] = read[lane.kind];
    let nextWm = wm;
    let nextAt = at;
    if (!wm || lane.newWm > wm) {
      nextWm = lane.newWm;
      nextAt = lane.newAtIds;
    } else if (lane.newWm === wm) {
      nextAt = [...new Set([...(at ?? []), ...(lane.newAtIds ?? [])])];
    }
    switch (lane.kind) {
      case "issues":
        state.issuesWm = nextWm;
        state.issuesAtWm = nextAt;
        return;
      case "pulls":
        state.pullsWm = nextWm;
        state.pullsAtWm = nextAt;
        return;
      case "comments":
        state.commentsWm = nextWm;
        state.commentsAtWm = nextAt;
        return;
      case "reviewComments":
        state.reviewCommentsWm = nextWm;
        state.reviewCommentsAtWm = nextAt;
        return;
      case "discussions":
        state.discussionsWm = nextWm;
        state.discussionsAtWm = nextAt;
        return;
    }
  }

  /** Complete the current lane: fold its watermark, move to the next lane. */
  private advanceLane(cur: GithubThreadsCursor, lane: LaneState): void {
    this.commitLaneWatermark(lane, this.repoState(cur, lane.repo));
    const nextKind: Record<LaneKind, LaneKind | undefined> = {
      issues: "pulls",
      pulls: "comments",
      comments: "reviewComments",
      reviewComments: "discussions",
      discussions: undefined,
    };
    const next = nextKind[lane.kind];
    if (next) {
      this.startLane(cur, lane.repo, next);
      return;
    }
    // Every lane this repository has ran to its end, so its enumeration is
    // complete and it can be claimed. A repository skipped on error never
    // reaches here — `runDiscoverySlice` clears the lane itself.
    //
    // Discussions are the exception, and deliberately so: the FIRST cycle that
    // cannot read them gaps the repository, and a repeat failure is treated as
    // the steady state a repository without the feature is in, so the lane
    // advances and the repository is covered without them. That is what lets
    // the rest of it keep reconciling; it also means a repository whose
    // discussions were removed has them swept, which is the intended outcome.
    // A gap already recorded this cycle stands whatever happens here.
    withRepoSnapshot(cur, (enumeration) => enumeration.cover(lane.repo));
    cur.lane = undefined; // repo discovery complete
  }

  private async runLaneStep(
    cur: GithubThreadsCursor,
    lane: LaneState,
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
  ): Promise<void> {
    switch (lane.kind) {
      case "issues":
      case "pulls":
        return this.threadDiscoveryLaneStep(cur, lane, pending, pendingSet);
      case "comments":
      case "reviewComments":
        return this.commentsLaneStep(cur, lane, pending, pendingSet);
      case "discussions":
        return this.discussionsLaneStep(cur, lane, pending, pendingSet);
    }
  }

  /**
   * One page of a discovery connection: enumerate for presence during a
   * snapshot, queue whatever is fresh, and advance or finish the lane.
   *
   * Shared by the issues, pull-request, and discussion lanes because the walk
   * is identical for all three — only the connection read, the document kind,
   * and the query differ.
   */
  private async connectionLaneStep(
    cur: GithubThreadsCursor,
    lane: LaneState,
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
    opts: { connection: DiscoveryConnection; kind: ThreadKind; discussion: boolean },
  ): Promise<void> {
    const snapshot = cur.snapshotMode === true;
    const [owner, name] = lane.repo.split("/");
    const data = await this.opts.client.graphql<{
      repository?: Partial<Record<DiscoveryConnection, ThreadConnection | null>> | null;
    }>(buildDiscoveryQuery(opts.connection, snapshot), {
      owner,
      name,
      after: lane.after ?? null,
    });
    if (data.repository == null) {
      // The repository is gone or invisible to this token. An empty walk here
      // would enumerate nothing and, in snapshot mode, sweep every document of
      // the repo — so treat it as a failed enumeration. Every caller of this
      // lane step (runDiscoverySlice, discussionsLaneStep) catches a
      // permission/unknown failure here and moves on to the next repo or
      // lane, so only this one repo's discovery is lost.
      throw new SyncError("permission", `GitHub returned no repository for ${lane.repo}.`, {
        scope: "partition",
      });
    }
    const conn = data.repository[opts.connection];
    let stopEarly = false;
    // Accumulated under this repository. A lane is one of several this repo
    // has, so the ids go in as they are found and the repository is covered
    // only once its last lane finishes — see `advanceLane`.
    const presentThisPage: string[] = [];
    for (const node of conn?.nodes ?? []) {
      if (!node) continue;
      if (snapshot) presentThisPage.push(threadExternalId(lane.repo, opts.kind, node.number));
      if (isFresh(lane.cutoff, lane.cutoffIds, node.updatedAt, node.number)) {
        this.addPending(
          pending,
          pendingSet,
          lane,
          pendingRef(lane.repo, node.number, opts.discussion),
        );
        trackLaneMax(lane, node.updatedAt, node.number);
      } else if (!snapshot && lane.cutoff !== undefined && node.updatedAt < lane.cutoff) {
        // Strictly below the cutoff second — everything after is older too.
        // Ties AT the cutoff arrive in arbitrary order, so an already-seen id
        // must not stop the walk before a fresh same-second sibling. (Snapshot
        // walks never stop early: they order on creation and enumerate all.)
        stopEarly = true;
        break;
      }
    }
    // Before the lane advances, because advancing off the last lane is what
    // covers the repository — ids added after that would not be in the set the
    // claim vouches for.
    if (snapshot) {
      withRepoSnapshot(cur, (enumeration) => enumeration.add(lane.repo, presentThisPage));
    }
    // A page claiming more without a cursor cannot be resumed — finish the
    // lane rather than re-reading page one forever. The lane still advances,
    // but the repository is recorded as unread: covering it on the way past
    // would turn "I am stuck here" into "I read everything", and a claim built
    // on that deletes whatever the walk never reached.
    const truncated = conn?.pageInfo?.hasNextPage === true && !conn.pageInfo.endCursor;
    if (truncated) {
      gapRepo(cur, lane.repo, `the ${opts.kind} listing reported more with no cursor to continue`);
    }
    const next = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? undefined) : undefined;
    if (next && !stopEarly) lane.after = next;
    else this.advanceLane(cur, lane);
  }

  private async commentsLaneStep(
    cur: GithubThreadsCursor,
    lane: LaneState,
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
  ) {
    const isReview = lane.kind === "reviewComments";
    if (!lane.since) {
      this.advanceLane(cur, lane);
      return;
    }
    const { rows, hasNextPage } = isReview
      ? await this.opts.client.listReviewCommentsSince(lane.repo, lane.since, lane.page ?? 1)
      : await this.opts.client.listIssueCommentsSince(lane.repo, lane.since, lane.page ?? 1);
    for (const row of rows) {
      if (isFresh(lane.cutoff, lane.cutoffIds, row.updated_at, row.id)) {
        const number = parentNumberFromApiUrl(isReview ? row.pull_request_url : row.issue_url);
        if (number !== undefined) {
          this.addPending(pending, pendingSet, lane, pendingRef(lane.repo, number));
        }
      }
      trackLaneMax(lane, row.updated_at, row.id);
    }
    if (hasNextPage) lane.page = (lane.page ?? 1) + 1;
    else this.advanceLane(cur, lane);
  }

  /** Issues and pull requests — see {@link connectionLaneStep}. */
  private async threadDiscoveryLaneStep(
    cur: GithubThreadsCursor,
    lane: LaneState,
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
  ) {
    const pulls = lane.kind === "pulls";
    return this.connectionLaneStep(cur, lane, pending, pendingSet, {
      connection: pulls ? "pullRequests" : "issues",
      kind: pulls ? "pull" : "issues",
      discussion: false,
    });
  }

  private async discussionsLaneStep(
    cur: GithubThreadsCursor,
    lane: LaneState,
    pending: PendingRef[],
    pendingSet: Set<PendingRef>,
  ) {
    try {
      await this.connectionLaneStep(cur, lane, pending, pendingSet, {
        connection: "discussions",
        kind: "discussions",
        discussion: true,
      });
      // Discovery worked, so whatever stopped it before is over. Clearing the
      // flag is what makes "a repeat failure" mean two in a row rather than
      // two ever: without it, a transient failure last winter and another this
      // summer read as a settled steady state, and the second one lets the
      // sweep take a repository's discussions that are still there.
      this.repoState(cur, lane.repo).discussionsUnavailable = undefined;
    } catch (err) {
      // A repo without Discussions enabled (or a token without the Discussions
      // grant) must not park the whole source — threads still sync. The first
      // failing cycle gaps this repository so its discussion docs are not swept
      // on a transient failure; a repeat permission failure is a steady state (feature
      // off, grant absent) and stops gapping, so the repository reconciles
      // again and its discussions — which are gone or unreachable — are swept.
      // Unknown upstream errors never establish that steady state.
      if (err instanceof SyncError && (err.kind === "permission" || err.kind === "unknown")) {
        const state = this.repoState(cur, lane.repo);
        log.warn(`Discussions unavailable for ${lane.repo}: ${err.message}`);
        if (err.kind !== "permission" || !state.discussionsUnavailable) {
          gapRepo(cur, lane.repo, `discussions unavailable (${err.message})`);
        }
        state.discussionsUnavailable = err.kind === "permission";
        this.advanceLane(cur, lane);
        return;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Materialization
  // -------------------------------------------------------------------------

  private async materializeBatch(
    pending: PendingRef[],
  ): Promise<{ docs: DocumentInput[]; edges: EdgeDeclaration[] }> {
    // Drop malformed refs defensively (cursor is untrusted storage).
    while (pending.length > 0 && parsePendingRef(pending[0]) === null) {
      log.warn(`Dropping malformed pending ref ${pending[0]}`);
      pending.shift();
    }
    if (pending.length === 0) return { docs: [], edges: [] };

    const head = parsePendingRef(pending[0])!;
    const batchSize = head.discussion ? DISCUSSION_BATCH : THREAD_BATCH;
    const refs: Array<{ ref: PendingRef; number: number }> = [];
    for (const ref of pending) {
      const parsed = parsePendingRef(ref);
      if (!parsed) continue;
      if (parsed.repo === head.repo && parsed.discussion === head.discussion) {
        refs.push({ ref, number: parsed.number });
        if (refs.length >= batchSize) break;
      }
    }

    const [owner, name] = head.repo.split("/");
    const variables: Record<string, unknown> = { owner, name };
    refs.forEach((r, i) => (variables[`n${i}`] = r.number));
    const query = head.discussion
      ? buildDiscussionBatchQuery(refs.length)
      : buildThreadBatchQuery(refs.length);
    const data = await this.opts.client.graphql<{
      repository?: Record<string, GqlThread | GqlDiscussion | null> | null;
    }>(query, variables, { tolerateNotFound: true });

    // Fetch every node whole first (overflow pagination included), then
    // resolve the batch's `#N` shorthand refs together, then render.
    const nodes: Array<GqlThread | GqlDiscussion | null> = [];
    for (let i = 0; i < refs.length; i++) {
      const alias = head.discussion ? `d${i}` : `t${i}`;
      const node = data.repository?.[alias] ?? null;
      if (node !== null) {
        if (head.discussion) await this.fillDiscussionOverflow(head.repo, node as GqlDiscussion);
        else await this.fillThreadOverflow(head.repo, node as GqlThread);
      }
      nodes.push(node);
    }
    const refKinds = await this.resolveRefKinds(head.repo, nodes, head.discussion);

    const docs: DocumentInput[] = [];
    const edges: EdgeDeclaration[] = [];
    for (const node of nodes) {
      if (node === null) {
        // Deleted, transferred, or invisible — the snapshot reconcile sweeps
        // any stored doc; nothing to emit.
        continue;
      }
      if (this.opts.dataCutoff && node.createdAt < this.opts.dataCutoff) continue;
      if (head.discussion) {
        docs.push(
          discussionToDocument(
            node as GqlDiscussion,
            head.repo,
            this.opts.providerId,
            this.opts.sourceId,
            refKinds,
          ),
        );
      } else {
        const normalized = threadToDocument(
          node as GqlThread,
          head.repo,
          this.opts.providerId,
          this.opts.sourceId,
          refKinds,
        );
        docs.push(normalized.doc);
        edges.push(...this.threadEdges(head.repo, normalized));
      }
    }

    const batchRefSet = new Set(refs.map((r) => r.ref));
    for (let i = pending.length - 1; i >= 0; i--) {
      if (batchRefSet.has(pending[i])) pending.splice(i, 1);
    }
    log.info(
      `Materialized ${docs.length}/${refs.length} ${head.discussion ? "discussions" : "threads"} from ${head.repo} (${pending.length} pending)`,
    );
    return { docs, edges };
  }

  /**
   * Resolve the kinds of the batch's `#N` shorthand refs, over as many
   * aliased queries as the ref count needs. Issues, PRs, and discussions
   * share a number sequence, so the number alone cannot name a document; a
   * number that resolves to nothing is dropped — prose like a CSS color can
   * never become a link.
   */
  private async resolveRefKinds(
    repo: string,
    nodes: ReadonlyArray<GqlThread | GqlDiscussion | null>,
    discussions: boolean,
  ): Promise<ReadonlyMap<number, ThreadKind> | undefined> {
    const texts = nodes.flatMap((node) =>
      node === null
        ? []
        : discussions
          ? collectDiscussionRefTexts(node as GqlDiscussion)
          : collectThreadRefTexts(node as GqlThread),
    );
    const numbers = collectIssueRefs(texts, repo);
    if (numbers.length === 0) return undefined;
    if (numbers.length > NOTABLE_REFS_PER_BATCH) {
      log.warn(
        `${numbers.length} shorthand refs in one ${repo} batch — resolving over ${Math.ceil(numbers.length / MAX_REFS_PER_QUERY)} queries`,
      );
    }
    const [owner, name] = repo.split("/");
    const kinds = new Map<number, ThreadKind>();
    for (let start = 0; start < numbers.length; start += MAX_REFS_PER_QUERY) {
      const chunk = numbers.slice(start, start + MAX_REFS_PER_QUERY);
      const variables: Record<string, unknown> = { owner, name };
      chunk.forEach((n, i) => (variables[`n${i}`] = n));
      const data = await this.opts.client.graphql<{
        repository?: Record<string, { __typename?: string; number?: number } | null> | null;
      }>(buildRefKindsQuery(chunk.length), variables, { tolerateNotFound: true });
      chunk.forEach((n, i) => {
        const t = data.repository?.[`t${i}`];
        const d = data.repository?.[`d${i}`];
        if (t?.__typename === "PullRequest") kinds.set(n, "pull");
        else if (t?.__typename === "Issue") kinds.set(n, "issues");
        else if (d?.number !== undefined && d !== null) kinds.set(n, "discussions");
      });
    }
    return kinds.size > 0 ? kinds : undefined;
  }

  /**
   * PR → merge-commit edge, declared as `accompanies`: created together,
   * neither contains the other, and — unlike `references` — not a type the
   * link re-extraction wipe manages, so the declared edge survives every
   * re-extraction. The "Closes #N" references ride `metadata.extra.links`
   * instead (see threadToDocument), which regenerates under that wipe.
   */
  private threadEdges(
    repo: string,
    normalized: {
      doc: DocumentInput;
      mergeCommitSha?: string;
    },
  ): EdgeDeclaration[] {
    if (!normalized.mergeCommitSha) return [];
    return [
      {
        from: { kind: "internal", sourceDocumentId: normalized.doc.externalId },
        to: {
          kind: "external",
          sourceId: String(this.opts.commitsSourceId),
          sourceDocumentId: commitExternalId(repo, normalized.mergeCommitSha),
        },
        type: "accompanies",
        metadata: { relation: "merge-commit" },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Overflow pagination — the rare thread bigger than the batch query's firsts
  // -------------------------------------------------------------------------

  private async fillThreadOverflow(repo: string, thread: GqlThread): Promise<void> {
    const [owner, name] = repo.split("/");
    if (thread.comments?.pageInfo?.hasNextPage) {
      await this.paginate(async (after) => {
        const data = await this.opts.client.graphql<{
          repository?: { issueOrPullRequest?: { comments?: GqlCommentPage } | null } | null;
        }>(THREAD_COMMENTS_PAGE_QUERY, { owner, name, number: thread.number, after });
        const page = data.repository?.issueOrPullRequest?.comments;
        thread.comments!.nodes = [...(thread.comments!.nodes ?? []), ...(page?.nodes ?? [])];
        return page?.pageInfo;
      }, thread.comments.pageInfo.endCursor);
    }
    const pr = thread.__typename === "PullRequest" ? (thread as GqlPullRequest) : undefined;
    if (pr?.reviews?.pageInfo?.hasNextPage) {
      await this.paginate(async (after) => {
        const data = await this.opts.client.graphql<{
          repository?: {
            pullRequest?: {
              reviews?: {
                pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
                nodes?: Array<GqlReview | null> | null;
              } | null;
            } | null;
          } | null;
        }>(PR_REVIEWS_PAGE_QUERY, { owner, name, number: thread.number, after });
        const page = data.repository?.pullRequest?.reviews;
        pr.reviews!.nodes = [...(pr.reviews!.nodes ?? []), ...(page?.nodes ?? [])];
        return page?.pageInfo;
      }, pr.reviews.pageInfo.endCursor);
    }
  }

  private async fillDiscussionOverflow(repo: string, discussion: GqlDiscussion): Promise<void> {
    if (!discussion.comments?.pageInfo?.hasNextPage) return;
    const [owner, name] = repo.split("/");
    await this.paginate(async (after) => {
      const data = await this.opts.client.graphql<{
        repository?: { discussion?: { comments?: GqlCommentPage } | null } | null;
      }>(DISCUSSION_COMMENTS_PAGE_QUERY, { owner, name, number: discussion.number, after });
      const page = data.repository?.discussion?.comments;
      discussion.comments!.nodes = [...(discussion.comments!.nodes ?? []), ...(page?.nodes ?? [])];
      return page?.pageInfo;
    }, discussion.comments.pageInfo.endCursor);
  }

  private async paginate(
    fetchPage: (
      after: string | null,
    ) => Promise<{ hasNextPage: boolean; endCursor?: string | null } | undefined>,
    startAfter: string | null | undefined,
  ): Promise<void> {
    let after: string | null = startAfter ?? null;
    for (let i = 0; i < MAX_OVERFLOW_PAGES; i++) {
      const pageInfo = await fetchPage(after);
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
      after = pageInfo.endCursor;
    }
    log.warn(`Overflow pagination hit the ${MAX_OVERFLOW_PAGES}-page cap — content truncated`);
  }
}
