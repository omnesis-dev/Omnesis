// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { CitationReads, type DocumentPortResult } from "@omnesis/agent";
import { CONTEXTUAL_EVIDENCE_MAX_BYTES } from "../inference/contextual-entailment.js";
import {
  createAnswerGroundingFinalizer,
  GROUNDING_CHANGED,
  GROUNDING_UNKNOWN,
  type AnswerGroundingDiagnostic,
} from "./answer-grounding.js";
import type { EntailCapability, LoopDetail } from "@omnesis/core";

const identity = { sessionId: "session", messageId: "turn", question: "What should I track?" };
const observed: LoopDetail = {
  loopId: "loop",
  title: "Calibrate the prism",
  description: "Tracking a laboratory request",
  state: "open",
  importance: 0.5,
  confidence: 0.8,
  deadline: "2026-03-10",
  docIds: ["source"],
  ledger: [{ at: 1, note: "Initial request recorded" }],
  knowledgeContext: { validity: "current" },
};
const draft = "The laboratory request is tracked.";
const revised = "The tracking record now includes a follow-up note; completion is not established.";
function fixture(initial: LoopDetail = observed) {
  let current: LoopDetail | null = structuredClone(initial);
  let sourceVisible = true,
    rootCurrent = true,
    sourceVersion = "v1";
  const document = (): DocumentPortResult => ({
    ref: { documentId: "source", sourceId: "fixture", sourceType: "fixture" },
    readSnapshot: { documentId: "source", version: sourceVersion },
    document: { content: "A laboratory calibration was requested." },
  });
  const reads = new CitationReads();
  reads.record(identity, document(), true);
  const verify = vi.fn<EntailCapability["verify"]>().mockResolvedValue({ label: "entailment" });
  const repair = vi.fn(async (_prompt: string, _signal: AbortSignal) => revised);
  const fetch = vi.fn(
    async (_id: string, _signal?: AbortSignal) => current && structuredClone(current),
  );
  const diagnostics: AnswerGroundingDiagnostic[] = [];
  const abort = new AbortController();
  const f = createAnswerGroundingFinalizer({
    reads,
    document: { fetch: async () => (sourceVisible ? document() : null) },
    loops: {
      fetch,
      list: async () => ({ loops: [], truncated: false, durationMs: 0 }),
      search: async () => ({ loops: [], query: "", durationMs: 0 }),
    },
    promptSupport: {
      evidence: [{ text: "Qualified captured orientation" }],
      current: () => rootCurrent,
    },
    getVerifier: async () => ({ verify, dispose() {} }),
    repair,
    diagnostic: (d) => diagnostics.push(d),
  })(identity);
  f.observe({
    type: "agent.tool.result",
    payload: {
      ...identity,
      toolCallId: "read",
      durationMs: 0,
      result: { kind: "loop.fetched", loop: structuredClone(initial) },
    },
  });
  return {
    f,
    verify,
    repair,
    fetch,
    diagnostics,
    abort,
    run: () => f.finalize({ draft, overflow: false, signal: abort.signal }),
    change: (next: LoopDetail | null) => {
      current = next;
    },
    note: (note = "Follow-up note recorded") => {
      current = { ...initial, ledger: [{ at: 2, note }] };
    },
    revokeSource: () => {
      sourceVisible = false;
    },
    changeSource: () => {
      sourceVersion = "v2";
    },
    changeRoot: () => {
      rootCurrent = false;
    },
  };
}

it("refreshes an observed ledger explicitly, without adding source authority or rerunning actions", async () => {
  const f = fixture();
  f.note();
  f.f.observe({
    type: "agent.tool.result",
    payload: {
      ...identity,
      toolCallId: "action",
      durationMs: 0,
      result: { kind: "structured", resultType: "annotation.created", data: {} },
    },
  });
  expect(await f.run()).toBe(revised);
  expect(f.repair).toHaveBeenCalledTimes(1);
  expect(f.verify).toHaveBeenCalledTimes(1);
  const prompt = f.repair.mock.calls[0]![0];
  expect(prompt).toContain("refreshed observations");
  expect(prompt).toContain("Follow-up note recorded");
  expect(prompt).toContain("annotation.created");
  expect(f.verify.mock.calls[0]![0].claim).toBe(revised);
  expect(f.verify.mock.calls[0]![0].evidence).toContain("Follow-up note recorded");
  expect(f.fetch.mock.calls.every(([id]) => id === "loop")).toBe(true);
  expect(f.diagnostics.at(-1)).toMatchObject({ status: "repaired", attempts: 1 });
});

