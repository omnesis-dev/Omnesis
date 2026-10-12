// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { knowledgeClaimContexts, contextualKnowledgeClaim } from "./claim-context.js";
import { knowledgeClaimFingerprint } from "./storage-validation.js";
import { parseClaimMarkup } from "./claims.js";

function contexts(markdown: string) {
  return knowledgeClaimContexts({ kind: "wiki", title: "Observatory", markdown });
}
it("includes actual heading ancestry, setext headings, and headings inside claim wrappers", () => {
  const result = contexts(
    '<claim id="intro" refs="source:a"># Observatory\r\n\r\nIntro.</claim>\r\n\r\n<claim id="schedule" refs="source:a">Schedule\r\n--------\r\n\r\nThursday.</claim>',
  );
  expect(result.get("schedule")?.sectionPaths).toEqual([["Observatory", "Schedule"]]);
});
it("keeps every section of a spanning claim and its nested attribution", () => {
  const result = contexts(
    '<claim id="parent" refs="source:a"># Historical experiments\n\nBefore closure:\n<claim id="child" refs="source:a">First trial.\n\n## Results\n\nSecond trial.</claim></claim>',
  );
  expect(result.get("child")).toEqual({
    pageTitle: "Observatory",
    sectionPaths: [["Historical experiments"], ["Historical experiments", "Results"]],
    enclosingClaims: ["# Historical experiments\n\nBefore closure:\n[selected claim]"],
    enclosingSemantics: [
      {
        id: "parent",
        relations: { "source:a": "supports" },
        supportLogic: "all",
        validFrom: null,
        validUntil: null,
        attribution: null,
        modality: "observation",
        epistemicStatus: "asserted",
      },
    ],
  });
});
it("does not mistake fenced or quoted headings for page scope", () => {
  const result = contexts(
    '# Real section\n\n```md\n# Fake section\n```\n\n> # Quoted section\n\n<claim id="fact" refs="source:a">A fact.</claim>',
  );
  expect(result.get("fact")?.sectionPaths).toEqual([["Real section"]]);
});
it("binds identical words to their placement without changing unscoped-record fingerprints", () => {
  const markdown = '<claim id="fact" refs="source:a">A fact.</claim>';
  const claim = parseClaimMarkup(markdown).claims[0]!;
  const original = knowledgeClaimFingerprint(claim, { "source:a": "v1" });
  expect(knowledgeClaimContexts({ kind: "brief", title: "Outcome", markdown }).size).toBe(0);
  expect(
    knowledgeClaimFingerprint(
      claim,
      { "source:a": "v1" },
      undefined,
      contexts(markdown).get("fact"),
    ),
  ).not.toBe(original);
  expect(contextualKnowledgeClaim(claim.text)).toBe(claim.text);
});
it("rejects oversized attribution instead of silently omitting it", () => {
  expect(() =>
    contexts(
      `<claim id="parent" refs="source:a">${"x".repeat(17000)}<claim id="child" refs="source:a">Fact.</claim></claim>`,
    ),
  ).toThrow("placement context exceeds");
});

it("keeps section offsets across link definitions and repeated headings", () => {
  const result = contexts(
    '[one]: https://example.org\n\n# First\n\n[second]: https://example.com\n\n## Repeated\n\n<claim id="first" refs="source:a">First fact.</claim>\n\n# Second\n\n## Repeated\n\n<claim id="second" refs="source:a">Second fact.</claim>',
  );
  expect(result.get("first")?.sectionPaths).toEqual([["First", "Repeated"]]);
  expect(result.get("second")?.sectionPaths).toEqual([["Second", "Repeated"]]);
});

it("retains subject attribution supplied by a sibling claim inside the same parent", () => {
  const result = contexts(
    '<claim id="parent" refs="source:a"><claim id="subject" refs="source:a">Orbital laboratory:</claim> <claim id="fact" refs="source:a">Three sensors.</claim></claim>',
  );
  expect(result.get("fact")?.enclosingClaims).toEqual(["Orbital laboratory: [selected claim]"]);
});

it("binds annotation qualifiers outside the selected span without making the classification a factual title", () => {
  const markdown =
    'Only after inspection: <claim id="fact" refs="source:a">the panel may be installed.</claim>';
  const input = { kind: "doc_annotation" as const, title: "assembly-status", markdown };
  const parsed = parseClaimMarkup(markdown);
  const context = knowledgeClaimContexts(input).get("fact")!;
  expect(context.pageTitle).toBe("");
  expect(context.annotation).toEqual({
    text: parsed.text,
    selectedSpan: parsed.claims[0]!.textSpan,
  });
  expect(
    context.annotation!.text.slice(
      context.annotation!.selectedSpan.start,
      context.annotation!.selectedSpan.end,
    ),
  ).toBe("the panel may be installed.");
  const changed = knowledgeClaimContexts({
    ...input,
    markdown: markdown.replace("Only after inspection", "Without inspection"),
  }).get("fact")!;
  expect(
    knowledgeClaimFingerprint(parsed.claims[0]!, { "source:a": "v1" }, undefined, context),
  ).not.toBe(
    knowledgeClaimFingerprint(parsed.claims[0]!, { "source:a": "v1" }, undefined, changed),
  );
  expect(contextualKnowledgeClaim(parsed.claims[0]!.text, context)).toContain(
    "Only after inspection",
  );
});

it("serializes nested context identically when a parent's unordered reference set is reordered", () => {
  const first =
    '<claim id="parent" refs="source:b source:a">Laboratory scope: <claim id="child" refs="source:a">The trial passed.</claim></claim>';
  const second = first.replace("source:b source:a", "source:a source:b");
  expect(contextualKnowledgeClaim("The trial passed.", contexts(first).get("child"))).toBe(
    contextualKnowledgeClaim("The trial passed.", contexts(second).get("child")),
  );
});

it("binds split loop assertions to the complete bounded outcome and title", () => {
  const input = {
    kind: "loop" as const,
    title: "Prepare the display",
    markdown:
      '<claim id="ready" refs="source:a">The display was approved Friday.</claim>\n<claim id="setup" refs="source:b">Later, assembly was proposed.</claim>',
  };
  const parsed = parseClaimMarkup(input.markdown);
  const context = knowledgeClaimContexts(input).get("setup")!;
  expect(context.outcome).toEqual({ text: parsed.text, selectedSpan: parsed.claims[1]!.textSpan });
  expect(context.pageTitle).toBe(input.title);
  const fingerprint = (patch: Partial<typeof input>) =>
    knowledgeClaimFingerprint(
      parsed.claims[1]!,
      { "source:b": "v1" },
      undefined,
      knowledgeClaimContexts({ ...input, ...patch }).get("setup"),
    );
  expect(fingerprint({ title: "Cancel the display" })).not.toBe(fingerprint({}));
  expect(fingerprint({ markdown: input.markdown.replace("Friday", "Monday") })).not.toBe(
    fingerprint({}),
  );
  expect(() =>
    knowledgeClaimContexts({ ...input, markdown: "x".repeat(17000) + input.markdown }),
  ).toThrow("placement context exceeds");
});
