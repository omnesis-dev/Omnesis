// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { syncPage } from "@omnesis/source-sdk";
import { COMMITS_RENDER_VERSION, commitToDocument } from "./normalizer.js";
import { commitExternalId } from "./types.js";
import { reconcileMissingRepos, resolveRepoList } from "./repo-selection.js";
import {
  gapRepo,
  resumeRepoSnapshot,
  startRepoSnapshot,
  withRepoSnapshot,
} from "./repo-snapshot.js";
import { INCREMENTAL_MARGIN_MS, SNAPSHOT_INTERVAL_MS, shouldEnterSnapshotMode } from "./threads.js";
import type { SourceConfig } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { SyncResult } from "@omnesis/source-sdk";
import type { GithubClient } from "./client.js";
import type { GithubCommitsCursor, RepoCommitState } from "./types.js";

const log = createLogger("source:github-commits");

/** Commit details fetched (one REST call each) per sync page. */
const COMMIT_BATCH = 20;
/** Prefer draining pending over starting another repo beyond this size. */
const MAX_PENDING_BEFORE_MATERIALIZE = 500;
const MAX_PENDING = 100_000;
/**
 * Short-sha memory per repo — the order-independent freshness test, and what
 * lets the snapshot walk spot force-pushed-in commits whose dates predate
 * the watermark.
 */
const MAX_KNOWN_SHAS = 100_000;
const SHORT_SHA_LEN = 12;
/** Listing pages fetched per discovery `sync()` call (incremental walks). */
const MAX_LANE_PAGES_PER_CALL = 30;

function marginBefore(wm: string | undefined) {
  if (!wm) return undefined;
  return new Date(new Date(wm).getTime() - INCREMENTAL_MARGIN_MS).toISOString();
}

export interface GithubCommitsSourceOptions {
  client: GithubClient;
  providerId: ProviderId;
  sourceId: SourceId;
  dataCutoff?: string;
  sourceConfig?: SourceConfig;
  snapshotIntervalMs?: number;
  now?: () => number;
}

/**
 * One document per commit on each repo's default branch — message, author,
 * stats, and changed-file paths; never the diff. Discovery lists commits
 * with a `since` pinned at lane start (committer-date watermark); freshness
 * is judged by the known-sha set, never by listing order. A daily snapshot
 * re-lists everything so force-pushed-away commits sweep via
 * `presentExternalIds` and force-pushed-in commits are noticed as unknown
 * shas.
 */
export class GithubCommitsSource {
  private readonly opts: GithubCommitsSourceOptions;
  private readonly now: () => number;

  constructor(opts: GithubCommitsSourceOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async sync(cursor: GithubCommitsCursor | null): Promise<SyncResult<GithubCommitsCursor>> {
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
    cursor: GithubCommitsCursor | null,
  ): Promise<SyncResult<GithubCommitsCursor>> {
    const cur: GithubCommitsCursor = { ...(cursor ?? {}), renderVersion: COMMITS_RENDER_VERSION };
    const pending: string[] = [...(cur.pending ?? [])];
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
      if (repoList.length === 0) return this.finishCycle(cur, []);
      return syncPage([], cur, { hasMore: true });
    }

    // Discovery: a bounded slice of listing pages per call. At the hard
    // pending cap the lane pauses and materialization drains.
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

    // Materialization: fetch details for a batch of shas.
    if (pending.length > 0) {
      const docs = await this.materializeBatch(cur, pending);
      cur.pending = pending;
      const moreWork =
        pending.length > 0 || (cur.discoveryQueue?.length ?? 0) > 0 || cur.lane !== undefined;
      if (!moreWork) return this.finishCycle(cur, docs);
      return syncPage(docs, cur, { hasMore: true });
    }

    return this.finishCycle(cur, []);
  }

  private repoState(cur: GithubCommitsCursor, repo: string): RepoCommitState {
    cur.repos ??= {};
    cur.repos[repo] ??= {};
    return cur.repos[repo];
  }

