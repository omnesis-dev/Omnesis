// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createPersonAnnotation,
  createPersonAnnotationStorageTables,
} from "../storage/person-annotations.js";
import { personRecordContext, readPersonReconciliationContext } from "./person-context.js";

it("keeps one explicit person fact sufficient and numbers repeated evidence sources consistently", () => {
  expect(
    personRecordContext("person", [{ docId: "first", quote: "I lead the observatory team." }]),
  ).toEqual({
    subject_id: "person",
    evidence: [{ source: 0, quote: "I lead the observatory team." }],
    evidence_truncated: false,
  });
  const context = personRecordContext("person", [
    { docId: "first", quote: "I lead the observatory team." },
    { docId: "first", quote: "Contact me about instrument access." },
    { docId: "second", quote: "Our team coordinator is Maya." },
  ]);
  expect(context.evidence.map((atom) => atom.source)).toEqual([0, 0, 1]);
  expect(JSON.stringify(context)).not.toContain("first");
});

it("bounds quote context without splitting Unicode and reports omitted evidence", () => {
  const context = personRecordContext(
    "person",
    Array.from({ length: 10 }, (_, i) => ({
      docId: `source-${i}`,
      quote: "x".repeat(499) + "🔭" + "end",
    })),
  );
  expect(context.evidence).toHaveLength(9);
  expect(context.evidence[0]?.quote).toBe("x".repeat(499));
  expect(context.evidence_truncated).toBe(true);
});

it("carries an explicit editorial plan without treating it as a command", () => {
  const context = personRecordContext(
    "person",
    [{ docId: "source", quote: "A supported scoped role." }],
    {
      operation: "replace",
      reason: "Omit a duplicate detail, retaining the older supported role.",
      predecessors: [
        { id: "old", kind: "role", text: "A supported scoped role and a duplicate detail." },
      ],
      retained_profile: [
        { id: "other", kind: "preference", text: "A distinct standing preference." },
      ],
      truncated: false,
    },
  );
  expect(context.reconciliation?.operation).toBe("replace");
  expect(context.reconciliation?.predecessors[0]?.id).toBe("old");
  expect(context.reconciliation?.retained_profile[0]?.id).toBe("other");
});

it("bounds whole profile facts and captures every represented source, prioritizing predecessors", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE people(id TEXT PRIMARY KEY,merged_into TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY); INSERT INTO people VALUES('person',NULL)",
    );
    createPersonAnnotationStorageTables(db);
    for (let i = 0; i < 65; i++) {
      db.prepare("INSERT INTO documents VALUES(?)").run(`source-${i}`);
      createPersonAnnotation(
        db,
        {
          id: `fact-${i}`,
          personId: "person",
          claimType: "scope",
          claimText: "x".repeat(300),
          evidenceDocId: `source-${i}`,
          evidenceQuote: "Synthetic support.",
          confidence: 0.5,
          claimBasis: "quoted",
          createdByRun: "fixture",
        },
        i,
        { maxFacts: 65, maxCharacters: 30000 },
      );
    }
    const result = db.transaction(() =>
      readPersonReconciliationContext(db, "person", ["fact-0"], "replace"),
    )();
    expect(result.reconciliation.predecessors).toEqual([
      { id: "fact-0", kind: "scope", text: "x".repeat(300) },
    ]);
    expect(result.reconciliation.truncated).toBe(true);
    const facts = [
      ...result.reconciliation.predecessors,
      ...result.reconciliation.retained_profile,
    ];
    expect(facts.length).toBeLessThanOrEqual(64);
    expect(facts.reduce((sum, fact) => sum + fact.text.length, 0)).toBeLessThanOrEqual(12000);
    expect(result.sourceIds.sort()).toEqual(
      facts.map((fact) => fact.id.replace("fact-", "source-")).sort(),
    );
  } finally {
    db.close();
  }
});