it.each(["description", "state", "importance", "confidence", "deadline", "title"] as const)(
  "never releases the old draft after observed %s changes",
  async (key) => {
    const f = fixture();
    f.change({ ...observed, [key]: typeof observed[key] === "number" ? 0.9 : "changed" });
    expect(await f.run()).toBe(revised);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.verify.mock.calls[0]![0].claim).toBe(revised);
  },
);

it.each(["revokeSource", "changeSource"] as const)(
  "refuses simultaneous loop and non-loop %s changes",
  async (action) => {
    const f = fixture();
    f.note();
    f[action]();
    expect(await f.run()).toBe(GROUNDING_CHANGED);
    expect(f.diagnostics.at(-1)).toMatchObject({
      reason: "evidence_changed",
      freshnessFailure: "source_authority",
    });
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  },
);

it("holds a captured root proof that changes while reading refreshed loop state", async () => {
  const f = fixture();
  f.note();
  f.fetch.mockImplementationOnce(async () => {
    f.changeRoot();
    return { ...observed, ledger: [{ at: 2, note: "New tracking note" }] };
  });
  expect(await f.run()).toBe(GROUNDING_CHANGED);
  expect(f.diagnostics.at(-1)).toMatchObject({
    reason: "evidence_changed",
    freshnessFailure: "root_authority",
  });
  expect(f.repair).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
});

it.each(["missing", "proof", "sources", "related"])(
  "holds changed %s authority rather than refreshing it",
  async (kind) => {
    const f = fixture();
    f.change(
      kind === "missing"
        ? null
        : {
            ...observed,
            ...(kind === "proof"
              ? { knowledgeContext: { validity: "stale" } }
              : kind === "sources"
                ? { docIds: ["new-source"] }
                : { relatedLoops: [{ loopId: "other", title: "Other task", state: "open" }] }),
          },
    );
    expect(await f.run()).toBe(GROUNDING_CHANGED);
    expect(f.diagnostics.at(-1)).toMatchObject({
      reason: "evidence_changed",
      freshnessFailure:
        kind === "missing"
          ? "loop_unavailable"
          : kind === "proof"
            ? "loop_proof"
            : "loop_associations",
    });
    expect(f.repair).not.toHaveBeenCalled();
  },
);

it("counts the discarded first check and shares one repair with at most two checks", async () => {
  const f = fixture();
  f.verify.mockImplementationOnce(async () => {
    f.note();
    return { label: "entailment" };
  });
  expect(await f.run()).toBe(revised);
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.repair).toHaveBeenCalledTimes(1);
  expect(f.diagnostics.at(-1)).toMatchObject({ attempts: 2, repairTrigger: "tracking" });
  expect(f.diagnostics.at(-1)?.checks).toEqual([
    { outcome: "recheck_failed" },
    {
      outcome: "accepted",
      label: "entailment",
      probabilityThreshold: "default_pass",
      negativeFacets: [],
    },
  ]);
});

it.each(["repair", "second-check"])(
  "does not repeat recovery after a second change during %s",
  async (phase) => {
    const f = fixture();
    f.note();
    if (phase === "repair")
      f.repair.mockImplementation(async () => {
        f.note("Changed again");
        return revised;
      });
    else
      f.verify.mockImplementation(async () => {
        f.note("Changed again");
        return { label: "entailment" };
      });
    expect(await f.run()).toBe(GROUNDING_CHANGED);
    expect(f.diagnostics.at(-1)).toMatchObject({
      reason: "evidence_changed",
      freshnessFailure: "loop_changed_again",
    });
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.verify.mock.calls.length).toBeLessThanOrEqual(1);
  },
);

