// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  DEFAULT_LOOKUP_OPTIONS,
  cosineSimilarity,
  hasOwnerInterest,
  lookupOwnerInterest,
  wordOverlap,
  wordSet,
} from "./lookup.js";
import type { InterestSignal } from "../storage/interest.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-03-10T09:00:00Z");
const MODEL = "fake-embedder";

let counter = 0;
function sig(
  over: Partial<InterestSignal> & { vector?: number[]; model?: string },
): InterestSignal {
  counter += 1;
  const { vector, model, ...rest } = over;
  return {
    id: `int_${String(counter).padStart(3, "0")}`,
    polarity: 1,
    kind: "task",
    source: "task_accepted",
    subjectText: "Book the dentist appointment",
    note: null,
    loopId: null,
    observationId: null,
    conversationId: null,
    ledgerSeq: null,
    embedding: vector ? Float32Array.from(vector) : null,
    embeddingModel: vector ? (model ?? MODEL) : null,
    createdAt: NOW - DAY,
    supersededAt: null,
    ...rest,
  };
}

const query = (text: string, vector?: number[]) => ({
  text,
  vector: vector ? { values: Float32Array.from(vector), model: MODEL } : null,
});

describe("similarity primitives", () => {
  test("cosine is 1 for parallel, 0 for orthogonal, 0 for mismatched or zero vectors", () => {
    const a = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, Float32Array.from([2, 0, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0);
    expect(cosineSimilarity(a, Float32Array.from([1, 0]))).toBe(0);
    expect(cosineSimilarity(a, Float32Array.from([0, 0, 0]))).toBe(0);
  });

  test("word sets keep lowercased words of three letters or more; overlap is Jaccard", () => {
    expect([...wordSet("Renew the Passport, by 3pm — ok?")].sort()).toEqual([
      "3pm",
      "passport",
      "renew",
      "the",
    ]);
    expect(wordOverlap(wordSet("renew the passport"), wordSet("renew the visa"))).toBeCloseTo(
      2 / 4,
    );
    expect(wordOverlap(new Set(), wordSet("anything"))).toBe(0);
  });
});

describe("lookupOwnerInterest with vectors", () => {
  test("ranks by cosine, excludes below the floor and rounds similarity to two decimals", () => {
    const signals = [
      sig({ id: "int_exact", vector: [1, 0, 0] }),
      sig({ id: "int_near", vector: [1, 1, 0] }), // cos 0.7071
      sig({ id: "int_far", vector: [1, 2, 0] }), // cos 0.447 < 0.55
      sig({ id: "int_orthogonal", vector: [0, 1, 0] }),
    ];
    const block = lookupOwnerInterest(signals, query("unrelated words", [1, 0, 0]), NOW)!;
    expect(block.positive.map((e) => e.similarity)).toEqual([1, 0.71]);
    expect(block.negative).toEqual([]);
    expect(block.statements).toEqual([]);
  });

  test("keeps k per polarity, the most similar of each", () => {
    const positives = [0.95, 0.9, 0.85, 0.8, 0.75].map((x, i) =>
      sig({
        id: `int_p${i}`,
        polarity: 1,
        subjectText: `p${i}`,
        vector: [x, Math.sqrt(1 - x * x), 0],
      }),
    );
    const negatives = [0.99, 0.6].map((x, i) =>
      sig({
        id: `int_n${i}`,
        polarity: -1,
        source: "task_ignored",
        subjectText: `n${i}`,
        vector: [x, Math.sqrt(1 - x * x), 0],
      }),
    );
    const block = lookupOwnerInterest([...negatives, ...positives], query("q", [1, 0, 0]), NOW, {
      ...DEFAULT_LOOKUP_OPTIONS,
      perPolarity: 4,
    })!;
    expect(block.positive.map((e) => e.text)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(block.negative.map((e) => e.text)).toEqual(["n0", "n1"]);
    expect(block.negative[0]).toMatchObject({ source: "task_ignored", similarity: 0.99 });
  });

  test("statements come out separately with their direction and no source", () => {
    const signals = [
      sig({ id: "int_task", vector: [1, 0, 0] }),
      sig({
        id: "int_more",
        kind: "statement",
        source: "statement",
        polarity: 1,
        subjectText: "trail running races",
        note: "I want more about my races",
        vector: [1, 0, 0],
      }),
      sig({
        id: "int_less",
        kind: "statement",
        source: "statement",
        polarity: -1,
        subjectText: "newsletter promotions",
        vector: [0.9, 0.1, 0],
      }),
    ];
    const block = lookupOwnerInterest(signals, query("q", [1, 0, 0]), NOW)!;
    expect(block.positive.map((e) => e.text)).toEqual(["Book the dentist appointment"]);
    expect(block.statements).toEqual([
      {
        text: "trail running races",
        note: "I want more about my races",
        direction: "more",
        ageDays: 1,
        similarity: 1,
      },
      { text: "newsletter promotions", direction: "less", ageDays: 1, similarity: 0.99 },
    ]);
  });

  test("ties go to the newest signal; ageDays is floored and never negative", () => {
    const signals = [
      sig({ id: "int_older", subjectText: "older", vector: [1, 0], createdAt: NOW - 2.9 * DAY }),
      sig({ id: "int_newer", subjectText: "newer", vector: [1, 0], createdAt: NOW - 1.1 * DAY }),
      sig({ id: "int_future", subjectText: "future", vector: [1, 0], createdAt: NOW + DAY }),
    ];
    const block = lookupOwnerInterest(signals, query("q", [1, 0]), NOW)!;
    expect(block.positive.map((e) => [e.text, e.ageDays])).toEqual([
      ["future", 0],
      ["newer", 1],
      ["older", 2],
    ]);
  });

  test("a vector from another model, or of another size, falls back to word overlap", () => {
    const signals = [
      sig({
        id: "int_other_model",
        subjectText: "Renew the passport",
        vector: [1, 0, 0],
        model: "older-embedder",
      }),
      sig({ id: "int_other_size", subjectText: "Renew the passport", vector: [1, 0] }),
      sig({
        id: "int_other_model_no_words",
        subjectText: "Buy groceries",
        vector: [1, 0, 0],
        model: "older-embedder",
      }),
    ];
    const block = lookupOwnerInterest(
      signals,
      query("Renew the passport before the trip", [0, 0, 1]),
      NOW,
    )!;
    // Both compared by words (3 shared of 5), neither by the orthogonal vector.
    expect(block.positive.map((e) => [e.text, e.similarity])).toEqual([
      ["Renew the passport", 0.6],
      ["Renew the passport", 0.6],
    ]);
  });
});

describe("lookupOwnerInterest without a query vector", () => {
  test("every signal is compared by word overlap against the overlap floor", () => {
    const signals = [
      sig({ id: "int_overlap", subjectText: "Renew the passport", vector: [1, 0, 0] }),
      sig({
        id: "int_note_overlap",
        polarity: -1,
        source: "brief_not_interested",
        subjectText: "Weekly deals",
        note: "passport renewal before the trip",
      }),
      sig({ id: "int_none", subjectText: "Buy groceries", vector: [1, 0, 0] }),
    ];
    const block = lookupOwnerInterest(signals, query("Renew the passport before the trip"), NOW)!;
    expect(block.positive.map((e) => e.text)).toEqual(["Renew the passport"]);
    expect(block.positive[0]!.similarity).toBe(0.6);
    // The note counts towards the match but the example shows the subject and the note apart.
    expect(block.negative).toEqual([
      {
        text: "Weekly deals",
        note: "passport renewal before the trip",
        source: "brief_not_interested",
        ageDays: 1,
        similarity: 0.5,
      },
    ]);
  });

  test("superseded rows are ignored even when they match", () => {
    const signals = [
      sig({ id: "int_gone", subjectText: "Renew the passport", supersededAt: NOW - 1 }),
      sig({ id: "int_live", subjectText: "Renew the visa" }),
    ];
    const block = lookupOwnerInterest(signals, query("Renew the passport"), NOW)!;
    expect(block.positive.map((e) => e.text)).toEqual(["Renew the visa"]);
    expect(lookupOwnerInterest([signals[0]!], query("Renew the passport"), NOW)).toBeNull();
  });

  test("empty input and nothing above the floor both answer null", () => {
    expect(lookupOwnerInterest([], query("anything"), NOW)).toBeNull();
    expect(
      lookupOwnerInterest(
        [sig({ subjectText: "Buy groceries" })],
        query("Renew the passport"),
        NOW,
      ),
    ).toBeNull();
    expect(
      lookupOwnerInterest([sig({ vector: [0, 1] })], query("Buy groceries", [1, 0]), NOW),
    ).toBeNull();
  });
});

describe("hasOwnerInterest", () => {
  test("is false for null and for a block with nothing in it", () => {
    expect(hasOwnerInterest(null)).toBe(false);
    expect(hasOwnerInterest({ positive: [], negative: [], statements: [] })).toBe(false);
    const example = { text: "x", source: "task_accepted", ageDays: 0, similarity: 1 };
    expect(hasOwnerInterest({ positive: [example], negative: [], statements: [] })).toBe(true);
    expect(hasOwnerInterest({ positive: [], negative: [example], statements: [] })).toBe(true);
    expect(
      hasOwnerInterest({
        positive: [],
        negative: [],
        statements: [{ text: "x", direction: "more", ageDays: 0, similarity: 1 }],
      }),
    ).toBe(true);
  });
});
