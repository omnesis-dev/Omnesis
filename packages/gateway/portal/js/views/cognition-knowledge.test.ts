// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — structural checks for the plain-JS portal renderer.
import { afterEach, expect, it, vi } from "vitest";
// Actual sanitizer and browser interactions are exercised by e2e/knowledge.spec.mts.
vi.mock("./knowledge-claim-markdown.js", async (importOriginal) => ({
  ...(await importOriginal()),
  renderKnowledgeMarkdown: vi.fn(() => ({ html: "<p>Sanitized prose</p>", targets: new Map() })),
}));
import { renderKnowledgeMarkdown } from "./knowledge-claim-markdown.js";
import {
  KnowledgeDetail,
  KnowledgeStatus,
  knowledgeReferenceHref,
  knowledgeSelectionHref,
  navigateKnowledgeSelection,
} from "./cognition-knowledge.js";
import { resolveSection } from "./cognition.js";
import { ConnectionClaims } from "./knowledge-connections.js";
import { KnowledgeBadge } from "./knowledge-reader.js";
function hosts(value, out = []) {
  if (value == null || typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    value.forEach((child) => hosts(child, out));
    return out;
  }
  if (typeof value !== "object") return out;
  if (typeof value.type === "function") return hosts(value.type(value.props), out);
  out.push(value);
  hosts(value.props?.children, out);
  return out;
}
function text(value) {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object") return String(value);
  if (typeof value.type === "function") return text(value.type(value.props));
  return text(value.props?.children);
}
const unsafe = '<script>alert("untrusted")</script>';
const node = {
  id: "root",
  kind: "root",
  title: "Orientation",
  revision: 3,
  meaningRevision: 2,
  validity: "stale",
  plainText: unsafe,
  markdown: `<claim id="date" refs="source:fixture">${unsafe}</claim>`,
  claims: [
    {
      id: "date",
      text: unsafe,
      verification: "stale",
      supportLogic: "all",
      modality: "reported",
      epistemicStatus: "disputed",
      attribution: "Fictional workshop organizer",
    },
  ],
  dependencies: [
    { claimId: "date", ref: "source:fixture", relation: "supports", inputVersion: "v2" },
  ],
  links: [{ fromId: "root", toId: "project", kind: "related_to" }],
  canonicalFields: {},
  metadata: {},
};
it("preserves experimental routes and rejects unsafe reference protocols", () => {
  expect(resolveSection("knowledge")).toBe("knowledge");
  expect(knowledgeReferenceHref("source:document/one#evidence:passage")).toBe(
    "/portal/doc/document%2Fone?evidence=passage",
  );
  expect(knowledgeReferenceHref("wiki:project#claim:date")).toBe(
    "/portal/debug/cognition/knowledge/project?claim=date",
  );
  expect(knowledgeReferenceHref("javascript:alert(1)")).toBeNull();
});
it("uses the sanitized internal-link-aware Markdown reader", () => {
  const tree = KnowledgeDetail({ node });
  const elements = hosts(tree);
  expect(renderKnowledgeMarkdown).toHaveBeenCalledWith(unsafe, [], {});
  expect(elements.some((element) => element.type === "script")).toBe(false);
  expect(text(tree)).toContain("Some context needs another look");
  expect(text(tree)).toContain("0 of 1 claims verified");
  expect(text(tree)).not.toContain("Canonical fields");
  expect(
    elements
      .filter((element) => element.type === "button")
      .map((element) => element.props["aria-pressed"]),
  ).toEqual([true, false, false, false]);
});
it("retains the page title unless a loaded canonical outcome already supplies it", () => {
  const loop = { ...node, kind: "loop", title: "Prepare workshop materials" };
  const headings = (hideTitle = false) =>
    hosts(KnowledgeDetail({ node: loop, hideTitle }))
      .filter((element) => element.type === "h2")
      .map(text);
  expect(headings()).toContain(loop.title);
  expect(headings(true)).not.toContain(loop.title);
});
it("shows assertion uncertainty in Connections without repeating source links", () => {
  const tree = ConnectionClaims({
    node,
    selectedClaim: "date",
    onClaim: () => {},
    Badge: KnowledgeBadge,
  });
  const elements = hosts(tree);
  expect(text(tree)).toContain("Disputed");
  expect(text(tree)).toContain("Attributed to: Fictional workshop organizer");
  expect(
    elements.some((element) => element.type === "script" || element.props?.dangerouslySetInnerHTML),
  ).toBe(false);
  expect(elements.filter((element) => element.type === "a")).toHaveLength(0);
  expect(text(tree)).not.toContain("source:fixture");
});
it("keeps relationship navigation in Connections instead of a duplicate Overview list", () => {
  const tree = KnowledgeDetail({ node });
  expect(text(tree)).not.toContain("Connected pages");
  const labels = hosts(tree)
    .filter((element) => element.type === "button")
    .map(text);
  expect(labels).toEqual(["Overview", "Connections", "History", "Advanced"]);
});
it("keeps raw markup literal and exact revisions discoverable in Advanced", () => {
  const elements = hosts(KnowledgeDetail({ node, activeTab: "advanced" }));
  expect(elements.some((element) => element.type === "pre" && text(element).includes(unsafe))).toBe(
    true,
  );
  expect(
    elements.some((element) => element.type === "script" || element.props?.dangerouslySetInnerHTML),
  ).toBe(false);
  expect(text(elements)).toContain("meaning 2");
  expect(text(elements)).toContain("Not scheduled");
});
it("does not label a failed or loading history as an empty history", () => {
  expect(text(KnowledgeDetail({ node, activeTab: "history", historyLoading: true }))).not.toContain(
    "No previous versions",
  );
  expect(text(KnowledgeDetail({ node, activeTab: "history", historyError: true }))).not.toContain(
    "No previous versions",
  );
  expect(text(KnowledgeDetail({ node, activeTab: "history" }))).toContain("No previous versions");
});
it("describes queued and held maintenance honestly without inventing active progress", () => {
  const tree = KnowledgeStatus({
    status: {
      cascades: { pending: 7 },
      work: [
        {
          count: 2,
          status: "deferred",
          tier: "routine",
          reason: "source_changed",
          readiness: "pending_content",
          nextDueAt: 100,
        },
      ],
      coverage: [{ phase: "recent", status: "covered", count: 4 }],
    },
  });
  expect(text(tree)).toContain("Updates awaiting maintenance");
  expect(text(tree)).not.toContain("is being maintained");
  expect(text(tree)).toContain("Waiting for source content");
  expect(text(tree)).toContain("7 pending cascade steps");
  expect(text(tree)).toContain("2 deferred");
  expect(text(tree)).not.toContain("4 subjects");
  expect(
    hosts(tree).some((element) => element.props?.href === "/portal/debug/cognition/bootstrap"),
  ).toBe(true);
});

