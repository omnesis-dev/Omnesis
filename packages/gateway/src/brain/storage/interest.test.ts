// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  INTEREST_EMBED_BACKOFF_BASE_MS,
  INTEREST_EMBED_BACKOFF_MAX_MS,
  INTEREST_NOTE_MAX_CHARS,
  INTEREST_SUBJECT_MAX_CHARS,
  applyBriefReaction,
  countInterestSignals,
  countUnembeddedInterestSignals,
  deleteBriefItemReaction,
  deleteInterestSignalsFor,
  embeddingFromBlob,
  embeddingToBlob,
  getBriefItemReaction,
  getInterestSignal,
  hasInterestEmbeddingsNotFrom,
  insertInterestSignal,
  interestEmbedRetryAt,
  interestLedgerFingerprint,
  isWithheldSuggestion,
  listBriefItemReactions,
  listInterestSignals,
  listLiveInterestSignals,
  listUnembeddedInterestSignals,
  listWithheldSuggestions,
  recordInterestSignal,
  resetInterestEmbeddingsNotFrom,
  setInterestSignalEmbedding,
  supersedeInterestSignals,
  upsertBriefItemReaction,
  type NewInterestSignal,
} from "./interest.js";
import { createObservation, getObservation, setObservationUserAction } from "./observations.js";
import { createOpenLoop, listOpenLoopLedger } from "./open-loops.js";
import { applyTaskCommand } from "./tasks.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00Z");
const MINUTE = 60_000;

let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

let counter = 0;
function signal(over: Partial<NewInterestSignal> = {}): NewInterestSignal {
  counter += 1;
  return {
    id: `int_${String(counter).padStart(4, "0")}`,
    polarity: 1,
    kind: "task",
    source: "task_accepted",
    subjectText: "Renew the passport before the Lisbon trip",
    createdAt: NOW + counter,
    ...over,
  };
}

function embedState(id: string): { attempts: number; after: number } {
  const row = db
    .prepare<
      [string],
      { embed_attempts: number; embed_after: number }
    >("SELECT embed_attempts, embed_after FROM interest_signals WHERE id = ?")
    .get(id)!;
  return { attempts: row.embed_attempts, after: row.embed_after };
}

const liveIds = () => listLiveInterestSignals(db, { limit: 50 }).map((s) => s.id);

