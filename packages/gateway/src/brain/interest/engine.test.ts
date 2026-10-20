// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  getInterestSignal,
  insertInterestSignal,
  listInterestSignals,
  listLiveInterestSignals,
} from "../storage/interest.js";
import { wordSet, type InterestLookupOptions } from "./lookup.js";
import { InterestEngine, type InterestEmbedder } from "./engine.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00Z");
const MINUTE = 60_000;
const log = createLogger("test").child("interest");

/**
 * A deterministic bag-of-words embedder: every distinct content word owns one
 * dimension, so texts sharing words are close and disjoint texts orthogonal.
 */
class FakeEmbedder implements InterestEmbedder {
  modelId = "fake";
  calls: string[] = [];
  failWith: Error | null = null;
  /** Never answers, like an embedder stuck behind a long queue. */
  hang = false;
  private readonly vocabulary = new Map<string, number>();
  private static readonly DIM = 64;

  async embedQuery(text: string): Promise<number[]> {
    this.calls.push(text);
    if (this.failWith) throw this.failWith;
    if (this.hang) return new Promise<number[]>(() => {});
    const vector = new Array<number>(FakeEmbedder.DIM).fill(0);
    for (const word of wordSet(text)) {
      let index = this.vocabulary.get(word);
      if (index === undefined) {
        index = this.vocabulary.size;
        if (index >= FakeEmbedder.DIM) throw new Error("fake vocabulary full");
        this.vocabulary.set(word, index);
      }
      vector[index] = 1;
    }
    return vector;
  }
}

let path: string;
let db: Database.Database;
let embedder: FakeEmbedder;
let enabled = true;
let clock = NOW;
let lookupOptions: Partial<InterestLookupOptions> = {};

