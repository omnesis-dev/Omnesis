// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SyncIssue } from "@omnesis/types";

/**
 * Assembling a `SyncResult.presentExternalIds` snapshot out of a read that can
 * come back incomplete.
 *
 * A snapshot is a source asserting *this is everything that exists*. The
 * gateway acts on that by deleting every document it holds for the source that
 * the snapshot does not name. So a snapshot assembled from a read that skipped
 * an address book, a repository, an account or a notebook is not merely a
 * smaller snapshot — it is an instruction to delete whatever the skipped part
 * of the read would have contained.
 *
 * The two outcomes are not symmetric. Withholding a snapshot costs one cycle of
 * deletion detection: nothing is removed, the next tick tries again, and a
 * deletion that happened meanwhile is found then. Emitting a wrong one costs
 * the corpus, and nothing upstream can put it back.
 *
 * That asymmetry is a reason to withhold when the source *knows* it did not
 * look everywhere. It is **not** a reason to withhold because the answer looks
 * surprising. Those are different questions with different owners, and the
 * distinction is load-bearing:
 *
 * - **Did I look everywhere?** The source knows this exactly, from its own
 *   read: a store that would not open, a schema it does not recognise, a page
 *   the API refused. Withholding here has no false positives, and this class
 *   exists to make it the default.
 * - **Is this answer too small to believe?** The source cannot know — it has no
 *   idea how many documents the gateway holds. The gateway does, and it
 *   responds by marking the absent documents with a deadline and corroborating
 *   across reads before deleting anything.
 *
 * A magnitude test here would not delay a suspicious deletion, it would cancel
 * it: a withheld snapshot tells the gateway nothing at all, so nothing is
 * marked and no deadline ever runs. A source that genuinely empties would then
 * never reconcile, and an operator who deleted everything would find Omnesis
 * still holding it — a privacy failure worse than the bug the test was guarding
 * against. So an empty enumeration from a read that covered every partition is
 * a legitimate snapshot, and {@link SnapshotEnumeration.result} returns `[]`
 * for it.
 *
 * `SnapshotEnumeration` therefore makes withholding the default, and makes
 * completeness something a source has to earn partition by partition:
 *
 * - The partitions the source **discovered** are declared to the constructor.
 *   That list is the definition of "everything" for this cycle.
 * - Ids enter the snapshot through {@link SnapshotEnumeration.cover}, a claim
 *   that one named partition was enumerated in full, or through
 *   {@link SnapshotEnumeration.add}, which holds them without claiming
 *   anything — see the paged rewalk below.
 * - A partition that could not be read is declared through
 *   {@link SnapshotEnumeration.gap}, with a reason an operator can act on.
 * - {@link SnapshotEnumeration.result} returns `undefined` — withhold — unless
 *   every discovered partition was covered.
 *
 * The last rule is the one that matters, because it makes *forgetting* safe. A
 * partition dropped by a bare `continue`, an early `return`, a swallowed
 * exception or a branch nobody thought about is never covered, so it holds the
 * snapshot back rather than silently shrinking it. Getting a wrong snapshot out
 * of this class takes a deliberate `cover()` of a partition that was not read.
 *
 * A source with a single backing store still uses it — one partition, covered
 * or gapped — so the "is this read complete?" question is asked in one place
 * for every source rather than re-derived at each call site.
 *
 * A source whose read spans several `sync()` calls cannot hold the enumeration
 * in memory: its rewalk outlives the process. {@link SnapshotEnumeration.add}
 * accumulates a store's ids without vouching for it, {@link toLedger} writes
 * the half-built enumeration into the cursor, and
 * {@link SnapshotEnumeration.resume} reads it back on the next page — against
 * the partitions the source discovers *now*, so a store that has since
 * disappeared cannot be claimed from a stale record of it.
 *
 *
 * @example
 * ```ts
 * const snapshot = new SnapshotEnumeration(stores.map((s) => s.key));
 * for (const store of stores) {
 *   if (store.kind === "unavailable") {
 *     snapshot.gap(store.key, store.reason);
 *     continue;
 *   }
 *   snapshot.cover(store.key, enumerateIds(store.db));
 * }
 * if (!snapshot.complete) log.warn(snapshot.withheldReason()!);
 * return syncPage(documents, cursor, { presentExternalIds: snapshot.result() });
 * ```
 */

/**
 * One partition the source read in full, and everything it found there.
 *
 * A snapshot's all-or-nothing form answers "may I delete anything at all?".
 * This answers the narrower question the gateway can also act on: "may I
 * delete anything *here*?" — which is what lets four readable notebooks keep
 * detecting deletions while a fifth is broken.
 */
