// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { COGNITION_RUN_KINDS } from "../storage/types.js";
import {
  parseCognitionDataRunPayload,
  parseCognitionDailyRunPayload,
  parseCognitionMayDayRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionTimeBasedRunPayload,
  parseCognitionDecayCheckRunPayload,
  parseCognitionFeedbackRunPayload,
  parseCognitionProvenanceRecheckPayload,
  parseCognitionNotesCompactionRunPayload,
} from "../run-payloads.js";
import {
  COGNITIVE_WORKFLOW_IDS,
  UNRECOGNIZED_WORKFLOW_ID,
  cognitiveWorkflowIdForRun,
  cognitiveWorkflowLabel,
  cognitiveWorkflowQueueKind,
  cognitionMechanismLabel,
  isCognitiveWorkflowId,
} from "./workflows.js";
import type { CognitiveWorkflowId } from "./workflows.js";
import type { CognitionRunKind } from "../storage/types.js";

/** A representative valid payload for every workflow that carries one. */
const PAYLOADS = {
  "datum-intake": { docId: "d1", event: "created", datumAt: 1 },
  "source-bootstrap": { docId: "d1", datumAt: 1 },
  "daily-source-review": { sourceId: "src_1", dateFrom: "2026-01-01", dateTo: "2026-01-01" },
  "daily-lookahead": { mayDay: true, date: "2026-01-02" },
  "morning-digest": { digest: true, date: "2026-01-02" },
  "time-reaction": { prompt: "check the venue booking" },
  "loop-decay-check": { decayCheckLoopId: "loop_7" },
  "feedback-learning": { briefId: "brief_3" },
  "provenance-recheck": { recheckDependentKind: "loop", recheckDependentId: "loop_7" },
  noticing: { focus: "noticing", date: "2026-01-02" },
  "collision-review": { focus: "collision", loopIds: ["loop_1", "loop_2"] },
  "contradiction-review": {
    focus: "annotation-contradiction",
    annotationIds: ["anno_1", "anno_2"],
    store: "doc",
  },
  "thematic-sweep": { sweepId: "s1", date: "2026-01-02", steeringPrompt: "p" },
  "memory-regrounding": {},
  "identity-adjudication": { candidateId: "c1" },
  "notes-compaction": { reason: "notes at 9000 of 8192 bytes after append" },
} as const satisfies Partial<Record<CognitiveWorkflowId, unknown>>;

const workflowEntries = Object.entries(PAYLOADS) as Array<[CognitiveWorkflowId, unknown]>;

describe("cognitiveWorkflowIdForRun", () => {
  it("resolves every workflow from a representative payload", () => {
    for (const [expected, payload] of workflowEntries) {
      const kind = cognitiveWorkflowQueueKind(expected);
      expect(kind).not.toBeNull();
      expect(cognitiveWorkflowIdForRun(kind as CognitionRunKind, payload)).toBe(expected);
    }
  });

  it("does not fold an undecodable payload into a real workflow's bucket", () => {
    // Only the kinds that multiplex procedures read the payload at all, so
    // only they can fail to decode one. Attributing such a run to the kind's
    // primary workflow would put work we could not read inside a number the
    // operator compares models on.
    const multiplexed: CognitionRunKind[] = [
      "data",
      "daily",
      "time_based",
      "feedback",
      "synthesis",
    ];
    for (const kind of multiplexed) {
      expect(cognitiveWorkflowIdForRun(kind, { nonsense: true })).toBe(UNRECOGNIZED_WORKFLOW_ID);
      expect(cognitiveWorkflowIdForRun(kind, undefined)).toBe(UNRECOGNIZED_WORKFLOW_ID);
    }
  });

  it("resolves a single-workflow kind from the kind alone", () => {
    // These kinds carry exactly one procedure, so the payload cannot change
    // the answer and an odd-shaped one must not demote the run to unknown.
    expect(cognitiveWorkflowIdForRun("bootstrap", { nonsense: true })).toBe("source-bootstrap");
    expect(cognitiveWorkflowIdForRun("sweep", undefined)).toBe("thematic-sweep");
    expect(cognitiveWorkflowIdForRun("verification", undefined)).toBe("memory-regrounding");
    expect(cognitiveWorkflowIdForRun("merge_adjudication", undefined)).toBe(
      "identity-adjudication",
    );
    expect(cognitiveWorkflowIdForRun("notes_compaction", { nonsense: true })).toBe(
      "notes-compaction",
    );
  });

  it("resolves a kind outside the known union instead of returning undefined", () => {
    // `kind` is an unvalidated cast of a SQLite text column. Returning
    // undefined violates cognition_spend's NOT NULL mechanism, which rolls
    // back the settle transaction and abandons the rest of the drain tick.
    const offUnion = "not_a_kind" as CognitionRunKind;
    expect(cognitiveWorkflowIdForRun(offUnion, {})).toBe(UNRECOGNIZED_WORKFLOW_ID);
    expect(cognitiveWorkflowIdForRun(offUnion, PAYLOADS["morning-digest"])).toBe(
      UNRECOGNIZED_WORKFLOW_ID,
    );
  });

  it("never returns a workflow belonging to a different queue kind", () => {
    for (const [id, payload] of workflowEntries) {
      const kind = cognitiveWorkflowQueueKind(id) as CognitionRunKind;
      expect(cognitiveWorkflowQueueKind(cognitiveWorkflowIdForRun(kind, payload))).toBe(kind);
    }
  });

  it("keeps every queue kind reachable", () => {
    const reachable = new Set(COGNITIVE_WORKFLOW_IDS.map(cognitiveWorkflowQueueKind));
    for (const kind of COGNITION_RUN_KINDS) expect(reachable).toContain(kind);
  });
});