function makeEngine(getEmbedder: () => InterestEmbedder | null = () => embedder): InterestEngine {
  return new InterestEngine({
    db,
    writeGate: directWriteGate(db),
    getEmbedder,
    enabled: () => enabled,
    lookupOptions: () => lookupOptions,
    clock: () => (clock += 1),
    idGen: () => randomUUID(),
    log,
  });
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

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  embedder = new FakeEmbedder();
  enabled = true;
  clock = NOW;
  lookupOptions = {};
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

const accepted = (subjectText: string, over: Record<string, unknown> = {}) => ({
  polarity: 1 as const,
  kind: "task" as const,
  source: "task_accepted" as const,
  subjectText,
  ...over,
});

describe("InterestEngine.record", () => {
  test("writes the signal and the backlog pass embeds it", async () => {
    const engine = makeEngine();
    const stored = await engine.record({
      ...accepted("Renew the passport before the Lisbon trip"),
      note: "Needed for the trip",
      loopId: "loop_1",
      conversationId: "conv_1",
    });
    expect(stored).toMatchObject({
      polarity: 1,
      source: "task_accepted",
      subjectText: "Renew the passport before the Lisbon trip",
      note: "Needed for the trip",
      loopId: "loop_1",
      conversationId: "conv_1",
      ledgerSeq: null,
      embedding: null,
    });
    expect(stored!.id).toMatch(/^int_/);
    await engine.embedBacklog();
    const [live] = listLiveInterestSignals(db, { limit: 10 });
    expect(live!.id).toBe(stored!.id);
    expect(live!.embeddingModel).toBe("fake");
    expect(live!.embedding).toBeInstanceOf(Float32Array);
    // The note is part of what gets embedded.
    expect(embedder.calls).toEqual([
      "Renew the passport before the Lisbon trip\nNeeded for the trip",
    ]);
    expect(engine.hasBacklog()).toBe(false);
  });

  test("replaces supersedes the earlier signal about the same observation in the same call", async () => {
    const engine = makeEngine();
    const first = await engine.record({
      polarity: 1,
      kind: "observation",
      source: "brief_thumbs_up",
      subjectText: "The gym renewal is due",
      observationId: "obs_1",
    });
    const second = await engine.record({
      polarity: -1,
      kind: "observation",
      source: "brief_not_interested",
      subjectText: "The gym renewal is due",
      note: "Cancelled it",
      observationId: "obs_1",
      replaces: { observationId: "obs_1" },
    });
    await engine.embedBacklog();
    expect(listLiveInterestSignals(db, { limit: 10 }).map((s) => s.id)).toEqual([second!.id]);
    const all = listInterestSignals(db, { limit: 10 });
    expect(all.find((s) => s.id === first!.id)?.supersededAt).toBe(second!.createdAt);
    expect(await engine.supersede({ observationId: "obs_1" })).toBe(1);
    expect(listLiveInterestSignals(db, { limit: 10 })).toEqual([]);
  });

  test("when the ledger is off nothing is written and nothing is looked up", async () => {
    enabled = false;
    const engine = makeEngine();
    expect(await engine.record(accepted("Renew the passport"))).toBeNull();
    expect(listInterestSignals(db, { limit: 10 })).toEqual([]);
    expect(embedder.calls).toEqual([]);
    expect(engine.hasBacklog()).toBe(false);
    enabled = true;
    await engine.record(accepted("Renew the passport"));
    enabled = false;
    expect(await engine.lookup({ text: "Renew the passport" })).toBeNull();
  });

  test("while the ledger is off, record still supersedes what the reaction replaces", async () => {
    const engine = makeEngine();
    const earlier = await engine.record({
      polarity: 1,
      kind: "observation",
      source: "brief_thumbs_up",
      subjectText: "The gym renewal is due",
      observationId: "obs_1",
    });
    enabled = false;
    expect(
      await engine.record({
        polarity: -1,
        kind: "observation",
        source: "brief_not_interested",
        subjectText: "The gym renewal is due",
        observationId: "obs_1",
        replaces: { observationId: "obs_1" },
      }),
    ).toBeNull();
    expect(listInterestSignals(db, { limit: 10 }).map((s) => s.id)).toEqual([earlier!.id]);
    expect(getInterestSignal(db, earlier!.id)?.supersededAt).not.toBeNull();
  });

  test("draft is the row a caller lands itself, and null while the ledger is off", () => {
    const engine = makeEngine();
    const draft = engine.draft({
      ...accepted("Renew the passport"),
      note: "Soon",
      loopId: "loop_1",
    });
    expect(draft).toEqual({
      id: expect.stringMatching(/^int_/),
      polarity: 1,
      kind: "task",
      source: "task_accepted",
      subjectText: "Renew the passport",
      note: "Soon",
      loopId: "loop_1",
      observationId: null,
      conversationId: null,
      ledgerSeq: null,
      createdAt: NOW + 1,
    });
    expect(listInterestSignals(db, { limit: 10 })).toEqual([]);
    enabled = false;
    expect(engine.draft(accepted("Renew the passport"))).toBeNull();
  });
});

describe("InterestEngine.lookup", () => {
  test("returns the similar positive and negative examples and null for an unrelated text", async () => {
    const engine = makeEngine();
    await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.record({
      polarity: -1,
      kind: "task",
      source: "task_ignored",
      subjectText: "Renew the gym membership",
      note: "Cancelled it",
    });
    await engine.record(accepted("Pay the water bill"));
    await engine.embedBacklog();

    const block = await engine.lookup({ text: "Renew the passport for the trip" });
    expect(block).not.toBeNull();
    expect(block!.positive.map((e) => e.text)).toEqual([
      "Renew the passport before the Lisbon trip",
    ]);
    expect(block!.positive[0]).toMatchObject({ basis: "vector" });
    expect(block!.positive[0]!.similarity).toBeGreaterThanOrEqual(0.55);
    expect(block!.negative).toEqual([]);
    const renewals = await engine.lookup({ text: "Renew the gym membership card" });
    expect(renewals!.negative.map((e) => [e.text, e.note])).toEqual([
      ["Renew the gym membership", "Cancelled it"],
    ]);
    expect(await engine.lookup({ text: "Book a dentist appointment" })).toBeNull();
    // The query vector is cached per text, so a repeat asks the embedder nothing.
    const before = embedder.calls.length;
    await engine.lookup({ text: "Renew the passport for the trip" });
    expect(embedder.calls.length).toBe(before);
  });

  test("without an embedder rows stay unembedded and lookup works by word overlap", async () => {
    const engine = makeEngine(() => null);
    const stored = await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    expect(engine.hasBacklog()).toBe(true);
    expect(listLiveInterestSignals(db, { limit: 10 })[0]!.embedding).toBeNull();
    expect(embedState(stored!.id)).toEqual({ attempts: 0, after: 0 });
    const block = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(block!.positive).toEqual([
      expect.objectContaining({
        text: "Renew the passport before the Lisbon trip",
        similarity: 0.8,
        basis: "words",
      }),
    ]);
    expect(await engine.lookup({ text: "Buy groceries" })).toBeNull();
  });

  test("an embedder outage pushes the row out by its backoff; a pass before then skips it", async () => {
    const engine = makeEngine();
    embedder.failWith = new Error("embedder down");
    // Inserted without `record`, whose own kick would be a pass of its own.
    const stored = insertInterestSignal(db, {
      id: "int_down",
      ...accepted("Renew the passport before the Lisbon trip"),
      createdAt: NOW,
    });
    await engine.embedBacklog();
    const first = embedState(stored.id);
    expect(first.attempts).toBe(1);
    expect(first.after).toBeGreaterThanOrEqual(clock + 15 * MINUTE - 10);
    expect(getInterestSignal(db, stored.id)!.embedding).toBeNull();
    expect(embedder.calls).toHaveLength(1);
    // Not due: the next pass leaves it alone and the backlog reads as empty.
    expect(engine.hasBacklog()).toBe(false);
    await engine.embedBacklog();
    expect(embedState(stored.id).attempts).toBe(1);
    expect(embedder.calls).toHaveLength(1);
    // The lookup still finds it by words meanwhile.
    const block = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(block!.positive.map((e) => [e.text, e.basis])).toEqual([
      ["Renew the passport before the Lisbon trip", "words"],
    ]);

    // Once the wait is over the row is due again, and the wait doubles.
    clock = first.after;
    expect(engine.hasBacklog()).toBe(true);
    await engine.embedBacklog();
    const second = embedState(stored.id);
    expect(second.attempts).toBe(2);
    expect(second.after).toBeGreaterThanOrEqual(first.after + 30 * MINUTE - 10);
    expect(embedder.calls).toHaveLength(2);

    // The embedder recovering embeds it at its next due time, and a fresh row at once.
    embedder.failWith = null;
    const fresh = await engine.record(accepted("Pay the water bill"));
    await engine.embedBacklog();
    expect(getInterestSignal(db, fresh!.id)!.embeddingModel).toBe("fake");
    expect(getInterestSignal(db, stored.id)!.embedding).toBeNull();
    clock = second.after;
    await engine.embedBacklog();
    expect(getInterestSignal(db, stored.id)!.embeddingModel).toBe("fake");
    expect(embedState(stored.id)).toEqual({ attempts: 3, after: 0 });
    expect(engine.hasBacklog()).toBe(false);
  });

  test("a new embedder model drops the old vectors and the next pass re-embeds them", async () => {
    const engine = makeEngine();
    const stored = await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    expect(listLiveInterestSignals(db, { limit: 10 })[0]!.embeddingModel).toBe("fake");
    expect(embedState(stored!.id).attempts).toBe(1);

    embedder.modelId = "fake-v2";
    await engine.embedBacklog();
    const [row] = listLiveInterestSignals(db, { limit: 10 });
    expect(row!.embeddingModel).toBe("fake-v2");
    expect(row!.embedding).toBeInstanceOf(Float32Array);
    // The attempts counter started over with the new model.
    expect(embedState(stored!.id).attempts).toBe(1);
    expect(embedder.calls).toHaveLength(2);
    // A pass with the same model touches nothing.
    await engine.embedBacklog();
    expect(embedder.calls).toHaveLength(2);
    // Lookup uses the new model's vectors.
    const block = await engine.lookup({ text: "Renew the passport for the trip" });
    expect(block!.positive.map((e) => e.basis)).toEqual(["vector"]);
  });

  test("the query is only embedded when a live signal has a vector from the current model", async () => {
    const engine = makeEngine();
    await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    const embeds = embedder.calls.length;
    // The vectors were made by another model: words, no query embedding.
    embedder.modelId = "fake-v2";
    const block = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(block!.positive.map((e) => e.basis)).toEqual(["words"]);
    expect(embedder.calls).toHaveLength(embeds);
  });

  test("a query the embedder cannot embed is matched by words, and by vector once it recovers", async () => {
    const engine = makeEngine();
    await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    embedder.failWith = new Error("embedder down");
    const byWords = await engine.lookup({ text: "Renew the passport for the trip" });
    expect(byWords!.positive.map((e) => [e.text, e.basis])).toEqual([
      ["Renew the passport before the Lisbon trip", "words"],
    ]);
    // Nothing shares enough words: no block, rather than a guess.
    expect(await engine.lookup({ text: "Book a dentist appointment" })).toBeNull();
    embedder.failWith = null;
    const byVector = await engine.lookup({ text: "Renew the passport for the trip" });
    expect(byVector!.positive.map((e) => e.basis)).toEqual(["vector"]);
  });

  test("a query embedding that outlasts its wait gives way to words", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const engine = makeEngine();
      await engine.record(accepted("Renew the passport before the Lisbon trip"));
      await engine.embedBacklog();
      embedder.hang = true;
      const pending = engine.lookup({ text: "Renew the passport for the trip" });
      await vi.advanceTimersByTimeAsync(10_000);
      const block = await pending;
      expect(block!.positive.map((e) => e.basis)).toEqual(["words"]);
    } finally {
      embedder.hang = false;
      vi.useRealTimers();
    }
  });

  test("the decoded ledger is kept until the table's fingerprint moves, even for writes made behind the engine", async () => {
    const engine = makeEngine(() => null);
    const stored = await engine.record(accepted("Renew the passport before the Lisbon trip"));
    const first = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(first!.positive.map((e) => e.text)).toEqual([
      "Renew the passport before the Lisbon trip",
    ]);
    // A change the fingerprint cannot see is served from the cache.
    db.prepare("UPDATE interest_signals SET subject_text = 'Pay the water bill' WHERE id = ?").run(
      stored!.id,
    );
    const cached = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(cached).toEqual(first);
    // A write that moves the fingerprint, made with no engine involved, is seen next time.
    insertInterestSignal(db, {
      id: "int_external",
      ...accepted("Renew the passport photo before the trip"),
      createdAt: clock + 1,
    });
    const refreshed = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(refreshed!.positive.map((e) => e.text)).toEqual([
      "Renew the passport photo before the trip",
    ]);
  });

  test("the lookup options are read live", async () => {
    const engine = makeEngine();
    await engine.record(accepted("Renew the passport"));
    await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    const both = await engine.lookup({ text: "Renew the passport" });
    expect(both!.positive.map((e) => e.similarity)).toEqual([1, 0.63]);
    lookupOptions = { cosineFloor: 0.9 };
    const strict = await engine.lookup({ text: "Renew the passport" });
    expect(strict!.positive.map((e) => e.similarity)).toEqual([1]);
    lookupOptions = { perPolarity: 1 };
    const one = await engine.lookup({ text: "Renew the passport" });
    expect(one!.positive).toHaveLength(1);
  });

  test("embedBacklog called during a pass covers the signals recorded meanwhile", async () => {
    const engine = makeEngine();
    const first = engine.record(accepted("Renew the passport before the Lisbon trip"));
    const second = engine.record(accepted("Pay the water bill"));
    await Promise.all([first, second]);
    await engine.embedBacklog();
    expect(engine.hasBacklog()).toBe(false);
    expect(listLiveInterestSignals(db, { limit: 10 }).every((s) => s.embedding)).toBe(true);
  });
});
