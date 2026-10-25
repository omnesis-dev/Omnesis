// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { selectAnswerEvidence, type AnswerSourceEvidence } from "./answer-evidence-selection.js";
const source = (id: string, text: string): AnswerSourceEvidence => ({
  documentId: id,
  title: id,
  text,
  authority: "whole_source",
  selectedQuotes: [],
});
const run = (
  sources: AnswerSourceEvidence[],
  maxBytes = 1000,
  anchors: ReadonlyMap<string, readonly string[]> = new Map(),
) =>
  selectAnswerEvidence({
    sources,
    maxBytes,
    anchors,
    question: "calibration",
    draft: "The calibration finished.",
    packetBytes: (s, incomplete) => Buffer.byteLength(JSON.stringify({ sources: s, incomplete })),
  });
it("preserves the complete original packet when it fits", () => {
  const sources = [source("one", "The calibration finished.")];
  expect(run(sources)).toEqual({ sources, incomplete: false });
});
it("keeps exact surrounding qualifiers and omits unrelated bulk deterministically", () => {
  const text =
    "Irrelevant padding.\n\n".repeat(200) +
    "Only in the test chamber.\n\nThe calibration finished.\n\nNot valid in other conditions.";
  const result = run([source("one", text)]);
  expect(result?.incomplete).toBe(true);
  expect(result?.sources[0]?.selectedQuotes).toEqual([
    "Only in the test chamber.\n\nThe calibration finished.\n\nNot valid in other conditions.",
  ]);
  expect(run([source("one", text)])).toEqual(result);
});
it("prioritizes an exact multiline citation anchor even without lexical query overlap", () => {
  const anchor = "Cobalt protocol.\n\nTrial result accepted.";
  const text =
    "Nothing relevant.\n\n".repeat(200) +
    "Only under laboratory conditions.\n\n" +
    anchor +
    "\n\nExpires after the trial.";
  const result = run([source("one", text)], 1100, new Map([["one", [anchor]]]));
  expect(result?.sources[0]?.selectedQuotes[0]).toContain(anchor);
  expect(result?.sources[0]?.selectedQuotes[0]).toContain("Only under laboratory conditions.");
  expect(result?.sources[0]?.selectedQuotes[0]).toContain("Expires after the trial.");
});
it("does not invent or truncate a meaningful window from one oversized unbroken paragraph", () => {
  expect(run([source("one", "calibration " + "x".repeat(3000))], 500)).toEqual({
    sources: [],
    incomplete: true,
  });
});
it("never expands partial-read authority", () => {
  const observed = {
    ...source("one", "Visible calibration.\n\nVisible condition."),
    authority: "selected_quote" as const,
    selectedQuotes: ["Visible calibration.\n\nVisible condition."],
  };
  const result = run([observed, source("bulk", "x".repeat(3000))], 900);
  expect(result?.sources).toEqual([observed]);
});
it("retains a joint packet across sources instead of independently approving relationships", () => {
  const results = run(
    [
      source("a", "calibration alpha\n\n" + "filler\n\n".repeat(300)),
      source("b", "calibration beta\n\n" + "filler\n\n".repeat(300)),
    ],
    1000,
  );
  expect(results?.sources.map((s) => s.documentId)).toEqual(["a", "b"]);
});
it("fails closed when indivisible fixed evidence already exceeds the packet budget", () => {
  expect(
    selectAnswerEvidence({
      sources: [source("one", "calibration")],
      anchors: new Map(),
      question: "",
      draft: "",
      maxBytes: 100,
      packetBytes: () => 101,
    }),
  ).toBeNull();
});

it("retains opening and enclosing heading restrictions outside the selected quote", () => {
  const text =
    "All statements below are provisional.\n\n# Draft contingency plan\n\n" +
    "Background padding.\n\n".repeat(300) +
    "## Proposed laboratory stage\n\nBackground.\n\nThe calibration finished.\n\nConditional result.";
  const result = run([source("one", text)], 1800);
  const chosen = result?.sources[0];
  expect(chosen?.text).toContain("All statements below are provisional.");
  expect(chosen?.text).toContain("# Draft contingency plan");
  expect(chosen?.text).toContain("## Proposed laboratory stage");
  expect(chosen?.selectedQuotes.join(" ")).not.toContain("All statements below");
  expect(chosen?.selectedQuotes.join(" ")).not.toContain("# Draft contingency plan");
});

