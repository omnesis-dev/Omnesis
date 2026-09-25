// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { MAX_CHANGED_ADDRESSED_ENTRY_IDS } from "./addressed-entry-context.js";
import { cognitionBriefLane, parseCognitionDataRunPayload } from "./run-payloads.js";
import { COGNITION_RUN_KINDS } from "./storage/types.js";

describe("cognitionBriefLane", () => {
  test("a sweep faces the strict bar unless its payload carries a declared lane", () => {
    const sweep = (payload: Record<string, unknown>) =>
      cognitionBriefLane({
        kind: "sweep",
        payload: { sweepId: "x", date: "2026-08-11", steeringPrompt: "p", ...payload },
      });
    // The lane is a charter a SYSTEM sweep declares. Every operator-authored
    // sweep — and any run whose payload predates the field — gets the four
    // gates, so a sweep can never route around them by existing.
    expect(sweep({})).toBe("reactive");
    expect(sweep({ origin: "user" })).toBe("reactive");
    expect(sweep({ briefLane: "lookahead" })).toBe("lookahead");
    expect(sweep({ briefLane: "noticing" })).toBe("noticing");
    // A lane the schema does not know fails the parse and falls to strict.
    expect(sweep({ briefLane: "digest" })).toBe("reactive");
  });

  test("the daily flavours land in their own lanes (may-day rows are historical)", () => {
    expect(
      cognitionBriefLane({ kind: "daily", payload: { digest: true, date: "2026-08-11" } }),
    ).toBe("digest");
    expect(
      cognitionBriefLane({ kind: "daily", payload: { mayDay: true, date: "2026-08-11" } }),
    ).toBe("lookahead");
    expect(
      cognitionBriefLane({
        kind: "daily",
        payload: { sourceId: "gmail:a", dateFrom: "2026-08-10", dateTo: "2026-08-11" },
      }),
    ).toBe("reactive");
  });

  test("digest and may-day payloads never collide (they are discriminated, not shape-matched)", () => {
    // Both carry only `date` beyond their literal marker, so a schema that
    // dropped the marker would silently route every may-day run as a digest —
    // and a digest never faces the push bar.
    expect(cognitionBriefLane({ kind: "daily", payload: { mayDay: true, date: "d" } })).not.toBe(
      "digest",
    );
    expect(cognitionBriefLane({ kind: "daily", payload: { digest: true, date: "d" } })).not.toBe(
      "lookahead",
    );
  });

  test("only a loop-scoped scheduled check is a dated reminder", () => {
    expect(
      cognitionBriefLane({
        kind: "time_based",
        payload: { prompt: "re-verify before it surfaces", loopId: "loop_1" },
      }),
    ).toBe("dated_reminder");
    // A loop-less schedule_agent_run is a free-form follow-up the agent wrote
    // for itself. Letting it reach the preparation bar would hand the agent a
    // way around the echo check by scheduling its own card.
    expect(
      cognitionBriefLane({ kind: "time_based", payload: { prompt: "look at this later" } }),
    ).toBe("reactive");
    expect(
      cognitionBriefLane({ kind: "time_based", payload: { decayCheckLoopId: "loop_1" } }),
    ).toBe("reactive");
  });

  test("only the noticing focus is the awareness lane", () => {
    expect(cognitionBriefLane({ kind: "synthesis", payload: { focus: "noticing" } })).toBe(
      "noticing",
    );
    for (const focus of ["collision", "annotation-contradiction"]) {
      expect(cognitionBriefLane({ kind: "synthesis", payload: { focus } })).toBe("reactive");
    }
  });

  test("every kind that does not fan out is reactive — the strict bar", () => {
    // Derived from the real union, so an eleventh run kind fails here rather
    // than silently inheriting a lane.
    const fanOut = new Set(["daily", "time_based", "synthesis"]);
    for (const kind of COGNITION_RUN_KINDS.filter((k) => !fanOut.has(k))) {
      expect(cognitionBriefLane({ kind, payload: {} }), kind).toBe("reactive");
    }
  });

  test("a malformed or unknown payload falls back to reactive, never a laxer lane", () => {
    // A corrupt row must not be able to widen a lane: every fallback is the
    // strict bar, so the failure mode is an over-judged card, not an
    // un-judged one.
    expect(cognitionBriefLane({ kind: "daily", payload: null })).toBe("reactive");
    expect(cognitionBriefLane({ kind: "daily", payload: { digest: "yes" } })).toBe("reactive");
    expect(cognitionBriefLane({ kind: "time_based", payload: {} })).toBe("reactive");
    expect(cognitionBriefLane({ kind: "synthesis", payload: { focus: "unknown" } })).toBe(
      "reactive",
    );
    expect(cognitionBriefLane({ kind: "not-a-kind", payload: {} })).toBe("reactive");
  });
});

