// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises plain-JS portal views from vitest.
//
// Every surface that shows a decision-model judgement renders it through the
// shared `DecisionCard`: each caller is mounted in a DOM with its data stubbed
// and must produce `.decision-card` elements carrying the scale icon, never a
// renderer of its own. A source scan backs this up for surfaces added later.
//
// All fixture data is invented; none comes from any real corpus.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getKnowledgeDecisionAudit: vi.fn(),
  getKnowledgePendingWork: vi.fn(),
  getCognitionObservation: vi.fn(),
  getKnowledgeBatch: vi.fn(),
  getDocumentSummariesBulk: vi.fn(),
  getKnowledgeNode: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({ ...(await importOriginal()), ...api }));

import { DecisionSection } from "../views/cognition.js";
import { KnowledgeDecisionAudit } from "../views/knowledge-decision-audit.js";
import { DecisionContextDetails } from "../views/knowledge-decision-context.js";
import { PendingWorkDetails } from "../views/knowledge-pending-details.js";
import { ObservationDetail } from "../views/cognition-observations.js";
import { BatchDetail } from "../views/cognition-maintenance.js";

const ledger = (over = {}) => ({
  id: "dec_ledger", purpose: "task-check", lane: "same_task", verdict: "pass", score: 3, threshold: 2,
  modelId: "jev-test", rubricVersion: "task-check-v1", documentId: null, subjectDocumentId: null,
  inheritedFromParent: false, subjectDoc: null, reusedFrom: null, recordId: "loop_fixture", enforced: true,
  error: null, latencyMs: 20, inputTokens: 90, createdAt: "2026-10-01T09:00:00.000Z", runId: "run_fixture",
  inputInspection: true, ...over,
});
const knowledge = (over = {}) => ({
  id: "dec_knowledge", kind: "knowledge", purpose: "review", scoreScale: "normalized-0-1", score: 0.5,
  threshold: null, recommendation: null, association: "recorded", modelId: "jev-test",
  rubricVersion: "knowledge-review-timing-v4", createdAt: 1_790_000_000_000, latencyMs: 12, inputTokens: 40,
  nodeId: "wiki_fixture", batchId: "batch_fixture", inputInspection: true, ...over,
});

let host, originalDocument, originalWindow;
const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const mount = async (vnode) => {
  await act(async () => { render(vnode, host); });
  await flush();
};
/** Open every closed disclosure, the way an operator expands a section. */
const openAll = async () => {
  for (const details of [...host.querySelectorAll("details:not([open])")]) {
    if (details.classList.contains("decision-card")) continue;
    details.setAttribute("open", "");
    details.open = true;
    await act(async () => { details.dispatchEvent(new window.Event("toggle")); });
  }
  await flush();
};
const cards = () => [...host.querySelectorAll(".decision-card")];
const expectShared = (ids) => {
  expect(cards().map((card) => card.getAttribute("data-decision-id"))).toEqual(ids);
  for (const card of cards())
    expect(card.querySelector(".decision-card-head svg.decision-icon")?.getAttribute("aria-label")).toBe("Decision model");
};

beforeEach(() => {
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = parsed.document.querySelector("#root");
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
});

describe("every decision surface renders the shared card", () => {
  it("a run's decision-model section", async () => {
    await mount(h(DecisionSection, { decisions: [ledger(), ledger({ id: "dec_two", lane: "adds_new" })] }));
    expectShared(["dec_ledger", "dec_two"]);
  });

  it("the decision audit list", async () => {
    api.getKnowledgeDecisionAudit.mockResolvedValue({ items: [{ ...ledger(), kind: "legacy" }, knowledge()], hasMore: false, nextCursor: null });
    await mount(h(KnowledgeDecisionAudit, {}));
    await openAll();
    expectShared(["dec_ledger", "dec_knowledge"]);
    expect(host.querySelector(".decision-card--compact")).not.toBeNull();
    const options = [...host.querySelectorAll("option")].map((option) => option.getAttribute("value"));
    expect(options).toEqual(expect.arrayContaining(["task-check", "observation-salience", "mention-worth", "find-route"]));
  });

  it("a knowledge page's or batch input's decision details", async () => {
    await mount(h(DecisionContextDetails, { contextKey: "wiki_fixture", decisions: [knowledge()] }));
    await openAll();
    expectShared(["dec_knowledge"]);
  });

  it("pending work's decision details", async () => {
    api.getKnowledgePendingWork.mockResolvedValue({
      items: [{ id: "work_fixture", dueAt: 1_790_000_000_000, subjectRef: { kind: "wiki", id: "wiki_fixture", title: "Garden plan" }, decisions: { items: [knowledge({ purpose: "impact" })], truncated: false } }],
      hasMore: false, nextCursor: null,
    });
    await mount(h(PendingWorkDetails, { group: { reason: "change", tier: "routine" } }));
    await openAll();
    expectShared(["dec_knowledge"]);
  });

  it("an observation's salience judgements", async () => {
    api.getCognitionObservation.mockResolvedValue({
      observation: { id: "obs_fixture", summary: "The bike service is due", why: "", state: "open", citations: [], claims: [], scores: null, notedScores: null, createdAt: "2026-10-01T09:00:00.000Z" },
      relatedLoops: [],
      decisions: [ledger({ id: "dec_salience", purpose: "observation-salience", lane: "recheck", recordId: "obs_fixture" })],
      provenance: null,
    });
    await mount(h(ObservationDetail, { id: "obs_fixture" }));
    expectShared(["dec_salience"]);
  });

  it("a maintenance batch's other checks", async () => {
    api.getKnowledgeBatch.mockResolvedValue({ status: "completed", tier: "routine", reasons: [], frontier: [], decisions: { items: [knowledge({ purpose: "urgency" })], truncated: false } });
    api.getDocumentSummariesBulk.mockResolvedValue({ docs: {} });
    await mount(h(BatchDetail, { id: "batch_fixture" }));
    expectShared(["dec_knowledge"]);
  });
});

describe("no second decision renderer", () => {
  it("keeps the decision card's markup in the shared component alone", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".js")) files.push(path);
      }
    };
    walk(root);
    const offenders = files
      .filter((path) => !path.endsWith(join("components", "decision-card.js")))
      .filter((path) => /class="(cognition-decision|decision-card)(-head)?["\s]|cognition-decision-bar-fill|decision-verdict/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });
});