describe("interest signals", () => {
  test("insert and get round-trip every field, with no vector yet", () => {
    const stored = insertInterestSignal(
      db,
      signal({
        id: "int_a",
        polarity: -1,
        kind: "observation",
        source: "brief_not_interested",
        subjectText: "  The gym renewal is due\nIt lapses on Friday  ",
        note: "I cancelled that membership",
        observationId: "obs_1",
        conversationId: "conv_1",
        ledgerSeq: null,
        createdAt: NOW,
      }),
    );
    expect(stored).toEqual({
      id: "int_a",
      polarity: -1,
      kind: "observation",
      source: "brief_not_interested",
      subjectText: "The gym renewal is due\nIt lapses on Friday",
      note: "I cancelled that membership",
      loopId: null,
      observationId: "obs_1",
      conversationId: "conv_1",
      ledgerSeq: null,
      embedding: null,
      embeddingModel: null,
      createdAt: NOW,
      supersededAt: null,
    });
    expect(getInterestSignal(db, "int_a")).toEqual(stored);
    expect(getInterestSignal(db, "int_missing")).toBeNull();
    expect(embedState("int_a")).toEqual({ attempts: 0, after: 0 });
  });

  test("the subject and the note are clipped to their maxima", () => {
    const stored = insertInterestSignal(
      db,
      signal({
        subjectText: "s".repeat(INTEREST_SUBJECT_MAX_CHARS + 500),
        note: "n".repeat(INTEREST_NOTE_MAX_CHARS + 500),
      }),
    );
    expect(stored.subjectText).toBe(`${"s".repeat(INTEREST_SUBJECT_MAX_CHARS)}…`);
    expect(stored.note).toBe(`${"n".repeat(INTEREST_NOTE_MAX_CHARS)}…`);
    const exact = insertInterestSignal(
      db,
      signal({ subjectText: "t".repeat(INTEREST_SUBJECT_MAX_CHARS), note: "" }),
    );
    expect(exact.subjectText).toHaveLength(INTEREST_SUBJECT_MAX_CHARS);
    expect(exact.note).toBeNull();
  });

  test("supersede by loop, by observation and by ledger seq, live rows only", () => {
    insertInterestSignal(db, signal({ id: "int_loop", loopId: "loop_1", ledgerSeq: 7 }));
    insertInterestSignal(db, signal({ id: "int_obs", observationId: "obs_1" }));
    insertInterestSignal(db, signal({ id: "int_seq", loopId: "loop_2", ledgerSeq: 9 }));
    insertInterestSignal(db, signal({ id: "int_other", loopId: "loop_3" }));

    expect(supersedeInterestSignals(db, { loopId: "loop_1" }, NOW + 100)).toBe(1);
    expect(supersedeInterestSignals(db, { observationId: "obs_1" }, NOW + 100)).toBe(1);
    expect(supersedeInterestSignals(db, { ledgerSeq: 9 }, NOW + 100)).toBe(1);
    // Already superseded rows are not counted again; an empty selector does nothing.
    expect(supersedeInterestSignals(db, { loopId: "loop_1" }, NOW + 200)).toBe(0);
    expect(supersedeInterestSignals(db, {}, NOW + 200)).toBe(0);
    expect(getInterestSignal(db, "int_loop")?.supersededAt).toBe(NOW + 100);

    expect(liveIds()).toEqual(["int_other"]);
    expect(
      listInterestSignals(db, { limit: 10 })
        .map((s) => s.id)
        .sort(),
    ).toEqual(["int_loop", "int_obs", "int_other", "int_seq"]);
  });

  test("supersede by kind narrows a scope and names nothing on its own", () => {
    insertInterestSignal(db, signal({ id: "int_task", loopId: "loop_1" }));
    insertInterestSignal(
      db,
      signal({
        id: "int_said",
        kind: "statement",
        source: "statement",
        subjectText: "the passport renewal",
        loopId: "loop_1",
      }),
    );
    expect(supersedeInterestSignals(db, { kind: "task" }, NOW + 100)).toBe(0);
    expect(supersedeInterestSignals(db, { loopId: "loop_1", kind: "task" }, NOW + 100)).toBe(1);
    expect(liveIds()).toEqual(["int_said"]);
  });

  test("supersede by statement text matches the subject case-insensitively, statements only", () => {
    insertInterestSignal(
      db,
      signal({
        id: "int_more",
        kind: "statement",
        source: "statement",
        subjectText: "  trail Running RACES ",
      }),
    );
    insertInterestSignal(
      db,
      signal({ id: "int_task", kind: "task", subjectText: "trail running races" }),
    );
    insertInterestSignal(
      db,
      signal({
        id: "int_other",
        kind: "statement",
        source: "statement",
        subjectText: "trail running shoes",
      }),
    );
    expect(supersedeInterestSignals(db, { statementText: "TRAIL running races" }, NOW + 1)).toBe(1);
    expect(liveIds().sort()).toEqual(["int_other", "int_task"]);
  });

  test("recordInterestSignal supersedes what the new signal replaces and inserts it together", () => {
    insertInterestSignal(db, signal({ id: "int_up", observationId: "obs_1", createdAt: NOW }));
    const stored = recordInterestSignal(
      db,
      signal({
        id: "int_down",
        polarity: -1,
        kind: "observation",
        source: "brief_not_interested",
        observationId: "obs_1",
        createdAt: NOW + 50,
      }),
      { observationId: "obs_1" },
    );
    expect(stored.id).toBe("int_down");
    expect(getInterestSignal(db, "int_up")?.supersededAt).toBe(NOW + 50);
    expect(liveIds()).toEqual(["int_down"]);
    // Without a scope nothing is superseded.
    recordInterestSignal(db, signal({ id: "int_again", observationId: "obs_1" }), null);
    expect(liveIds().sort()).toEqual(["int_again", "int_down"]);
  });

  test("deleting for an observation removes its signals and its reaction row; for a loop, its signals", () => {
    insertInterestSignal(db, signal({ id: "int_o1", observationId: "obs_1" }));
    insertInterestSignal(db, signal({ id: "int_o2", observationId: "obs_1", createdAt: 1 }));
    insertInterestSignal(db, signal({ id: "int_l1", loopId: "loop_1" }));
    insertInterestSignal(db, signal({ id: "int_keep", loopId: "loop_2" }));
    upsertBriefItemReaction(
      db,
      { observationId: "obs_1", day: "2026-03-10", messageId: "msg_1", reaction: "up" },
      NOW,
    );
    upsertBriefItemReaction(
      db,
      { observationId: "obs_2", day: "2026-03-10", messageId: "msg_1", reaction: "up" },
      NOW,
    );

    expect(deleteInterestSignalsFor(db, { observationId: "obs_1" })).toBe(2);
    expect(getBriefItemReaction(db, "obs_1")).toBeNull();
    expect(getBriefItemReaction(db, "obs_2")).not.toBeNull();
    expect(deleteInterestSignalsFor(db, { loopId: "loop_1" })).toBe(1);
    expect(deleteInterestSignalsFor(db, {})).toBe(0);
    expect(listInterestSignals(db, { limit: 10 }).map((s) => s.id)).toEqual(["int_keep"]);
  });

  test("live signals come newest first, bounded and since a time", () => {
    insertInterestSignal(db, signal({ id: "int_old", createdAt: NOW - 3 }));
    insertInterestSignal(db, signal({ id: "int_mid", createdAt: NOW - 2 }));
    insertInterestSignal(db, signal({ id: "int_new", createdAt: NOW - 1 }));
    expect(liveIds()).toEqual(["int_new", "int_mid", "int_old"]);
    expect(listLiveInterestSignals(db, { limit: 2 }).map((s) => s.id)).toEqual([
      "int_new",
      "int_mid",
    ]);
    expect(listLiveInterestSignals(db, { limit: 10, since: NOW - 2 }).map((s) => s.id)).toEqual([
      "int_new",
      "int_mid",
    ]);
  });

  test("the ledger fingerprint moves on every change a lookup would see", () => {
    const empty = interestLedgerFingerprint(db);
    insertInterestSignal(db, signal({ id: "int_a", loopId: "loop_1", createdAt: NOW }));
    const inserted = interestLedgerFingerprint(db);
    expect(inserted).not.toBe(empty);
    expect(interestLedgerFingerprint(db)).toBe(inserted);
    setInterestSignalEmbedding(db, "int_a", { vector: [1, 0], model: "m1" }, NOW);
    const embedded = interestLedgerFingerprint(db);
    expect(embedded).not.toBe(inserted);
    supersedeInterestSignals(db, { loopId: "loop_1" }, NOW + 1);
    const superseded = interestLedgerFingerprint(db);
    expect(superseded).not.toBe(embedded);
    deleteInterestSignalsFor(db, { loopId: "loop_1" });
    expect(interestLedgerFingerprint(db)).toBe(empty);
  });

  test("counts split live signals by polarity and statements, and count the superseded", () => {
    insertInterestSignal(db, signal({ id: "int_p1" }));
    insertInterestSignal(db, signal({ id: "int_p2" }));
    insertInterestSignal(db, signal({ id: "int_n1", polarity: -1, source: "task_ignored" }));
    insertInterestSignal(
      db,
      signal({ id: "int_s1", polarity: -1, kind: "statement", source: "statement" }),
    );
    insertInterestSignal(db, signal({ id: "int_gone", loopId: "loop_gone" }));
    supersedeInterestSignals(db, { loopId: "loop_gone" }, NOW);
    expect(countInterestSignals(db)).toEqual({
      live: 4,
      superseded: 1,
      positive: 2,
      negative: 1,
      statements: 1,
    });
  });
});

