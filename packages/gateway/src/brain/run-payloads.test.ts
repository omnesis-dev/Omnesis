// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { MAX_CHANGED_ADDRESSED_ENTRY_IDS } from "./addressed-entry-context.js";
import {
  parseCognitionDataRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionMayDayRunPayload,
  parseCognitionSweepRunPayload,
  parseCognitionSynthesisRunPayload,
} from "./run-payloads.js";
import { decodeRunTrigger } from "./run-payload-view.js";
import { cognitiveWorkflowIdForRun } from "./cognition/workflows.js";
import { mutatingToolsFor } from "./cognition/authority.js";
import { COGNITION_RUN_KINDS } from "./storage/types.js";

describe("maintenance continuation lineage", () => {
  const base = { focus: "knowledge-maintenance", batchId: "batch_example" };

  test.each([
    { continuedByRunId: "run_next" },
    { continuedFromRunId: "run_previous" },
    { continuedFromRunId: "run_previous", continuedByRunId: "run_next" },
  ])("preserves maintenance identity and authority with %j", (lineage) => {
    const payload = { ...base, ...lineage };
    expect(parseCognitionSynthesisRunPayload(payload)).toEqual(payload);
    expect(decodeRunTrigger("synthesis", payload)).toEqual({
      type: "knowledge-maintenance",
      batchId: "batch_example",
    });
    const workflow = cognitiveWorkflowIdForRun("synthesis", payload);
    expect(workflow).toBe("knowledge-maintenance");
    expect(mutatingToolsFor(workflow).has("knowledge_save")).toBe(true);
  });

  test("lineage cannot grant authority to an invalid payload", () => {
    for (const payload of [
      { ...base, continuedFromRunId: "" },
      { ...base, continuedByRunId: 3 },
      { ...base, continuedFromRunId: "run_previous", surpriseKey: true },
      { continuedFromRunId: "run_previous" },
    ]) {
      expect(parseCognitionSynthesisRunPayload(payload)).toBeNull();
      expect(decodeRunTrigger("synthesis", payload)).toEqual({ type: "unknown" });
      expect(mutatingToolsFor(cognitiveWorkflowIdForRun("synthesis", payload)).size).toBe(0);
    }
  });
});

describe("daily and sweep payload discrimination", () => {
  test("digest and may-day payloads never collide (they are discriminated, not shape-matched)", () => {
    // Both carry only `date` beyond their literal marker, so a schema that
    // dropped the marker would silently route every may-day run as a digest.
    expect(parseCognitionDigestRunPayload({ mayDay: true, date: "d" })).toBeNull();
    expect(parseCognitionMayDayRunPayload({ digest: true, date: "d" })).toBeNull();
    expect(parseCognitionDigestRunPayload({ digest: true, date: "d" })).toEqual({
      digest: true,
      date: "d",
    });
    expect(parseCognitionDigestRunPayload({ digest: "yes", date: "d" })).toBeNull();
  });

  test("a pending sweep run that still carries a retired editorial lane stays claimable", () => {
    const base = { sweepId: "x", date: "2026-08-11", steeringPrompt: "p" };
    expect(parseCognitionSweepRunPayload({ ...base, briefLane: "lookahead" })).toEqual(base);
    expect(parseCognitionSweepRunPayload({ ...base, origin: "user" })).toEqual({
      ...base,
      origin: "user",
    });
    // Any other unknown key still fails the strict parse.
    expect(parseCognitionSweepRunPayload({ ...base, surpriseKey: true })).toBeNull();
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
