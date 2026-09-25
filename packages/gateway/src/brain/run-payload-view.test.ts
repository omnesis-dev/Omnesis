// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { decodeRunTrigger } from "./run-payload-view.js";
import { COGNITION_RUN_KINDS, type CognitionRunKind } from "./storage/types.js";

describe("decodeRunTrigger", () => {
  test("data → docId + event, diff null when absent", () => {
    expect(decodeRunTrigger("data", { docId: "doc_a", event: "created", datumAt: 1 })).toEqual({
      type: "data",
      docId: "doc_a",
      event: "created",
      diff: null,
    });
  });

  test("data → summarizes an updated run's diff into added/removed line counts", () => {
    const trigger = decodeRunTrigger("data", {
      docId: "doc_b",
      event: "updated",
      datumAt: 1,
      // The `+++`/`---` unified-diff headers must NOT be miscounted as
      // added/removed content lines.
      diff: "--- old\n+++ new\n line kept\n+first added\n+second added\n-only removed",
    });
    expect(trigger).toEqual({
      type: "data",
      docId: "doc_b",
      event: "updated",
      diff: { added: 2, removed: 1 },
    });
  });

  test("daily → per-source batch and the may-day lookahead are distinct flavours", () => {
    expect(
      decodeRunTrigger("daily", { sourceId: "src", dateFrom: "2026-07-01", dateTo: "2026-07-01" }),
    ).toEqual({
      type: "daily-source",
      sourceId: "src",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-01",
    });
    expect(decodeRunTrigger("daily", { mayDay: true, date: "2026-07-02" })).toEqual({
      type: "daily-mayday",
      date: "2026-07-02",
    });
    expect(decodeRunTrigger("daily", { digest: true, date: "2026-07-02" })).toEqual({
      type: "daily-digest",
      date: "2026-07-02",
    });
  });

  test("time_based → a scheduled prompt vs. an engine decay check are distinct flavours", () => {
    expect(decodeRunTrigger("time_based", { prompt: "check the quote" })).toEqual({
      type: "scheduled",
      prompt: "check the quote",
    });
    expect(decodeRunTrigger("time_based", { decayCheckLoopId: "loop_1" })).toEqual({
      type: "decay-check",
      loopId: "loop_1",
    });
  });

  test("feedback → briefId; snoozeUntil defaults to null when absent", () => {
    expect(decodeRunTrigger("feedback", { briefId: "brf_1" })).toEqual({
      type: "feedback",
      briefId: "brf_1",
      snoozeUntil: null,
    });
    expect(decodeRunTrigger("feedback", { briefId: "brf_2", snoozeUntil: 5000 })).toEqual({
      type: "feedback",
      briefId: "brf_2",
      snoozeUntil: 5000,
    });
  });

  test("feedback's provenance-recheck variant decodes from payload and dedupe key", () => {
    expect(
      decodeRunTrigger("feedback", {
        recheckDependentKind: "brief",
        recheckDependentId: "brf_3",
      }),
    ).toEqual({ type: "provenance-recheck", dependentKind: "brief", dependentId: "brf_3" });
    expect(decodeRunTrigger("feedback", {}, "feedback:provenance:loop:loop_9")).toEqual({
      type: "provenance-recheck",
      dependentKind: "loop",
      dependentId: "loop_9",
    });
  });

  test("a wiped, missing, or legacy payload decodes to unknown — tolerated gracefully", () => {
    // Legacy settled rows were wiped to `{}` (no dedupe key to fall back on here).
    expect(decodeRunTrigger("data", {})).toEqual({ type: "unknown" });
    expect(decodeRunTrigger("daily", {})).toEqual({ type: "unknown" });
    expect(decodeRunTrigger("time_based", {})).toEqual({ type: "unknown" });
    expect(decodeRunTrigger("feedback", {})).toEqual({ type: "unknown" });
    // Null / non-object / partial legacy shapes never throw.
    expect(decodeRunTrigger("data", null)).toEqual({ type: "unknown" });
    expect(decodeRunTrigger("data", { docId: "x" })).toEqual({ type: "unknown" });
  });

  test("a wiped payload falls back to the dedupe key, per key family", () => {
    expect(decodeRunTrigger("data", {}, "data:doc:doc_a")).toEqual({
      type: "data",
      docId: "doc_a",
      event: null,
      diff: null,
    });
    // A thread key names no single doc — still recognisably a data trigger.
    expect(decodeRunTrigger("data", {}, "data:thread:gmail:acct:thr_1")).toEqual({
      type: "data",
      docId: null,
      event: null,
      diff: null,
    });
    // The source id may itself contain colons; the day is the LAST segment.
    expect(decodeRunTrigger("daily", {}, "daily:source:gmail:acct:2026-07-01")).toEqual({
      type: "daily-source",
      sourceId: "gmail:acct",
      dateFrom: null,
      dateTo: null,
    });
    expect(decodeRunTrigger("daily", {}, "daily:mayday:2026-07-02")).toEqual({
      type: "daily-mayday",
      date: "2026-07-02",
    });
    expect(decodeRunTrigger("daily", {}, "daily:digest:2026-07-02")).toEqual({
      type: "daily-digest",
      date: "2026-07-02",
    });
    expect(decodeRunTrigger("time_based", {}, "decay:loop:loop_z")).toEqual({
      type: "decay-check",
      loopId: "loop_z",
    });
    expect(decodeRunTrigger("feedback", {}, "feedback:brief:brf_q")).toEqual({
      type: "feedback",
      briefId: "brf_q",
      snoozeUntil: null,
    });
  });

  test("the dedupe-key fallback never overrides a live payload and rejects mismatched kinds", () => {
    // A decodable payload wins even when a key is present.
    expect(
      decodeRunTrigger("data", { docId: "doc_p", event: "created", datumAt: 1 }, "data:doc:OTHER"),
    ).toEqual({ type: "data", docId: "doc_p", event: "created", diff: null });
    // A key from another family than the row's kind stays unknown.
    expect(decodeRunTrigger("data", {}, "decay:loop:loop_z")).toEqual({ type: "unknown" });
    expect(decodeRunTrigger("time_based", {}, "data:doc:doc_a")).toEqual({ type: "unknown" });
    // Agent-scheduled checks have no dedupe key at all.
    expect(decodeRunTrigger("time_based", {}, null)).toEqual({ type: "unknown" });
  });
});

