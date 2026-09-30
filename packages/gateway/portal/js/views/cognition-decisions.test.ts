// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest;
// the module is untyped browser code, so type-checking is off here.
//
// How the runs page shows the decision model: the gated status a worth-gate
// skip gives a run, the list's gate marker, and the run detail's Decision
// model section. Same headless VNode-expansion harness as
// cognition-doclist.test.ts — function components are expanded into a flat
// host-element list and asserted. A synthetic gateway runs no worth gate, so
// this is where the populated panel is checked at all.
//
// All fixture data is invented; none comes from any real corpus.

import { describe, expect, it } from "vitest";
import * as cognition from "./cognition.js";

function expandToHostNodes(vnode, out = []) {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const v of vnode) expandToHostNodes(v, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number") return out;
  if (!vnode.type) return out;
  if (typeof vnode.type === "function") return expandToHostNodes(vnode.type(vnode.props ?? {}), out);
  out.push({
    tag: vnode.type,
    class: vnode.props?.class ?? "",
    href: vnode.props?.href,
    style: vnode.props?.style ?? "",
    text: collectText(vnode.props?.children),
  });
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

function collectText(children) {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type && typeof children.type !== "function") return collectText(children.props?.children);
  return "";
}

const flatText = (vnode) =>
  expandToHostNodes(vnode).map((n) => n.text).join(" ").replace(/\s+/g, " ").trim();

const CRITERIA = [
  "Nothing: a newsletter or a promotion.",
  "A minor record: an automated notice about the recipient's own account.",
  "Worth recording: a dated event or a request made to them.",
  "Important: correspondence with a person they know.",
];

const REQUEST = {
  model: "jev-1.13.0",
  state: { subject: "your weekly digest is here", from: "news@example.com", body: "Ten new templates this week." },
  questions: {
    worth_score: { type: "score", instructions: "How much would an assistant want to record from this email?", criteria: CRITERIA },
  },
};

const RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    worth_score: {
      type: "score",
      score: 0.21,
      confidence: 0.83,
      probabilities: { "0": 0.82, "1": 0.15, "2": 0.02, "3": 0.01 },
    },
  },
};

function decision(over = {}) {
  return {
    id: "dec_1",
    purpose: "worth-gate",
    lane: "bootstrap",
    verdict: "skip",
    score: 0.21,
    threshold: 1.08,
    modelId: "jev-1.13.0",
    rubricVersion: "email-worth-v1",
    documentId: "doc-mail",
    subjectDocumentId: "doc-mail",
    inheritedFromParent: false,
    subjectDoc: { id: "doc-mail", title: "your weekly digest is here", sourceType: null },
    reusedFrom: null,
    recordId: null,
    enforced: true,
    error: null,
    latencyMs: 412,
    inputTokens: 356,
    createdAt: "2026-09-20T10:00:00.000Z",
    request: REQUEST,
    response: RESPONSE,
    ...over,
  };
}

const settled = (over = {}) => ({
  id: "run_1",
  kind: "bootstrap",
  status: "completed",
  running: false,
  attempts: 1,
  enqueuedAt: "2026-09-20T09:59:00.000Z",
  lastAttemptAt: "2026-09-20T10:00:00.000Z",
  completedAt: "2026-09-20T10:00:01.000Z",
  nextAttemptAt: null,
  trigger: { type: "bootstrap", docId: "doc-mail" },
  usage: null,
  ...over,
});

