// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import { completePeopleEnrichment, DocumentList } from "./source-recent.js";
// @ts-expect-error — portal modules are plain JS.
import { notesDayForDocument } from "../lib/notes.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function collectText(vnode: any): string {
  if (vnode == null || typeof vnode === "boolean") return "";
  if (Array.isArray(vnode)) return vnode.map(collectText).join("");
  if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
  return collectText(vnode.props?.children);
}

describe("source recent people enrichment", () => {
  test("marks every requested document complete when a document disappears", () => {
    expect(
      completePeopleEnrichment(["doc-present", "doc-removed"], {
        docs: {
          "doc-present": {
            people: [{ id: "person-1" }],
            total: 1,
          },
        },
      }),
    ).toEqual({
      "doc-present": {
        people: [{ id: "person-1" }],
        total: 1,
      },
      "doc-removed": [],
    });
  });
});

describe("DocumentList partition origin", () => {
  test("shows each recent row's friendly device name", () => {
    const vnode = DocumentList({
      documents: [
        {
          id: "doc-1",
          title: "Fictional session",
          sourceCreatedAt: "2026-08-01T00:00:00.000Z",
          deviceId: "device-maya",
          deviceName: "Maya-Laptop",
        },
      ],
      peopleByDoc: {},
      onRequestDelete: () => {},
    });
    expect(collectText(vnode)).toContain("Maya-Laptop");
  });
});

function findByClass(vnode: any, className: string): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (node == null || typeof node === "boolean") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "object") {
      const classes = String(node.props?.class ?? node.props?.className ?? "").split(" ");
      if (classes.includes(className)) found.push(node);
      visit(node.props?.children);
    }
  };
  visit(vnode);
  return found;
}

describe("DocumentList read-only Notes rows", () => {
  const notesDoc = {
    id: "doc-notes",
    title: "Notes — March 1",
    externalId: "2026-03-01",
    sourceCreatedAt: "2026-03-01T10:00:00.000Z",
  };

  test("offers Manage notes to that day instead of a delete button", () => {
    const vnode = DocumentList({
      documents: [notesDoc],
      peopleByDoc: {},
      onRequestDelete: undefined,
      manageDayForDoc: notesDayForDocument,
    });
    expect(collectText(vnode)).toContain("Manage notes");
    const links = findByClass(vnode, "source-recent-item-manage");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("/portal/capture?day=2026-03-01");
    expect(findByClass(vnode, "source-recent-item-delete")).toHaveLength(0);
  });

  test("falls back to the creation date when the external id is not a day", () => {
    const vnode = DocumentList({
      documents: [{ ...notesDoc, externalId: "not-a-day" }],
      peopleByDoc: {},
      onRequestDelete: undefined,
      manageDayForDoc: notesDayForDocument,
    });
    const links = findByClass(vnode, "source-recent-item-manage");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("/portal/capture?day=2026-03-01");
  });

  test("a Notes row with no day-shaped date renders no action at all", () => {
    const vnode = DocumentList({
      documents: [{ ...notesDoc, externalId: "not-a-day", sourceCreatedAt: "garbage" }],
      peopleByDoc: {},
      onRequestDelete: undefined,
      manageDayForDoc: notesDayForDocument,
    });
    expect(findByClass(vnode, "source-recent-item-manage")).toHaveLength(0);
    expect(findByClass(vnode, "source-recent-item-delete")).toHaveLength(0);
  });

  test("regular rows keep the delete button and no manage link", () => {
    const vnode = DocumentList({
      documents: [notesDoc],
      peopleByDoc: {},
      onRequestDelete: () => {},
    });
    expect(findByClass(vnode, "source-recent-item-delete")).toHaveLength(1);
    expect(findByClass(vnode, "source-recent-item-manage")).toHaveLength(0);
    expect(collectText(vnode)).not.toContain("Manage notes");
  });
});
