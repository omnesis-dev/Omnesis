// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { DISCOVERY_INPUT_MAX_BYTES, judgeKnowledge, knowledgeDecisionRequest } from "./decision.js";

function fixture() {
  const decide = vi.fn<DecisionCapability["decide"]>().mockResolvedValue({
    model: "scripted",
    answers: { discovery: { type: "score", score: 0 } },
    inputTokens: 12,
  });
  const record = vi.fn(),
    recordSpend = vi.fn();
  const deps = {
    getDecision: () => ({ modelId: "scripted", decide, dispose() {} }),
    record,
    recordSpend,
    log: createLogger("test:discovery-budget"),
  };
  return { deps, decide, record, recordSpend };
}
it("counts the complete generic input including rubric and UTF-8 bytes without truncating", async () => {
  const { deps, decide, record } = fixture();
  const emptyBytes = Buffer.byteLength(
    JSON.stringify(knowledgeDecisionRequest("discovery", { source: { content: "" } })),
  );
  const content = "é" + "x".repeat(DISCOVERY_INPUT_MAX_BYTES - emptyBytes - 2);
  const state = { source: { content } };
  expect(Buffer.byteLength(JSON.stringify(knowledgeDecisionRequest("discovery", state)))).toBe(
    DISCOVERY_INPUT_MAX_BYTES,
  );
  expect(await judgeKnowledge(deps, "discovery", state)).toBe(0);
  expect(decide.mock.calls[0]![0].state).toEqual(state);
  expect(record.mock.calls[0]![0].bypass).toBeUndefined();
  decide.mockClear();
  expect(
    await judgeKnowledge(deps, "discovery", { source: { content: content + "x" } }),
  ).toBeNull();
  expect(decide).not.toHaveBeenCalled();
  expect(record).toHaveBeenLastCalledWith(
    expect.objectContaining({
      score: null,
      inputTokens: 0,
      latencyMs: 0,
      modelId: "unavailable",
      bypass: {
        reason: "request_budget_exceeded",
        inputBytes: DISCOVERY_INPUT_MAX_BYTES + 1,
        budgetBytes: DISCOVERY_INPUT_MAX_BYTES,
      },
    }),
  );
});
it("audits empty input and absent decision without paid calls or invented scores", async () => {
  const { deps, decide, record, recordSpend } = fixture();
  expect(await judgeKnowledge(deps, "discovery", { source: { content: " \n " } })).toBeNull();
  expect(record).toHaveBeenLastCalledWith(
    expect.objectContaining({
      bypass: expect.objectContaining({ reason: "empty_source" }),
      inputTokens: 0,
    }),
  );
  expect(
    await judgeKnowledge({ ...deps, getDecision: () => null }, "discovery", {
      source: { content: "A fictional observation." },
    }),
  ).toBeNull();
  expect(record).toHaveBeenLastCalledWith(
    expect.objectContaining({
      bypass: expect.objectContaining({ reason: "decision_unavailable" }),
      score: null,
    }),
  );
  expect(decide).not.toHaveBeenCalled();
  expect(recordSpend).not.toHaveBeenCalled();
});
it("keeps provider rejection unavailable and auditable rather than treating it as irrelevant", async () => {
  const { deps, decide, record } = fixture();
  decide.mockRejectedValue(new Error("Provider rejected input capacity"));
  expect(
    await judgeKnowledge(
      deps,
      "discovery",
      { source: { content: "x".repeat(60_000) } },
      { payloadCapture: { erasureGeneration: 0, subjects: [{ kind: "source", id: "fictional" }] } },
    ),
  ).toBeNull();
  expect(record).toHaveBeenLastCalledWith(
    expect.objectContaining({
      score: null,
      payload: expect.objectContaining({ error: expect.stringContaining("capacity") }),
    }),
  );
});