export interface SnapshotClaim {
  partition: string;
  ids: string[];
}

/**
 * A {@link SnapshotEnumeration} in the form a source can persist.
 *
 * A single-cycle read builds its enumeration in memory and closes it before
 * returning. A paged one cannot: its rewalk spans many `sync()` calls and many
 * process lifetimes, so the half-built enumeration has to live in the cursor
 * between them. This is that value — plain JSON, no methods — and
 * {@link SnapshotEnumeration.resume} turns it back into the class that knows
 * the rules.
 *
 * Every field is optional so an older cursor, or one written before the source
 * had anything to record, resumes as an empty ledger rather than being refused.
 */
export interface SnapshotLedger {
  /**
   * Ids seen so far, by partition. Holding a partition's ids is not the same
   * as vouching for it: a store abandoned half-way through pagination leaves
   * entries here, and `covered` is what says the set is complete.
   */
  ids?: Record<string, string[]>;
  /** Partitions enumerated to the end — the only ones that become claims. */
  covered?: string[];
  /** Partitions that failed, and the operator-facing reason each did. */
  gaps?: Record<string, string>;
  /**
   * Why this read cannot name every partition that exists, when the missing
   * thing has no partition to be missing from — a directory that would not
   * list, an account whose store index came back truncated, an upstream that
   * acknowledged a container it then refused to describe.
   *
   * A gap says "this named store was not read". This says "the list of names
   * is itself short", which no per-partition record can express. It withholds
   * the whole-source snapshot exactly as a gap does, and leaves the claims of
   * the partitions that WERE read intact.
   */
  blindSpot?: string;
}

/**
 * Whether a stored value is a ledger this build can resume from.
 *
 * A source's cursor decoder has to run this. `resume` trusts what it is handed
 * — it iterates the id arrays and re-inserts them — so a ledger whose `ids` are
 * not arrays of strings throws part-way through a page. The decoder is the only
 * place that can turn that into a re-bootstrap: a value that decodes and then
 * throws leaves the source retrying the same cursor and failing the same way,
 * with no policy able to reach it.
 */
export function isSnapshotLedger(value: unknown): value is SnapshotLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const isStrings = (x: unknown): boolean =>
    Array.isArray(x) && x.every((entry) => typeof entry === "string");
  const isRecordOf = (x: unknown, check: (entry: unknown) => boolean): boolean =>
    typeof x === "object" && x !== null && !Array.isArray(x) && Object.values(x).every(check);
  if (v.ids !== undefined && !isRecordOf(v.ids, isStrings)) return false;
  if (v.covered !== undefined && !isStrings(v.covered)) return false;
  if (v.gaps !== undefined && !isRecordOf(v.gaps, (r) => typeof r === "string")) return false;
  if (v.blindSpot !== undefined && typeof v.blindSpot !== "string") return false;
  return true;
}

/** One partition of a snapshot read that could not be enumerated. */
export interface SnapshotGap {
  /** Stable identifier of the partition, as declared to the constructor. */
  partition: string;
  /** Why it could not be read, phrased for an operator reading a log line. */
  reason: string;
}

/** Reason attached to a discovered partition that was never accounted for. */
const UNACCOUNTED_REASON = "not read this cycle";

export class SnapshotEnumeration {
  private readonly discovered: readonly string[];
  private readonly declaredGaps: SnapshotGap[] = [];
  /**
   * The ids each covered partition holds.
   *
   * Kept apart rather than merged, because which partition an id came from is
   * the difference between "one store would not open, so no deletion is
   * detected anywhere" and "one store would not open, so no deletion is
   * detected in *it*". A source with five notebooks and one bad one has always
   * known that; it was the flattening here that lost it.
   */
  private readonly byPartition = new Map<string, Set<string>>();
  /**
   * Ids belonging to partitions that are still being read. Kept apart from
   * {@link byPartition} so that holding a store's ids never reads as having
   * finished it — the distinction a paged rewalk lives or dies by.
   */
  private readonly pending = new Map<string, Set<string>>();
  /** See {@link SnapshotLedger.blindSpot}. */
  private blind: string | undefined;

