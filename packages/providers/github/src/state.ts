// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each GitHub source persists between runs.
 *
 * Both cursors carry a `renderVersion` tag, stamped onto every returned page
 * by `threads.ts` / `commits.ts`. It has nothing to do with the cursor's own
 * JSON shape — an issue, PR, discussion or commit keeps the same external id
 * across a bump — it names which generation of *rendered document* the state
 * was collected under. `decode` rejects any tag but the live one, so a page
 * written under an older render reads exactly like a value this build cannot
 * parse, which is what a full re-walk needs to mean.
 *
 * There is nothing to migrate forward from an old *tag*: it is not that the
 * state's fields changed shape, only that the documents they will produce
 * next did, and upstream re-fetches every thread and commit under the
 * identity it always had. A tag mismatch only ever needs discarding, which
 * `onUnreadable: "rebootstrap"` does on its own.
 *
 * The state's *version* is a different question, and there is one step: a
 * cycle's snapshot used to accumulate every id it had seen in one flat
 * account-wide list, and now keeps them per repository. See `migrate[1]`.
 */

import { COMMITS_RENDER_VERSION, THREADS_RENDER_VERSION } from "./normalizer.js";
import { isValidCursorShape } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { GithubCommitsCursor, GithubThreadsCursor } from "./types.js";

export const githubThreadsStateSpec: SourceStateSpec<GithubThreadsCursor> = {
  version: 2,

  migrate: {
    /**
     * Version 1 accumulated a snapshot's external ids in one flat
     * account-wide `snapshotIds` list, with no record of which repository each
     * came from. Version 2 keeps a `SnapshotLedger` instead, because that
     * attribution is what lets a walk that could not list one repository still
     * vouch for the rest.
     *
     * A flat list cannot be split back up, so a snapshot caught mid-flight by
     * the upgrade is ended rather than resumed: `snapshotMode` is cleared and
     * the accumulator dropped, so the cycle finishes as an ordinary
     * incremental one and the next snapshot starts fresh. `lastSnapshotAt` is
     * left alone — unadvanced for the abandoned walk — so that next one starts
     * as soon as the interval already says it should.
     *
     * The lane in flight goes with it. A snapshot walk orders its threads on
     * creation date ascending and an incremental one on update date
     * descending (see `buildDiscoveryQuery`), and a GraphQL cursor addresses a
     * position in the ordering that produced it. Ending the snapshot while
     * keeping `lane.after` would resume that cursor under the other ordering,
     * skipping a prefix of the most recently updated threads — and the lane's
     * watermark would then fold forward past threads nobody enumerated, so the
     * loss would be durable rather than one cycle's. The repository simply
     * starts its lanes again.
     *
     * Everything the snapshot did not own survives: the per-repository
     * watermarks and known shas, the pending queue, the discovery queue and
     * the two-strike missing-repo counters.
     */
    1: (prior: unknown): unknown | null => {
      if (!prior || typeof prior !== "object") return null;
      const {
        snapshotIds: _snapshotIds,
        snapshotIncomplete: _snapshotIncomplete,
        lane: _lane,
        ...rest
      } = prior as Record<string, unknown>;
      return {
        ...rest,
        ...(rest.snapshotMode === true ? {} : { lane: _lane }),
        snapshotMode: false,
      };
    },
  },

  /**
   * Every shape a cycle can be paused in — mid-lane, mid-materialize,
   * mid-snapshot — carries the same live tag.
   *
   * A cursor with *no* tag is accepted rather than rejected. The tag marks how
   * a thread's document body was rendered, and a cursor written before the tag
   * existed says nothing about its rendering — so rejecting it would re-walk
   * every issue, pull request and discussion in the account against a
   * rate-limited API to answer a question it did not ask. A *different* tag is
   * a genuine mismatch and is refused, which is what re-renders the corpus
   * when the rendering actually changes.
   */
  decode(value: unknown): GithubThreadsCursor | null {
    if (!isValidCursorShape(value)) return null;
    const tag = (value as { renderVersion?: unknown }).renderVersion;
    if (tag !== undefined && tag !== THREADS_RENDER_VERSION) return null;
    return value as GithubThreadsCursor;
  },

  /**
   * A runaway guard, not a capacity limit. The snapshot ledger accumulates one
   * external id per thread found during a full re-enumeration, under the
   * repository it came from, and is only cleared when that snapshot finishes —
   * so its size tracks the whole discovered corpus rather than one page. The ceiling sits well above what
   * even a large multi-repo watch list discovers in one pass, so tripping it
   * means a snapshot stopped completing — the reconcile that clears the
   * field never ran — rather than that the corpus grew.
   */
  maxBytes: 64 * 1024 * 1024,

  /**
   * GitHub keeps every issue, PR, discussion and comment until the operator
   * deletes it, so a discarded cursor costs a re-walk under upstream's own
   * ids and loses nothing.
   */
  onUnreadable: "rebootstrap",
};

