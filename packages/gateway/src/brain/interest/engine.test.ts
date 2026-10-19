// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  insertInterestSignal,
  listInterestSignals,
  listLiveInterestSignals,
} from "../storage/interest.js";
import { wordSet } from "./lookup.js";
import { InterestEngine, type InterestEmbedder } from "./engine.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00Z");
const log = createLogger("test").child("interest");

/**
 * A deterministic bag-of-words embedder: every distinct word owns one
 * dimension, so texts sharing words are close and disjoint texts orthogonal.
 */
class FakeEmbedder implements InterestEmbedder {
  modelId = "fake";
  calls: string[] = [];
  failWith: Error | null = null;
  private readonly vocabulary = new Map<string, number>();
  private static readonly DIM = 64;

  async embedQuery(text: string): Promise<number[]> {
    this.calls.push(text);
    if (this.failWith) throw this.failWith;
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

function makeEngine(getEmbedder: () => InterestEmbedder | null = () => embedder): InterestEngine {
  return new InterestEngine({
    db,
    writeGate: directWriteGate(db),
    getEmbedder,
    enabled: () => enabled,
    clock: () => (clock += 1),
    idGen: () => randomUUID(),
    log,
  });
}

function attempts(id: string): number {
  return db
    .prepare<
      [string],
      { n: number }
    >("SELECT embed_attempts AS n FROM interest_signals WHERE id = ?")
    .get(id)!.n;
}

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  embedder = new FakeEmbedder();
  enabled = true;
  clock = NOW;
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
    expect(attempts(stored!.id)).toBe(0);
    const block = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(block!.positive).toEqual([
      expect.objectContaining({
        text: "Renew the passport before the Lisbon trip",
        similarity: 0.83,
      }),
    ]);
    expect(await engine.lookup({ text: "Buy groceries" })).toBeNull();
  });

  test("an embedder that throws counts an attempt per pass, leaves no vector and leaves lookup intact", async () => {
    const engine = makeEngine();
    embedder.failWith = new Error("embedder down");
    // Inserted without `record`, whose own kick would be a pass of its own.
    const stored = insertInterestSignal(db, {
      id: "int_down",
      ...accepted("Renew the passport before the Lisbon trip"),
      createdAt: NOW,
    });
    await engine.embedBacklog();
    expect(attempts(stored.id)).toBe(1);
    expect(listLiveInterestSignals(db, { limit: 10 })[0]!.embedding).toBeNull();
    expect(engine.hasBacklog()).toBe(true);
    const block = await engine.lookup({ text: "Renew the passport before the trip" });
    expect(block!.positive.map((e) => e.text)).toEqual([
      "Renew the passport before the Lisbon trip",
    ]);
    // Two more failed passes exhaust the row's attempts and the backlog gives it up.
    await engine.embedBacklog();
    await engine.embedBacklog();
    expect(attempts(stored.id)).toBe(3);
    expect(engine.hasBacklog()).toBe(false);
    // The embedder recovering embeds a new signal but not the exhausted one.
    embedder.failWith = null;
    const fresh = await engine.record(accepted("Pay the water bill"));
    await engine.embedBacklog();
    expect(listLiveInterestSignals(db, { limit: 10 }).map((s) => [s.id, s.embeddingModel])).toEqual(
      [
        [fresh!.id, "fake"],
        [stored.id, null],
      ],
    );
  });

  test("a new embedder model drops the old vectors and the next pass re-embeds them", async () => {
    const engine = makeEngine();
    const stored = await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    expect(listLiveInterestSignals(db, { limit: 10 })[0]!.embeddingModel).toBe("fake");
    expect(attempts(stored!.id)).toBe(1);

    embedder.modelId = "fake-v2";
    await engine.embedBacklog();
    const [row] = listLiveInterestSignals(db, { limit: 10 });
    expect(row!.embeddingModel).toBe("fake-v2");
    expect(row!.embedding).toBeInstanceOf(Float32Array);
    // The attempts counter started over with the new model.
    expect(attempts(stored!.id)).toBe(1);
    expect(embedder.calls).toHaveLength(2);
    // A pass with the same model touches nothing.
    await engine.embedBacklog();
    expect(embedder.calls).toHaveLength(2);
    // Lookup uses the new model's vectors.
    const block = await engine.lookup({ text: "Renew the passport for the trip" });
    expect(block!.positive).toHaveLength(1);
  });

  test("lookup resolves when the embedder throws mid-query", async () => {
    const engine = makeEngine();
    await engine.record(accepted("Renew the passport before the Lisbon trip"));
    await engine.embedBacklog();
    embedder.failWith = new Error("embedder down");
    await expect(engine.lookup({ text: "Renew the passport for the trip" })).resolves.toSatisfy(
      (block) => block === null || typeof block === "object",
    );
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