  private finishCycle(
    cur: GithubCommitsCursor,
    docs: DocumentInput[],
  ): SyncResult<GithubCommitsCursor> {
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
        log.warn(enumeration.withheldReason() ?? "Snapshot withheld");
        const claims = enumeration.claims();
        if (claims.length === 0) return syncPage(docs, cur, { hasMore: false, issues });
        log.info(
          `Claiming ${claims.length} repositories read in full — deletions are detected inside them and deferred for the rest.`,
        );
        return syncPage(docs, cur, { hasMore: false, presentClaims: claims, issues });
      }
      const present = enumeration.result();
      // A snapshot that enumerated nothing where commits previously existed is
      // suspicious, and is deliberately still published. Refusing it would not
      // delay the deletion, it would cancel it: a withheld snapshot tells the
      // gateway nothing, so nothing is marked and no deadline runs, and a
      // repository whose history was genuinely rewritten away would stay in
      // the index forever. Magnitude is the gateway's call — it knows how many
      // documents it holds and marks absences with a deadline. What this walk
      // owes it is the `incomplete` answer just above: whether the read
      // actually covered every repository.
      log.info(`Snapshot complete: ${present?.length ?? 0} commits present`);
      return syncPage(docs, cur, {
        hasMore: false,
        issues,
        presentExternalIds: present ?? [],
        watermark: { guarantee: "snapshot", observedAt: cur.lastSnapshotAt },
      });
    }
    return syncPage(docs, cur, { hasMore: false });
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private async runDiscoverySlice(
    cur: GithubCommitsCursor,
    pending: string[],
    pendingSet: Set<string>,
  ): Promise<void> {
    let budget = MAX_LANE_PAGES_PER_CALL;
    while (budget > 0) {
      if (!cur.lane) {
        const repo = cur.discoveryQueue?.shift();
        if (!repo) return;
        const state = this.repoState(cur, repo);
        cur.lane = {
          repo,
          page: 1,
          since: cur.snapshotMode
            ? this.opts.dataCutoff
            : (marginBefore(state.wm) ?? this.opts.dataCutoff),
        };
      }
      try {
        budget -= 1;
        await this.listStep(cur, pending, pendingSet);
      } catch (err) {
        // A deleted repo or a revoked grant must not wedge the source. During
        // a snapshot the repository is recorded as a gap, so the rest of the
        // account still reconciles. An empty repository never reaches here —
        // the client maps its 409 to an empty listing.
        if (err instanceof SyncError && (err.kind === "permission" || err.kind === "unknown")) {
          const repo = cur.lane?.repo;
          log.warn(`Skipping commit listing for ${repo}: ${err.message}`);
          if (repo) gapRepo(cur, repo, err.message);
          cur.lane = undefined;
          continue;
        }
        throw err;
      }
      // The full-history snapshot walk commits page-by-page.
      if (cur.snapshotMode && cur.lane) return;
    }
  }

  private async listStep(
    cur: GithubCommitsCursor,
    pending: string[],
    pendingSet: Set<string>,
  ): Promise<void> {
    const lane = cur.lane!;
    const state = this.repoState(cur, lane.repo);
    const snapshot = cur.snapshotMode === true;
    const known = new Set(state.knownShas ?? []);
    const { rows, hasNextPage } = await this.opts.client.listCommits(
      lane.repo,
      lane.since,
      lane.page ?? 1,
    );
    const freshShas: string[] = [];
    // Accumulated under this repository, not into one account-wide list: which
    // repository an id came from is what lets a walk that could not read one of
    // them still vouch for the rest.
    const presentThisPage: string[] = [];
    for (const row of rows) {
      const short = row.sha.slice(0, SHORT_SHA_LEN);
      if (snapshot) presentThisPage.push(commitExternalId(lane.repo, row.sha));
      if (!known.has(short)) {
        const ref = `${lane.repo}@${row.sha}`;
        if (pendingSet.has(ref)) {
          // already queued from a previous page/lane
        } else if (pending.length < MAX_PENDING) {
          pending.push(ref);
          pendingSet.add(ref);
          // Recorded as known at DISCOVERY time: pending + knownShas travel in
          // the same cursor, so they commit or are lost together.
          freshShas.push(short);
        } else {
          // Not recorded as known — rediscovered by the next listing. Lane-
          // scoped: any drop on any page withholds the watermark fold below.
          if (!lane.dropped) log.error(`Pending queue at cap — deferring refs to the next cycle`);
          lane.dropped = true;
        }
      }
      const date = row.commit.committer?.date ?? row.commit.author?.date;
      if (date && (!lane.newWm || date > lane.newWm)) lane.newWm = date;
    }
    if (freshShas.length > 0) {
      const merged = [...(state.knownShas ?? []), ...freshShas];
      state.knownShas =
        merged.length > MAX_KNOWN_SHAS ? merged.slice(merged.length - MAX_KNOWN_SHAS) : merged;
    }
    if (snapshot) {
      withRepoSnapshot(cur, (enumeration) => {
        enumeration.add(lane.repo, presentThisPage);
        // The last page of this repository's listing is the only place its set
        // becomes complete. Every other way out — a permission error, an
        // unknown error, a cycle that ends mid-listing — leaves before here.
        if (!hasNextPage) enumeration.cover(lane.repo);
      });
    }
    if (hasNextPage) {
      lane.page = (lane.page ?? 1) + 1;
    } else {
      // Fold the observed max committer date into the watermark only on a
      // completed, drop-free walk — an interrupted or capped walk re-runs
      // against the old `since` instead of losing the unseen tail.
      if (!lane.dropped && lane.newWm && (!state.wm || lane.newWm > state.wm)) {
        state.wm = lane.newWm;
      }
      cur.lane = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Materialization
  // -------------------------------------------------------------------------

  private async materializeBatch(
    cur: GithubCommitsCursor,
    pending: string[],
  ): Promise<DocumentInput[]> {
    const batch = pending.slice(0, COMMIT_BATCH);
    const docs: DocumentInput[] = [];
    for (const ref of batch) {
      const at = ref.lastIndexOf("@");
      const repo = ref.slice(0, at);
      const sha = ref.slice(at + 1);
      if (!repo || !sha || at < 0) continue;
      try {
        const detail = await this.opts.client.getCommit(repo, sha);
        const committedAt = detail.commit.committer?.date ?? detail.commit.author?.date;
        if (!(this.opts.dataCutoff && committedAt && committedAt < this.opts.dataCutoff)) {
          docs.push(commitToDocument(detail, repo, this.opts.providerId, this.opts.sourceId));
        }
      } catch (err) {
        if (err instanceof SyncError && err.kind === "permission") {
          // The commit vanished (force-push) between listing and fetch.
          log.warn(`Commit ${ref} is gone — skipping`);
        } else {
          throw err;
        }
      }
    }
    pending.splice(0, batch.length);
    log.info(`Materialized ${docs.length}/${batch.length} commits (${pending.length} pending)`);
    return docs;
  }
}
