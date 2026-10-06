// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it, vi } from "vitest";
vi.mock("./format.js", () => ({
  sourceIconUrl: (id: string) => (id === "fixture-notes" ? "/icons/fixture.png" : null),
}));
// @ts-expect-error Plain JavaScript portal module.
import {
  knowledgeIconHtml,
  knowledgeReferenceMetadata,
  knowledgeLinkReference,
} from "./knowledge-link-icons.js";

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