it("does not refresh after a semantic-negative repair has consumed the allowance", async () => {
  const f = fixture();
  f.verify.mockResolvedValue({ label: "neutral" });
  f.repair.mockImplementation(async () => {
    f.note();
    return revised;
  });
  expect(await f.run()).toBe(GROUNDING_CHANGED);
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.repair).toHaveBeenCalledTimes(1);
});

it.each(["cancel", "outage", "budget"])(
  "holds recovery on %s without repeating a successful operation",
  async (kind) => {
    const f = fixture();
    f.note();
    f.f.observe({
      type: "agent.tool.result",
      payload: {
        ...identity,
        toolCallId: "action",
        durationMs: 0,
        result: { kind: "structured", resultType: "annotation.created", data: {} },
      },
    });
    if (kind === "cancel")
      f.repair.mockImplementation(async () => {
        f.abort.abort();
        return revised;
      });
    if (kind === "outage") f.verify.mockRejectedValue(new Error("Unavailable"));
    if (kind === "budget") f.note("x".repeat(CONTEXTUAL_EVIDENCE_MAX_BYTES));
    const result = await f.run();
    if (kind === "cancel") expect(result).toBe("");
    else {
      expect(result.match(/annotation.created/g)).toHaveLength(1);
      expect(result).toContain(kind === "budget" ? GROUNDING_CHANGED : GROUNDING_UNKNOWN);
    }
    expect(f.repair.mock.calls.length).toBeLessThanOrEqual(1);
    expect(f.verify.mock.calls.length).toBeLessThanOrEqual(1);
  },
);

const qualifiedObserved = {
  ...observed,
  knowledgeContext: {
    nodeId: "loop",
    kind: "loop",
    validity: "current",
    verifiedSupport: [
      {
        ref: "loop:loop#claim:calibration",
        revision: 3,
        text: JSON.stringify({
          statement: "Calibration may begin after the permit arrives.",
          semantics: { modality: "possibility", epistemicStatus: "asserted" },
        }),
        interpretationContext: JSON.stringify({
          pageTitle: "Prism calibration",
          outcome: {
            text: "If the permit arrives, calibration may begin.",
            selectedSpan: { start: 0, end: 49 },
          },
        }),
      },
    ],
  },
} satisfies LoopDetail;

it("rebuilds qualified loop evidence after tracking-only repair with its interpretation constraints intact", async () => {
  const f = fixture(qualifiedObserved);
  f.note("A new tracking note, not evidence of permit arrival");
  expect(await f.run()).toBe(revised);
  expect(f.repair).toHaveBeenCalledTimes(1);
  const packet = JSON.parse(f.verify.mock.calls[0]![0].evidence);
  const references = packet.evidenceParts.flatMap(
    (part: string) => JSON.parse(part).verifiedReferences ?? [],
  );
  expect(references).toEqual([
    { text: "Qualified captured orientation" },
    ...qualifiedObserved.knowledgeContext!.verifiedSupport.map(
      ({ text, interpretationContext }: { text: string; interpretationContext: string }) => ({
        text,
        interpretationContext,
      }),
    ),
  ]);
  expect(f.verify.mock.calls[0]![0].evidence).toContain("A new tracking note");
});

it.each(["text", "interpretationContext", "revision"] as const)(
  "holds changed qualified loop %s after repair instead of reusing captured support",
  async (field) => {
    const f = fixture(qualifiedObserved);
    f.note();
    f.repair.mockImplementation(async () => {
      const next: LoopDetail = structuredClone(qualifiedObserved);
      const support = next.knowledgeContext!.verifiedSupport as Array<Record<string, unknown>>;
      support[0]![field] = field === "revision" ? 4 : "Changed qualified authority";
      next.ledger = [{ at: 2, note: "Follow-up note recorded" }];
      f.change(next);
      return revised;
    });
    expect(await f.run()).toBe(GROUNDING_CHANGED);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.verify).not.toHaveBeenCalled();
  },
);
