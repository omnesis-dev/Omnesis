// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal component from vitest.
//
// The one decision card: each purpose's wording, both ledgers' scores, the
// compact and full layouts, and the request/answer views. Function components
// are expanded into host nodes; the lazy payload loader owns hooks and is left
// unexpanded (it is mounted in browser coverage).
//
// All fixture data is invented; none comes from any real corpus.

import { describe, expect, it } from "vitest";
import {
  DecisionCard,
  DecisionIcon,
  DecisionInspection,
  DecisionList,
  DecisionPayload,
  DecisionPayloadLoader,
  DecisionScheduling,
  DECISION_PURPOSES,
  decisionView,
} from "./decision-card.js";

function hosts(value, out = []) {
  if (value == null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((entry) => hosts(entry, out));
    return out;
  }
  if (typeof value.type === "function") {
    if (value.type === DecisionPayloadLoader) {
      out.push({ type: "loader", props: value.props });
      return out;
    }
    return hosts(value.type(value.props ?? {}), out);
  }
  out.push(value);
  hosts(value.props?.children, out);
  return out;
}
function text(value) {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object") return String(value);
  if (value.type === DecisionPayloadLoader) return "";
  return text(typeof value.type === "function" ? value.type(value.props ?? {}) : value.props?.children);
}
const flat = (tree) => text(tree).replace(/\s+/g, " ").trim();

const CRITERIA = [
  "Nothing: a newsletter or a promotion.",
  "A minor record: an automated notice about the recipient's own account.",
  "Worth recording: a dated event or a request made to them.",
  "Important: correspondence with a person they know.",
];
const REQUEST = {
  model: "jev-1.13.0",
  state: { subject: "your weekly digest is here", from: "news@example.com", body: "Ten new templates this week." },
  questions: { worth_score: { type: "score", instructions: "How much would an assistant want to record from this email?", criteria: CRITERIA } },
};
const RESPONSE = {
  model: "jev-1.13.0",
  answers: { worth_score: { type: "score", score: 0.21, confidence: 0.83, probabilities: { "0": 0.82, "1": 0.15, "2": 0.02, "3": 0.01 } } },
};

/** A run-ledger decision as the run detail serves it. */
function ledger(over = {}) {
  return {
    id: "dec_1", purpose: "worth-gate", lane: "bootstrap", verdict: "skip", score: 0.21, threshold: 1.08,
    modelId: "jev-1.13.0", rubricVersion: "email-worth-v1", documentId: "doc-mail", subjectDocumentId: "doc-mail",
    inheritedFromParent: false, subjectDoc: { id: "doc-mail", title: "your weekly digest is here", sourceType: null },
    reusedFrom: null, recordId: null, enforced: true, error: null, latencyMs: 412, inputTokens: 356,
    createdAt: "2026-09-20T10:00:00.000Z", runId: "run_1", inputInspection: true, ...over,
  };
}
/** A knowledge-ledger decision as the audit serves it. */
function knowledge(over = {}) {
  return {
    id: "decision-fixture", kind: "knowledge", purpose: "discovery", scoreScale: "normalized-0-1",
    score: 0.13, threshold: 0.25, recommendation: "skip", association: "recorded",
    modelId: "decision-model", rubricVersion: "example-rubric", createdAt: 1_700_000_000_000,
    latencyMs: 0, inputTokens: 0, nodeId: "source:document-fixture", batchId: "batch-fixture", inputInspection: true, ...over,
  };
}

describe("the decision icon", () => {
  it("is the Lucide scale glyph with an accessible label, stroked in the theme's colour", () => {
    const svg = DecisionIcon();
    expect(svg.type).toBe("svg");
    expect(svg.props["aria-label"]).toBe("Decision model");
    expect(svg.props.role).toBe("img");
    expect(svg.props.stroke).toBe("currentColor");
    expect(hosts(svg).filter((n) => n.type === "path")).toHaveLength(5);
  });

  it("leads the header of every card, in both layouts", () => {
    for (const layout of ["full", "compact"])
      for (const decision of [ledger(), knowledge()]) {
        const tree = DecisionCard({ decision, layout });
        const head = hosts(tree).find((n) => String(n.props?.class ?? "").includes("decision-card-head"));
        expect(head.props.children.flat().find((child) => child?.type === DecisionIcon)).toBeDefined();
      }
  });
});

