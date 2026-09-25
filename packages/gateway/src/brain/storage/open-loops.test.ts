// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import {
  appendOpenLoopLedger,
  cascadeOpenLoopPrivacyDelete,
  createOpenLoop,
  deleteOpenLoop,
  getOpenLoop,
  listLoopsForPerson,
  listOpenLoopLedger,
  listOpenLoops,
  listRelatedLoops,
  loopPeople,
  searchOpenLoopsLexical,
  updateOpenLoop,
  type CreateOpenLoopInput,
} from "./open-loops.js";
import { createBrief, getBrief, setBriefState } from "./briefs.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function loopInput(over: Partial<CreateOpenLoopInput> = {}): CreateOpenLoopInput {
  return {
    id: over.id ?? `olp_${randomUUID()}`,
    createdByRun: over.createdByRun ?? "run_1",
    title: over.title ?? "Confirm the studio booking with Jamie Lopez",
    description: over.description ?? "Awaiting a reply from the studio.",
    confidence: over.confidence ?? 0.8,
    importance: over.importance ?? 0.6,
    ...over,
  };
}

describe("open-loop repository", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("create + fetch round-trips every field", () => {
    const created = createOpenLoop(
      db,
      loopInput({
        id: "olp_1",
        deadline: { kind: "by", date: "2026-08-01" },
        actors: ["per_1"],
        involved: ["per_1", "per_2"],
        docs: ["doc_a", "doc_b"],
        blockedBy: ["olp_0"],
      }),
      1000,
    );
    expect(created.id).toBe("olp_1");
    const fetched = getOpenLoop(db, "olp_1");
    expect(fetched).toEqual(created);
    expect(fetched?.state).toBe("open");
    expect(fetched?.deadline).toEqual({ kind: "by", date: "2026-08-01" });
    expect(fetched?.docs.sort()).toEqual(["doc_a", "doc_b"]);
    expect(fetched?.createdAt).toBe(1000);
    expect(fetched?.lastUpdate).toBe(1000);
    expect(fetched?.lastDecayCheck).toBeNull();
  });

  test("getOpenLoop returns null for an unknown id", () => {
    expect(getOpenLoop(db, "olp_missing")).toBeNull();
  });

  test("partial update mutates only the named fields and bumps last_update", () => {
    createOpenLoop(db, loopInput({ id: "olp_1", docs: ["doc_a"] }), 1000);
    const updated = updateOpenLoop(
      db,
      "olp_1",
      { state: "done", importance: 0.1, docs: ["doc_a", "doc_c"], deadline: null },
      2000,
    );
    expect(updated?.state).toBe("done");
    expect(updated?.importance).toBe(0.1);
    expect(updated?.docs.sort()).toEqual(["doc_a", "doc_c"]);
    expect(updated?.deadline).toBeNull();
    expect(updated?.lastUpdate).toBe(2000);
    // Unnamed fields survive.
    expect(updated?.title).toBe("Confirm the studio booking with Jamie Lopez");
    expect(updated?.confidence).toBe(0.8);
    expect(updateOpenLoop(db, "olp_missing", { state: "done" }, 2000)).toBeNull();
  });

  test("ledger appends are ordered, run-stamped, and bump last_update", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    appendOpenLoopLedger(
      db,
      "olp_1",
      { runId: "run_1", note: "created from the quote email" },
      1500,
    );
    appendOpenLoopLedger(db, "olp_1", { runId: "run_2", note: "no reply yet" }, 1500);
    const entries = listOpenLoopLedger(db, "olp_1");
    expect(entries.map((e) => e.runId)).toEqual(["run_1", "run_2"]);
    expect(entries.map((e) => e.note)).toEqual(["created from the quote email", "no reply yet"]);
    expect(getOpenLoop(db, "olp_1")?.lastUpdate).toBe(1500);
  });

  test("decay back-off: kept checks accumulate, a ledger note never resets, reinforcement does", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    expect(getOpenLoop(db, "olp_1")?.decayCheckCount).toBe(0);

    // Each decay-check KEEP investigates (a ledger note) then records the
    // verdict via open_loop_update({ decayCheckPassed }). The note must not
    // cancel the increment, so the back-off counter accumulates across
    // kept checks and the interval grows toward the ~1-month cap.
    for (let i = 1; i <= 3; i++) {
      appendOpenLoopLedger(
        db,
        "olp_1",
        { runId: `run_check_${i}`, note: "checked — still relevant, keeping" },
        2000 + i,
      );
      updateOpenLoop(db, "olp_1", { lastDecayCheck: 2000 + i }, 2000 + i);
      expect(getOpenLoop(db, "olp_1")?.decayCheckCount).toBe(i);
    }

    // A bare ledger note does not reset an accumulated back-off counter.
    appendOpenLoopLedger(db, "olp_1", { runId: "run_note", note: "context for later" }, 2100);
    expect(getOpenLoop(db, "olp_1")?.decayCheckCount).toBe(3);

    // Genuine reinforcement — a substantive update carrying new data, with
    // no decay-check flag — resets the counter to the base delay.
    updateOpenLoop(db, "olp_1", { docs: ["doc_new"] }, 3000);
    expect(getOpenLoop(db, "olp_1")?.decayCheckCount).toBe(0);
  });

  test("listOpenLoops filters by state and orders by last_update desc", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    createOpenLoop(db, loopInput({ id: "olp_2" }), 2000);
    createOpenLoop(db, loopInput({ id: "olp_3", state: "done" }), 3000);
    expect(listOpenLoops(db).map((l) => l.id)).toEqual(["olp_3", "olp_2", "olp_1"]);
    expect(listOpenLoops(db, { states: ["open"] }).map((l) => l.id)).toEqual(["olp_2", "olp_1"]);
    expect(listOpenLoops(db, { states: ["open"], limit: 1 }).map((l) => l.id)).toEqual(["olp_2"]);
  });

  test("listOpenLoops orderBy:importance sorts by importance DESC, last_update DESC tiebreak", () => {
    // olp_old is older but more important; olp_new is newest but trivial.
    createOpenLoop(db, loopInput({ id: "olp_old", importance: 0.9 }), 1000);
    createOpenLoop(db, loopInput({ id: "olp_new", importance: 0.2 }), 5000);
    // Two loops of EQUAL importance — the recency tiebreak orders them newest-first.
    createOpenLoop(db, loopInput({ id: "olp_tieA", importance: 0.5 }), 2000);
    createOpenLoop(db, loopInput({ id: "olp_tieB", importance: 0.5 }), 3000);
    expect(listOpenLoops(db, { orderBy: "importance" }).map((l) => l.id)).toEqual([
      "olp_old", // 0.9
      "olp_tieB", // 0.5, newer than tieA
      "olp_tieA", // 0.5
      "olp_new", // 0.2
    ]);
    // Default is unchanged (recency): newest-updated first regardless of importance.
    expect(listOpenLoops(db).map((l) => l.id)).toEqual([
      "olp_new",
      "olp_tieB",
      "olp_tieA",
      "olp_old",
    ]);
  });

  test("listOpenLoops importance keyset includes importance, recency, and id", () => {
    createOpenLoop(db, loopInput({ id: "olp_high", importance: 0.9 }), 1000);
    createOpenLoop(db, loopInput({ id: "olp_tie_b", importance: 0.5 }), 2000);
    createOpenLoop(db, loopInput({ id: "olp_tie_a", importance: 0.5 }), 2000);
    createOpenLoop(db, loopInput({ id: "olp_low", importance: 0.2 }), 5000);

    expect(
      listOpenLoops(db, {
        orderBy: "importance",
        afterImportance: {
          importance: 0.5,
          lastUpdate: 2000,
          id: "olp_tie_b",
        },
      }).map((loop) => loop.id),
    ).toEqual(["olp_tie_a", "olp_low"]);
  });

  describe("deletion invariant", () => {
    test("deleting a loop deletes attached non-terminal briefs, keeps terminal ones edge-free", () => {
      createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
      createBrief(
        db,
        {
          id: "brf_live",
          createdByRun: "run_1",
          kind: "loop",
          title: "Studio booking still unconfirmed",
          confidence: 0.8,
          urgency: 0.4,
          relatedLoopIds: ["olp_1"],
        },
        1000,
      );
      createBrief(
        db,
        {
          id: "brf_terminal",
          createdByRun: "run_1",
          kind: "loop",
          title: "Old reminder",
          confidence: 0.8,
          urgency: 0.4,
          relatedLoopIds: ["olp_1"],
        },
        1000,
      );
      setBriefState(db, "brf_terminal", "dismissed_not_relevant", 1100);

      const result = deleteOpenLoop(db, "olp_1");
      expect(result.deleted).toBe(true);
      expect(result.deletedBriefIds).toEqual(["brf_live"]);
      expect(getOpenLoop(db, "olp_1")).toBeNull();
      expect(getBrief(db, "brf_live")).toBeNull();
      // Terminal brief survives with the dangling edge removed.
      const terminal = getBrief(db, "brf_terminal");
      expect(terminal?.state).toBe("dismissed_not_relevant");
      expect(terminal?.relatedLoopIds).toEqual([]);
      // Ledger + doc edges FK-cascade.
      expect(listOpenLoopLedger(db, "olp_1")).toEqual([]);
    });

    test("deleting an unknown loop reports deleted: false", () => {
      expect(deleteOpenLoop(db, "olp_missing")).toEqual({ deleted: false, deletedBriefIds: [] });
    });
  });

  describe("privacy-delete cascade", () => {
    test("deleting a source document deletes derived loops and briefs (terminal included)", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", docs: ["doc_gone", "doc_other"] }), 1000);
      createOpenLoop(db, loopInput({ id: "olp_2", docs: ["doc_other"] }), 1000);
      // Attached to the cascaded loop, already terminally dismissed —
      // privacy still purges it.
      createBrief(
        db,
        {
          id: "brf_attached",
          createdByRun: "run_1",
          kind: "loop",
          title: "Follow up",
          confidence: 0.5,
          urgency: 0.5,
          relatedLoopIds: ["olp_1"],
        },
        1000,
      );
      setBriefState(db, "brf_attached", "dismissed_wrong", 1100);
      // Cites the deleted doc directly, no loop.
      createBrief(
        db,
        {
          id: "brf_citing",
          createdByRun: "run_1",
          kind: "info",
          title: "Context",
          confidence: 0.5,
          urgency: 0.5,
          citations: ["doc_gone"],
        },
        1000,
      );
      // Unrelated survivor.
      createBrief(
        db,
        {
          id: "brf_unrelated",
          createdByRun: "run_1",
          kind: "info",
          title: "Elsewhere",
          confidence: 0.5,
          urgency: 0.5,
          citations: ["doc_other"],
          relatedLoopIds: ["olp_2"],
        },
        1000,
      );

      const result = cascadeOpenLoopPrivacyDelete(db, ["doc_gone"]);
      expect(result.deletedLoopIds).toEqual(["olp_1"]);
      expect(result.deletedBriefIds.sort()).toEqual(["brf_attached", "brf_citing"]);
      expect(getOpenLoop(db, "olp_1")).toBeNull();
      expect(getBrief(db, "brf_attached")).toBeNull();
      expect(getBrief(db, "brf_citing")).toBeNull();
      // The untouched loop and brief survive.
      expect(getOpenLoop(db, "olp_2")).not.toBeNull();
      expect(getBrief(db, "brf_unrelated")).not.toBeNull();
    });

    test("no derived state is a clean no-op", () => {
      expect(cascadeOpenLoopPrivacyDelete(db, ["doc_gone"])).toEqual({
        deletedLoopIds: [],
        deletedBriefIds: [],
      });
      expect(cascadeOpenLoopPrivacyDelete(db, [])).toEqual({
        deletedLoopIds: [],
        deletedBriefIds: [],
      });
    });
  });

  describe("open_loop_people join table (identity-reconcile index dual-write)", () => {
    function peopleRowCount(loopId: string): number {
      return (
        db
          .prepare<
            [string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM open_loop_people WHERE loop_id = ?")
          .get(loopId)?.n ?? 0
      );
    }

    test("create dual-writes actors/involved as role-tagged rows matching the JSON columns", () => {
      createOpenLoop(
        db,
        loopInput({ id: "olp_1", actors: ["per_a"], involved: ["per_b", "per_c"] }),
        1000,
      );
      expect(loopPeople(db, "olp_1")).toEqual({
        actors: ["per_a"],
        involved: ["per_b", "per_c"],
      });
      const loop = getOpenLoop(db, "olp_1")!;
      expect(loop.actors).toEqual(["per_a"]);
      expect(loop.involved.sort()).toEqual(["per_b", "per_c"]);
    });

    test("a person on both roles yields one row per role", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", actors: ["per_x"], involved: ["per_x"] }), 1000);
      expect(loopPeople(db, "olp_1")).toEqual({ actors: ["per_x"], involved: ["per_x"] });
      expect(peopleRowCount("olp_1")).toBe(2);
    });

    test("deleting a loop cascades its people rows (FK ON DELETE CASCADE)", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", actors: ["per_a"], involved: ["per_b"] }), 1000);
      expect(peopleRowCount("olp_1")).toBe(2);
      deleteOpenLoop(db, "olp_1");
      expect(peopleRowCount("olp_1")).toBe(0);
    });

    test("an actors-only update rewrites actors and leaves the involved rows intact", () => {
      createOpenLoop(
        db,
        loopInput({ id: "olp_1", actors: ["per_a"], involved: ["per_b", "per_c"] }),
        1000,
      );
      // Partial update naming only actors must not wipe the involved rows.
      updateOpenLoop(db, "olp_1", { actors: ["per_a", "per_d"] }, 2000);
      expect(loopPeople(db, "olp_1")).toEqual({
        actors: ["per_a", "per_d"],
        involved: ["per_b", "per_c"],
      });
      // ...and an involved-only update leaves actors intact (and can clear involved).
      updateOpenLoop(db, "olp_1", { involved: [] }, 3000);
      expect(loopPeople(db, "olp_1")).toEqual({ actors: ["per_a", "per_d"], involved: [] });
    });

    test("an update touching neither actors nor involved leaves the join rows untouched", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", actors: ["per_a"], involved: ["per_b"] }), 1000);
      updateOpenLoop(db, "olp_1", { importance: 0.2 }, 2000);
      expect(loopPeople(db, "olp_1")).toEqual({ actors: ["per_a"], involved: ["per_b"] });
    });
  });

  describe("searchOpenLoopsLexical (the reconcile fresh-reads overlay)", () => {
    test("matches a just-created loop by a title token, case-insensitively", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", title: "Pay invoice INV-2041" }), 1_000);
      const hits = searchOpenLoopsLexical(db, "payment received inv-2041");
      expect(hits.map((l) => l.id)).toEqual(["olp_1"]);
    });

    test("matches on description tokens too", () => {
      createOpenLoop(
        db,
        loopInput({
          id: "olp_1",
          title: "Reply to Dana",
          description: "Dana asked for the Harborview lease documents.",
        }),
        1_000,
      );
      expect(searchOpenLoopsLexical(db, "harborview").map((l) => l.id)).toEqual(["olp_1"]);
    });

    test("any-token match: one matching token among several suffices", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", title: "Book the Silver Lake campsite" }), 1_000);
      const hits = searchOpenLoopsLexical(db, "unrelated words silver here");
      expect(hits.map((l) => l.id)).toEqual(["olp_1"]);
    });

    test("short tokens (< 3 chars) are ignored; an all-short query returns nothing", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", title: "An ab task" }), 1_000);
      expect(searchOpenLoopsLexical(db, "an ab")).toEqual([]);
    });

    test("LIKE metacharacters in the query are literal, not wildcards", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", title: "Percent 100% done" }), 1_000);
      createOpenLoop(db, loopInput({ id: "olp_2", title: "Something else entirely" }), 2_000);
      const hits = searchOpenLoopsLexical(db, "100%");
      expect(hits.map((l) => l.id)).toEqual(["olp_1"]);
      // A bare-wildcard-looking token must not match everything.
      expect(searchOpenLoopsLexical(db, "%%%")).toEqual([]);
    });

    test("orders most-recently-updated first and honours the limit", () => {
      createOpenLoop(db, loopInput({ id: "olp_old", title: "invoice alpha" }), 1_000);
      createOpenLoop(db, loopInput({ id: "olp_mid", title: "invoice beta" }), 2_000);
      createOpenLoop(db, loopInput({ id: "olp_new", title: "invoice gamma" }), 3_000);
      const hits = searchOpenLoopsLexical(db, "invoice", { limit: 2 });
      expect(hits.map((l) => l.id)).toEqual(["olp_new", "olp_mid"]);
    });

    test("a multi-token match outranks fresher single-token matches and survives the limit", () => {
      // The buried-loop case: an OLD loop matches several query tokens (the
      // one carrying the query's reference marker); a pile of fresher loops
      // each match one generic token. The old loop must rank first, not be
      // cut by the limit.
      createOpenLoop(
        db,
        loopInput({ id: "olp_target", title: "Sign and return venue contract CT-9993" }),
        1_000,
      );
      createOpenLoop(db, loopInput({ id: "olp_a", title: "Own the venue decision" }), 2_000);
      createOpenLoop(db, loopInput({ id: "olp_b", title: "Review maintenance contract" }), 3_000);
      createOpenLoop(db, loopInput({ id: "olp_c", title: "Send signed disclosure" }), 4_000);
      const hits = searchOpenLoopsLexical(db, "CT-9993 contract signed venue", { limit: 2 });
      expect(hits[0]!.id).toBe("olp_target");
    });
  });

  describe("consolidation trace fires only on the resolve path", () => {
    function retiredCount(): number {
      return db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM retired_loops").get()!.n;
    }

    test("a plain open→open field update does NOT retire", () => {
      createOpenLoop(db, loopInput({ id: "olp_1" }), 1_000);
      // Field-only update (no state change).
      updateOpenLoop(db, "olp_1", { importance: 0.2, description: "still waiting" }, 2_000);
      // An explicit no-op state re-assert to 'open' likewise must not retire.
      updateOpenLoop(db, "olp_1", { state: "open" }, 3_000);
      expect(retiredCount()).toBe(0);
    });

    test("resolving (open→done) retires exactly once", () => {
      createOpenLoop(db, loopInput({ id: "olp_1" }), 1_000);
      updateOpenLoop(db, "olp_1", { state: "done" }, 2_000);
      expect(retiredCount()).toBe(1);
    });

    test("a transition out of a non-open state (snoozed→done) does NOT retire", () => {
      createOpenLoop(db, loopInput({ id: "olp_1", state: "snoozed" }), 1_000);
      updateOpenLoop(db, "olp_1", { state: "done" }, 2_000);
      expect(retiredCount()).toBe(0);
    });
  });

  describe("listLoopsForPerson", () => {
    test("returns active loops the person is an actor OR involved in, newest first, excluding terminal", () => {
      createOpenLoop(db, loopInput({ id: "olp_actor", actors: ["per_a"] }), 3_000);
      createOpenLoop(db, loopInput({ id: "olp_involved", involved: ["per_a"] }), 2_000);
      createOpenLoop(db, loopInput({ id: "olp_done", actors: ["per_a"], state: "done" }), 4_000);
      createOpenLoop(db, loopInput({ id: "olp_other", actors: ["per_b"] }), 1_000);

      // Newest-first, active only; the done loop and the other person's loop drop out.
      expect(listLoopsForPerson(db, "per_a").map((l) => l.id)).toEqual([
        "olp_actor",
        "olp_involved",
      ]);
      expect(listLoopsForPerson(db, "per_b").map((l) => l.id)).toEqual(["olp_other"]);
      expect(listLoopsForPerson(db, "per_none")).toEqual([]);
    });
  });

  describe("listRelatedLoops", () => {
    const NOW = 10_000;
    const brief = (id: string, loops: string[]): void =>
      createBrief(
        db,
        {
          id,
          createdByRun: "run_1",
          kind: "loop",
          title: "cluster",
          confidence: 0.8,
          urgency: 0.4,
          relatedLoopIds: loops,
        },
        1_000,
      );

    test("returns active loops sharing a live brief, newest first, excluding self + terminal loops", () => {
      createOpenLoop(db, loopInput({ id: "olp_1" }), 1_000);
      createOpenLoop(db, loopInput({ id: "olp_2" }), 3_000);
      createOpenLoop(db, loopInput({ id: "olp_3", state: "done" }), 2_000);
      createOpenLoop(db, loopInput({ id: "olp_lonely" }), 1_000);
      brief("brf_a", ["olp_1", "olp_2"]); // olp_1 & olp_2 grouped
      brief("brf_b", ["olp_1", "olp_3"]); // olp_3 is done → excluded

      // olp_1's siblings: olp_2 (active), not olp_3 (done), not itself.
      expect(listRelatedLoops(db, "olp_1", NOW).map((l) => l.id)).toEqual(["olp_2"]);
      // symmetric.
      expect(listRelatedLoops(db, "olp_2", NOW).map((l) => l.id)).toEqual(["olp_1"]);
      // a loop on no brief has no related loops.
      expect(listRelatedLoops(db, "olp_lonely", NOW)).toEqual([]);
    });

    test("ignores groupings through a brief that is no longer on the feed", () => {
      createOpenLoop(db, loopInput({ id: "olp_x" }), 1_000);
      createOpenLoop(db, loopInput({ id: "olp_y" }), 2_000);
      brief("brf_live", ["olp_x", "olp_y"]);
      expect(listRelatedLoops(db, "olp_x", NOW).map((l) => l.id)).toEqual(["olp_y"]);

      // The user dismisses the card (terminal state); the edge rows survive, but the
      // grouping must no longer be honored — both loops are still open.
      setBriefState(db, "brf_live", "dismissed_not_relevant", 1_100);
      expect(listRelatedLoops(db, "olp_x", NOW)).toEqual([]);
    });
  });
});