export const githubCommitsStateSpec: SourceStateSpec<GithubCommitsCursor> = {
  version: 2,

  migrate: {
    /**
     * Version 1 accumulated a snapshot's external ids in one flat
     * account-wide `snapshotIds` list, with no record of which repository each
     * came from. Version 2 keeps a `SnapshotLedger` instead, because that
     * attribution is what lets a walk that could not list one repository still
     * vouch for the rest.
     *
     * A flat list cannot be split back up, so a snapshot caught mid-flight by
     * the upgrade is ended rather than resumed: `snapshotMode` is cleared and
     * the accumulator dropped, so the cycle finishes as an ordinary
     * incremental one and the next snapshot starts fresh. `lastSnapshotAt` is
     * left alone — unadvanced for the abandoned walk — so that next one starts
     * as soon as the interval already says it should.
     *
     * The lane in flight goes with it. A snapshot walk orders its threads on
     * creation date ascending and an incremental one on update date
     * descending (see `buildDiscoveryQuery`), and a GraphQL cursor addresses a
     * position in the ordering that produced it. Ending the snapshot while
     * keeping `lane.after` would resume that cursor under the other ordering,
     * skipping a prefix of the most recently updated threads — and the lane's
     * watermark would then fold forward past threads nobody enumerated, so the
     * loss would be durable rather than one cycle's. The repository simply
     * starts its lanes again.
     *
     * Everything the snapshot did not own survives: the per-repository
     * watermarks and known shas, the pending queue, the discovery queue and
     * the two-strike missing-repo counters.
     */
    1: (prior: unknown): unknown | null => {
      if (!prior || typeof prior !== "object") return null;
      const {
        snapshotIds: _snapshotIds,
        snapshotIncomplete: _snapshotIncomplete,
        lane: _lane,
        ...rest
      } = prior as Record<string, unknown>;
      return {
        ...rest,
        ...(rest.snapshotMode === true ? {} : { lane: _lane }),
        snapshotMode: false,
      };
    },
  },

  decode(value: unknown): GithubCommitsCursor | null {
    if (!isValidCursorShape(value)) return null;
    // An untagged cursor is accepted for the same reason as the threads lane:
    // it predates the tag and makes no claim about rendering, so re-walking
    // the account's commit history to re-answer it costs requests and gains
    // nothing.
    const tag = (value as { renderVersion?: unknown }).renderVersion;
    if (tag !== undefined && tag !== COMMITS_RENDER_VERSION) return null;
    return value as GithubCommitsCursor;
  },

  /** Same growth shape as the threads cursor's ledger — see {@link githubThreadsStateSpec}. */
  maxBytes: 64 * 1024 * 1024,

  /** A repo's commit history is retained by GitHub the same way — see {@link githubThreadsStateSpec}. */
  onUnreadable: "rebootstrap",
};