describe("run-ledger decisions", () => {
  it("shows a skip with its score against the threshold, model, latency, tokens and rubric", () => {
    const rendered = flat(DecisionCard({ decision: ledger() }));
    expect(rendered).toContain("Worth admission");
    expect(rendered).toContain("skip");
    expect(rendered).toContain("score 0.21 < threshold 1.08");
    expect(rendered).toContain("Gate declined admission for this attempt");
    expect(rendered).toContain("jev-1.13.0");
    expect(rendered).toContain("412 ms");
    expect(rendered).toContain("356");
    expect(rendered).toContain("email-worth-v1");
    expect(rendered).toContain("your weekly digest is here");
    expect(rendered).toContain("View run");
  });

  it("names the document an attachment was judged by", () => {
    const rendered = flat(DecisionCard({ decision: ledger({ verdict: "pass", score: 2.4, documentId: "doc-attachment", subjectDocumentId: "doc-parent", inheritedFromParent: true, subjectDoc: { id: "doc-parent", title: "Venue booking for the Q4 review" } }) }));
    expect(rendered).toContain("score 2.40 ≥ threshold 1.08");
    expect(rendered).toContain("Admitted for agent review");
    expect(rendered).toContain("the document that contains it");
    expect(rendered).toContain("Venue booking for the Q4 review");
    expect(rendered).toContain("inherits its email's judgement");
  });

  it("points a reused decision at the one it repeated, with no payload of its own", () => {
    const tree = DecisionCard({ decision: ledger({ reusedFrom: "dec_0", latencyMs: null, inputTokens: null }) });
    expect(flat(tree)).toContain("dec_0");
    expect(flat(tree)).toContain("no model call was made");
    expect(hosts(tree).some((n) => n.type === "loader")).toBe(false);
  });

  it("shows why the decision model was unavailable", () => {
    const tree = DecisionCard({ decision: ledger({ verdict: "unavailable", score: null, error: "TypeSafe returned HTTP 503" }) });
    expect(flat(tree)).toContain("Admitted for agent review without a verdict");
    expect(flat(tree)).toContain("No score");
    expect(hosts(tree).find((n) => String(n.props?.class ?? "").includes("decision-card-error")).props.children).toContain("TypeSafe returned HTTP 503");
  });

  it("never reads a decision of an unknown purpose as a worth-gate verdict", () => {
    const rendered = flat(DecisionCard({ decision: ledger({ purpose: "future-check", verdict: "pass" }) }));
    expect(rendered).toContain("future-check");
    expect(rendered).toContain("pass");
    expect(rendered).not.toContain("Admitted for agent review");
  });

  it("distinguishes a shadow record-check rejection from a blocked save, and names the record", () => {
    const check = (over) => ledger({ purpose: "record-check", recordId: "ta_example", threshold: 0.81, score: 0.12, ...over });
    const shadow = flat(DecisionCard({ decision: check({ enforced: false }) }));
    expect(shadow).toContain("would reject");
    expect(shadow).toContain("did not block saving");
    expect(shadow).toContain("ta_example");
    const enforced = flat(DecisionCard({ decision: check({ enforced: true }) }));
    expect(enforced).toContain("Gate blocked this save attempt");
    expect(flat(DecisionCard({ decision: check({ verdict: "pass", score: 2.6 }) }))).toContain("Gate allowed this record");
    expect(flat(DecisionCard({ decision: check({ verdict: "unavailable", score: null }) }))).toContain("Allowed without a verdict");
  });

  it("reads each task-check question in its own terms and links the task", () => {
    const task = (lane, verdict) => DecisionCard({ decision: ledger({ purpose: "task-check", lane, verdict, recordId: "loop_fixture", documentId: null, subjectDocumentId: null, subjectDoc: null }) });
    expect(flat(task("same_task", "skip"))).toContain("different task");
    expect(flat(task("same_task", "skip"))).toContain("waits for the user");
    expect(flat(task("same_task", "pass"))).toContain("same task");
    expect(flat(task("adds_new", "skip"))).toContain("only repeats the task's history");
    expect(flat(task("adds_new", "unavailable"))).toContain("the note was recorded");
    const link = hosts(task("same_task", "pass")).find((n) => n.type === "a" && String(n.props.href).includes("loop"));
    expect(link).toBeDefined();
    expect(flat(task("same_task", "pass"))).not.toContain("About");
  });

  it("covers the decisions made outside any Brain run", () => {
    const mention = flat(DecisionCard({ decision: ledger({ purpose: "mention-worth", lane: "date-mentions", verdict: "skip", runId: null }) }));
    expect(mention).toContain("Date mention worth");
    expect(mention).toContain("left out of date queries");
    expect(mention).toContain("Made outside any Brain run");
    const route = flat(DecisionCard({ decision: ledger({ purpose: "find-route", lane: "agentic", verdict: "pass", score: null, threshold: 0, runId: null, subjectDoc: null, documentId: null, subjectDocumentId: null }) }));
    expect(route).toContain("Search routing");
    expect(route).toContain("agent research");
    expect(route).not.toContain("No score");
    const salience = flat(DecisionCard({ decision: ledger({ purpose: "observation-salience", lane: "recheck", verdict: "pass", recordId: "obs_fixture" }) }));
    expect(salience).toContain("Belongs in the morning brief");
    expect(salience).toContain("obs_fixture");
  });

  it("keeps a pruned run's judgement inspectable without inventing a transcript link", () => {
    const tree = DecisionCard({ decision: { ...ledger(), kind: "legacy", runAvailable: false } });
    expect(flat(tree)).toContain("No longer retained");
    expect(hosts(tree).some((n) => n.type === "a" && String(n.props.href).includes("/runs/"))).toBe(false);
    expect(hosts(tree).some((n) => n.type === "loader")).toBe(true);
  });

  it("loads the request and answer on demand from the run ledger", () => {
    const loader = hosts(DecisionCard({ decision: ledger() })).find((n) => n.type === "loader");
    expect(loader.props).toEqual({ id: "dec_1", knowledge: false });
  });

  it("shows a retained copy inline when the decision is served with one and no inspection", () => {
    const tree = DecisionCard({ decision: ledger({ inputInspection: false, request: REQUEST, response: RESPONSE }) });
    const rendered = flat(tree);
    expect(rendered).toContain("news@example.com");
    expect(rendered).toContain("confidence 83%");
    expect(rendered).toContain("retained decision ledger");
  });
});