  /**
   * @param partitions Every partition the source discovered for this cycle —
   *   including the ones it already knows it cannot read. Discovering none is
   *   not the same as discovering an empty one: an address book directory that
   *   has moved, a token that lists no repositories and an account that has not
   *   finished provisioning all present as zero partitions, and none of them
   *   means "the source is empty". A zero-partition enumeration therefore
   *   always withholds. An *empty* partition — a store that opened and holds no
   *   rows — is covered with no ids, which is how a source legitimately says
   *   "everything here is gone".
   */
  constructor(partitions: Iterable<string>) {
    // Deduped: a partition named twice would produce two claims for one
    // store, which the gateway refuses as a contradiction — turning an
    // author's slip into a page the gateway rejects, and a source that never
    // advances its cursor. Everything else in this class costs a slip one
    // cycle of deletion detection; this would cost the sync.
    this.discovered = [...new Set(partitions)];
  }

  /**
   * Add ids to a partition without vouching for it.
   *
   * A paged source sees one store across many pages and many process
   * lifetimes; it knows the store is complete only when its last page comes
   * back. Until then the ids it has are real but the set is not, and calling
   * {@link cover} for them would claim a store that a failure on the next page
   * would leave half-read. Accumulate with this, then `cover(partition)` when
   * the store's own enumeration ends.
   *
   * @throws if `partition` was not declared to the constructor — same reason as
   *   {@link cover}.
   */
  add(partition: string, ids: Iterable<string>): this {
    this.requireDiscovered(partition, "add");
    const drained = [...ids];
    // A partition that is already covered keeps its ids where everything that
    // reads a covered partition can see them. Holding them aside instead would
    // leave the partition claimed as complete while the claim omitted the ids
    // just added — an instruction to delete exactly the difference.
    const covered = this.byPartition.get(partition);
    const held = covered ?? this.pending.get(partition) ?? new Set<string>();
    for (const id of drained) held.add(id);
    (covered ? this.byPartition : this.pending).set(partition, held);
    return this;
  }

  /**
   * Declare that this read cannot name every partition that exists. See
   * {@link SnapshotLedger.blindSpot} — a hole in the list of names itself,
   * which withholds the whole-source snapshot without withholding the claims
   * of the partitions that were read.
   */
  blindSpot(reason: string): this {
    this.blind ??= reason;
    return this;
  }

  /** This enumeration in the form a cursor can hold. See {@link SnapshotLedger}. */
  toLedger(): SnapshotLedger {
    const ledger: SnapshotLedger = {};
    // Unioned, not overwritten: a partition holds ids in both maps if it was
    // added to after it was covered, and writing one over the other would drop
    // the difference on the round trip through the cursor.
    const ids: Record<string, string[]> = {};
    const hold = (partition: string, held: Iterable<string>): void => {
      ids[partition] = [...new Set([...(ids[partition] ?? []), ...held])];
    };
    for (const [partition, held] of this.pending) hold(partition, held);
    for (const [partition, held] of this.byPartition) hold(partition, held);
    if (Object.keys(ids).length > 0) ledger.ids = ids;
    const covered = [...this.byPartition.keys()];
    if (covered.length > 0) ledger.covered = covered;
    if (this.declaredGaps.length > 0) {
      ledger.gaps = Object.fromEntries(this.declaredGaps.map((g) => [g.partition, g.reason]));
    }
    if (this.blind !== undefined) ledger.blindSpot = this.blind;
    return ledger;
  }

  /**
   * Rebuild an enumeration a previous page left in a cursor.
   *
   * `partitions` is re-read from the source's own state rather than from the
   * ledger, because the discovered set is what defines "everything" and a
   * stored one could be older than the cycle it is closing. A recorded
   * partition the source no longer discovers is dropped, not covered: it
   * becomes unaccounted-for, which withholds the whole-source snapshot rather
   * than shrinking it.
   */
  static resume(
    partitions: Iterable<string>,
    ledger: SnapshotLedger | undefined,
  ): SnapshotEnumeration {
    const snapshot = new SnapshotEnumeration(partitions);
    if (!ledger) return snapshot;
    const covered = new Set(ledger.covered ?? []);
    for (const partition of snapshot.discovered) {
      const ids = ledger.ids?.[partition];
      if (ids !== undefined) {
        if (covered.has(partition)) snapshot.cover(partition, ids);
        else snapshot.add(partition, ids);
      } else if (covered.has(partition)) {
        snapshot.cover(partition, []);
      }
    }
    for (const [partition, reason] of Object.entries(ledger.gaps ?? {})) {
      if (snapshot.discovered.includes(partition)) snapshot.gap(partition, reason);
    }
    if (ledger.blindSpot !== undefined) snapshot.blindSpot(ledger.blindSpot);
    return snapshot;
  }

