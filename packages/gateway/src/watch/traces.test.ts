// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The account a watch keeps of itself.
 *
 * A trace is a debugging artefact that a shadow week reads constantly, which
 * makes both of its bounds load-bearing: it has to be complete enough to
 * explain a firing, and small enough not to quietly become the largest thing in
 * the install.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { DECLINED_SAMPLE, EXCHANGES_RETAINED, WatchTraceStore } from "./traces.js";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import type { WatchTrace } from "@omnesis/watch";

let db: EncryptedSqliteDatabase;

beforeEach(() => {
  db = new Database(":memory:") as unknown as EncryptedSqliteDatabase;
});

afterEach(() => {
  db.close();
});

/** A trace of `count` records, numbered so ordering is checkable. */
function traceOf(watch: string, count: number, from = 0): WatchTrace {
  return {
    watch,
    firings: [],
    records: Array.from({ length: count }, (_, index) => ({
      seq: from + index,
      nodeId: "mail",
      key: "singleton",
      transition: "fired" as const,
    })),
  };
}

/** A trace of `count` records of one transition, numbered so order is checkable. */
function traceOfKind(watch: string, count: number, transition: string, from = 0): WatchTrace {
  return {
    watch,
    firings: [],
    records: Array.from({ length: count }, (_, index) => ({
      seq: from + index,
      nodeId: "mail",
      key: "singleton",
      transition: transition as "fired",
      detail: "no lexical term matched",
    })),
  };
}

/**
 * The runtime's noise floor, bounded.
 *
 * A watch with a narrow recall arm declines nearly everything it looks at, and
 * a record apiece filled the whole retention on a real install — which had
 * already evicted the one record explaining that watch's one live cell. What a
 * reader needs from those is the *number*, plus enough samples to see what a
 * decline looks like on this watch.
 */
describe("the declines", () => {
  it("keeps a sample rather than every one", () => {
    const traces = new WatchTraceStore(db);

    traces.record(traceOfKind("w-1", 40, "ignored"), "2026-03-01T09:00:00Z");

    expect(traces.count("w-1")).toBe(DECLINED_SAMPLE);
  });

  it("keeps the newest of them, which is what a reader is looking at", () => {
    const traces = new WatchTraceStore(db);

    traces.record(traceOfKind("w-1", 40, "ignored"), "2026-03-01T09:00:00Z");

    const kept = traces.recent("w-1").map((row) => row.seq);
    expect(kept).toEqual([35, 36, 37, 38, 39]);
  });

  it("counts every one it saw, and goes on counting across the roll-off", () => {
    const traces = new WatchTraceStore(db);

    traces.record(traceOfKind("w-1", 40, "ignored"), "2026-03-01T09:00:00Z");
    traces.record(traceOfKind("w-1", 40, "ignored", 40), "2026-03-01T09:05:00Z");

    // The rows are a sample; the count is the diagnostic. A page reporting the
    // sample size would say "5" about a watch that has declined eighty times.
    expect(traces.classCounts("w-1").ignored).toBe(80);
    expect(traces.count("w-1")).toBe(DECLINED_SAMPLE);
  });

  /**
   * The rule with teeth. Everything else here is about size; this is about
   * which records survive, and getting it wrong is what made a real watch's
   * one firing unexplainable.
   */
  it("never evicts a record that explains something, however many declines arrive", () => {
    const traces = new WatchTraceStore(db);
    traces.record(traceOf("w-1", 1), "2026-03-01T09:00:00Z");

    // Ten times the whole retention, all of it noise.
    for (let round = 0; round < 30; round += 1) {
      traces.record(traceOfKind("w-1", 1_000, "ignored", round * 1_000), "2026-03-01T09:05:00Z");
    }

    const kept = traces.recent("w-1", 10_000);
    expect(
      kept.filter((row) => row.transition === "fired"),
      "the firing's own record was carried out by the noise",
    ).toHaveLength(1);
    expect(traces.classCounts("w-1").ignored).toBe(30_000);
  });

  it.each(["fired", "armed", "cancelled", "suppressed", "failed"])(
    "keeps every %s record, which is never a decline",
    (transition) => {
      const traces = new WatchTraceStore(db);

      traces.record(traceOfKind("w-1", 40, transition), "2026-03-01T09:00:00Z");

      expect(traces.count("w-1")).toBe(40);
    },
  );

  it("forgets a removed watch's counts with its records", () => {
    // They outlive the rows on purpose, but not the watch: a re-added watch of
    // the same id would open with somebody else's history of declines.
    const traces = new WatchTraceStore(db);
    traces.record(traceOfKind("w-1", 10, "ignored"), "2026-03-01T09:00:00Z");

    traces.forget("w-1");

    expect(traces.classCounts("w-1")).toEqual({});
  });
});

