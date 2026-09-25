// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import {
  createBrief,
  deleteBriefsAttachedToLoops,
  retireBrief,
  getBrief,
  listBriefs,
  listBriefsForLoop,
  countShowableUnreadBriefs,
  listShowableBriefs,
  markBriefRead,
  retractBriefsForResolvedLoop,
  setBriefState,
  updateBrief,
  type CreateBriefInput,
} from "./briefs.js";
import { TERMINAL_BRIEF_STATES } from "./types.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function briefInput(over: Partial<CreateBriefInput> = {}): CreateBriefInput {
  return {
    id: over.id ?? `brf_${randomUUID()}`,
    createdByRun: over.createdByRun ?? "run_1",
    kind: over.kind ?? "info",
    title: over.title ?? "Marathon entry closes Friday",
    description: over.description ?? "The entry form is still unsubmitted.",
    confidence: over.confidence ?? 0.7,
    urgency: over.urgency ?? 0.5,
    ...over,
  };
}

describe("brief repository", () => {
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

  test("create + fetch round-trips every field, born unread", () => {
    const created = createBrief(
      db,
      briefInput({
        id: "brf_1",
        kind: "loop",
        body: "Longer context…",
        citations: ["doc_a", "doc_b"],
        relevantUntil: 9000,
        relatedLoopIds: ["olp_1"],
        nextShow: 5000,
        eventAt: 7000,
      }),
      1000,
    );
    expect(created.state).toBe("unread");
    const fetched = getBrief(db, "brf_1");
    expect(fetched).toEqual(created);
    expect(fetched?.citations).toEqual(["doc_a", "doc_b"]);
    expect(fetched?.relatedLoopIds).toEqual(["olp_1"]);
    expect(fetched?.nextShow).toBe(5000);
    expect(fetched?.eventAt).toBe(7000);
    expect(fetched?.userFeedback).toBeNull();
    expect(getBrief(db, "brf_missing")).toBeNull();
  });

  test("citation order is display order, not lexical", () => {
    createBrief(db, briefInput({ id: "brf_1", citations: ["doc_z", "doc_a", "doc_m"] }), 1000);
    expect(getBrief(db, "brf_1")?.citations).toEqual(["doc_z", "doc_a", "doc_m"]);
  });

  test("partial update mutates only named fields", () => {
    createBrief(db, briefInput({ id: "brf_1", citations: ["doc_a"] }), 1000);
    const updated = updateBrief(
      db,
      "brf_1",
      { urgency: 0.9, nextShow: 4000, userFeedback: "the deadline is actually the 20th" },
      2000,
    );
    expect(updated?.urgency).toBe(0.9);
    expect(updated?.nextShow).toBe(4000);
    expect(updated?.userFeedback).toBe("the deadline is actually the 20th");
    expect(updated?.citations).toEqual(["doc_a"]);
    expect(updated?.title).toBe("Marathon entry closes Friday");
    expect(updated?.updatedAt).toBe(2000);
    expect(updateBrief(db, "brf_missing", { urgency: 1 }, 2000)).toBeNull();
  });

  test("terminal dismissed states are one-way", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    expect(setBriefState(db, "brf_1", "read", 1100)).toBe(true);
    expect(setBriefState(db, "brf_1", "dismissed_already_handled", 1200)).toBe(true);
    // No exit from a terminal state — not even to another terminal one.
    expect(setBriefState(db, "brf_1", "unread", 1300)).toBe(false);
    expect(setBriefState(db, "brf_1", "dismissed_wrong", 1300)).toBe(false);
    expect(getBrief(db, "brf_1")?.state).toBe("dismissed_already_handled");
    // Same-state set stays allowed (idempotent dismiss).
    expect(setBriefState(db, "brf_1", "dismissed_already_handled", 1400)).toBe(true);
  });

  test("snooze is the sanctioned exit — dismissed_snoozed can return to unread", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    expect(setBriefState(db, "brf_1", "dismissed_snoozed", 1100)).toBe(true);
    expect(setBriefState(db, "brf_1", "unread", 1200)).toBe(true);
    expect(getBrief(db, "brf_1")?.state).toBe("unread");
  });

  test("writing next_show to a snoozed brief returns it to unread (the snooze round-trip's engine half)", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    expect(setBriefState(db, "brf_1", "dismissed_snoozed", 1100)).toBe(true);
    const updated = updateBrief(db, "brf_1", { nextShow: 9000 }, 1200);
    expect(updated?.state).toBe("unread");
    expect(updated?.nextShow).toBe(9000);
    // Explicit null ("show immediately") is also an exit.
    expect(setBriefState(db, "brf_1", "dismissed_snoozed", 1300)).toBe(true);
    expect(updateBrief(db, "brf_1", { nextShow: null }, 1400)?.state).toBe("unread");
  });

  test("next_show writes do NOT resurrect other states: terminal briefs stay put, active states keep their state", () => {
    createBrief(db, briefInput({ id: "brf_t" }), 1000);
    setBriefState(db, "brf_t", "dismissed_wrong", 1100);
    expect(updateBrief(db, "brf_t", { nextShow: 9000 }, 1200)?.state).toBe("dismissed_wrong");
    createBrief(db, briefInput({ id: "brf_r" }), 1000);
    setBriefState(db, "brf_r", "read", 1100);
    expect(updateBrief(db, "brf_r", { nextShow: 9000 }, 1200)?.state).toBe("read");
  });

  test("an update NOT touching next_show leaves a snoozed brief snoozed", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    setBriefState(db, "brf_1", "dismissed_snoozed", 1100);
    expect(updateBrief(db, "brf_1", { description: "still waiting" }, 1200)?.state).toBe(
      "dismissed_snoozed",
    );
  });

  test("every terminal state refuses resurrection", () => {
    for (const terminal of TERMINAL_BRIEF_STATES) {
      const id = `brf_${terminal}`;
      createBrief(db, briefInput({ id }), 1000);
      expect(setBriefState(db, id, terminal, 1100)).toBe(true);
      expect(setBriefState(db, id, "unread", 1200)).toBe(false);
    }
  });

  test("setBriefState on an unknown brief returns false", () => {
    expect(setBriefState(db, "brf_missing", "read", 1000)).toBe(false);
  });

  test("listBriefs filters by state, newest first", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    createBrief(db, briefInput({ id: "brf_2" }), 2000);
    setBriefState(db, "brf_1", "read", 2500);
    expect(listBriefs(db).map((b) => b.id)).toEqual(["brf_2", "brf_1"]);
    expect(listBriefs(db, { states: ["unread"] }).map((b) => b.id)).toEqual(["brf_2"]);
    expect(listBriefs(db, { states: ["unread", "read"] })).toHaveLength(2);
  });

  test("the loop-delete cascade removes a brief and its edges", () => {
    createBrief(
      db,
      briefInput({ id: "brf_1", citations: ["doc_a"], relatedLoopIds: ["olp_1"] }),
      1000,
    );
    expect(deleteBriefsAttachedToLoops(db, ["olp_1"], { includeTerminal: true })).toEqual([
      "brf_1",
    ]);
    expect(getBrief(db, "brf_1")).toBeNull();
    const edges = db
      .prepare<
        [],
        { n: number }
      >("SELECT (SELECT COUNT(*) FROM brief_citations) + (SELECT COUNT(*) FROM brief_related_loops) AS n")
      .get();
    expect(edges?.n).toBe(0);
    expect(deleteBriefsAttachedToLoops(db, ["olp_1"], { includeTerminal: true })).toEqual([]);
  });

  test("retireBrief takes a card off every active surface, keeping the row", () => {
    createBrief(db, briefInput({ id: "brf_1", relatedLoopIds: ["olp_1"] }), 1000);
    expect(retireBrief(db, "brf_1", 2000)).toBe(true);
    const row = getBrief(db, "brf_1");
    expect(row?.state).toBe("retired");
    expect(listShowableBriefs(db, 3000).map((b) => b.id)).not.toContain("brf_1");
    expect(countShowableUnreadBriefs(db, 3000)).toBe(0);
    // Terminal, so it is one-way and cannot be walked back onto the feed.
    expect(setBriefState(db, "brf_1", "unread", 4000)).toBe(false);
  });

  test("retireBrief leaves a user's dismissal intact — that state carries feedback", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    setBriefState(db, "brf_1", "dismissed_wrong", 2000);
    expect(retireBrief(db, "brf_1", 3000)).toBe(true);
    expect(getBrief(db, "brf_1")?.state).toBe("dismissed_wrong");
  });

  test("retireBrief reports false only for a brief that does not exist", () => {
    expect(retireBrief(db, "brf_missing", 1000)).toBe(false);
  });

  test("the loop-delete cascade with includeTerminal false spares terminal briefs", () => {
    createBrief(db, briefInput({ id: "brf_live", relatedLoopIds: ["olp_1"] }), 1000);
    createBrief(db, briefInput({ id: "brf_done", relatedLoopIds: ["olp_1"] }), 1000);
    setBriefState(db, "brf_done", "dismissed_already_handled", 1500);
    expect(deleteBriefsAttachedToLoops(db, ["olp_1"], { includeTerminal: false })).toEqual([
      "brf_live",
    ]);
    expect(getBrief(db, "brf_done")).not.toBeNull();
    expect(getBrief(db, "brf_live")).toBeNull();
  });

  test("listShowableBriefs selects exactly the feed's showable set", () => {
    const NOW = 10_000;
    createBrief(db, briefInput({ id: "brf_plain" }), 1000);
    createBrief(db, briefInput({ id: "brf_seen" }), 1000);
    setBriefState(db, "brf_seen", "read", 1500);
    createBrief(db, briefInput({ id: "brf_show_due", nextShow: NOW }), 1000);
    createBrief(db, briefInput({ id: "brf_show_future", nextShow: NOW + 1 }), 1000);
    createBrief(db, briefInput({ id: "brf_still_relevant", relevantUntil: NOW + 1 }), 1000);
    createBrief(db, briefInput({ id: "brf_expired", relevantUntil: NOW }), 1000);
    for (const state of [...TERMINAL_BRIEF_STATES, "dismissed_snoozed" as const]) {
      const id = `brf_${state}`;
      createBrief(db, briefInput({ id }), 1000);
      setBriefState(db, id, state, 1500);
    }
    expect(
      listShowableBriefs(db, NOW)
        .map((b) => b.id)
        .sort(),
    ).toEqual(["brf_plain", "brf_seen", "brf_show_due", "brf_still_relevant"]);
  });

  test("countShowableUnreadBriefs is the showable set minus already-read briefs", () => {
    const NOW = 10_000;
    createBrief(db, briefInput({ id: "brf_plain" }), 1000);
    createBrief(db, briefInput({ id: "brf_seen" }), 1000);
    setBriefState(db, "brf_seen", "read", 1500);
    createBrief(db, briefInput({ id: "brf_show_due", nextShow: NOW }), 1000);
    createBrief(db, briefInput({ id: "brf_show_future", nextShow: NOW + 1 }), 1000);
    createBrief(db, briefInput({ id: "brf_still_relevant", relevantUntil: NOW + 1 }), 1000);
    createBrief(db, briefInput({ id: "brf_expired", relevantUntil: NOW }), 1000);
    for (const state of [...TERMINAL_BRIEF_STATES, "dismissed_snoozed" as const]) {
      const id = `brf_${state}`;
      createBrief(db, briefInput({ id }), 1000);
      setBriefState(db, id, state, 1500);
    }
    // The feed's showable set is {plain, seen, show_due, still_relevant};
    // the badge excludes the read one, leaving 3 unread awaiting attention.
    expect(countShowableUnreadBriefs(db, NOW)).toBe(3);
  });

  test("markBriefRead flips unread → read once, idempotently", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    expect(markBriefRead(db, "brf_1", 2000)).toEqual({ outcome: "marked" });
    const read = getBrief(db, "brf_1")!;
    expect(read.state).toBe("read");
    expect(read.updatedAt).toBe(2000);
    expect(markBriefRead(db, "brf_1", 3000)).toEqual({ outcome: "already_read" });
    expect(getBrief(db, "brf_1")?.updatedAt).toBe(2000); // no-op, no touch
  });

  test("markBriefRead refuses dismissed briefs and unknown ids", () => {
    expect(markBriefRead(db, "brf_missing", 2000)).toEqual({ outcome: "not_found" });
    for (const state of [...TERMINAL_BRIEF_STATES, "dismissed_snoozed" as const]) {
      const id = `brf_${state}`;
      createBrief(db, briefInput({ id }), 1000);
      setBriefState(db, id, state, 1500);
      expect(markBriefRead(db, id, 2000)).toEqual({ outcome: "not_markable", state });
      expect(getBrief(db, id)?.state).toBe(state);
    }
  });

  test("listBriefsForLoop returns every attached brief (any state), newest-created first", () => {
    createBrief(db, briefInput({ id: "brf_old", relatedLoopIds: ["loop_a"] }), 1000);
    createBrief(db, briefInput({ id: "brf_new", relatedLoopIds: ["loop_a", "loop_b"] }), 2000);
    createBrief(db, briefInput({ id: "brf_other", relatedLoopIds: ["loop_b"] }), 3000);
    createBrief(db, briefInput({ id: "brf_none" }), 4000);
    setBriefState(db, "brf_old", "dismissed_wrong", 5000);

    expect(listBriefsForLoop(db, "loop_a").map((b) => b.id)).toEqual(["brf_new", "brf_old"]);
    expect(listBriefsForLoop(db, "loop_b").map((b) => b.id)).toEqual(["brf_other", "brf_new"]);
    expect(listBriefsForLoop(db, "loop_missing")).toEqual([]);
  });

  test("retractBriefsForResolvedLoop moves non-terminal linked briefs to terminal-handled", () => {
    createBrief(db, briefInput({ id: "brf_unread", relatedLoopIds: ["loop_a"] }), 1000);
    createBrief(db, briefInput({ id: "brf_read", relatedLoopIds: ["loop_a"] }), 2000);
    createBrief(db, briefInput({ id: "brf_snoozed", relatedLoopIds: ["loop_a"] }), 3000);
    createBrief(db, briefInput({ id: "brf_terminal", relatedLoopIds: ["loop_a"] }), 4000);
    createBrief(db, briefInput({ id: "brf_other", relatedLoopIds: ["loop_b"] }), 5000);
    markBriefRead(db, "brf_read", 2500);
    setBriefState(db, "brf_snoozed", "dismissed_snoozed", 3500);
    setBriefState(db, "brf_terminal", "dismissed_wrong", 4500);

    const retracted = retractBriefsForResolvedLoop(db, "loop_a", 6000);
    // The three non-terminal linked briefs are retracted; the terminal one
    // and the unrelated loop's brief are not.
    expect(new Set(retracted)).toEqual(new Set(["brf_unread", "brf_read", "brf_snoozed"]));
    expect(getBrief(db, "brf_unread")!.state).toBe("dismissed_already_handled");
    expect(getBrief(db, "brf_read")!.state).toBe("dismissed_already_handled");
    expect(getBrief(db, "brf_snoozed")!.state).toBe("dismissed_already_handled");
    expect(getBrief(db, "brf_terminal")!.state).toBe("dismissed_wrong");
    expect(getBrief(db, "brf_other")!.state).toBe("unread");

    // Idempotent: a second call over the resolved loop retracts nothing.
    expect(retractBriefsForResolvedLoop(db, "loop_a", 7000)).toEqual([]);
    // A loop with no briefs is a clean no-op.
    expect(retractBriefsForResolvedLoop(db, "loop_missing", 7000)).toEqual([]);
  });

  test("retractBriefsForResolvedLoop counts a multi-loop-linked brief once", () => {
    // A brief attached to two loops must be retracted exactly once when one
    // of its loops resolves (the DISTINCT guard).
    createBrief(db, briefInput({ id: "brf_multi", relatedLoopIds: ["loop_a", "loop_b"] }), 1000);
    const retracted = retractBriefsForResolvedLoop(db, "loop_a", 2000);
    expect(retracted).toEqual(["brf_multi"]);
    expect(getBrief(db, "brf_multi")!.state).toBe("dismissed_already_handled");
  });
});
