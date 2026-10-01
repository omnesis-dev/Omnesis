// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — the portal ships plain browser JavaScript.

import { describe, expect, it } from "vitest";
import { CalendarEntryDetail } from "./calendar-detail.js";

const entry = {
  id: "projection-1",
  origin: "projection",
  kind: "deadline",
  label: "Submit workshop registration",
  start: "2026-10-15T00:00:00.000Z",
  endExclusive: "2026-10-16T00:00:00.000Z",
  allDay: true,
  precision: "day",
  status: "active",
  projection: { sourceId: "fictional-tasks:account", slot: "due", documentId: "doc-1" },
};

function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node !== "object") return String(node);
  if (typeof node.type === "function") return text(node.type(node.props));
  return text(node.props?.children);
}

function nodes(node, tag) {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item) => nodes(item, tag));
  if (typeof node.type === "function") return nodes(node.type(node.props), tag);
  return [...(node.type === tag ? [node] : []), ...nodes(node.props?.children, tag)];
}

function body(value, documents = {}, options = {}) {
  // Inspect the content given to Modal; its browser focus hooks belong to the shell.
  return CalendarEntryDetail({ entry: value, documents, ...options }).props.children;
}

describe("Calendar entry explanations", () => {
  it("shows source evidence without technical identifiers or explanatory footer", () => {
    const content = body(entry, { "doc-1": { title: "Workshop registration" } });
    expect(text(content)).not.toContain("A structured date supplied by the source");
    expect(text(content)).not.toContain("Recorded by");
    expect(text(content)).not.toContain("Dates and times shown");
    expect(nodes(content, "details")).toHaveLength(0);
    expect(text(content)).not.toContain("Projection slot");
    expect(text(content)).not.toContain("fictional-tasks:account");
    expect(nodes(content, "a")[0].props.href).toBe("/portal/doc/doc-1");
  });

  it("quotes a mention and explains its relative reference date without claiming an event", () => {
    const content = body({
      ...entry,
      origin: "mention",
      projection: undefined,
      mention: { documentId: "doc/2", text: "by tomorrow", relative: true },
    });
    expect(text(content)).toContain("It may not describe an event or an obligation");
    expect(text(content)).toContain("document's own date, rather than today's date");
    expect(text(nodes(content, "blockquote")[0])).toBe("by tomorrow");
    expect(text(content)).toContain("Document containing this phrase");
    expect(nodes(content, "a")[0].props.href).toBe("/portal/doc/doc%2F2");
    expect(text(content)).toContain("Open supporting document");
  });

  it("shows an agent rationale and linked evidence without technical details", () => {
    const content = body(
      {
        ...entry,
        origin: "annotation",
        projection: undefined,
        annotation: {
          documentIds: ["doc-3", "doc-3"],
          revision: 4,
          rationale: "The form specifies the final submission date.",
        },
      },
      { "doc-3": { title: "Registration form" } },
    );
    expect(text(content)).toContain("The agent recorded this interpretation");
    expect(text(content)).toContain("The form specifies the final submission date");
    expect(nodes(content, "a")).toHaveLength(1);
    expect(nodes(content, "details")).toHaveLength(0);
    expect(text(content)).not.toContain("Revision");
  });

  it("marks the agent title with its icon without repeating its annotation", () => {
    const value = { ...entry, origin: "annotation", projection: undefined,
      annotation: { documentIds: [], rationale: entry.label } };
    const modal = CalendarEntryDetail({ entry: value });
    expect(modal.props.title).toBe(entry.label);
    expect(text(modal.props.titleIcon)).toBe("✦");
    expect(text(modal.props.children)).not.toContain(entry.label);
  });

  it("explains missing evidence and handles absent details", () => {
    expect(text(body({ ...entry, projection: undefined }))).toContain(
      "No supporting document is linked",
    );
    expect(CalendarEntryDetail({ entry: null })).toBeNull();
  });

  it("keeps supporting quotes with their documents and renders explicitly linked entries separately", () => {
    const related = {
      ...entry,
      id: "annotation-2",
      origin: "annotation",
      label: "Registration deadline interpretation",
    };
    const opened = [];
    const content = body(
      entry,
      {},
      {
        evidenceQuotes: [
          { documentId: "doc-1", quote: "Submit the form by 15 October." },
          { documentId: "other-doc", quote: "An unrelated passage." },
        ],
        relatedEntries: [related],
        onOpenRelated: (value) => opened.push(value),
      },
    );
    expect(text(content)).toContain("Submit the form by 15 October.");
    expect(text(content)).not.toContain("An unrelated passage.");
    expect(text(content)).toContain("Entries stay separate.");
    const button = nodes(content, "button")[0];
    button.props.onClick();
    expect(opened).toEqual([related]);
  });

  it("keeps document links available while supporting passages load or fail", () => {
    const loading = body(entry, {}, { evidenceLoading: true });
    expect(text(loading)).toContain("Loading supporting passages");
    expect(nodes(loading, "a")).toHaveLength(1);
    const failure = body(entry, {}, { evidenceError: "unavailable" });
    expect(text(failure)).toContain("You can still open the documents above");
    expect(nodes(failure, "a")).toHaveLength(1);
  });
});