describe("the embedding backlog", () => {
  test("the retry wait doubles from fifteen minutes and is capped at sixteen hours", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 20].map(
      (attempts) => (interestEmbedRetryAt(attempts, NOW) - NOW) / MINUTE,
    );
    expect(waits).toEqual([15, 30, 60, 120, 240, 480, 960, 960, 960]);
    expect(interestEmbedRetryAt(1, NOW) - NOW).toBe(INTEREST_EMBED_BACKOFF_BASE_MS);
    expect(interestEmbedRetryAt(8, NOW) - NOW).toBe(INTEREST_EMBED_BACKOFF_MAX_MS);
    expect(interestEmbedRetryAt(0, NOW) - NOW).toBe(INTEREST_EMBED_BACKOFF_BASE_MS);
  });

  test("lists the rows due at `now` oldest first and pages by (created_at, id)", () => {
    insertInterestSignal(db, signal({ id: "int_b", createdAt: NOW + 2 }));
    insertInterestSignal(db, signal({ id: "int_a1", createdAt: NOW + 1 }));
    insertInterestSignal(db, signal({ id: "int_a2", createdAt: NOW + 1 }));
    insertInterestSignal(db, signal({ id: "int_gone", createdAt: NOW, loopId: "loop_gone" }));
    supersedeInterestSignals(db, { loopId: "loop_gone" }, NOW);
    const ids = (opts: Parameters<typeof listUnembeddedInterestSignals>[1]) =>
      listUnembeddedInterestSignals(db, opts).map((s) => s.id);

    expect(ids({ limit: 10, now: NOW + 10 })).toEqual(["int_a1", "int_a2", "int_b"]);
    expect(ids({ limit: 2, now: NOW + 10 })).toEqual(["int_a1", "int_a2"]);
    expect(ids({ limit: 2, now: NOW + 10, after: { createdAt: NOW + 1, id: "int_a2" } })).toEqual([
      "int_b",
    ]);
    expect(ids({ limit: 10, now: NOW + 10, after: { createdAt: NOW + 1, id: "int_a1" } })).toEqual([
      "int_a2",
      "int_b",
    ]);
    expect(ids({ limit: 10, now: NOW + 10, after: { createdAt: NOW + 2, id: "int_b" } })).toEqual(
      [],
    );
    expect(countUnembeddedInterestSignals(db, NOW + 10)).toBe(3);
  });

  test("a failed attempt pushes the row out by its backoff and never gives it up for good", () => {
    insertInterestSignal(db, signal({ id: "int_a", createdAt: NOW }));
    insertInterestSignal(db, signal({ id: "int_b", createdAt: NOW + 1 }));
    const due = (now: number) =>
      listUnembeddedInterestSignals(db, { limit: 10, now }).map((s) => s.id);

    const t1 = NOW + 10;
    expect(setInterestSignalEmbedding(db, "int_a", null, t1)).toBe(true);
    expect(embedState("int_a")).toEqual({ attempts: 1, after: t1 + 15 * MINUTE });
    expect(due(t1)).toEqual(["int_b"]);
    expect(countUnembeddedInterestSignals(db, t1)).toBe(1);
    expect(due(t1 + 15 * MINUTE - 1)).toEqual(["int_b"]);
    expect(due(t1 + 15 * MINUTE)).toEqual(["int_a", "int_b"]);

    const t2 = t1 + 15 * MINUTE;
    setInterestSignalEmbedding(db, "int_a", null, t2);
    expect(embedState("int_a")).toEqual({ attempts: 2, after: t2 + 30 * MINUTE });
    const t3 = t2 + 30 * MINUTE;
    setInterestSignalEmbedding(db, "int_a", null, t3);
    expect(embedState("int_a")).toEqual({ attempts: 3, after: t3 + 60 * MINUTE });
    // No hard cap: once the wait is over the row is offered again.
    expect(due(t3 + 60 * MINUTE)).toEqual(["int_a", "int_b"]);
    expect(setInterestSignalEmbedding(db, "int_missing", null, NOW)).toBe(false);
  });

  test("a vector is stored as Float32, read back with its model, and clears the backoff", () => {
    insertInterestSignal(db, signal({ id: "int_v" }));
    setInterestSignalEmbedding(db, "int_v", null, NOW);
    expect(embedState("int_v").after).toBeGreaterThan(NOW);
    expect(
      setInterestSignalEmbedding(
        db,
        "int_v",
        { vector: [0.5, -1.25, 3, 0.1], model: "m1" },
        NOW + 1,
      ),
    ).toBe(true);
    const stored = getInterestSignal(db, "int_v")!;
    expect(stored.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(stored.embedding!)).toEqual(
      Array.from(Float32Array.from([0.5, -1.25, 3, 0.1])),
    );
    expect(stored.embeddingModel).toBe("m1");
    expect(embedState("int_v")).toEqual({ attempts: 2, after: 0 });
    expect(listUnembeddedInterestSignals(db, { limit: 10, now: NOW + 10 * MINUTE })).toEqual([]);
    // A Float32Array input stores the same bytes as a plain array.
    expect(embeddingToBlob(Float32Array.from([1, 2]))).toEqual(embeddingToBlob([1, 2]));
  });

  test("reset forgets vectors from other embedders with their attempts and backoff, keeping the live one's", () => {
    insertInterestSignal(db, signal({ id: "int_old_model" }));
    insertInterestSignal(db, signal({ id: "int_live_model" }));
    insertInterestSignal(db, signal({ id: "int_none" }));
    setInterestSignalEmbedding(db, "int_old_model", { vector: [1, 0], model: "m1" }, NOW);
    setInterestSignalEmbedding(db, "int_live_model", { vector: [0, 1], model: "m2" }, NOW);
    setInterestSignalEmbedding(db, "int_none", null, NOW);
    db.prepare("UPDATE interest_signals SET embed_after = 999 WHERE id = 'int_old_model'").run();

    expect(hasInterestEmbeddingsNotFrom(db, "m2")).toBe(true);
    expect(hasInterestEmbeddingsNotFrom(db, "m1")).toBe(true);
    expect(resetInterestEmbeddingsNotFrom(db, "m2")).toBe(1);
    expect(hasInterestEmbeddingsNotFrom(db, "m2")).toBe(false);
    const reset = getInterestSignal(db, "int_old_model")!;
    expect(reset.embedding).toBeNull();
    expect(reset.embeddingModel).toBeNull();
    expect(embedState("int_old_model")).toEqual({ attempts: 0, after: 0 });
    const kept = getInterestSignal(db, "int_live_model")!;
    expect(kept.embeddingModel).toBe("m2");
    expect(Array.from(kept.embedding!)).toEqual([0, 1]);
    // A row without a vector is not from another embedder; its failed attempt stands.
    expect(embedState("int_none").attempts).toBe(1);
    expect(resetInterestEmbeddingsNotFrom(db, "m2")).toBe(0);
    // A superseded row's foreign vector is nobody's concern.
    insertInterestSignal(db, signal({ id: "int_gone", loopId: "loop_gone" }));
    setInterestSignalEmbedding(db, "int_gone", { vector: [1, 1], model: "m1" }, NOW);
    supersedeInterestSignals(db, { loopId: "loop_gone" }, NOW);
    expect(hasInterestEmbeddingsNotFrom(db, "m2")).toBe(false);
  });

  test("embeddingFromBlob rejects empty and odd-length blobs", () => {
    expect(embeddingFromBlob(null)).toBeNull();
    expect(embeddingFromBlob(Buffer.alloc(0))).toBeNull();
    expect(embeddingFromBlob(Buffer.alloc(6))).toBeNull();
    expect(Array.from(embeddingFromBlob(embeddingToBlob([1.5, -2]))!)).toEqual([1.5, -2]);
    // The vector is a copy, not a view on the blob's memory.
    const blob = embeddingToBlob([4, 5]);
    const vector = embeddingFromBlob(blob)!;
    blob.fill(0);
    expect(Array.from(vector)).toEqual([4, 5]);
  });
});

