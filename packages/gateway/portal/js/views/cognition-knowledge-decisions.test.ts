// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
// @ts-nocheck — portal components are plain JavaScript; inspect their rendered host VNodes.
import { expect, it } from "vitest";
import { DecisionInputContent, DecisionRetainedContent, DecisionScheduling, KnowledgeDecisionCard, ContextualDecisions } from "./cognition-knowledge-decisions.js";
function text(value) {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object") return String(value);
  return text(typeof value.type === "function" ? value.type(value.props) : value.props?.children);
}
function hosts(value, out = []) {
  if (value == null || typeof value !== "object") return out;
  if (Array.isArray(value)) { value.forEach((entry) => hosts(entry, out)); return out; }
  if (typeof value.type === "function") return hosts(value.type(value.props), out);
  out.push(value);
  hosts(value.props?.children, out);
  return out;
}
const decision = {
  id: "decision-fixture", purpose: "discovery", scoreScale: "normalized-0-1",
  score: 0.13, threshold: 0.25, recommendation: "skip", association: "recorded",
  modelId: "decision-model", rubricVersion: "example-rubric", createdAt: 1_700_000_000_000,
  latencyMs: 0, inputTokens: 0, nodeId: "source:document-fixture", batchId: "batch-fixture",
};
it("shows normalized scores and a recommendation without presenting it as an actual skip", () => {
  const rendered = text(KnowledgeDecisionCard({ decision }));
  expect(rendered).toContain("Discovery admission");
  expect(rendered).toContain("Score 0.13 · scale 0–1");
  expect(rendered).toContain("Threshold 0.25");
  expect(rendered).toContain("Recommendation: Skip");
  expect(rendered).toContain("Other work requirements can override this recommendation.");
  expect(rendered).toContain("Linked to this run when recorded");
  expect(rendered).toContain("0 ms");
  expect(rendered).toContain("Input tokens0");
});
it("distinguishes unavailable judgements and historical matching without inventing a bypass reason", () => {
  const rendered = text(KnowledgeDecisionCard({ decision: { ...decision, score: null, recommendation: "unavailable", association: "historical-matched" } }));
  expect(rendered).toContain("Score Unavailable");
  expect(rendered).toContain("Recommendation: Unavailable");
  expect(rendered).toContain("Historical match");
  expect(rendered).not.toContain("Linked to this run when recorded");
  expect(rendered).not.toContain("bypassed");
});
it("does not invent admission thresholds or recommendations for timing judgements", () => {
  const rendered = text(KnowledgeDecisionCard({ decision: { ...decision, purpose: "review", threshold: null, recommendation: null } }));
  expect(rendered).toContain("Review timing");
  expect(rendered).not.toContain("Threshold");
  expect(rendered).not.toContain("Recommendation:");
});
it("keeps model and subject metadata as inert text and leaves absent audit history unstated", () => {
  const tree = KnowledgeDecisionCard({ decision: { ...decision, modelId: "<script>untrusted</script>", nodeId: "javascript:untrusted" } });
  expect(text(tree)).toContain("<script>untrusted</script>");
  expect(hosts(tree).some((node) => node.type === "script" || node.props?.dangerouslySetInnerHTML || node.props?.href?.startsWith("javascript:"))).toBe(false);
  expect(text(ContextualDecisions({ decisions: [] }))).toContain("No recorded judgement for this context");
});

it("labels bounded and incomplete historical audit without asserting that no check happened", () => {
  const rendered = text(ContextualDecisions({ decisions: [], audit: { truncated: true, legacyIncomplete: true } }));
  expect(rendered).toContain("No recorded judgement for this context");
  expect(rendered).toContain("does not establish that a gate was bypassed");
  expect(rendered).toContain("Additional recorded checks");
  expect(rendered).toContain("Historical associations are incomplete");
});
it("shows exact retained request/result as inert text and distinguishes absent or oversized inspection", () => {
  const input = { availability: "available", request: { model: "fixture", state: "<script>payload</script>", questions: [] }, response: { model: "fixture", answers: [0.4] } };
  const tree = DecisionInputContent({ input });
  expect(text(tree)).toContain(JSON.stringify(input.request, null, 2));
  expect(text(tree)).toContain(JSON.stringify(input.response, null, 2));
  expect(text(DecisionInputContent({ input: { ...input, response: null, error: "Recorded transport failure" } }))).toContain("Recorded failureRecorded transport failure");
  expect(hosts(tree).some((node) => node.type === "script" || node.props?.dangerouslySetInnerHTML)).toBe(false);
  expect(text(DecisionInputContent({ input: { availability: "unavailable" } }))).toContain("not been reconstructed");
  expect(text(DecisionInputContent({ input: { availability: "oversized" } }))).toContain("inspection limit");
});
it("labels applied urgency scheduling as an attempt snapshot rather than current work state", () => {
  const rendered = text(DecisionScheduling({ scheduling: { status: "scheduled", applied: { tier: "soon", dueAt: 1_700_000_000_000 }, fallbackSoon: true } }));
  expect(rendered).toContain("Scheduled at this attempt");
  expect(rendered).toContain("Applied tiersoon");
  expect(rendered).toContain("without a usable urgency verdict");
  expect(text(DecisionScheduling({ scheduling: { status: "unscheduled" } }))).toContain("No schedule applied at this attempt");
});
it("exposes captured scheduling policy and distinguishes the proposal from coalesced work", () => {
  const scheduling = { status: "scheduled", policy: { immediateThreshold: 0.8, soonThreshold: 0.3, soonDelayMs: 60_000, routineDelayMs: 300_000 }, proposed: { tier: "routine", dueAt: 200 }, applied: { tier: "soon", dueAt: 100 } };
  const rendered = text(DecisionScheduling({ scheduling }));
  expect(rendered).toContain("Immediate ≥ 0.80; Soon ≥ 0.30; otherwise Routine");
  expect(rendered).toContain("Configured delays");
  expect(rendered).toContain("Proposed scheduleroutine");
  expect(rendered).toContain("Applied tiersoon");
  expect(text(DecisionScheduling({ scheduling: { ...scheduling, proposed: scheduling.applied } }))).not.toContain("Proposed schedule");
  const associated = text(KnowledgeDecisionCard({ decision: { ...decision, workId: "work-fixture" } }));
  expect(associated).toContain("Linked through scheduled work");
  expect(associated).not.toContain("Linked to this run when recorded");
});
it("labels retained redacted history separately from an exact snapshot", () => {
  const rendered = text(DecisionRetainedContent({ retained: { request: { state: { redacted: true } }, response: { score: 1.2 }, requestFidelity: "redacted", responseFidelity: "score-only" } }));
  expect(rendered).toContain("An exact snapshot is unavailable");
  expect(rendered).toContain("Source context was redacted");
  expect(rendered).toContain("Only the resulting score was retained");
  expect(rendered).not.toContain("summary above uses 0–1");
});


it("leads captured answers with their score and keeps long rubric text in a closed disclosure", () => {
  const tree = DecisionInputContent({ input: { availability: "available", request: { questions: { review: { instructions: "A detailed invented review question", criteria: ["Low", "High"] } } }, response: { answers: { review: { score: 1 } } } } });
  const rendered = text(tree);
  expect(rendered.indexOf("Model score: 1")).toBeLessThan(rendered.indexOf("A detailed invented review question"));
  const disclosure = hosts(tree).find((node) => node.type === "details" && text(node).includes("Question and criteria"));
  expect(disclosure.props.open).toBeUndefined();
  expect(hosts(disclosure).some((node) => node.type === "strong")).toBe(false);
});
