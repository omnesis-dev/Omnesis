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
import { DecisionCard } from "../components/decision-card.js";

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

  it("heads the run's judgements and renders each through the shared decision card", () => {
    const section = cognition.DecisionSection({ decisions: [decision(), decision({ id: "dec_2" })] });
    expect(flatText(section)).toContain("Decision model (2)");
    const cards = section.flat(Infinity).filter((node) => node?.type === DecisionCard);
    expect(cards.map((card) => card.props.decision.id)).toEqual(["dec_1", "dec_2"]);
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