describe("brief item reactions", () => {
  const input = {
    observationId: "obs_1",
    day: "2026-03-10",
    messageId: "msg_1",
    reaction: "up" as const,
  };

  test("upsert creates, a second upsert replaces, keeping the first creation time", () => {
    const created = upsertBriefItemReaction(db, input, NOW);
    expect(created).toEqual({
      observationId: "obs_1",
      day: "2026-03-10",
      messageId: "msg_1",
      reaction: "up",
      note: null,
      noteId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const replaced = upsertBriefItemReaction(
      db,
      {
        ...input,
        reaction: "factual_error",
        note: "  The invoice was 40, not 400  ",
        noteId: "note_1",
      },
      NOW + 10,
    );
    expect(replaced).toMatchObject({
      reaction: "factual_error",
      note: "The invoice was 40, not 400",
      noteId: "note_1",
      createdAt: NOW,
      updatedAt: NOW + 10,
    });
    expect(getBriefItemReaction(db, "obs_1")).toEqual(replaced);
    // A replacement without a note clears the previous one.
    expect(
      upsertBriefItemReaction(db, { ...input, reaction: "not_interested" }, NOW + 20),
    ).toMatchObject({ reaction: "not_interested", note: null, noteId: null });
    const long = upsertBriefItemReaction(
      db,
      { ...input, note: "x".repeat(INTEREST_NOTE_MAX_CHARS + 1) },
      NOW + 30,
    );
    expect(long.note).toHaveLength(INTEREST_NOTE_MAX_CHARS + 1);
    expect(long.note?.endsWith("…")).toBe(true);
  });

  test("list by message keys the reactions by observation; delete reports whether one was there", () => {
    upsertBriefItemReaction(db, input, NOW);
    upsertBriefItemReaction(
      db,
      { ...input, observationId: "obs_2", reaction: "not_interested", note: "Not for me" },
      NOW,
    );
    upsertBriefItemReaction(db, { ...input, observationId: "obs_3", messageId: "msg_2" }, NOW);

    const byMessage = listBriefItemReactions(db, "msg_1");
    expect([...byMessage.keys()].sort()).toEqual(["obs_1", "obs_2"]);
    expect(byMessage.get("obs_2")).toMatchObject({
      reaction: "not_interested",
      note: "Not for me",
    });
    expect(listBriefItemReactions(db, "msg_none").size).toBe(0);

    expect(deleteBriefItemReaction(db, "obs_1")).toBe(true);
    expect(deleteBriefItemReaction(db, "obs_1")).toBe(false);
    expect(getBriefItemReaction(db, "obs_1")).toBeNull();
    expect(listBriefItemReactions(db, "msg_1").size).toBe(1);
  });

  describe("applyBriefReaction", () => {
    beforeEach(() => {
      createObservation(
        db,
        { id: "obs_1", createdByRun: "run_1", summary: "The gym renewal is due" },
        NOW - 100,
      );
    });
    const userAction = () => getObservation(db, "obs_1")?.userAction;

    test("a thumbs lands its signal, its row and the user action together, replacing the previous thumbs only", () => {
      insertInterestSignal(
        db,
        signal({
          id: "int_said",
          kind: "statement",
          source: "statement",
          subjectText: "gym reminders",
          observationId: "obs_1",
        }),
      );
      const up = applyBriefReaction(
        db,
        {
          ...input,
          signal: signal({
            id: "int_up",
            kind: "observation",
            source: "brief_thumbs_up",
            observationId: "obs_1",
          }),
        },
        NOW,
      );
      expect(up).toMatchObject({ reaction: "up", createdAt: NOW, updatedAt: NOW });
      expect(userAction()).toBe("thumbs_up");
      expect(liveIds().sort()).toEqual(["int_said", "int_up"]);

      const down = applyBriefReaction(
        db,
        {
          ...input,
          reaction: "not_interested",
          note: "Cancelled it",
          signal: signal({
            id: "int_down",
            polarity: -1,
            kind: "observation",
            source: "brief_not_interested",
            note: "Cancelled it",
            observationId: "obs_1",
          }),
        },
        NOW + 10,
      );
      expect(down).toMatchObject({ reaction: "not_interested", note: "Cancelled it" });
      expect(userAction()).toBe("not_interested");
      expect(getInterestSignal(db, "int_up")?.supersededAt).toBe(NOW + 10);
      // The statement about the item is not a thumbs and stands.
      expect(liveIds().sort()).toEqual(["int_down", "int_said"]);
    });

    test("a factual error leaves no signal and keeps the note it was saved as", () => {
      applyBriefReaction(
        db,
        {
          ...input,
          signal: signal({
            id: "int_up",
            kind: "observation",
            source: "brief_thumbs_up",
            observationId: "obs_1",
          }),
        },
        NOW,
      );
      const disputed = applyBriefReaction(
        db,
        { ...input, reaction: "factual_error", note: "It was paid", noteId: "note_1" },
        NOW + 10,
      );
      expect(disputed).toMatchObject({
        reaction: "factual_error",
        note: "It was paid",
        noteId: "note_1",
      });
      expect(userAction()).toBe("disputed");
      expect(liveIds()).toEqual([]);
    });

    test("clearing removes the row, takes the signal back and clears only a reaction's user action", () => {
      applyBriefReaction(
        db,
        {
          ...input,
          signal: signal({
            id: "int_up",
            kind: "observation",
            source: "brief_thumbs_up",
            observationId: "obs_1",
          }),
        },
        NOW,
      );
      expect(userAction()).toBe("thumbs_up");
      expect(applyBriefReaction(db, { ...input, reaction: null }, NOW + 10)).toBeNull();
      expect(getBriefItemReaction(db, "obs_1")).toBeNull();
      expect(getInterestSignal(db, "int_up")?.supersededAt).toBe(NOW + 10);
      expect(userAction()).toBeNull();

      // A user action another tool wrote is not this reaction's to clear.
      setObservationUserAction(db, "obs_1", "suppressed", NOW + 20);
      expect(applyBriefReaction(db, { ...input, reaction: null }, NOW + 30)).toBeNull();
      expect(userAction()).toBe("suppressed");
    });
  });
});

describe("withheld suggestions", () => {
  const ORIGIN = { surface: "tasks", runId: "user:tasks" } as const;
  function withheld(id: string, title: string, at: number) {
    return createOpenLoop(
      db,
      {
        id,
        createdByRun: "run_gate",
        title,
        confidence: 0.8,
        importance: 0.6,
        proposal: { tier: "withhold", note: `Like what you ignore: ${title}` },
      },
      at,
    );
  }

  test("lists open withheld suggestions newest first with the ledger entry undo takes", () => {
    withheld("loop_old", "Chase the deposit refund", NOW - 2000);
    withheld("loop_new", "Reply to the venue survey", NOW - 1000);
    // A suggestion the user ignored is theirs, not the gate's.
    createOpenLoop(
      db,
      {
        id: "loop_user",
        createdByRun: "run_1",
        title: "Book the car service",
        confidence: 0.8,
        importance: 0.6,
      },
      NOW - 500,
    );
    expect(applyTaskCommand(db, { ...ORIGIN, kind: "ignore", id: "loop_user" }, NOW).ok).toBe(true);
    // A loop the gate adopted is not withheld.
    createOpenLoop(
      db,
      {
        id: "loop_adopted",
        createdByRun: "run_gate",
        title: "Renew the parking permit",
        confidence: 0.8,
        importance: 0.6,
        proposal: { tier: "adopt", note: "Like what you keep" },
      },
      NOW - 400,
    );

    const listed = listWithheldSuggestions(db);
    expect(listed.map((w) => w.loopId)).toEqual(["loop_new", "loop_old"]);
    expect(listed[0]).toEqual({
      loopId: "loop_new",
      title: "Reply to the venue survey",
      seq: listOpenLoopLedger(db, "loop_new")[0]!.seq,
      at: NOW - 1000,
      note: "Like what you ignore: Reply to the venue survey",
    });
    expect(listWithheldSuggestions(db, 1).map((w) => w.loopId)).toEqual(["loop_new"]);
    expect(isWithheldSuggestion(db, "loop_new")).toBe(true);
    expect(isWithheldSuggestion(db, "loop_user")).toBe(false);
    expect(isWithheldSuggestion(db, "loop_adopted")).toBe(false);
    expect(isWithheldSuggestion(db, "loop_missing")).toBe(false);
  });

  test("a withheld suggestion the user later accepts, or whose withhold is undone, drops out", () => {
    withheld("loop_a", "Chase the deposit refund", NOW - 2000);
    withheld("loop_b", "Reply to the venue survey", NOW - 1000);
    expect(applyTaskCommand(db, { ...ORIGIN, kind: "accept", id: "loop_a" }, NOW).ok).toBe(true);
    expect(listWithheldSuggestions(db).map((w) => w.loopId)).toEqual(["loop_b"]);
    expect(isWithheldSuggestion(db, "loop_a")).toBe(false);
    const seq = listWithheldSuggestions(db)[0]!.seq;
    expect(applyTaskCommand(db, { ...ORIGIN, kind: "undo", seq }, NOW).ok).toBe(true);
    expect(listWithheldSuggestions(db)).toEqual([]);
  });
});