it("maps normalized Markdown heading offsets to original CRLF quote ranges", () => {
  const text =
    "Provisional observations.\r\n\r\n# Current draft\r\n\r\n" +
    "Background padding.\r\n\r\n".repeat(200) +
    "Local condition.\r\n\r\nThe calibration finished.\r\n\r\nConditional result.\r\n\r\n" +
    "Unrelated background.\r\n\r\n".repeat(3) +
    "# Future alternative\r\n\r\nOther material.";
  const chosen = run([source("one", text)], 1800)?.sources[0];
  expect(chosen?.text).toContain("# Current draft");
  expect(chosen?.text).not.toContain("# Future alternative");
  expect(chosen?.selectedQuotes).toEqual([
    "Local condition.\r\n\r\nThe calibration finished.\r\n\r\nConditional result.\r",
  ]);
  for (const quote of chosen?.selectedQuotes ?? []) expect(text).toContain(quote);
});

it("omits sources exceeding the bounded selection scan instead of treating a prefix as complete", () => {
  expect(run([source("one", "calibration.\n\n" + "padding.\n\n".repeat(1000))], 1000)).toEqual({
    sources: [],
    incomplete: true,
  });
});

it("omits a passage when its indivisible opening interpretation cannot fit", () => {
  const text =
    "Scope " +
    "x".repeat(1200) +
    "\n\nBackground.\n\nThe calibration finished.\n\nConditional result.";
  expect(run([source("one", text)], 1000)).toEqual({ sources: [], incomplete: true });
});

it("keeps focused assertions ahead of incidental words scattered across a broad answer", () => {
  const text =
    "Archive observations.\n\n" +
    Array.from(
      { length: 12 },
      (_, i) =>
        `Directory ${i}: telescope pottery orchard violin glacier lantern compass mosaic zephyr.\n\n`,
    ).join("") +
    "Ordinary background.\n\nFor the west chamber only.\n\n" +
    "The cobalt sensor passed calibration.\n\nRepeat before production use.\n\n" +
    "Ordinary background.\n\n".repeat(100) +
    "Archive entry accepted.\n\nNo deployment authorized.";
  const result = selectAnswerEvidence({
    sources: [source("archive", text)],
    anchors: new Map([["archive", ["Archive entry accepted."]]]),
    question: "Summarize the observations.",
    draft:
      "The cobalt sensor passed calibration. Telescope optics adjusted. Pottery clay dried. " +
      "Orchard harvest scheduled. Violin strings replaced. Glacier survey completed. " +
      "Lantern battery replaced. Compass reading checked. Mosaic tile shipped. Zephyr trial started.",
    maxBytes: 2200,
    packetBytes: (sources, incomplete) =>
      Buffer.byteLength(JSON.stringify({ sources, incomplete })),
  });
  const selected = result!.sources[0]!;
  expect(result!.incomplete).toBe(true);
  expect(selected.selectedQuotes.join("\n")).toContain(
    "For the west chamber only.\n\nThe cobalt sensor passed calibration.\n\nRepeat before production use.",
  );
  expect(selected.selectedQuotes.join("\n")).toContain("Archive entry accepted.");
  for (const quote of selected.selectedQuotes) expect(text).toContain(quote);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2200);
});

it("does not treat URL destination keywords as prose relevance or alter retained URLs", () => {
  const anchor = "[Archive record](https://example.org/original?record=42)";
  const text =
    "Provisional archive.\n\n" +
    Array.from(
      { length: 12 },
      (_, i) => `[Index ${i}](https://example.org/calibration/sensor/cobalt/finished/${i})\n\n`,
    ).join("") +
    "Laboratory only.\n\nThe cobalt sensor calibration finished.\n\nSubject to inspection.\n\n" +
    "Background.\n\n".repeat(40) +
    anchor;
  const result = run([source("archive", text)], 1700, new Map([["archive", [anchor]]]));
  expect(result!.sources[0]!.selectedQuotes.join("\n")).toContain(
    "The cobalt sensor calibration finished.",
  );
  expect(result!.sources[0]!.selectedQuotes.join("\n")).toContain(anchor);
  for (const quote of result!.sources[0]!.selectedQuotes) expect(text).toContain(quote);
});