describe("knowledge-ledger decisions", () => {
  it("shows normalized scores and a recommendation without presenting it as an actual skip", () => {
    const rendered = flat(DecisionCard({ decision: knowledge() }));
    expect(rendered).toContain("Discovery admission");
    expect(rendered).toContain("score 0.13 < threshold 0.25 · scale 0–1");
    expect(rendered).toContain("skip");
    expect(rendered).toContain("Other work requirements can override this recommendation.");
    expect(rendered).toContain("Linked to this run when recorded");
    expect(rendered).toContain("0 ms");
    expect(rendered).toContain("View batch");
  });

  it("distinguishes unavailable judgements and historical matching", () => {
    const rendered = flat(DecisionCard({ decision: knowledge({ score: null, recommendation: "unavailable", association: "historical-matched" }) }));
    expect(rendered).toContain("No score");
    expect(rendered).toContain("unavailable");
    expect(rendered).toContain("Historical match");
  });

  it("does not invent thresholds or recommendations for timing judgements", () => {
    const rendered = flat(DecisionCard({ decision: knowledge({ purpose: "review", threshold: null, recommendation: null }) }));
    expect(rendered).toContain("Review timing");
    expect(rendered).not.toContain("threshold");
    expect(rendered).not.toContain("override this recommendation");
  });

  it("shows an explicit engine bypass without a fabricated recommendation", () => {
    const rendered = flat(DecisionCard({ decision: knowledge({ score: null, modelId: "unavailable", recommendation: "unavailable", inputInspection: false, bypass: { reason: "request_budget_exceeded", inputBytes: 140000, budgetBytes: 131072 } }) }));
    expect(rendered).toContain("engine bypass");
    expect(rendered).toContain("No model call");
    expect(rendered).toContain("140000 input bytes / 131072 budget bytes");
    expect(rendered).not.toContain("override this recommendation");
  });

  it("names scheduled-work association and loads from the knowledge ledger", () => {
    const tree = DecisionCard({ decision: knowledge({ workId: "work-fixture" }) });
    expect(flat(tree)).toContain("Linked through scheduled work");
    expect(hosts(tree).find((n) => n.type === "loader").props).toEqual({ id: "decision-fixture", knowledge: true });
  });

  it("keeps model and subject metadata as inert text", () => {
    const tree = DecisionCard({ decision: knowledge({ modelId: "<script>untrusted</script>", nodeId: "javascript:untrusted" }) });
    expect(text(tree)).toContain("<script>untrusted</script>");
    expect(hosts(tree).some((n) => n.type === "script" || n.props?.dangerouslySetInnerHTML || String(n.props?.href ?? "").startsWith("javascript:"))).toBe(false);
  });
});