/**
 * Two keys the retired watch evaluator wrote onto a `data` payload.
 *
 * The schema is `.strict()`, and settled rows deliberately keep their
 * payloads. So the keys could not simply be deleted from the object: every
 * stored payload still carrying one would fail to parse — and a run whose
 * payload does not parse is granted **zero write authority**, silently, which
 * looks exactly like a model deciding to do nothing. They are stripped before
 * the strict object sees them instead.
 */
describe("a stored payload from the retired evaluator", () => {
  const LIVE = { docId: "doc_1", event: "created" as const, datumAt: 1 };

  test("still parses, and comes back without the retired keys", () => {
    const parsed = parseCognitionDataRunPayload({
      ...LIVE,
      subscriptionEvaluationIds: ["ev_1", "ev_2"],
      operatorWatchEvaluationIds: ["ev_1"],
    });

    expect(parsed, "a stored payload stopped parsing, so its run writes nothing").not.toBeNull();
    expect(parsed).toEqual(LIVE);
  });

  test("keeps every field the run still uses", () => {
    // The strip must take two keys and nothing else: a fold's snapshot and a
    // barrier's schedule are load-bearing on the very rows most likely to be
    // carrying the retired ones.
    const parsed = parseCognitionDataRunPayload({
      ...LIVE,
      subscriptionEvaluationIds: ["ev_1"],
      debounceUntil: 10,
      barrierUntil: 20,
      diff: "@@",
      snapshot: { content: "x", capturedAt: 3 },
    });

    expect(parsed).toMatchObject({
      debounceUntil: 10,
      barrierUntil: 20,
      diff: "@@",
      snapshot: { content: "x", capturedAt: 3 },
    });
  });

  test("still refuses a key nobody has ever written", () => {
    // The strip widens two values, not the object. An unrecognised key is a
    // payload this build does not understand, and `.strict()` saying so is
    // what stops a typo becoming a silently ignored field.
    expect(parseCognitionDataRunPayload({ ...LIVE, surpriseKey: 1 })).toBeNull();
  });
});

describe("changed addressed-entry attribution", () => {
  const LIVE = { docId: "doc_1", event: "updated" as const, datumAt: 1 };

  test("accepts the bounded id-only payload and its honest truncation marker", () => {
    const ids = Array.from(
      { length: MAX_CHANGED_ADDRESSED_ENTRY_IDS },
      (_, index) => `entry_${index}`,
    );
    expect(
      parseCognitionDataRunPayload({
        ...LIVE,
        changedAddressedEntryIds: ids,
        addressedEntriesTruncated: true,
      }),
    ).toMatchObject({ changedAddressedEntryIds: ids, addressedEntriesTruncated: true });
  });

  test("rejects a queue payload beyond the privacy and prompt-work cap", () => {
    const ids = Array.from(
      { length: MAX_CHANGED_ADDRESSED_ENTRY_IDS + 1 },
      (_, index) => `entry_${index}`,
    );
    expect(parseCognitionDataRunPayload({ ...LIVE, changedAddressedEntryIds: ids })).toBeNull();
  });
});