describe("runs list — the worth gate", () => {
  it("a completed run the gate skipped reads as gated, not completed", () => {
    expect(cognition.runDisplayStatus(settled({ gateVerdict: "skip" }))).toBe("gated");
    expect(cognition.runDisplayStatus(settled({ gateVerdict: "pass" }))).toBe("completed");
    expect(cognition.runDisplayStatus(settled({ gateVerdict: null }))).toBe("completed");
    // A failed run stays failed whatever its verdict.
    expect(cognition.runDisplayStatus(settled({ status: "failed", gateVerdict: "unavailable" }))).toBe("failed");
    const now = Date.parse("2026-09-20T12:00:01.000Z");
    expect(cognition.runTimeLabel(settled({ gateVerdict: "skip" }), now).label).toBe("gated 2h ago");
  });

  it("renders the Gated chip on the row", () => {
    const nodes = expandToHostNodes(cognition.RunListRow({ run: settled({ gateVerdict: "skip" }), selectedId: null, nowMs: Date.now() }));
    const pill = nodes.find((n) => n.class.includes("debug-pill"));
    expect(pill.text).toBe("gated");
    expect(nodes.find((n) => n.class.includes("cognition-gate-marker"))).toBeUndefined();
  });

  it("marks a pass and an unavailable gate beside the kind", () => {
    const pass = expandToHostNodes(cognition.RunListRow({ run: settled({ gateVerdict: "pass" }), selectedId: null, nowMs: Date.now() }));
    expect(pass.find((n) => n.class.includes("debug-pill")).text).toBe("completed");
    expect(pass.find((n) => n.class.includes("cognition-gate-marker")).text).toBe("worth a run");
    const down = expandToHostNodes(cognition.RunListRow({ run: settled({ gateVerdict: "unavailable" }), selectedId: null, nowMs: Date.now() }));
    expect(down.find((n) => n.class.includes("cognition-gate-marker--warn")).text).toBe("not judged");
  });
});