describe("payload-schema mutual exclusivity", () => {
  // Discrimination rests on this: each schema is `.strict()` with a disjoint
  // set of required keys, so at most one parser accepts a payload and the
  // order of the checks cannot matter. Relaxing a `.strict()` would silently
  // reattribute a whole workflow's spend, so the premise is pinned rather
  // than assumed.
  const PARSERS = {
    data: parseCognitionDataRunPayload,
    daily: parseCognitionDailyRunPayload,
    mayDay: parseCognitionMayDayRunPayload,
    digest: parseCognitionDigestRunPayload,
    timeBased: parseCognitionTimeBasedRunPayload,
    decay: parseCognitionDecayCheckRunPayload,
    feedback: parseCognitionFeedbackRunPayload,
    provenance: parseCognitionProvenanceRecheckPayload,
    notesCompaction: parseCognitionNotesCompactionRunPayload,
  };

  it.each(workflowEntries)("%s is accepted by at most one parser", (_id, payload) => {
    const accepting = Object.entries(PARSERS)
      .filter(([, parse]) => parse(payload) !== null)
      .map(([name]) => name);
    expect(accepting.length).toBeLessThanOrEqual(1);
  });

  it("refuses a payload that tries to satisfy two schemas at once", () => {
    // `digest` and `mayDay` are both z.literal(true) on distinct keys, so a
    // payload carrying both is refused by BOTH under `.strict()` — it cannot
    // resolve to whichever branch happens to be checked first.
    const both = { digest: true, mayDay: true, date: "2026-01-02" };
    expect(parseCognitionDigestRunPayload(both)).toBeNull();
    expect(parseCognitionMayDayRunPayload(both)).toBeNull();
    expect(cognitiveWorkflowIdForRun("daily", both)).toBe(UNRECOGNIZED_WORKFLOW_ID);
  });
});

describe("cognitionMechanismLabel", () => {
  it("labels workflow ids", () => {
    expect(cognitionMechanismLabel("daily-source-review")).toBe("Daily source review");
    expect(cognitionMechanismLabel(UNRECOGNIZED_WORKFLOW_ID)).toBe("Unrecognized work");
  });

  it("labels the interactive lanes, evaluators and Deep Research stages", () => {
    expect(cognitionMechanismLabel("interactive")).toBe("Interactive chat");
    expect(cognitionMechanismLabel("entailment-gate")).toBe("Evidence verifier");
    expect(cognitionMechanismLabel("brief-judge")).toBe("Brief gate");
    expect(cognitionMechanismLabel("deep-research:history-sweep")).toBe(
      "Deep Research · history sweep",
    );
    expect(cognitionMechanismLabel("deep-research:other")).toBe("Deep Research · other stage");
  });

  it("passes an unnamed mechanism through verbatim", () => {
    // A cost this build cannot name must still be visible on the surface —
    // this covers both a newer build's workflow id and a row an older build
    // recorded under a coarser name.
    expect(cognitionMechanismLabel("some-future-workflow")).toBe("some-future-workflow");
    expect(cognitionMechanismLabel("daily")).toBe("daily");
  });

  it("recognises workflow ids and nothing else", () => {
    expect(isCognitiveWorkflowId("noticing")).toBe(true);
    expect(isCognitiveWorkflowId("interactive")).toBe(false);
    // Own-property check, not a prototype probe.
    expect(isCognitiveWorkflowId("toString")).toBe(false);
  });

  it("gives every id a non-empty label", () => {
    for (const id of COGNITIVE_WORKFLOW_IDS) expect(cognitiveWorkflowLabel(id)).toBeTruthy();
  });
});