  private requireDiscovered(partition: string, method: "add" | "cover"): void {
    if (!this.discovered.includes(partition)) {
      throw new Error(
        `SnapshotEnumeration: cannot ${method} undiscovered partition "${partition}" ` +
          `(discovered: ${this.discovered.join(", ") || "none"})`,
      );
    }
  }

  /**
   * Claim that `partition` was enumerated in full, and add its ids to the
   * snapshot. Safe to call more than once for the same partition, and safe to
   * interleave with {@link add} — everything held for the partition is kept.
   *
   * @throws if `partition` was not declared to the constructor — enumerating
   *   something the discovery pass never found means the two disagree about
   *   what "everything" is, which is exactly the confusion this class exists to
   *   prevent.
   */
  cover(partition: string, ids: Iterable<string> = []): this {
    this.requireDiscovered(partition, "cover");
    // Drain the iterable before marking the partition covered. The parameter is
    // an `Iterable`, so it may be a generator that throws part-way through; a
    // partition marked covered first would then be a half-read partition the
    // enumeration believes it holds in full.
    const drained = [...ids];
    // Everything already held for this partition, however it arrived. Merging
    // both maps is what makes `add` and `cover` safe to interleave: taking one
    // and dropping the other would lose ids silently while still claiming the
    // partition was read in full.
    const held = this.byPartition.get(partition) ?? new Set<string>();
    for (const id of this.pending.get(partition) ?? []) held.add(id);
    for (const id of drained) held.add(id);
    this.pending.delete(partition);
    this.byPartition.set(partition, held);
    return this;
  }

  /**
   * Declare that `partition` was read and holds nothing, discarding whatever
   * was accumulated under it.
   *
   * Distinct from `cover(partition, [])`, which merges: a store the source has
   * since learned is gone may already have contributed ids from the pages it
   * managed before it disappeared, and keeping them would have the snapshot
   * vouch for items in a store that no longer exists. This is the claim-shaped
   * way to say "everything that was in here is gone" — the one statement that
   * lets the gateway sweep a whole partition.
   *
   * @throws if `partition` was not declared to the constructor, as {@link cover}.
   */
  empty(partition: string): this {
    this.requireDiscovered(partition, "cover");
    this.pending.delete(partition);
    this.byPartition.set(partition, new Set<string>());
    return this;
  }

  /**
   * Declare that `partition` could not be read, which withholds the whole
   * snapshot. A gap is never fatal — the source keeps syncing, it just does not
   * vouch for absence this cycle.
   */
  gap(partition: string, reason: string): this {
    this.declaredGaps.push({ partition, reason });
    return this;
  }

  /**
   * Drop an id the enumeration returned but that the source knows is gone —
   * a row it is reporting in `deletedExternalIds` in the same cycle, read
   * before the deletion landed. Dropping an id the snapshot does not hold is a
   * no-op.
   */
  exclude(id: string): this {
    for (const held of this.byPartition.values()) held.delete(id);
    for (const held of this.pending.values()) held.delete(id);
    return this;
  }

  /**
   * True when every discovered partition was covered, none was gapped, and the
   * read knows of nothing it could not even name.
   */
  get complete(): boolean {
    return this.gaps.length === 0 && this.discovered.length > 0 && this.blind === undefined;
  }

  /**
   * Every partition the snapshot cannot vouch for: the ones explicitly gapped,
   * plus any discovered partition that was never covered.
   */
  get gaps(): readonly SnapshotGap[] {
    const gapped = new Set(this.declaredGaps.map((g) => g.partition));
    const unaccounted = this.discovered
      .filter((p) => !this.byPartition.has(p) && !gapped.has(p))
      .map((partition) => ({ partition, reason: UNACCOUNTED_REASON }));
    return [...this.declaredGaps, ...unaccounted];
  }

  /**
   * Number of ids enumerated so far, whether or not the snapshot is complete
   * and whether or not the partitions holding them have been covered. This is
   * a progress figure for a log line, not a statement about what was read.
   */
  get size(): number {
    // Distinct ids, not the sum of the partitions'. One item can legitimately
    // appear in two of them — the same contact in two address books, the same
    // commit in two repositories — and the snapshot is a set.
    const all = new Set<string>();
    for (const held of this.byPartition.values()) for (const id of held) all.add(id);
    for (const held of this.pending.values()) for (const id of held) all.add(id);
    return all.size;
  }