// Every run kind must decode to a real trigger from a representative payload —
// the runtime decode lists (unlike the prompt builder's assertNever) drift
// silently when a kind is added, leaving its runs showing "trigger
// unavailable" in the portal.
//
// The map is typed over CognitionRunKind AND checked against the kind list at
// run time. The type alone does not hold: every package tsconfig excludes
// `*.test.ts` (Vitest compiles those), so a missing key here is a type error
// no gate ever evaluates — which is how `subscription_compile` came to be
// absent from a map whose comment claimed a new kind could not be.
describe("run-kind trigger exhaustiveness", () => {
  const FIXTURES: Record<CognitionRunKind, { payload: unknown; dedupeKey: string | null }> = {
    data: {
      payload: { docId: "doc_a", event: "created", datumAt: 1 },
      dedupeKey: "data:doc:doc_a",
    },
    daily: {
      payload: { sourceId: "src", dateFrom: "2026-07-01", dateTo: "2026-07-01" },
      dedupeKey: "daily:source:src:2026-07-01",
    },
    time_based: {
      payload: { decayCheckLoopId: "loop_a" },
      dedupeKey: "decay:loop:loop_a",
    },
    feedback: {
      payload: { briefId: "brf_a" },
      dedupeKey: "feedback:brief:brf_a",
    },
    synthesis: {
      payload: { focus: "noticing", date: "2026-07-01" },
      dedupeKey: "synthesis:noticing:2026-07-01",
    },
    sweep: {
      payload: { sweepId: "weekly-money", date: "2026-07-01", steeringPrompt: "steer" },
      dedupeKey: "sweep:weekly-money:2026-07-01",
    },
    bootstrap: {
      payload: { docId: "doc_b", datumAt: 1 },
      dedupeKey: "bootstrap:doc:doc_b",
    },
    verification: {
      payload: { annotationIds: ["anno_a", "anno_b"], store: "doc" },
      dedupeKey: "verify:doc:anno_a,anno_b",
    },
    merge_adjudication: {
      payload: { candidateId: "cand_a" },
      dedupeKey: "merge-adjudication:candidate:cand_a",
    },
    notes_compaction: {
      payload: { reason: "notes over soft cap" },
      dedupeKey: "notes-compaction",
    },
    // A watch compile never sits in the queue: it runs inside the authoring
    // request and its row is inserted already settled, with `dedupe_key` NULL.
    // There is no key to recover a trigger from, so the payload is the only
    // decode path this kind has.
    subscription_compile: {
      payload: {
        request: "when a contract renewal lands",
        authoredBy: "operator",
        path: "session",
        attempts: 2,
      },
      dedupeKey: null,
    },
  };

  // The guard the type was supposed to be. A kind added to the union without a
  // fixture reddens here, where a test actually runs.
  test("the fixture map covers every kind the gateway can record", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...COGNITION_RUN_KINDS].sort());
  });

  test("every kind decodes a trigger from its payload", () => {
    for (const [kind, f] of Object.entries(FIXTURES)) {
      const k = kind as CognitionRunKind;
      expect(decodeRunTrigger(k, f.payload, null).type, `payload decode for ${kind}`).not.toBe(
        "unknown",
      );
    }
  });

  test("every queued kind also decodes from its dedupe key alone", () => {
    for (const [kind, f] of Object.entries(FIXTURES)) {
      if (f.dedupeKey === null) continue;
      const k = kind as CognitionRunKind;
      expect(decodeRunTrigger(k, {}, f.dedupeKey).type, `dedupe-key decode for ${kind}`).not.toBe(
        "unknown",
      );
    }
  });

  test("sweep decodes its theme + day from payload and from the dedupe key", () => {
    expect(decodeRunTrigger("sweep", FIXTURES.sweep.payload, null)).toEqual({
      type: "sweep",
      sweepId: "weekly-money",
      date: "2026-07-01",
    });
    // Theme ids may contain colons — the day is the LAST segment.
    expect(decodeRunTrigger("sweep", {}, "sweep:a:b:2026-07-02")).toEqual({
      type: "sweep",
      sweepId: "a:b",
      date: "2026-07-02",
    });
  });

  test("verification decodes its ids + store from payload and from the dedupe key", () => {
    expect(
      decodeRunTrigger("verification", { annotationIds: ["panno_b", "panno_a"], store: "person" }),
    ).toEqual({
      type: "verification",
      annotationIds: ["panno_b", "panno_a"],
      store: "person",
    });
    // The dedupe key bakes the store in, so the fallback recovers it too.
    expect(decodeRunTrigger("verification", {}, "verify:person:panno_a,panno_b")).toEqual({
      type: "verification",
      annotationIds: ["panno_a", "panno_b"],
      store: "person",
    });
    // A key whose store segment is not a real store stays unknown.
    expect(decodeRunTrigger("verification", {}, "verify:elsewhere:anno_a")).toEqual({
      type: "unknown",
    });
  });

  test("merge_adjudication decodes its candidate from payload and from the dedupe key", () => {
    expect(decodeRunTrigger("merge_adjudication", { candidateId: "cand_a" })).toEqual({
      type: "merge-adjudication",
      candidateId: "cand_a",
    });
    // A wiped payload recovers the candidate from the surviving dedupe key.
    expect(
      decodeRunTrigger("merge_adjudication", {}, "merge-adjudication:candidate:cand_b"),
    ).toEqual({ type: "merge-adjudication", candidateId: "cand_b" });
    // A key from another family — or none — stays unknown.
    expect(decodeRunTrigger("merge_adjudication", {}, "data:doc:doc_a")).toEqual({
      type: "unknown",
    });
    expect(decodeRunTrigger("merge_adjudication", {}, null)).toEqual({ type: "unknown" });
  });

  test("notes_compaction decodes its reason from payload and the fixed fold key", () => {
    expect(decodeRunTrigger("notes_compaction", { reason: "notes over soft cap" })).toEqual({
      type: "notes-compaction",
      reason: "notes over soft cap",
    });
    // A wiped payload recovers the kind from the fixed fold key; the key
    // carries no reason.
    expect(decodeRunTrigger("notes_compaction", {}, "notes-compaction")).toEqual({
      type: "notes-compaction",
      reason: null,
    });
    // A key from another family — or none — stays unknown.
    expect(decodeRunTrigger("notes_compaction", {}, "data:doc:doc_a")).toEqual({
      type: "unknown",
    });
    expect(decodeRunTrigger("notes_compaction", {}, null)).toEqual({ type: "unknown" });
  });

  test("the annotation-contradiction synthesis flavour decodes from payload and dedupe key", () => {
    expect(
      decodeRunTrigger("synthesis", {
        focus: "annotation-contradiction",
        annotationIds: ["anno_a", "anno_b"],
        store: "doc",
      }),
    ).toEqual({
      type: "synthesis-annotation-contradiction",
      annotationIds: ["anno_a", "anno_b"],
      store: "doc",
    });
    // The dedupe key carries the ids but not the store — store comes back null.
    expect(
      decodeRunTrigger("synthesis", {}, "synthesis:anno-contradiction:panno_a,panno_b"),
    ).toEqual({
      type: "synthesis-annotation-contradiction",
      annotationIds: ["panno_a", "panno_b"],
      store: null,
    });
  });
});