describe("what is kept", () => {
  it("records a run in the order it happened", () => {
    const traces = new WatchTraceStore(db);
    traces.record(traceOf("w-1", 3), "2026-03-01T09:00:00Z");

    expect(traces.recent("w-1").map((row) => row.seq)).toEqual([0, 1, 2]);
  });

  it("keeps each watch's account to itself", () => {
    const traces = new WatchTraceStore(db);
    traces.record(traceOf("w-1", 2), "2026-03-01T09:00:00Z");
    traces.record(traceOf("w-2", 3), "2026-03-01T09:00:00Z");

    expect(traces.count("w-1")).toBe(2);
    expect(traces.count("w-2")).toBe(3);
  });

  it("says nothing about a run with nothing in it", () => {
    const traces = new WatchTraceStore(db);
    traces.record(traceOf("w-1", 0), "2026-03-01T09:00:00Z");
    expect(traces.count("w-1")).toBe(0);
  });
});

describe("what is forgotten", () => {
  it("keeps only the most recent records, and keeps the most recent ones", () => {
    // Both halves matter. A prune that ran but kept the wrong end would leave a
    // reader looking at the first hour of a week-long shadow period.
    const traces = new WatchTraceStore(db, 5);
    traces.record(traceOf("w-1", 4, 0), "2026-03-01T09:00:00Z");
    traces.record(traceOf("w-1", 4, 100), "2026-03-01T10:00:00Z");

    const kept = traces.recent("w-1", 100);
    expect(kept, "the retention bound was never enforced").toHaveLength(5);
    expect(kept.map((row) => row.seq)).toEqual([3, 100, 101, 102, 103]);
  });

  it("prunes one watch without touching another", () => {
    // The other watch's record goes in FIRST, so it sits below everything the
    // prune will delete. Written afterwards it would fall outside the deleted
    // range by accident of ordering, and a prune that ignored `watch_id`
    // altogether would still pass.
    const traces = new WatchTraceStore(db, 2);
    traces.record(traceOf("w-2", 1), "2026-03-01T09:00:00Z");
    traces.record(traceOf("w-1", 5), "2026-03-01T09:30:00Z");

    expect(traces.count("w-1")).toBe(2);
    expect(traces.count("w-2"), "pruning one watch took another's records").toBe(1);
  });
});

describe("what removing a watch takes with it", () => {
  it("erases its account, and only its account", () => {
    // The runtime's own state lives in a table this store cannot see and is
    // cleared beside it. Without this half, a week of add-tune-remove leaves
    // orphan records the prune never reclaims — it is keyed on a watch that no
    // longer exists.
    const traces = new WatchTraceStore(db);
    traces.record(traceOf("w-1", 3), "2026-03-01T09:00:00Z");
    traces.record(traceOf("w-2", 2), "2026-03-01T09:00:00Z");

    traces.forget("w-1");

    expect(traces.count("w-1"), "a removed watch kept its trace").toBe(0);
    expect(traces.count("w-2"), "removing one watch took another's trace").toBe(2);
  });
});

/**
 * A failure's class, which is the half of it that is safe to show anyone.
 *
 * The runtime chooses a category — a query that would not bind, a backend that
 * was unreachable, a budget spent — and puts it on the record beside whatever
 * the backend itself said. The class is a fixed vocabulary and can be printed
 * anywhere; the detail is free text from a query engine or a model and may
 * quote a value out of the corpus. A store that kept only the detail would keep
 * exactly the wrong one of the two.
 */
