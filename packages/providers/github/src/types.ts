// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSnapshotLedger, makeCursorValidator } from "@omnesis/source-sdk";
import type { SnapshotLedger, SyncCursor } from "@omnesis/source-sdk";
import type { GithubClient } from "./client.js";

/** Shared per-account context handed to both sources. */
export interface GithubContext {
  client: GithubClient;
  accountId: string;
  dataCutoff?: string;
  configDir?: string;
}

// ---------------------------------------------------------------------------
// Thread identity
// ---------------------------------------------------------------------------

/** The kinds of thread document this source materializes. */
export type ThreadKind = "issues" | "pull" | "discussions";

/**
 * A pending-materialization work item, serialized into the cursor as
 * `owner/repo#123` (issue or PR — resolved at fetch time) or
 * `owner/repo#D123` (discussion). Kept as strings so the cursor stays a
 * plain JSON value and the pending set deduplicates naturally.
 */
export type PendingRef = string;

export function pendingRef(repo: string, number: number, discussion = false): PendingRef {
  return `${repo}#${discussion ? "D" : ""}${number}`;
}

export function parsePendingRef(
  ref: PendingRef,
): { repo: string; number: number; discussion: boolean } | null {
  const m = /^([^\s#]+\/[^\s#]+)#(D?)(\d+)$/.exec(ref);
  if (!m) return null;
  return { repo: m[1], number: Number(m[3]), discussion: m[2] === "D" };
}

/**
 * External id for a thread document — deliberately the public URL path
 * (`owner/repo/issues/123`), so the provider's `urlPatterns` regex maps any
 * mention of the thread's URL straight onto the document id.
 */
export function threadExternalId(repo: string, kind: ThreadKind, number: number): string {
  return `${repo}/${kind}/${number}`;
}

/** External id for a commit document — mirrors the public URL path. */
export function commitExternalId(repo: string, sha: string): string {
  return `${repo}/commit/${sha}`;
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * Per-repo incremental watermarks for the threads source. Each lane pairs
 * its watermark with the ids already seen AT that exact timestamp: GitHub
 * timestamps are second-granular, so an item landing in the same second as
 * the watermark after the lane ran would be missed by a strict `>` cut,
 * while `>=` alone would re-process the boundary row every poll.
 */
export interface RepoThreadState {
  /** Max issue `updatedAt` seen on the GraphQL issues lane (ISO). */
  issuesWm?: string;
  issuesAtWm?: number[];
  /** Max PR `updatedAt` seen on the GraphQL pull-requests lane (ISO). */
  pullsWm?: string;
  pullsAtWm?: number[];
  /** Max `updated_at` seen on the repo-wide issue-comments lane (ISO). */
  commentsWm?: string;
  commentsAtWm?: number[];
  /** Max `updated_at` seen on the repo-wide review-comments lane (ISO). */
  reviewCommentsWm?: string;
  reviewCommentsAtWm?: number[];
  /** Max discussion `updatedAt` seen on the GraphQL discussions lane (ISO). */
  discussionsWm?: string;
  discussionsAtWm?: number[];
  /**
   * Discussions discovery failed for this repo on the previous cycle (feature
   * off, grant absent). A second consecutive failure is steady state and no
   * longer poisons the snapshot reconcile; a successful discovery clears it,
   * so two failures months apart are two first failures rather than a settled
   * one.
   */
  discussionsUnavailable?: boolean;
}

/** A discovery connection page: thread numbers with their update times. */
export interface ThreadConnection {
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
  nodes?: Array<{ number: number; updatedAt: string } | null> | null;
}

/** Discovery-lane kinds, run in this order for each repo. */
export type LaneKind = "issues" | "pulls" | "comments" | "reviewComments" | "discussions";

/**
 * Resume state for the in-flight discovery lane. Discovery runs bounded
 * multi-page slices per `sync()` call (snapshot walks commit page-by-page), so a failure mid-walk loses at most one slice of progress.
 */
export interface LaneState {
  repo: string;
  kind: LaneKind;
  page?: number;
  /** GraphQL after-cursor (the connection-walk lanes). */
  after?: string;
  /** The listing's `since`, pinned at lane start so pagination is stable. */
  since?: string;
  /** The freshness cutoff (the lane's watermark when it started). */
  cutoff?: string;
  /** Ids already processed at exactly `cutoff`'s second. */
  cutoffIds?: number[];
  /** Max timestamp seen by the in-flight walk (folded in on completion). */
  newWm?: string;
  /** Ids sharing `newWm`'s exact second. */
  newAtIds?: number[];
  /** A ref was dropped at the pending cap — withhold the watermark. */
  dropped?: boolean;
}

export interface GithubThreadsCursor extends SyncCursor {
  /** Cursor schema/render version — a mismatch forces a full re-walk. */
  renderVersion?: number;
  /** Per-repo lane watermarks, keyed by `owner/repo`. */
  repos?: Record<string, RepoThreadState>;
  /** The discovery lane currently mid-walk. */
  lane?: LaneState;
  /** Threads awaiting materialization. */
  pending?: PendingRef[];
  /** Repos still to run discovery lanes for in the current cycle. */
  discoveryQueue?: string[];
  /** True while the current cycle is a snapshot (full re-enumeration). */
  snapshotMode?: boolean;
  /**
   * The repositories this snapshot cycle set out to read, frozen at cycle
   * start. This is the definition of "everything" the enumeration below is
   * judged against, and freezing it matters: the accessible listing can change
   * between the pages of one cycle, and a repository that appeared half-way
   * through was never walked from the beginning.
   */
  snapshotRepos?: string[];
  /**
   * The in-flight snapshot's enumeration, one partition per repository. A
   * repository whose listing ran to its last page is covered and becomes a
   * claim; one skipped on a permission or unknown error is a gap and is
   * vouched for by nothing. A repository this source has synced before that is
   * absent from the listing altogether is the ledger's blind spot — it is
   * missing from the very list that says what "everything" is, and a revoked
   * grant looks exactly like a deletion from there.
   */
  snapshot?: SnapshotLedger;
  /**
   * Consecutive snapshots a previously-synced repo has been absent from the
   * accessible-repo listing. A temporarily revoked grant looks identical to
   * a deleted repo there, so the first absence defers deletions and only a
   * second consecutive absence lets the sweep proceed.
   */
  missingRepos?: Record<string, number>;
  /** ISO timestamp of the last completed snapshot. */
  lastSnapshotAt?: string;
}

/** Per-repo state for the commits source. */
export interface RepoCommitState {
  /** Max committer date seen (ISO). */
  wm?: string;
  /**
   * Short (12-char) shas of commits already materialized. Bounded by
   * MAX_KNOWN_SHAS; lets the snapshot enumeration detect force-pushed
   * commits whose dates predate the watermark.
   */
  knownShas?: string[];
}

export interface GithubCommitsCursor extends SyncCursor {
  renderVersion?: number;
  repos?: Record<string, RepoCommitState>;
  /** The repo listing currently mid-walk. */
  lane?: { repo: string; page?: number; since?: string; newWm?: string; dropped?: boolean };
  /** Full shas awaiting a detail fetch, as `owner/repo@sha`. */
  pending?: string[];
  discoveryQueue?: string[];
  snapshotMode?: boolean;
  /**
   * The repositories this snapshot cycle set out to read, frozen at cycle
   * start. This is the definition of "everything" the enumeration below is
   * judged against, and freezing it matters: the accessible listing can change
   * between the pages of one cycle, and a repository that appeared half-way
   * through was never walked from the beginning.
   */
  snapshotRepos?: string[];
  /**
   * The in-flight snapshot's enumeration, one partition per repository. A
   * repository whose listing ran to its last page is covered and becomes a
   * claim; one skipped on a permission or unknown error is a gap and is
   * vouched for by nothing. A repository this source has synced before that is
   * absent from the listing altogether is the ledger's blind spot — it is
   * missing from the very list that says what "everything" is, and a revoked
   * grant looks exactly like a deletion from there.
   */
  snapshot?: SnapshotLedger;
  missingRepos?: Record<string, number>;
  lastSnapshotAt?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isRecordOfObjects(v: unknown): v is Record<string, Record<string, unknown>> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "object" && x !== null)
  );
}

/**
 * Shape-check a stored cursor. The pending queue and the snapshot's enumeration
 * decide what gets materialized and what survives a reconcile, so a malformed
 * slot must reset the cursor (⇒ re-bootstrap, safe) rather than be trusted.
 *
 * The enumeration is checked as well as its partition list, and a snapshot
 * cycle is required to carry both. Resuming an enumeration iterates its stored
 * id arrays and refuses a partition the cycle did not open with, so a cursor
 * that is malformed either way throws part-way through a page rather than being
 * refused here — and a value that decodes and then throws leaves the source
 * retrying the same cursor forever, where `onUnreadable` cannot reach it.
 */
export function isValidCursorShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (c.repos !== undefined && !isRecordOfObjects(c.repos)) return false;
  if (c.pending !== undefined && !isStringArray(c.pending)) return false;
  if (c.discoveryQueue !== undefined && !isStringArray(c.discoveryQueue)) return false;
  if (c.snapshotRepos !== undefined && !isStringArray(c.snapshotRepos)) return false;
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  if (c.snapshotMode === true && !isStringArray(c.snapshotRepos)) return false;
  // A cursor written before the per-repository ledger carries `snapshotIds`, a
  // flat array of every id the in-flight snapshot had seen with no record of
  // which repository each came from. It cannot be split back up, so it is
  // refused here rather than resumed from — the state migration turns it into
  // a cursor with no snapshot in flight, and the next cycle starts a fresh one.
  if (c.snapshotIds !== undefined) return false;
  return true;
}

