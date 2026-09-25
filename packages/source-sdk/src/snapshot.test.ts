// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { isSnapshotLedger, SnapshotEnumeration } from "./snapshot.js";

describe("SnapshotEnumeration", () => {
  test("a fully covered read yields the union of every partition's ids", () => {
    const snapshot = new SnapshotEnumeration(["store-a", "store-b"]);
    snapshot.cover("store-a", ["a1", "a2"]);
    snapshot.cover("store-b", ["b1"]);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.result()?.sort()).toEqual(["a1", "a2", "b1"]);
    expect(snapshot.withheldReason()).toBeNull();
    expect(snapshot.withheldIssue()).toBeUndefined();
  });

  test("an explicitly gapped partition withholds the whole snapshot", () => {
    const snapshot = new SnapshotEnumeration(["store-a", "store-b"]);
    snapshot.cover("store-a", ["a1", "a2"]);
    snapshot.gap("store-b", "locked by another writer");

    expect(snapshot.complete).toBe(false);
    expect(snapshot.result()).toBeUndefined();
    expect(snapshot.withheldReason()).toContain("store-b (locked by another writer)");
    expect(snapshot.withheldReason()).toContain("1 of 2 partition(s)");
    expect(snapshot.withheldIssue()).toMatchObject({
      code: "snapshot-withheld",
      scope: "partition",
      count: 1,
      subject: "Deletion detection",
      remediation: { restartRequired: false },
    });
  });

  test("what a person is shown is not the log line", () => {
    // The log wants the vocabulary of the contract; a source list wants a
    // sentence. Reusing one string for both is how an operator ends up
    // reading "partition(s) could not be enumerated ... may still reconcile"
    // on the screen where they manage their own data.
    const snapshot = new SnapshotEnumeration(["store-a", "store-b"]);
    snapshot.cover("store-a", ["a1"]);
    snapshot.gap("store-b", "a file in it is over the size limit");

    const shown = snapshot.withheldIssue()!;
    const logged = snapshot.withheldReason()!;
    expect(shown.message).not.toBe(logged);
    for (const jargon of ["partition", "enumerated", "reconcile"]) {
      expect(shown.message.toLowerCase()).not.toContain(jargon);
    }
    // It still has to say which part failed and why — that is the actionable half.
    expect(shown.message).toContain("store-b (a file in it is over the size limit)");
    // And it must say the data is safe, because that is the reader's first question.
    expect(shown.remediation?.summary).toMatch(/^Nothing is lost\./);
  });

  test("the remedy never tells someone to restore access they never lost", () => {
    // A part goes unread for reasons unrelated to permissions — a file past
    // the size cap, a page that did not finish. Sending them to check access
    // sends them somewhere there is nothing to find.
    const snapshot = new SnapshotEnumeration(["calendars"]);
    snapshot.gap("calendars", "an earlier page of this cycle could not account for every calendar");

    const remediation = snapshot.withheldIssue()!.remediation!;
    const text = [remediation.summary, ...remediation.steps].join(" ").toLowerCase();
    expect(text).not.toContain("restore access");
    expect(text).toContain("nothing is lost");
  });

  test("a discovered partition nobody covered withholds it too — forgetting is safe", () => {
    const snapshot = new SnapshotEnumeration(["store-a", "store-b"]);
    // `store-b` is dropped by a bare `continue` — no gap() call at all.
    snapshot.cover("store-a", ["a1"]);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.result()).toBeUndefined();
    expect(snapshot.gaps).toEqual([{ partition: "store-b", reason: "not read this cycle" }]);
  });

  test("an empty enumeration from a fully covered read IS published", () => {
    const snapshot = new SnapshotEnumeration(["store-a"]);
    snapshot.cover("store-a", []);

    // The store opened and holds nothing. `[]` means "delete everything", and
    // that is exactly right: an operator who empties a source expects Omnesis
    // to empty with it. Refusing here would not delay the deletion, it would
    // cancel it — the gateway is told nothing, so it marks nothing and no
    // deadline ever runs.
    expect(snapshot.complete).toBe(true);
    expect(snapshot.result()).toEqual([]);
    expect(snapshot.withheldReason()).toBeNull();
  });

  test("an emptied source reconciles to zero rather than being vetoed", () => {
    // Cycle 1: the source holds three ids and vouches for them.
    const first = new SnapshotEnumeration(["store-a"]);
    first.cover("store-a", ["a", "b", "c"]);
    expect(first.result()).toEqual(["a", "b", "c"]);

    // Cycle 2: the operator deleted all three. No magnitude test stands in the
    // way — the read covered its one partition, so the source knows the store
    // is empty and says so.
    const emptied = new SnapshotEnumeration(["store-a"]);
    emptied.cover("store-a", []);
    expect(emptied.result()).toEqual([]);
  });

  test("discovering no partitions at all withholds rather than deleting everything", () => {
    const snapshot = new SnapshotEnumeration([]);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.result()).toBeUndefined();
    expect(snapshot.withheldReason()).toContain("no partitions were discovered");
  });

  test("covering an undiscovered partition throws rather than widening the snapshot", () => {
    const snapshot = new SnapshotEnumeration(["store-a"]);
    expect(() => snapshot.cover("store-z", ["z1"])).toThrow(
      /cannot cover undiscovered partition "store-z"/,
    );
  });

  test("ids are de-duplicated across partitions", () => {
    const snapshot = new SnapshotEnumeration(["store-a", "store-b"]);
    snapshot.cover("store-a", ["shared", "a1"]);
    snapshot.cover("store-b", ["shared", "b1"]);

    expect(snapshot.size).toBe(3);
    expect(snapshot.result()?.sort()).toEqual(["a1", "b1", "shared"]);
  });

  test("a partition may be covered in several passes", () => {
    const snapshot = new SnapshotEnumeration(["store-a"]);
    snapshot.cover("store-a", ["a1"]);
    snapshot.cover("store-a", ["a2"]);

    expect(snapshot.result()?.sort()).toEqual(["a1", "a2"]);
  });

  test("exclude() drops an id the source is deleting in the same cycle", () => {
    const snapshot = new SnapshotEnumeration(["store-a"]);
    snapshot.cover("store-a", ["a1", "a2"]);
    snapshot.exclude("a2");
    snapshot.exclude("never-present");

    expect(snapshot.result()).toEqual(["a1"]);
  });

  test("size reports the enumeration even while the snapshot is withheld", () => {
    const snapshot = new SnapshotEnumeration(["store-a", "store-b"]);
    snapshot.cover("store-a", ["a1", "a2"]);
    snapshot.gap("store-b", "permission denied");

    expect(snapshot.size).toBe(2);
    expect(snapshot.result()).toBeUndefined();
  });

  test("every gap is named in the withheld reason", () => {
    const snapshot = new SnapshotEnumeration(["a", "b", "c"]);
    snapshot.cover("a", ["a1"]);
    snapshot.gap("b", "permission denied");
    // "c" is silently dropped.

    const reason = snapshot.withheldReason()!;
    expect(reason).toContain("b (permission denied)");
    expect(reason).toContain("c (not read this cycle)");
    expect(reason).toContain("readable partitions may still reconcile");
  });

  test("cover() consumes the ids before marking the partition covered", () => {
    // `cover` takes an Iterable, so a generator may throw part-way. A partition
    // marked covered before the ids are drained would leave the enumeration
    // believing it holds a partition it only half-read.
    function* halfway(): Generator<string> {
      yield "a";
      throw new Error("read failed mid-enumeration");
    }
    const snapshot = new SnapshotEnumeration(["store-a"]);
    expect(() => snapshot.cover("store-a", halfway())).toThrow("read failed mid-enumeration");

    expect(snapshot.complete, "the half-read partition must still count as a gap").toBe(false);
    expect(snapshot.result()).toBeUndefined();
  });
});