describe("a failed record", () => {
  const failed = (watch: string): WatchTrace => ({
    watch,
    firings: [],
    records: [
      {
        seq: 41,
        nodeId: "spend",
        key: "singleton",
        transition: "failed" as const,
        detail: "the query engine refused to bind a comparison",
        failure: "query" as const,
      },
    ],
  });

  it("keeps the class the runtime chose", () => {
    const traces = new WatchTraceStore(db);
    traces.record(failed("w-1"), "2026-03-01T09:00:00Z");

    const [record] = traces.recent("w-1");
    expect(record?.failure, "the class was dropped and only the message survived").toBe("query");
    expect(record?.detail).toContain("refused to bind");
  });

  it("leaves every other transition without one", () => {
    // A class on a record that did not fail would read as a fault on a watch
    // that is working.
    const traces = new WatchTraceStore(db);
    traces.record(traceOf("w-1", 1), "2026-03-01T09:00:00Z");
    expect(traces.recent("w-1")[0]?.failure).toBeNull();
  });

  it("gains the column on a store written before it existed", () => {
    // The live file already exists and `CREATE TABLE IF NOT EXISTS` does
    // nothing to it, so without the additive upgrade the first read naming the
    // column takes the whole trace surface down.
    db.exec(`
      CREATE TABLE watch_traces (
        rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id    TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        node_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        transition  TEXT NOT NULL,
        detail      TEXT,
        at          TEXT NOT NULL
      )`);
    db.prepare(
      `INSERT INTO watch_traces (watch_id, seq, node_id, key, transition, detail, at)
       VALUES ('w-1', 1, 'mail', 'singleton', 'fired', NULL, '2026-02-01T09:00:00Z')`,
    ).run();

    const traces = new WatchTraceStore(db);
    expect(traces.recent("w-1")[0]?.failure, "an old record read as a failure").toBeNull();

    traces.record(failed("w-1"), "2026-03-01T09:00:00Z");
    expect(traces.recent("w-1")[1]?.failure).toBe("query");
  });
});