describe("layouts", () => {
  it("compact folds the card into a disclosure whose summary is the header", () => {
    const tree = DecisionCard({ decision: ledger(), layout: "compact" });
    expect(tree.type).toBe("details");
    const summary = hosts(tree).find((n) => n.type === "summary");
    expect(String(summary.props.class)).toContain("decision-card-head");
    expect(text(summary)).toContain("Worth admission");
    expect(text(summary)).toContain("skip");
  });

  it("full renders in place, and leaves the subject out when asked", () => {
    expect(DecisionCard({ decision: ledger() }).type).toBe("article");
    expect(flat(DecisionCard({ decision: ledger(), showSubject: false }))).not.toContain("your weekly digest is here");
  });

  it("lists decisions as compact cards and says only that none were recorded when empty", () => {
    const list = DecisionList({ decisions: [ledger(), knowledge()] });
    expect(hosts(list).filter((n) => n.type === "details" && String(n.props.class).includes("decision-card--compact"))).toHaveLength(2);
    const empty = flat(DecisionList({ decisions: [], audit: { truncated: true, legacyIncomplete: true } }));
    expect(empty).toContain("does not establish that a gate was bypassed");
    expect(empty).toContain("Additional recorded checks");
    expect(empty).toContain("Historical associations are incomplete");
  });

  it("offers every purpose the gateway records", () => {
    expect(DECISION_PURPOSES.map(([value]) => value)).toEqual([
      "discovery", "impact", "review", "urgency", "worth-gate", "record-check", "task-check",
      "observation-salience", "mention-worth", "find-route",
    ]);
    expect(decisionView(ledger({ purpose: "find-route", lane: "direct", verdict: "pass" })).outcome.label).toBe("index search");
  });
});

describe("request and answer", () => {
  it("carries the state, the criteria levels and the answer's probabilities named by criterion", () => {
    const tree = DecisionPayload({ request: REQUEST, response: RESPONSE });
    const nodes = hosts(tree);
    const rendered = text(tree);
    expect(rendered).toContain("news@example.com");
    expect(rendered).toContain("How much would an assistant want to record");
    expect(nodes.filter((n) => n.type === "li")).toHaveLength(4);
    expect(rendered).toContain("confidence 83%");
    expect(nodes.filter((n) => n.props?.class === "cognition-decision-bar-fill").map((n) => n.props.style)).toEqual(["width:82%;", "width:15%;", "width:2%;", "width:1%;"]);
    expect(rendered).toContain("Nothing: a newsletter or a promotion.");
    expect(rendered).toContain(JSON.stringify({ request: REQUEST, response: RESPONSE }, null, 2));
  });

  it("labels retained, redacted and absent inputs without claiming exact capture", () => {
    const retained = flat(DecisionInspection({ data: { retained: { request: { state: { redacted: true } }, response: null, requestFidelity: "redacted", responseFidelity: "score-only" } } }));
    expect(retained).toContain("An exact snapshot is unavailable");
    expect(retained).toContain("Source context was redacted");
    expect(retained).toContain("Only the resulting score was retained");
    expect(retained).toContain("No model answer is retained");
    expect(flat(DecisionInspection({ data: { input: { availability: "unavailable" } } }))).toContain("not been reconstructed");
    expect(flat(DecisionInspection({ data: { input: { availability: "oversized" } } }))).toContain("inspection limit");
    expect(flat(DecisionInspection({ data: { input: { availability: "available", request: REQUEST, response: null, error: "Recorded transport failure" } } }))).toContain("Recorded failure");
  });

  it("keeps a hostile payload inert", () => {
    const tree = DecisionPayload({ request: { state: "<script>payload</script>", questions: [] }, response: { answers: [0.4] } });
    expect(text(tree)).toContain("<script>payload</script>");
    expect(hosts(tree).some((n) => n.type === "script" || n.props?.dangerouslySetInnerHTML)).toBe(false);
  });
});

describe("urgency scheduling", () => {
  it("labels the applied schedule as an attempt snapshot and distinguishes the proposal", () => {
    expect(flat(DecisionScheduling({ scheduling: { status: "scheduled", applied: { tier: "soon", dueAt: 1_700_000_000_000 }, fallbackSoon: true } }))).toContain("without a usable urgency verdict");
    expect(flat(DecisionScheduling({ scheduling: { status: "unscheduled" } }))).toContain("No schedule applied at this attempt");
    const scheduling = { status: "scheduled", policy: { immediateThreshold: 0.8, soonThreshold: 0.3, soonDelayMs: 60_000, routineDelayMs: 300_000 }, proposed: { tier: "routine", dueAt: 200 }, applied: { tier: "soon", dueAt: 100 } };
    const rendered = flat(DecisionScheduling({ scheduling }));
    expect(rendered).toContain("Immediate ≥ 0.80; Soon ≥ 0.30; otherwise Routine");
    expect(rendered).toContain("Proposed schedule");
    expect(flat(DecisionScheduling({ scheduling: { ...scheduling, proposed: scheduling.applied } }))).not.toContain("Proposed schedule");
  });
});
