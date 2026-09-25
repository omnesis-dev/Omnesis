// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the decision view — the pure fold from a stored run
 * transcript to the operator's "what did the agent decide and why"
 * summary: mutating tool calls become actions (with error results
 * marked), research calls are counted, and the persisted payload
 * resolves to a per-kind subject line.
 */

import { describe, expect, test } from "vitest";
import { describeRunSubject, summarizeCognitionTranscript } from "./decision-view.js";
import type { CognitionRunTranscript } from "./transcripts.js";

function transcript(over: Partial<CognitionRunTranscript> = {}): CognitionRunTranscript {
  return {
    runId: "run_1",
    attempt: 1,
    kind: "data",
    payload: { docId: "doc_a", event: "created", datumAt: 500 },
    startedAt: 1000,
    finishedAt: 2000,
    prompt: "Background Cognition Steward run.",
    events: [],
    finalText: "Tracked the new commitment.",
    outcome: "completed",
    usage: { promptTokens: 100, completionTokens: 20 },
    ...over,
  };
}

function toolStart(toolCallId: string, tool: string, args: unknown) {
  return { type: "agent.tool.start", payload: { toolCallId, tool, args } };
}

function toolResult(toolCallId: string, kind: string) {
  return { type: "agent.tool.result", payload: { toolCallId, result: { kind } } };
}

describe("summarizeCognitionTranscript", () => {
  test("splits tool calls into decision actions vs research, in order", () => {
    const decision = summarizeCognitionTranscript(
      transcript({
        events: [
          toolStart("t1", "search", { query: "invoice" }),
          toolResult("t1", "search.results"),
          toolStart("t2", "open_loop_create", { title: "Pay the studio invoice" }),
          toolResult("t2", "structured"),
          toolStart("t3", "open_document", { id: "doc_a" }),
          toolStart("t4", "brief_create", { title: "An invoice arrived" }),
          toolResult("t4", "structured"),
        ],
      }),
    );
    expect(decision.researchToolCalls).toBe(2);
    expect(decision.actions).toEqual([
      { tool: "open_loop_create", detail: 'create loop "Pay the studio invoice"', ok: true },
      { tool: "brief_create", detail: 'create brief "An invoice arrived"', ok: true },
    ]);
    expect(decision.subject).toBe("doc doc_a (created)");
    expect(decision.docId).toBe("doc_a");
    expect(decision.finalText).toBe("Tracked the new commitment.");
    expect(decision.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
  });

  test("marks an action failed when its tool result is an error", () => {
    const decision = summarizeCognitionTranscript(
      transcript({
        events: [
          toolStart("t1", "open_loop_update", { id: "loop_x", state: "done" }),
          toolResult("t1", "error"),
        ],
      }),
    );
    expect(decision.actions).toEqual([
      { tool: "open_loop_update", detail: "update loop loop_x → done", ok: false },
    ]);
  });

  test("an empty event stream means the agent decided to do nothing", () => {
    const decision = summarizeCognitionTranscript(transcript());
    expect(decision.actions).toEqual([]);
    expect(decision.researchToolCalls).toBe(0);
  });

  test("describes the remaining mutating tools legibly", () => {
    const decision = summarizeCognitionTranscript(
      transcript({
        events: [
          toolStart("t1", "open_loop_ledger_append", { id: "loop_x", note: "Reply landed." }),
          toolStart("t2", "open_loop_delete", { id: "loop_x" }),
          toolStart("t3", "brief_update", { id: "brf_1" }),
          toolStart("t4", "brief_delete", { id: "brf_1" }),
          toolStart("t5", "notes_rewrite", { text: "…" }),
          toolStart("t6", "schedule_agent_run", { when: "2026-07-04T09:00:00Z", prompt: "…" }),
          toolStart("t7", "annotation_supersede", { id: "anno_a", supersededBy: "anno_b" }),
          toolStart("t8", "person_annotation_supersede", {
            id: "panno_a",
            supersededBy: "panno_b",
          }),
        ],
      }),
    );
    expect(decision.actions.map((a) => a.detail)).toEqual([
      "ledger loop_x: Reply landed.",
      "delete loop loop_x",
      "update brief brf_1",
      "withdraw brief brf_1",
      "rewrite agent notes",
      "schedule run at 2026-07-04T09:00:00Z",
      "supersede anno_a → anno_b",
      "supersede panno_a → panno_b",
    ]);
  });

  test("a transcript without a persisted payload yields a null subject (older files)", () => {
    const decision = summarizeCognitionTranscript(transcript({ payload: undefined }));
    expect(decision.subject).toBeNull();
    expect(decision.docId).toBeNull();
  });

  test("carries the failure outcome + error message through", () => {
    const decision = summarizeCognitionTranscript(
      transcript({ outcome: "failed", errorMessage: "backend unavailable", usage: null }),
    );
    expect(decision.outcome).toBe("failed");
    expect(decision.errorMessage).toBe("backend unavailable");
    expect(decision.usage).toBeNull();
  });
});

describe("describeRunSubject", () => {
  test("resolves each run kind's payload to a one-line subject", () => {
    expect(describeRunSubject("data", { docId: "doc_a", event: "updated", datumAt: 1 })).toBe(
      "doc doc_a (updated)",
    );
    expect(
      describeRunSubject("daily", {
        sourceId: "health-samples",
        dateFrom: "2026-06-30",
        dateTo: "2026-07-01",
      }),
    ).toBe("source health-samples 2026-06-30 → 2026-07-01");
    expect(describeRunSubject("daily", { mayDay: true, date: "2026-07-01" })).toBe(
      "may-day 2026-07-01",
    );
    expect(describeRunSubject("feedback", { briefId: "brf_1" })).toBe("brief brf_1");
    expect(describeRunSubject("time_based", { decayCheckLoopId: "loop_x" })).toBe(
      "decay-check loop loop_x",
    );
    expect(describeRunSubject("time_based", { prompt: "Re-check the rental form thread" })).toBe(
      "prompt: Re-check the rental form thread",
    );
    expect(
      describeRunSubject("sweep", {
        sweepId: "weekly-money",
        date: "2026-07-01",
        steeringPrompt: "steer",
      }),
    ).toBe('sweep "weekly-money" for 2026-07-01');
    expect(describeRunSubject("bootstrap", { docId: "doc_b", datumAt: 1 })).toBe(
      "bootstrap doc doc_b",
    );
    expect(
      describeRunSubject("synthesis", {
        focus: "annotation-contradiction",
        annotationIds: ["anno_a", "anno_b"],
        store: "doc",
      }),
    ).toBe("annotation contradiction (doc): anno_a, anno_b");
    expect(
      describeRunSubject("verification", {
        annotationIds: ["panno_a", "panno_b"],
        store: "person",
      }),
    ).toBe("re-verify (person): panno_a, panno_b");
    expect(describeRunSubject("notes_compaction", { reason: "notes at 9000 of 8192 bytes" })).toBe(
      "notes compaction: notes at 9000 of 8192 bytes",
    );
  });

  test("malformed or absent payloads resolve to null, never throw", () => {
    expect(describeRunSubject("data", { junk: true })).toBeNull();
    expect(describeRunSubject("daily", null)).toBeNull();
    expect(describeRunSubject("feedback", undefined)).toBeNull();
    expect(describeRunSubject("notes_compaction", { junk: true })).toBeNull();
  });
});
