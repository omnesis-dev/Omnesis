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
  PageCard,
  knowledgeReferenceHref,
  knowledgeSelectionHref,
  navigateKnowledgeSelection,
} from "./cognition-knowledge.js";
import { resolveSection } from "./cognition.js";
import { NodeReviewDetails } from "./knowledge-decision-context.js";
import { KnowledgeContent, KnowledgeProse } from "./knowledge-reader.js";
function hosts(value, out = []) {
  if (value == null || typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    value.forEach((child) => hosts(child, out));
    return out;
  }
  if (typeof value !== "object") return out;
  // Hook-driven content is exercised by the browser suite, not invoked outside Preact.
  if ((value.type === KnowledgeContent || value.type === NodeReviewDetails)) {
    out.push(value);
    return out;
  }
  if (typeof value.type === "function") return hosts(value.type(value.props), out);
  out.push(value);
  hosts(value.props?.children, out);
  return out;
}
function text(value) {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object") return String(value);
  if ((value.type === KnowledgeContent || value.type === NodeReviewDetails)) return "";
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
it("shows canonical person context in cards and details without nesting profile links", () => {
  const personNote = {
    ...node,
    id: "annotation_fixture",
    kind: "person_annotation",
    subjectRef: { kind: "person", id: "person/fixture", name: "Maya Reeves" },
  };
  const card = PageCard({ node: personNote, selectedId: personNote.id });
  expect(card.type).toBe("article");
  expect(card.props.class).toContain("is-selected");
  for (const tree of [card, KnowledgeDetail({ node: personNote })]) {
    expect(text(tree)).toContain("About Maya Reeves");
    const profile = hosts(tree).find((element) => element.type === "a" &&
      element.props.href === "/portal/people/person%2Ffixture");
    expect(profile).toBeDefined();
    for (const anchor of hosts(tree).filter((element) => element.type === "a")) {
      expect(hosts(anchor.props.children).some((element) => element.type === "a")).toBe(false);
    }
  }
});
it("does not infer a person from stale fields or prose when the canonical subject is unavailable", () => {
  const personNote = {
    ...node,
    kind: "person_annotation",
    canonicalFields: { subjectId: "stale-person" },
    subjectRef: null,
  };
  const tree = PageCard({ node: personNote });
  expect(text(tree)).toContain("Person unavailable");
  expect(hosts(tree).some((element) => element.props?.href?.startsWith("/portal/people/"))).toBe(false);
  const hostile = PageCard({ node: { ...personNote,
    subjectRef: { kind: "person", id: "fixture", name: "<script>unsafe</script>" } } });
  expect(text(hostile)).toContain("<script>unsafe</script>");
  expect(hosts(hostile).some((element) => element.type === "script" ||
    element.props?.dangerouslySetInnerHTML?.__html?.includes("<script>unsafe</script>"))).toBe(false);
  expect(text(PageCard({ node }))).not.toContain("Person unavailable");
});
it("shows document annotation context from the canonical subject with a source icon and document link", () => {
  const note = { ...node, kind: "doc_annotation", subjectRef: {
    kind: "source", id: "document/fixture", title: "Workshop equipment checklist", sourceId: "notes",
  } };
  for (const tree of [PageCard({ node: note }), KnowledgeDetail({ node: note })]) {
    expect(text(tree)).toContain("About Workshop equipment checklist");
    const link = hosts(tree).find((element) => element.type === "a" && element.props.href === "/portal/doc/document%2Ffixture");
    expect(link).toBeDefined();
    expect(hosts(link).some((element) => element.props?.class?.includes("kn-link-icon-wrap"))).toBe(true);
    expect(hosts(link.props.children).some((element) => element.type === "a")).toBe(false);
  }
  expect(text(PageCard({ node: { ...note, subjectRef: null } }))).toContain("Document unavailable");
  const untitled = PageCard({ node: { ...note, subjectRef: { ...note.subjectRef, title: "" } } });
  expect(text(untitled)).toContain("Untitled document");
  expect(hosts(untitled).some((element) => element.props?.href === "/portal/doc/document%2Ffixture")).toBe(true);
  const unnamed = PageCard({ node: { ...node, kind: "person_annotation", subjectRef: { kind: "person", id: "person-fixture", name: "" } } });
  expect(text(unnamed)).toContain("Unnamed person");
  expect(hosts(unnamed).some((element) => element.props?.href === "/portal/people/person-fixture")).toBe(true);
});
it("labels superseded and invalidated annotations without presenting their mirror as current verification", () => {
  for (const kind of ["person_annotation", "doc_annotation"]) {
    const historical = { ...node, kind, validity: "current", canonicalFields: { supersededBy: "replacement-fixture", invalidatedAt: 123 } };
    for (const tree of [PageCard({ node: historical }), KnowledgeDetail({ node: historical })]) {
      expect(text(tree)).toContain("Superseded");
      expect(text(tree)).not.toContain("Invalidated");
      expect(text(tree)).not.toContain("Up to date with linked evidence");
      expect(text(tree)).not.toContain("claims verified");
    }
    expect(text(KnowledgeDetail({ node: { ...historical, canonicalFields: { invalidatedAt: 123 } } }))).toContain("Invalidated");
    const withdrawn = KnowledgeDetail({ node: { ...historical, canonicalFields: { withdrawn: true } } });
    expect(text(withdrawn)).toContain("Withdrawn");
    expect(text(withdrawn)).not.toContain("Up to date with linked evidence");
    expect(text(withdrawn)).not.toContain("claims verified");
    const active = KnowledgeDetail({ node: { ...historical, canonicalFields: { supersededBy: null, invalidatedAt: null } } });
    expect(text(active)).toContain("Up to date with linked evidence");
    expect(text(active)).not.toContain("Superseded");
  }
});
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
  const prose = KnowledgeProse({ text: unsafe });
  expect(renderKnowledgeMarkdown).toHaveBeenCalledWith(unsafe, [], {});
  expect(prose.props.dangerouslySetInnerHTML).toEqual({ __html: "<p>Sanitized prose</p>" });
  const tree = KnowledgeDetail({ node });
  const elements = hosts(tree);
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
it("passes the selected claim and its metadata to the Overview reader", () => {
  const onClaim = vi.fn();
  const references = { "source:fixture": { title: "Example source", kind: "source" } };
  const tree = KnowledgeDetail({
    node,
    selectedClaim: "date",
    onClaim,
    references,
  });
  const content = hosts(tree).find((element) => element.type === KnowledgeContent);
  expect(content.props.node).toBe(node);
  expect(content.props.selectedClaim).toBe("date");
  expect(content.props.onClaim).toBe(onClaim);
  expect(content.props.references).toBe(references);
});
it("keeps relationship navigation in Connections instead of a duplicate Overview list", () => {
  const tree = KnowledgeDetail({ node });
  expect(text(tree)).not.toContain("Connected pages");
  const labels = hosts(tree)
    .filter((element) => element.type === "button")
    .map(text);
  expect(labels).toEqual(["Overview", "Connections", "History", "Advanced"]);
});
it("keeps claim mappings and revisions in Advanced without duplicating raw Markdown", () => {
  const elements = hosts(KnowledgeDetail({ node, activeTab: "advanced" }));
  expect(elements.filter((element) => element.type === "pre")).toHaveLength(2);
  expect(elements.filter((element) => element.type === "h4").map(text)).toEqual([
    "Canonical fields and review metadata",
    "Exact claim dependencies",
  ]);
  const mappings = JSON.parse(text(elements.filter((element) => element.type === "pre")[1]));
  expect(mappings.claims[0].text).toBe(unsafe);
  expect(mappings.dependencies).toEqual(node.dependencies);
  expect(
    elements.some((element) => element.type === "script" || element.props?.dangerouslySetInnerHTML),
  ).toBe(false);
  expect(text(elements)).toContain("meaning 2");
  expect(text(elements)).toContain("Review timing: Automatic");
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
afterEach(() => vi.unstubAllGlobals());
it("selects library entries without leaving the document or changing the library filter", () => {
  expect(knowledgeSelectionHref("outcome/one")).toBe(
    "/portal/debug/cognition/knowledge/outcome%2Fone",
  );
  expect(knowledgeSelectionHref("outcome/one", "loop")).toBe(
    "/portal/debug/cognition/knowledge/outcome%2Fone?kind=loop",
  );
  expect(knowledgeSelectionHref(null, "wiki")).toBe("/portal/debug/cognition/knowledge?kind=wiki");
  expect(knowledgeSelectionHref("retired-loop:example", "loop", "retired")).toContain("?kind=loop&status=retired");
  expect(knowledgeSelectionHref(null, "brief", "unread")).toBe("/portal/debug/cognition/knowledge?kind=brief&status=unread");
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

it("does not mistake an implicit automatic review policy for an unscheduled wiki", () => {
  const automatic = text(KnowledgeDetail({ node: { ...node, kind: "wiki", metadata: { nextReviewAt: null } } }));
  expect(automatic).toContain("Review timing: Automatic");
  expect(automatic).not.toContain("Not scheduled");
  const explicit = text(KnowledgeDetail({ node: { ...node, kind: "wiki", metadata: { nextReviewAt: 1700000000000 } } }));
  expect(explicit).toContain("Next review:");
  expect(explicit).not.toContain("Review timing: Automatic");
  const historical = text(KnowledgeDetail({ node: { ...node, kind: "brief", metadata: {} }, activeTab: "advanced" }));
  expect(historical).toContain("No explicit review date");
  expect(historical).not.toContain("Review timing: Automatic");
});
