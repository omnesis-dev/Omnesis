// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it, vi } from "vitest";
vi.mock("./format.js", () => ({
  sourceIconUrl: (id: string) => (id === "fixture-notes" ? "/icons/fixture.png" : null),
}));
// @ts-expect-error Plain JavaScript portal module.
import * as knowledgeLinks from "./knowledge-link-icons.js";
const { knowledgeIconHtml, knowledgeReferenceMetadata, knowledgeLinkReference } = knowledgeLinks;

it("uses the source registry identity and keeps unavailable source artwork neutral", () => {
  expect(knowledgeIconHtml({ reference: "source:document", sourceId: "fixture-notes" })).toContain(
    'src="/icons/fixture.png"',
  );
  expect(knowledgeIconHtml({ reference: "source:fixture-notes" })).not.toContain("<img");
  expect(knowledgeIconHtml({ kind: "constructor" })).toBe("");
  expect(knowledgeIconHtml({ kind: "<img src=x onerror=alert(1)>" })).toBe("");
});

it("shares source metadata between whole-record and claim-specific references", () => {
  const document = { kind: "source", sourceId: "fixture-notes" };
  expect(
    knowledgeReferenceMetadata("source:note#claim:opening", { "source:note": document }),
  ).toEqual(document);
  expect(knowledgeReferenceMetadata("source:missing", { "source:note": document })).toEqual({});
});

it("recognizes only local canonical navigation paths for private metadata hydration", () => {
  expect(knowledgeLinkReference("/portal/doc/letter%2Fone?evidence=paragraph")).toBe(
    "source:letter/one",
  );
  expect(knowledgeLinkReference("https://example.org/portal/doc/letter")).toBeNull();
  expect(knowledgeLinkReference("//example.org/portal/doc/letter")).toBeNull();
  expect(knowledgeLinkReference("/portal/doc/%zz")).toBeNull();
  expect(knowledgeIconHtml({ kind: "root" })).toContain("kn-link-icon--wiki");
});

it("uses the same decorative glyphs for brief and canonical annotation links", () => {
  const brief = knowledgeIconHtml({ reference: "brief:brief_invented" });
  expect(brief).toContain('<circle cx="12" cy="12" r="10"/>');
  expect(brief).toContain('aria-hidden="true"');
  const person = knowledgeIconHtml({ kind: "person_annotation" });
  const document = knowledgeIconHtml({ kind: "doc_annotation" });
  expect(person).toContain("kn-link-icon-badge--user");
  expect(document).toContain("kn-link-icon-badge--file");
  expect(person).not.toContain("kn-link-icon-badge--file");
  expect(document).not.toContain("kn-link-icon-badge--user");
  expect(knowledgeIconHtml({ reference: "annotation:unknown" })).toContain(
    "kn-link-icon--annotation",
  );
  expect(knowledgeIconHtml({ reference: "annotation:unknown" })).not.toContain(
    "kn-link-icon-badge",
  );
});

it("hydrates exact annotation kinds without guessing ownership from an identifier", () => {
  const metadata = { kind: "person_annotation", title: "Fictional practice notes" };
  const reference = "annotation:panno_invented#field:claimText";
  expect(knowledgeReferenceMetadata(reference, { "node:panno_invented": metadata })).toEqual(
    metadata,
  );
  expect(knowledgeIconHtml({ reference, ...metadata })).toContain("kn-link-icon-badge--user");
  expect(knowledgeLinkReference("/portal/debug/cognition/briefs/brief_invented")).toBe(
    "brief:brief_invented",
  );
  expect(knowledgeLinkReference("/portal/debug/cognition/loops/loop_invented")).toBe(
    "loop:loop_invented",
  );
  expect(knowledgeLinkReference("brief_invented")).toBe("brief:brief_invented");
  expect(knowledgeLinkReference("anno_invented")).toBe("annotation:anno_invented");
  expect(knowledgeLinkReference("https://example.org/portal/debug/cognition/briefs/private")).toBeNull();
});
