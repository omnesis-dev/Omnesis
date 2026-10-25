// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { parseContextualEntailment } from "../../inference/contextual-entailment.js";
import { readKnowledgeSourceEvidence } from "./source-evidence.js";
const databases: Database.Database[] = [];
function setup(metadata = true) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    `CREATE TABLE documents(id TEXT PRIMARY KEY, content TEXT, content_hash TEXT${metadata ? ",title TEXT,source_created_at TEXT,source_updated_at TEXT" : ""}); INSERT INTO documents(id,content,content_hash) VALUES('source','The instrument is ready.','body')`,
  );
  if (metadata)
    db.exec(
      "UPDATE documents SET title='Instrument log',source_created_at='2026-01-03',source_updated_at='2026-01-04'",
    );
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));
it("exposes trusted record dates separately from the unchanged raw source body", () => {
  const value = readKnowledgeSourceEvidence(setup(), "source")!;
  expect(value.content).toBe("The instrument is ready.");
  expect(value.contentHash).toBe("body");
  expect(value.sourceMetadata).toMatchObject({
    title: "Instrument log",
    sourceCreatedAt: "2026-01-03",
  });
  expect(JSON.parse(value.verifierEvidence)).toMatchObject({
    sources: [{ authority: "whole_source", sourceCreatedAt: "2026-01-03", text: value.content }],
    verifiedReferences: [],
  });
  expect(JSON.parse(value.verifierEvidence).limitation).toContain("not automatically event times");
});
it("retains selected-quote scope and surrounding qualifications without granting full-source proof", () => {
  const db = setup();
  db.exec(
    "UPDATE documents SET content='An earlier log said the instrument is ready. That status is now disputed.'",
  );
  const value = readKnowledgeSourceEvidence(db, "source", "the instrument is ready")!;
  const frame = JSON.parse(value.verifierEvidence);
  expect(frame.sources[0].authority).toBe("selected_quote");
  expect(frame.sources[0].selectedQuotes).toEqual(["the instrument is ready"]);
  expect(frame.sources[0].text).toContain("now disputed");
  expect(frame.limitation).toContain("only qualify its interpretation");
});
it("supports minimalist stores and bounds verifier source framing without truncating reader text", () => {
  const db = setup(false);
  db.prepare("UPDATE documents SET content=?").run("x".repeat(60_000));
  const value = readKnowledgeSourceEvidence(db, "source")!;
  expect(value.content).toHaveLength(60_000);
  expect(value.sourceMetadata.title).toBeNull();
  expect(JSON.parse(value.verifierEvidence).sources[0].truncated).toBe(true);
  expect(value.verifierEvidence.length).toBeLessThan(50_000);
});

it("authorizes exact retained passages but not omission markers or metadata from truncated sources", () => {
  const db = setup();
  const head = "a".repeat(24_000),
    tail = "z".repeat(24_000);
  const full = head + "unseen middle" + tail;
  db.prepare("UPDATE documents SET content=?").run(full);
  const value = readKnowledgeSourceEvidence(db, "source")!;
  const frame = JSON.parse(value.verifierEvidence);
  expect(value.content).toBe(full);
  expect(frame.sources[0]).toMatchObject({
    authority: "selected_quote",
    truncated: true,
    text: expect.stringContaining("source head and tail, in that order"),
    selectedQuotes: [head, tail],
  });
  expect(frame.sources[0].selectedQuotes.every((quote: string) => full.includes(quote))).toBe(true);
  expect(frame.sources[0].text).not.toContain(head);
  expect(value.verifierEvidence.length).toBeLessThan(50_000);
  expect(frame.limitation).toContain("metadata alone cannot establish an independent claim");
});
it("does not expand a selected reference to other retained passages", () => {
  const db = setup();
  db.prepare("UPDATE documents SET content=?").run("head " + "x".repeat(60_000) + " tail");
  const frame = JSON.parse(readKnowledgeSourceEvidence(db, "source", "head")!.verifierEvidence);
  expect(frame.sources[0]).toMatchObject({ authority: "selected_quote", selectedQuotes: ["head"] });
});

it("the verifier accepts retained text but rejects framing and metadata as truncated-source witnesses", () => {
  const db = setup();
  db.prepare("UPDATE documents SET content=?").run(
    "Beginning retained." + "x".repeat(60_000) + "End retained.",
  );
  const evidence = readKnowledgeSourceEvidence(db, "source")!.verifierEvidence;
  const label = (quote: string) =>
    parseContextualEntailment(
      JSON.stringify({
        contentInContext: {
          verdict: "supported",
          evidenceQuotes: [quote],
          reason: "Scripted witness.",
        },
        placementSupport: {
          verdict: "not_applicable",
          evidenceQuotes: [],
          reason: "Generic context.",
        },
      }),
      evidence,
    );
  expect(label("Beginning retained.")).toBe("entailment");
  expect(label("End retained.")).toBe("entailment");
  expect(label("The first two selectedQuotes")).toBeNull();
  expect(label("Instrument log")).toBeNull();
  expect(label("2026-01-03")).toBeNull();
});

it("retains long-source selected authority through contextual segment rendering", async () => {
  const { prepareContextualWitnessRequest, parseContextualWitnessVerdict } =
    await import("../../inference/contextual-segments.js");
  const db = setup();
  const content = "The lens is green.\n" + "x".repeat(60_000) + "\nThe mount is proposed.";
  db.prepare("UPDATE documents SET content=?").run(content);
  const evidence = readKnowledgeSourceEvidence(db, "source")!.verifierEvidence;
  const request = prepareContextualWitnessRequest({
    claim: "The lens is green.",
    evidence,
    context: "Historical instrument reference",
  });
  expect([...request.segments.values()].join("")).toBe(
    content.slice(0, 24_000) + content.slice(-24_000),
  );
  expect(
    [...request.segments.values()].some((text) => text.includes("The first two selectedQuotes")),
  ).toBe(false);
  expect([...request.segments.values()].some((text) => text.includes("Instrument log"))).toBe(
    false,
  );
  const packet = JSON.parse(request.prompt.split("\n").at(-1)!);
  expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(55_000);
  const response = {
    witnessSet: request.witnessSet,
    contentInContext: {
      verdict: "supported",
      evidenceSegments: ["s0"],
      reason: "Scripted source support",
    },
    placementSupport: {
      verdict: "not_applicable",
      evidenceSegments: [],
      reason: "Generic context",
    },
  };
  expect(parseContextualWitnessVerdict(JSON.stringify(response), request)).toBe("entailment");
  response.contentInContext.evidenceSegments = ["context"];
  expect(parseContextualWitnessVerdict(JSON.stringify(response), request)).toBeNull();
});