  /**
   * What each partition that *was* read holds, whether or not the rest were.
   *
   * This is the claim the gateway can act on partition by partition. A source
   * with five notebooks and one that will not open still vouches for the four
   * it read, so a note deleted in one of them is found this cycle rather than
   * waiting on a repair that may take days — while the fifth's documents are
   * left alone, which is the whole point of withholding.
   *
   * Ordered by the discovery order, so a claim list is stable across cycles
   * that read the same partitions.
   */
  claims(): SnapshotClaim[] {
    // `gaps` is the one place that decides what this cycle does not vouch for:
    // a partition that failed, and a partition nobody ever accounted for. A
    // claim is what is left — every discovered partition with ids behind it.
    const withheld = new Set(this.gaps.map((g) => g.partition));
    const out: SnapshotClaim[] = [];
    for (const partition of this.discovered) {
      const held = this.byPartition.get(partition);
      if (held === undefined || withheld.has(partition)) continue;
      out.push({ partition, ids: [...held] });
    }
    return out;
  }

  /**
   * The snapshot, or `undefined` when the read was not complete. Assign the
   * return value straight to `presentExternalIds` (or the structured twin
   * `presentIds`) — `undefined` is the contract's "no snapshot this cycle".
   */
  result(): string[] | undefined {
    if (!this.complete) return undefined;
    const all = new Set<string>();
    for (const held of this.byPartition.values()) for (const id of held) all.add(id);
    return [...all];
  }

  /**
   * A one-line, operator-facing explanation of why the snapshot is withheld, or
   * `null` when it is not. Log it at `warn`: a source that silently stops
   * detecting deletions looks exactly like a source with nothing to delete.
   */
  withheldReason(): string | null {
    if (this.complete) return null;
    if (this.discovered.length === 0) {
      return (
        "Snapshot withheld: no partitions were discovered, so the source cannot tell an empty " +
        "store from one it failed to find. No deletions detected this cycle."
      );
    }
    if (this.gaps.length === 0 && this.blind !== undefined) {
      return (
        `Snapshot withheld: every partition read was complete, but the list of partitions is ` +
        `itself short — ${this.blind}. No whole-source deletion detected this cycle.`
      );
    }
    const detail = this.gaps.map((g) => `${g.partition} (${g.reason})`).join("; ");
    const blind = this.blind === undefined ? "" : ` It is also short a partition: ${this.blind}.`;
    return (
      `Snapshot withheld: ${this.gaps.length} of ${this.discovered.length} partition(s) ` +
      `could not be enumerated — ${detail}.${blind} Whole-source deletion detection is incomplete; readable partitions may still reconcile.`
    );
  }

  /**
   * What a person is shown when the snapshot is withheld — one sentence.
   *
   * Deliberately not {@link withheldReason}, which is written for a log and
   * says "partition", "enumerated" and "reconcile". Someone reading their
   * source list wants to know what has stopped and which part caused it; the
   * remediation beside it says whether their data is at risk.
   */
  private withheldSummary(): string | null {
    if (this.complete) return null;
    const lead = "Items deleted at the source are not being removed yet";
    if (this.discovered.length === 0) {
      return `${lead}: this sync found nothing at all, which cannot be told apart from an empty source.`;
    }
    if (this.gaps.length === 0 && this.blind !== undefined) {
      return `${lead}: ${this.blind}.`;
    }
    const detail = this.gaps.map((g) => `${g.partition} (${g.reason})`).join("; ");
    const scope =
      this.discovered.length === 1
        ? "this source could not be read in full"
        : `${this.gaps.length} of ${this.discovered.length} parts of this source could not be read in full`;
    return `${lead}: ${scope} — ${detail}.`;
  }

  /** A durable, nonfatal operator warning to include in a finalized page's issues. */
  withheldIssue(): SyncIssue | undefined {
    const message = this.withheldSummary();
    if (message === null) return undefined;
    return {
      code: "snapshot-withheld",
      scope: "partition",
      kind: "unknown",
      count: Math.max(1, this.gaps.length),
      subject: "Deletion detection",
      message,
      remediation: {
        // No instruction to "restore access": a part goes unread for reasons
        // that have nothing to do with permissions — a file past the size
        // cap, a page that did not finish — and telling someone to fix a
        // permission they never lost sends them somewhere there is nothing
        // to find.
        summary:
          "Nothing is lost. New and changed items keep syncing; an item deleted at the source stays in Omnesis until a later sync can read the whole source and confirm it is gone.",
        steps: [
          "This clears on its own once a sync can read every part of the source.",
          "If the reason names a file or folder, check it is readable and not unusually large.",
        ],
        restartRequired: false,
      },
    };
  }
}