describe("what each readable partition vouches for", () => {
  test("a partition that was read is claimed even when another was not", () => {
    // The whole point. Four notebooks read and one that will not open is not
    // silence about all five: the four still vouch for themselves.
    const snapshot = new SnapshotEnumeration(["a", "b", "c"]);
    snapshot.cover("a", ["a1", "a2"]);
    snapshot.cover("b", ["b1"]);
    snapshot.gap("c", "the store would not open");

    expect(snapshot.result()).toBeUndefined();
    expect(snapshot.claims()).toEqual([
      { partition: "a", ids: ["a1", "a2"] },
      { partition: "b", ids: ["b1"] },
    ]);
  });

  test("a partition that was read in part and then failed is claimed by nobody", () => {
    // The dangerous shape, and the one a flat snapshot could not express. A
    // source that reads a store in several queries covers what each returns;
    // when a later query fails it gaps the store. The ids from the successful
    // half are a *part* of that partition, and claiming them would order the
    // deletion of everything the failed half would have named.
    const snapshot = new SnapshotEnumeration(["a", "b"]);
    snapshot.cover("a", ["a1"]);
    snapshot.cover("b", ["b1"]);
    snapshot.gap("b", "the second page was refused");

    expect(snapshot.claims()).toEqual([{ partition: "a", ids: ["a1"] }]);
    expect(snapshot.result()).toBeUndefined();
  });

  test("a partition nobody accounted for is claimed by nobody", () => {
    // Forgetting a partition — a bare `continue`, an early return — must not
    // produce a claim, or the silence would read as "read, and empty".
    const snapshot = new SnapshotEnumeration(["a", "b"]);
    snapshot.cover("a", ["a1"]);

    // `b` was discovered and never mentioned again. It is not claimed, and it
    // is not claimed as empty either — silence about a partition has to read
    // as "not read", never as "read, and there was nothing there".
    expect(snapshot.claims()).toEqual([{ partition: "a", ids: ["a1"] }]);
    expect(snapshot.claims().map((c) => c.partition)).not.toContain("b");
  });

  test("a partition that opened and held nothing is a claim, not a silence", () => {
    // This is how a source says "everything here is gone", and it has to be
    // distinguishable from a partition it never reached.
    const snapshot = new SnapshotEnumeration(["a"]);
    snapshot.cover("a", []);

    expect(snapshot.claims()).toEqual([{ partition: "a", ids: [] }]);
    expect(snapshot.result()).toEqual([]);
  });

  test("an id in two partitions is claimed by both, and counted once", () => {
    const snapshot = new SnapshotEnumeration(["a", "b"]);
    snapshot.cover("a", ["shared", "a1"]);
    snapshot.cover("b", ["shared"]);

    expect(snapshot.claims()).toEqual([
      { partition: "a", ids: ["shared", "a1"] },
      { partition: "b", ids: ["shared"] },
    ]);
    expect(snapshot.size).toBe(2);
  });

  test("an excluded id leaves every partition that held it", () => {
    const snapshot = new SnapshotEnumeration(["a", "b"]);
    snapshot.cover("a", ["gone", "a1"]);
    snapshot.cover("b", ["gone"]);
    snapshot.exclude("gone");

    expect(snapshot.claims()).toEqual([
      { partition: "a", ids: ["a1"] },
      { partition: "b", ids: [] },
    ]);
  });

  test("claims follow the order the partitions were discovered in", () => {
    const snapshot = new SnapshotEnumeration(["c", "a", "b"]);
    snapshot.cover("b", ["b1"]);
    snapshot.cover("c", ["c1"]);
    snapshot.cover("a", ["a1"]);

    expect(snapshot.claims().map((c) => c.partition)).toEqual(["c", "a", "b"]);
  });

  test("ids added to a partition do not vouch for it", () => {
    // The distinction the paged path lives on: holding a store's ids is not
    // having finished reading it. A source that pages through one store and
    // fails on page three has ids and no complete set — treating the ids as a
    // claim would vouch for a store it read half of.
    const snapshot = new SnapshotEnumeration(["a", "b"]);
    snapshot.add("a", ["a1", "a2"]);
    snapshot.cover("b", ["b1"]);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.claims()).toEqual([{ partition: "b", ids: ["b1"] }]);
    expect(snapshot.gaps).toEqual([{ partition: "a", reason: "not read this cycle" }]);
    // The ids are held, so the progress figure counts them.
    expect(snapshot.size).toBe(3);
  });

  test("covering a partition adopts what was added to it", () => {
    const snapshot = new SnapshotEnumeration(["a"]);
    snapshot.add("a", ["a1"]);
    snapshot.add("a", ["a2"]);
    snapshot.cover("a");

    expect(snapshot.complete).toBe(true);
    expect(snapshot.result()?.sort()).toEqual(["a1", "a2"]);
  });

  test("ids added after a partition is covered are still part of what it vouches for", () => {
    // A source can reach `cover` and then find more of the same store — a page
    // that arrived out of order, a second query over one mailbox. The class
    // documents the two calls as safe to interleave, so the ids have to survive
    // both the in-memory merge and the round trip through a cursor. Dropping
    // them would leave the partition claimed as complete while the snapshot
    // omits part of it, which is an instruction to delete the difference.
    const snapshot = new SnapshotEnumeration(["a"]);
    snapshot.add("a", ["a1"]);
    snapshot.cover("a", ["a2"]);
    snapshot.add("a", ["a3"]);

    expect(snapshot.claims()[0]?.ids.slice().sort()).toEqual(["a1", "a2", "a3"]);
    expect(snapshot.toLedger().ids?.a?.slice().sort()).toEqual(["a1", "a2", "a3"]);

    // And a second cover keeps them rather than adopting only its own.
    snapshot.cover("a", ["a4"]);
    expect(snapshot.result()?.sort()).toEqual(["a1", "a2", "a3", "a4"]);

    const resumed = SnapshotEnumeration.resume(["a"], snapshot.toLedger());
    expect(resumed.result()?.sort()).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("adding to an undiscovered partition names the method that refused", () => {
    // The two entry points throw the same way, and an author debugging one of
    // them should not be sent to the other.
    const snapshot = new SnapshotEnumeration(["a"]);
    expect(() => snapshot.add("b", ["b1"])).toThrow(/cannot add undiscovered partition "b"/);
    expect(() => snapshot.cover("b")).toThrow(/cannot cover undiscovered partition "b"/);
    // `empty` is a cover too — a store that was read and holds nothing — so it
    // refuses an undiscovered partition on the same terms.
    expect(() => snapshot.empty("b")).toThrow(/cannot cover undiscovered partition "b"/);
  });

  test("emptying a partition discards what it held, where covering it would keep it", () => {
    // A store the source has since learned is gone may already have contributed
    // ids from the pages it managed before it disappeared. Keeping them would
    // have the snapshot vouch for items in a store that no longer exists, and
    // the sweep would leave exactly those behind.
    const merged = new SnapshotEnumeration(["a"]);
    merged.add("a", ["a1"]);
    merged.cover("a", []);
    expect(merged.result()).toEqual(["a1"]);

    const emptied = new SnapshotEnumeration(["a"]);
    emptied.add("a", ["a1"]);
    emptied.empty("a");
    expect(emptied.complete).toBe(true);
    expect(emptied.result()).toEqual([]);
    expect(emptied.claims()).toEqual([{ partition: "a", ids: [] }]);
  });

  test("a blind spot withholds the whole-source snapshot but not the claims", () => {
    // Something exists that this read could not even name — an upstream that
    // acknowledged a container it then refused to describe. It is missing from
    // the very list that says what "everything" is, so no gap can carry it.
    const snapshot = new SnapshotEnumeration(["a"]);
    snapshot.cover("a", ["a1"]);
    snapshot.blindSpot("the workspace listed a store it would not describe");

    expect(snapshot.complete).toBe(false);
    expect(snapshot.result()).toBeUndefined();
    expect(snapshot.claims()).toEqual([{ partition: "a", ids: ["a1"] }]);
    expect(snapshot.withheldReason()).toContain("the list of partitions is itself short");
  });

  test("a ledger round-trips through a cursor without changing what is vouched for", () => {
    const first = new SnapshotEnumeration(["a", "b", "c"]);
    first.add("a", ["a1"]);
    first.cover("b", ["b1"]);
    first.gap("c", "403 while the share propagates");
    const ledger = first.toLedger();

    // What a cursor would hold: plain JSON, no methods.
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(ledger);

    const resumed = SnapshotEnumeration.resume(["a", "b", "c"], ledger);
    resumed.add("a", ["a2"]);
    resumed.cover("a");

    expect(resumed.complete).toBe(false);
    expect(resumed.claims()).toEqual([
      { partition: "a", ids: ["a1", "a2"] },
      { partition: "b", ids: ["b1"] },
    ]);
    expect(resumed.gaps).toEqual([{ partition: "c", reason: "403 while the share propagates" }]);
  });

  test("a resumed partition the source no longer discovers is dropped, not claimed", () => {
    // The discovered set is re-read from the source's own state, so it is the
    // current cycle that decides what "everything" is. A stale record cannot
    // add a partition back — and losing one leaves the enumeration short of a
    // partition it never covered, which withholds rather than shrinks.
    const before = new SnapshotEnumeration(["a", "gone"]);
    before.cover("a", ["a1"]);
    before.cover("gone", ["ghost"]);

    const resumed = SnapshotEnumeration.resume(["a"], before.toLedger());

    expect(resumed.complete).toBe(true);
    expect(resumed.result()).toEqual(["a1"]);
    expect(resumed.claims()).toEqual([{ partition: "a", ids: ["a1"] }]);
  });

  test("a ledger shape check refuses what resume would throw on", () => {
    // `resume` iterates the stored id arrays, so a malformed ledger throws
    // part-way through a page rather than being refused. A source's decoder is
    // the only place that can turn that into a re-bootstrap — a value that
    // decodes and then throws leaves the source retrying the same cursor
    // forever, and no `onUnreadable` policy can reach it.
    expect(isSnapshotLedger({})).toBe(true);
    expect(isSnapshotLedger({ ids: { a: ["a1"] }, covered: ["a"] })).toBe(true);
    expect(isSnapshotLedger({ gaps: { a: "403" }, blindSpot: "short list" })).toBe(true);

    expect(isSnapshotLedger(null)).toBe(false);
    expect(isSnapshotLedger([])).toBe(false);
    expect(isSnapshotLedger({ ids: { a: 42 } })).toBe(false);
    expect(isSnapshotLedger({ ids: { a: [1] } })).toBe(false);
    expect(isSnapshotLedger({ covered: "a" })).toBe(false);
    expect(isSnapshotLedger({ gaps: { a: 1 } })).toBe(false);
    expect(isSnapshotLedger({ blindSpot: true })).toBe(false);
  });

  test("resuming nothing is an empty enumeration, not a broken one", () => {
    // The first page of a rewalk has no ledger to resume, and a cursor written
    // by a build that predates the field has none either.
    const snapshot = SnapshotEnumeration.resume(["a"], undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.claims()).toEqual([]);
    expect(snapshot.toLedger()).toEqual({});
  });
});