describe("run detail — the Decision model section", () => {
  it("is absent when no decision was made", () => {
    expect(expandToHostNodes(cognition.DecisionSection({ decisions: [] }))).toHaveLength(0);
  });

  it("shows a skip with its score against the threshold, model, latency, tokens and rubric", () => {
    const text = flatText(cognition.DecisionSection({ decisions: [decision()] }));
    expect(text).toContain("Decision model");
    expect(text).toContain("skip");
    expect(text).toContain("score 0.21 < threshold 1.08");
    expect(text).toContain("Not worth a run");
    expect(text).toContain("jev-1.13.0");
    expect(text).toContain("412 ms");
    expect(text).toContain("356");
    expect(text).toContain("email-worth-v1");
    expect(text).toContain("your weekly digest is here");
  });

  it("carries the exact request — state and the four criteria levels — and the answer's probabilities", () => {
    const nodes = expandToHostNodes(cognition.DecisionCard({ decision: decision() }));
    const summaries = nodes.filter((n) => n.tag === "summary").map((n) => n.text);
    expect(summaries).toEqual(["Request sent", "Answer"]);
    const text = nodes.map((n) => n.text).join(" ");
    expect(text).toContain("news@example.com");
    expect(text).toContain("Ten new templates this week.");
    expect(text).toContain("How much would an assistant want to record");
    const levels = nodes.find((n) => n.tag === "ol" && n.class.includes("cognition-decision-criteria"));
    expect(levels).toBeDefined();
    expect(nodes.filter((n) => n.tag === "li")).toHaveLength(4);
    expect(text).toContain("confidence 83%");
    const bars = nodes.filter((n) => n.class === "cognition-decision-bar-fill");
    expect(bars.map((b) => b.style)).toEqual(["width:82%;", "width:15%;", "width:2%;", "width:1%;"]);
    // Each probability is named by the criterion it scores.
    expect(text).toContain("Nothing: a newsletter or a promotion.");
    expect(text).toContain("82%");
  });

  it("names the document an attachment was judged by", () => {
    const text = flatText(
      cognition.DecisionCard({
        decision: decision({
          verdict: "pass",
          score: 2.4,
          documentId: "doc-attachment",
          subjectDocumentId: "doc-parent",
          inheritedFromParent: true,
          subjectDoc: { id: "doc-parent", title: "Venue booking for the Q4 review", sourceType: null },
        }),
      }),
    );
    expect(text).toContain("pass");
    expect(text).toContain("score 2.40 ≥ threshold 1.08");
    expect(text).toContain("the document that contains it");
    expect(text).toContain("Venue booking for the Q4 review");
    expect(text).toContain("inherits its email's judgement");
  });

  it("points a reused decision at the one it repeated, with no request of its own", () => {
    const nodes = expandToHostNodes(
      cognition.DecisionCard({ decision: decision({ reusedFrom: "dec_0", request: null, response: null, latencyMs: null, inputTokens: null }) }),
    );
    const text = nodes.map((n) => n.text).join(" ");
    expect(text).toContain("dec_0");
    expect(text).toContain("no model call was made");
    expect(nodes.filter((n) => n.tag === "summary")).toHaveLength(0);
  });

  it("shows why the decision model was unavailable, and the request that failed", () => {
    const nodes = expandToHostNodes(
      cognition.DecisionCard({
        decision: decision({ verdict: "unavailable", score: null, response: null, error: "TypeSafe returned HTTP 503" }),
      }),
    );
    const text = nodes.map((n) => n.text).join(" ");
    expect(text).toContain("unavailable");
    expect(text).toContain("went ahead unjudged");
    expect(nodes.find((n) => n.class.includes("debug-error")).text).toContain("TypeSafe returned HTTP 503");
    expect(nodes.filter((n) => n.tag === "summary").map((n) => n.text)).toEqual(["Request sent"]);
  });

  it("never reads a decision of an unknown purpose as a worth-gate verdict", () => {
    const text = flatText(cognition.DecisionCard({ decision: decision({ purpose: "future-check", verdict: "pass" }) }));
    expect(text).toContain("pass");
    expect(text).not.toContain("Worth a run");
    expect(text).toContain("future-check");
  });

  describe("a record check", () => {
    const recordCheck = (over = {}) =>
      decision({
        id: "dec_rc",
        purpose: "record-check",
        verdict: "skip",
        score: 0.12,
        threshold: 0.81,
        rubricVersion: "record-belongs-v1",
        recordId: "ta_example",
        enforced: false,
        subjectDoc: { id: "doc-mail", title: "Studio Northstar opens a new cycle room", sourceType: null },
        request: {
          model: "jev-1.13.0",
          state: {
            record_type: "timeline",
            record_kind: "event",
            record: "Studio Northstar says its new cycle room opens on 3 October 2026.",
          },
          questions: { belongs: { type: "score", instructions: "How much does `record` belong?", criteria: CRITERIA } },
        },
        response: { model: "jev-1.13.0", answers: { belongs: { type: "score", score: 0.12 } } },
        ...over,
      });

    it("shows the record it judged, its id and the document it came from", () => {
      const text = flatText(cognition.DecisionCard({ decision: recordCheck() }));
      expect(text).toContain("record check · bootstrap");
      expect(text).toContain("Studio Northstar says its new cycle room opens on 3 October 2026.");
      expect(text).toContain("ta_example");
      expect(text).toContain("Studio Northstar opens a new cycle room");
      expect(text).not.toContain("the document that contains it");
    });

    it("says an observing skip saved the record anyway, and an enforced one did not", () => {
      const observing = flatText(cognition.DecisionCard({ decision: recordCheck() }));
      expect(observing).toContain("would drop");
      expect(observing).toContain("saved anyway");
      const enforced = flatText(cognition.DecisionCard({ decision: recordCheck({ enforced: true }) }));
      expect(enforced).toContain("dropped");
      expect(enforced).toContain("the record was not saved");
      expect(enforced).not.toContain("saved anyway");
    });

    it("still names the record id and its document once retention cleared the request", () => {
      const text = flatText(cognition.DecisionCard({ decision: recordCheck({ request: null, response: null }) }));
      expect(text).toContain("ta_example");
      expect(text).toContain("Studio Northstar opens a new cycle room");
      expect(text).not.toContain("undefined");
    });

    it("reads a pass as kept and an outage as saved unjudged", () => {
      expect(flatText(cognition.DecisionCard({ decision: recordCheck({ verdict: "pass", score: 2.6 }) }))).toContain(
        "the record was kept",
      );
      expect(
        flatText(cognition.DecisionCard({ decision: recordCheck({ verdict: "unavailable", score: null, response: null }) })),
      ).toContain("the record was saved unjudged");
    });
  });

  it("says plainly that a gated run has no transcript because no agent turn ran", () => {
    expect(flatText(cognition.TranscriptSlot({ id: "run_1", transcripts: [], gated: true }))).toContain(
      "The decision model skipped this document, so no agent turn ran",
    );
    expect(flatText(cognition.TranscriptSlot({ id: "run_1", transcripts: [], gated: false }))).toBe(
      "No transcript stored for this run.",
    );
  });
});
