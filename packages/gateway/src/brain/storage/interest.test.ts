// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  INTEREST_NOTE_MAX_CHARS,
  INTEREST_SUBJECT_MAX_CHARS,
  countUnembeddedInterestSignals,
  deleteBriefItemReaction,
  embeddingFromBlob,
  embeddingToBlob,
  getBriefItemReaction,
  getInterestSignal,
  insertInterestSignal,
  listBriefItemReactions,
  listInterestSignals,
  listLiveInterestSignals,
  listUnembeddedInterestSignals,
  resetInterestEmbeddingsNotFrom,
  setInterestSignalEmbedding,
  supersedeInterestSignals,
  upsertBriefItemReaction,
  type NewInterestSignal,
} from "./interest.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00Z");

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

function attempts(id: string): number {
  return db
    .prepare<
      [string],
      { n: number }
    >("SELECT embed_attempts AS n FROM interest_signals WHERE id = ?")
    .get(id)!.n;
}

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

    expect(listLiveInterestSignals(db, { limit: 10 }).map((s) => s.id)).toEqual(["int_other"]);
    expect(
      listInterestSignals(db, { limit: 10 })
        .map((s) => s.id)
        .sort(),
    ).toEqual(["int_loop", "int_obs", "int_other", "int_seq"]);
  });

  test("live signals come newest first, bounded and since a time", () => {
    insertInterestSignal(db, signal({ id: "int_old", createdAt: NOW - 3 }));
    insertInterestSignal(db, signal({ id: "int_mid", createdAt: NOW - 2 }));
    insertInterestSignal(db, signal({ id: "int_new", createdAt: NOW - 1 }));
    expect(listLiveInterestSignals(db, { limit: 10 }).map((s) => s.id)).toEqual([
      "int_new",
      "int_mid",
      "int_old",
    ]);
    expect(listLiveInterestSignals(db, { limit: 2 }).map((s) => s.id)).toEqual([
      "int_new",
      "int_mid",
    ]);
    expect(listLiveInterestSignals(db, { limit: 10, since: NOW - 2 }).map((s) => s.id)).toEqual([
      "int_new",
      "int_mid",
    ]);
  });

  test("the unembedded backlog is oldest first and gives up after three attempts", () => {
    insertInterestSignal(db, signal({ id: "int_b", createdAt: NOW + 2 }));
    insertInterestSignal(db, signal({ id: "int_a", createdAt: NOW + 1 }));
    insertInterestSignal(db, signal({ id: "int_gone", createdAt: NOW, loopId: "loop_gone" }));
    supersedeInterestSignals(db, { loopId: "loop_gone" }, NOW);

    expect(listUnembeddedInterestSignals(db, 10).map((s) => s.id)).toEqual(["int_a", "int_b"]);
    expect(listUnembeddedInterestSignals(db, 1).map((s) => s.id)).toEqual(["int_a"]);
    expect(countUnembeddedInterestSignals(db)).toBe(2);

    expect(setInterestSignalEmbedding(db, "int_a", null)).toBe(true);
    expect(setInterestSignalEmbedding(db, "int_a", null)).toBe(true);
    expect(attempts("int_a")).toBe(2);
    expect(listUnembeddedInterestSignals(db, 10).map((s) => s.id)).toEqual(["int_a", "int_b"]);
    expect(setInterestSignalEmbedding(db, "int_a", null)).toBe(true);
    expect(attempts("int_a")).toBe(3);
    expect(listUnembeddedInterestSignals(db, 10).map((s) => s.id)).toEqual(["int_b"]);
    expect(countUnembeddedInterestSignals(db)).toBe(1);
    expect(setInterestSignalEmbedding(db, "int_missing", null)).toBe(false);
  });

  test("a vector is stored as Float32 and read back as the same vector with its model", () => {
    insertInterestSignal(db, signal({ id: "int_v" }));
    expect(
      setInterestSignalEmbedding(db, "int_v", { vector: [0.5, -1.25, 3, 0.1], model: "m1" }),
    ).toBe(true);
    const stored = getInterestSignal(db, "int_v")!;
    expect(stored.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(stored.embedding!)).toEqual(
      Array.from(Float32Array.from([0.5, -1.25, 3, 0.1])),
    );
    expect(stored.embeddingModel).toBe("m1");
    expect(attempts("int_v")).toBe(1);
    expect(listUnembeddedInterestSignals(db, 10)).toEqual([]);
    // A Float32Array input stores the same bytes as a plain array.
    expect(embeddingToBlob(Float32Array.from([1, 2]))).toEqual(embeddingToBlob([1, 2]));
  });

  test("reset forgets vectors from other embedders and their attempts, keeping the live one's", () => {
    insertInterestSignal(db, signal({ id: "int_old_model" }));
    insertInterestSignal(db, signal({ id: "int_live_model" }));
    insertInterestSignal(db, signal({ id: "int_none" }));
    setInterestSignalEmbedding(db, "int_old_model", { vector: [1, 0], model: "m1" });
    setInterestSignalEmbedding(db, "int_live_model", { vector: [0, 1], model: "m2" });
    setInterestSignalEmbedding(db, "int_none", null);

    expect(resetInterestEmbeddingsNotFrom(db, "m2")).toBe(1);
    const reset = getInterestSignal(db, "int_old_model")!;
    expect(reset.embedding).toBeNull();
    expect(reset.embeddingModel).toBeNull();
    expect(attempts("int_old_model")).toBe(0);
    const kept = getInterestSignal(db, "int_live_model")!;
    expect(kept.embeddingModel).toBe("m2");
    expect(Array.from(kept.embedding!)).toEqual([0, 1]);
    // A row without a vector is not from another embedder; its failed attempts stand.
    expect(attempts("int_none")).toBe(1);
    expect(resetInterestEmbeddingsNotFrom(db, "m2")).toBe(0);
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
});