it("keeps library maintenance compact and links the dedicated queue view", () => {
  const tree = KnowledgeStatus({
    compact: true,
    status: { work: [{ status: "pending", count: 3 }], cascades: { pending: 2 } },
  });
  expect(text(tree)).toContain("3 queued");
  expect(text(tree)).not.toContain("Work queue");
  expect(hosts(tree).some((element) => element.type === "details")).toBe(false);
  expect(
    hosts(tree).some((element) => element.props?.href === "/portal/debug/cognition/maintenance"),
  ).toBe(true);
});

afterEach(() => vi.unstubAllGlobals());
it("selects library entries without leaving the document or changing the library filter", () => {
  expect(knowledgeSelectionHref("outcome/one")).toBe(
    "/portal/debug/cognition/knowledge/outcome%2Fone",
  );
  expect(knowledgeSelectionHref("outcome/one", "loop")).toBe(
    "/portal/debug/cognition/knowledge/outcome%2Fone?kind=loop",
  );
  expect(knowledgeSelectionHref(null, "wiki")).toBe("/portal/debug/cognition/knowledge?kind=wiki");
  const pushState = vi.fn(),
    dispatchEvent = vi.fn(),
    preventDefault = vi.fn();
  vi.stubGlobal("history", { pushState });
  vi.stubGlobal("window", { dispatchEvent });
  const href = knowledgeSelectionHref("project", "wiki");
  navigateKnowledgeSelection({
    button: 0,
    preventDefault,
    currentTarget: { getAttribute: () => href },
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(pushState).toHaveBeenCalledWith(null, "", href);
  expect(dispatchEvent).toHaveBeenCalledOnce();
});
it("leaves modified, middle-button and already handled library clicks to the browser", () => {
  for (const event of [
    { button: 1 },
    { button: 2 },
    { button: 0, metaKey: true },
    { button: 0, ctrlKey: true },
    { button: 0, shiftKey: true },
    { button: 0, altKey: true },
    { button: 0, defaultPrevented: true },
  ]) {
    const preventDefault = vi.fn();
    navigateKnowledgeSelection({ ...event, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  }
});