describe("what the judge decided, kept per subject", () => {
  it("counts one document once, however many times it is judged", () => {
    // The shape the double count came from: the judge is asked outside the
    // transaction its event commits in, so a node further down the same event
    // throwing rolls the event back and the resume re-asks about the same
    // document. A running total reaches ten having nominated one.
    const store = new WatchTraceStore(db);
    const judged = (subject: string, decision: "matched" | "declined") =>
      store.recordJudgement({
        watchId: "w-1",
        nodeId: "mail",
        key: "singleton",
        subject,
        decision,
        at: "2026-03-01T09:00:00.000Z",
      });

    judged("doc-1", "declined");
    judged("doc-1", "declined");
    judged("doc-1", "declined");

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 0, declined: 1 });
  });

  it("counts two documents apart, and two nodes asking about one document apart", () => {
    // Two recall arms over one document each get their own first look, so each
    // is a nomination of its own — and a subject judged by one node says
    // nothing about what the other decided.
    const store = new WatchTraceStore(db);
    const judged = (nodeId: string, subject: string, decision: "matched" | "declined") =>
      store.recordJudgement({
        watchId: "w-1",
        nodeId,
        key: "singleton",
        subject,
        decision,
        at: "2026-03-01T09:00:00.000Z",
      });

    judged("mail", "doc-1", "declined");
    judged("mail", "doc-2", "declined");
    judged("files", "doc-1", "matched");

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 2 });
  });

  it("takes the last answer about a subject, not the first", () => {
    // A subject re-judged after new evidence arrived has genuinely been decided
    // again. Keeping the first would let a watch whose judge has since said yes
    // go on reading as one that never does.
    const store = new WatchTraceStore(db);
    for (const decision of ["declined", "matched"] as const) {
      store.recordJudgement({
        watchId: "w-1",
        nodeId: "mail",
        key: "singleton",
        subject: "doc-1",
        decision,
        at: "2026-03-01T09:00:00.000Z",
      });
    }

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 0 });
  });

  it("keeps two cells that lead with one document from erasing each other", () => {
    // A node judging accumulated evidence is asked once per cell, and two
    // cells can lead with the same document. Keyed on the document alone, the
    // second cell's decline overwrote the first cell's match — and a judge
    // that has never matched is what both silence-reading verdicts gate on,
    // so the watch would be told its judge refuses everything.
    const store = new WatchTraceStore(db);
    const judged = (key: string, decision: "matched" | "declined") =>
      store.recordJudgement({
        watchId: "w-1",
        nodeId: "review",
        key,
        subject: "doc-1",
        decision,
        at: "2026-03-01T09:00:00.000Z",
      });

    judged("person=p-1", "matched");
    judged("person=p-2", "declined");

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 1 });
  });

  it("does not let a later decline erase a match", () => {
    // The other direction of last-answer-wins, and the one that is a lie. A
    // document revised after it matched is judged again and may be declined —
    // but the count is of documents, and a document the judge admitted is not
    // one it refused. Ten of these and the operator is told the judge refused
    // every one, about a watch whose judge said yes.
    const store = new WatchTraceStore(db);
    const judged = (decision: "matched" | "declined") =>
      store.recordJudgement({
        watchId: "w-1",
        nodeId: "mail",
        key: "singleton",
        subject: "doc-1",
        decision,
        at: "2026-03-01T09:00:00.000Z",
      });

    judged("matched");
    judged("declined");

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 0 });
  });

  it("keeps one watch's judgements out of another's", () => {
    const store = new WatchTraceStore(db);
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      decision: "matched",
      at: "2026-03-01T09:00:00.000Z",
    });
    store.recordJudgement({
      watchId: "w-2",
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      decision: "declined",
      at: "2026-03-01T09:00:00.000Z",
    });

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 0 });
    expect(store.judgementsAll().get("w-2")).toEqual({ matched: 0, declined: 1 });
  });

  it("reads a file written before the sticky match existed", () => {
    // The install this matters on booted yesterday: its table has no
    // `ever_matched`, and every query naming it would fail. Its rows still
    // carry the last answer, which is the most an upgrade can recover — a
    // subject standing at `matched` has certainly matched.
    db.exec(`
      CREATE TABLE watch_judgements (
        watch_id TEXT NOT NULL,
        node_id  TEXT NOT NULL,
        key      TEXT NOT NULL,
        subject  TEXT NOT NULL,
        decision TEXT NOT NULL,
        at       TEXT NOT NULL,
        PRIMARY KEY (watch_id, node_id, key, subject)
      )`);
    db.prepare(
      `INSERT INTO watch_judgements (watch_id, node_id, key, subject, decision, at) VALUES
         ('w-1', 'mail', 'singleton', 'doc-1', 'matched',  '2026-02-01T09:00:00Z'),
         ('w-1', 'mail', 'singleton', 'doc-2', 'declined', '2026-02-01T09:00:00Z')`,
    ).run();

    const store = new WatchTraceStore(db);

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 1 });
    // And the recovered match is sticky from here on, like any other.
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      decision: "declined",
      at: "2026-03-01T09:00:00.000Z",
    });
    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 1 });
  });

  it("settles a carried judgement onto the cell key the node turns out to use", () => {
    // The table that predates the instance key is rebuilt with its rows carried
    // under `singleton`, which is the key every unkeyed node is asked under and
    // the only one an upgrade can guess. A node that judges accumulated
    // evidence is asked under a cell key instead, so its carried rows sit
    // beside the ones it writes from then on and every subject it re-judges is
    // counted twice — permanently, because nothing writes the singleton key
    // again. Five declined documents reading as ten crosses the threshold the
    // silence-reading verdicts gate on and raises an actionable
    // "the judge refuses everything" about a watch that is merely resting.
    db.exec(`
      CREATE TABLE watch_judgements (
        watch_id TEXT NOT NULL,
        node_id  TEXT NOT NULL,
        subject  TEXT NOT NULL,
        decision TEXT NOT NULL,
        at       TEXT NOT NULL,
        PRIMARY KEY (watch_id, node_id, subject)
      )`);
    const subjects = ["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"];
    for (const subject of subjects) {
      db.prepare(
        `INSERT INTO watch_judgements (watch_id, node_id, subject, decision, at)
         VALUES ('w-1', 'review', ?, 'declined', '2026-02-01T09:00:00Z')`,
      ).run(subject);
    }

    const store = new WatchTraceStore(db);
    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 0, declined: 5 });

    // The node is asked again about each of them, per cell, as it always was.
    for (const subject of subjects) {
      store.recordJudgement({
        watchId: "w-1",
        nodeId: "review",
        key: "person=p-1",
        subject,
        decision: "declined",
        at: "2026-03-01T09:00:00.000Z",
      });
    }

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 0, declined: 5 });
  });

  it("keeps the judge's exchanges newest-first, and forgets them with the watch", () => {
    const store = new WatchTraceStore(db);
    for (const n of [1, 2, 3]) {
      store.recordJudgeExchange({
        watchId: "w-1",
        nodeId: "review",
        key: "singleton",
        subject: `doc-${n}`,
        verdict: n === 3 ? "matched" : "declined",
        prompt: `Is doc-${n} a quote for building work?`,
        reply: `{"decision":"${n === 3 ? "matched" : "not_matched"}"}`,
        ms: 40 * n,
        at: `2026-03-0${n}T09:00:00.000Z`,
      });
    }

    const read = store.judgeExchanges("w-1");
    // Newest first: a judge that started deciding wrongly did so at one end of
    // this list, and it is not the old one.
    expect(read.map((e) => e.subject)).toEqual(["doc-3", "doc-2", "doc-1"]);
    expect(read[0]?.verdict).toBe("matched");
    expect(read[0]?.prompt).toContain("doc-3");
    expect(read[0]?.ms).toBe(120);

    // A prompt quotes the document, so the exchanges go when the watch does
    // rather than ageing out of a table nobody reads any more.
    store.forget("w-1");
    expect(store.judgeExchanges("w-1")).toEqual([]);
  });

  it("keeps the newest exchanges per watch and no more", () => {
    // An exchange is a prompt and a reply rather than a line, so the bound is
    // far below the trace retention — and it is enforced on the way in, because
    // a bound swept elsewhere is wrong between sweeps.
    const store = new WatchTraceStore(db);
    for (let n = 0; n < EXCHANGES_RETAINED + 5; n += 1) {
      store.recordJudgeExchange({
        watchId: "w-1",
        nodeId: "review",
        key: "singleton",
        subject: `doc-${n}`,
        verdict: "declined",
        prompt: "Is this a quote?",
        reply: '{"decision":"not_matched"}',
        ms: 10,
        at: "2026-03-01T09:00:00.000Z",
      });
    }

    const all = store.judgeExchanges("w-1", EXCHANGES_RETAINED + 50);
    expect(all).toHaveLength(EXCHANGES_RETAINED);
    // The ones kept are the newest, not whichever the delete happened to miss.
    expect(all[0]?.subject).toBe(`doc-${EXCHANGES_RETAINED + 4}`);
  });

  it("has exactly two statements that can write a judgement row", () => {
    // The settle above deletes a real row on every keyed write, and it is
    // correct only because a singleton-keyed row can be one of two things: a
    // row the key-widening migration carried across, or one an unkeyed node
    // wrote. Both are answers about the same instance, so folding them into
    // the keyed row loses nothing.
    //
    // A third writer would break that silently — no test above would fail, and
    // a live sibling's judgement would be deleted and its history folded into
    // an unrelated instance's row. So the two are pinned rather than argued.
    const text = readFileSync(fileURLToPath(new URL("./traces.ts", import.meta.url)), "utf8");
    const writes = [...text.matchAll(/INSERT\s+INTO\s+watch_judgements/gi)];
    expect(
      writes,
      "a third statement writes watch_judgements — see the fold's premise",
    ).toHaveLength(2);
  });

  it("folds a live singleton sibling, which is the shape to watch for (#1933)", () => {
    // The third origin the two above do not cover. A node reached by one edge
    // that declares a key and another that does not inherits the upstream
    // signal's key on the second — and an unkeyed upstream renders as
    // `singleton`. Both rows are then live answers from the same node about
    // the same subject, from two different instances, and the fold treats the
    // singleton one as a leftover.
    //
    // Characterised rather than fixed: no watch on any install has the shape
    // today — it needs a keyed judge node, and telling a leftover from a live
    // sibling needs the definition, which this store does not have. This test
    // is what would change when it is.
    const store = new WatchTraceStore(db);
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "review",
      key: "singleton",
      subject: "doc-1",
      decision: "matched",
      at: "2026-03-01T09:00:00.000Z",
    });
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "review",
      key: "person=p-1",
      subject: "doc-1",
      decision: "declined",
      at: "2026-03-01T09:05:00.000Z",
    });

    // One row, not two: the live singleton answer was folded away, and its
    // match carried onto an instance that declined.
    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 0 });
  });

  it("does not lose a carried match when the cell key settles it", () => {
    // The settle deletes a row, and that row may hold the one fact the table
    // exists to keep: a document the judge admitted, whose last answer has
    // since gone the other way. Dropped rather than folded, the watch reads as
    // one whose judge has never said yes.
    db.exec(`
      CREATE TABLE watch_judgements (
        watch_id TEXT NOT NULL,
        node_id  TEXT NOT NULL,
        subject  TEXT NOT NULL,
        decision TEXT NOT NULL,
        at       TEXT NOT NULL,
        PRIMARY KEY (watch_id, node_id, subject)
      )`);
    db.prepare(
      `INSERT INTO watch_judgements (watch_id, node_id, subject, decision, at)
       VALUES ('w-1', 'review', 'doc-1', 'matched', '2026-02-01T09:00:00Z')`,
    ).run();

    const store = new WatchTraceStore(db);
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "review",
      key: "person=p-1",
      subject: "doc-1",
      decision: "declined",
      at: "2026-03-01T09:00:00.000Z",
    });

    expect(store.judgementsAll().get("w-1")).toEqual({ matched: 1, declined: 0 });
  });

  it("forgets them with the watch, so a re-added id opens on nobody's history", () => {
    const store = new WatchTraceStore(db);
    store.recordJudgement({
      watchId: "w-1",
      nodeId: "mail",
      key: "singleton",
      subject: "doc-1",
      decision: "declined",
      at: "2026-03-01T09:00:00.000Z",
    });

    store.forget("w-1");

    expect(store.judgementsAll().get("w-1")).toBeUndefined();
  });
});