export const validateGithubThreadsCursor = makeCursorValidator<GithubThreadsCursor>(
  (c): c is GithubThreadsCursor => isValidCursorShape(c),
);

export const validateGithubCommitsCursor = makeCursorValidator<GithubCommitsCursor>(
  (c): c is GithubCommitsCursor => isValidCursorShape(c),
);

// ---------------------------------------------------------------------------
// REST payload shapes (only the fields the source reads)
// ---------------------------------------------------------------------------

export interface RestUserRef {
  login: string;
  type?: string; // "User" | "Bot" | "Organization"
}

export interface RestCommentRow {
  id: number;
  issue_url?: string;
  pull_request_url?: string;
  updated_at: string;
}

export interface RestRepoRow {
  full_name: string;
}

export interface RestCommitListRow {
  sha: string;
  commit: { committer?: { date?: string } | null; author?: { date?: string } | null };
}

export interface RestCommitDetail {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string } | null;
    committer?: { name?: string; email?: string; date?: string } | null;
  };
  author?: RestUserRef | null;
  committer?: RestUserRef | null;
  stats?: { additions?: number; deletions?: number; total?: number };
  files?: Array<{ filename: string; status?: string; additions?: number; deletions?: number }>;
  parents?: Array<{ sha: string }>;
}

// ---------------------------------------------------------------------------
// GraphQL payload shapes
// ---------------------------------------------------------------------------

export interface GqlActor {
  login: string;
  __typename?: string;
  name?: string | null;
}

export interface GqlComment {
  author?: GqlActor | null;
  body: string;
  createdAt: string;
  updatedAt?: string;
  url?: string;
  isAnswer?: boolean;
  replies?: { nodes?: Array<GqlComment | null> | null } | null;
}

export interface GqlCommentPage {
  totalCount?: number;
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
  nodes?: Array<GqlComment | null> | null;
}

export interface GqlReview {
  author?: GqlActor | null;
  state: string;
  body?: string;
  submittedAt?: string | null;
  comments?: {
    pageInfo?: { hasNextPage: boolean };
    nodes?: Array<{
      author?: GqlActor | null;
      body: string;
      path?: string | null;
      createdAt: string;
      updatedAt?: string;
    } | null> | null;
  } | null;
}

export interface GqlThreadBase {
  __typename: "Issue" | "PullRequest";
  number: number;
  title: string;
  body?: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  url: string;
  author?: GqlActor | null;
  labels?: { nodes?: Array<{ name: string } | null> | null } | null;
  assignees?: { nodes?: Array<GqlActor | null> | null } | null;
  milestone?: { title: string } | null;
  comments?: GqlCommentPage | null;
}

export interface GqlIssue extends GqlThreadBase {
  __typename: "Issue";
  stateReason?: string | null;
}

export interface GqlPullRequest extends GqlThreadBase {
  __typename: "PullRequest";
  isDraft?: boolean;
  merged?: boolean;
  mergedAt?: string | null;
  mergedBy?: GqlActor | null;
  baseRefName?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: {
    pageInfo?: { hasNextPage: boolean };
    nodes?: Array<{ path: string; additions?: number; deletions?: number } | null> | null;
  } | null;
  reviews?: {
    pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
    nodes?: Array<GqlReview | null> | null;
  } | null;
  closingIssuesReferences?: {
    nodes?: Array<{ number: number; repository?: { nameWithOwner: string } } | null> | null;
  } | null;
  /** The commit this PR landed on the base branch as (squash/rebase/merge). */
  mergeCommit?: { oid: string } | null;
}

export interface GqlDiscussion {
  number: number;
  title: string;
  body?: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  author?: GqlActor | null;
  category?: { name: string } | null;
  answer?: { id: string } | null;
  comments?: GqlCommentPage | null;
}

export type GqlThread = GqlIssue | GqlPullRequest;
