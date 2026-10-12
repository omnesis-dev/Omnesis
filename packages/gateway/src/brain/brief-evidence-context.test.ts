// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createKnowledgeTables } from "./knowledge/schema.js";
import { briefEvidenceContext } from "./brief-evidence-context.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,source_id TEXT,metadata TEXT,title TEXT,source_created_at TEXT,source_updated_at TEXT); INSERT INTO documents VALUES('source','Original dated notice','v1','fixture','{}','Exhibit','2026-07-01','2026-07-01')",
  );
  createKnowledgeTables(db);
});
afterEach(() => db.close());

test("frames original evidence and separates display interpretation from the asserted text", () => {
  const result = briefEvidenceContext(
    db,
    { title: "Exhibit", body: "Consider visiting.", eventAt: 2, relevantUntil: 3 },
    ["source"],
    4,
  )!;
  expect(JSON.parse(result.claim)).toEqual({
    title: "Exhibit",
    description: null,
    body: "Consider visiting.",
  });
  expect(JSON.parse(result.context)).toMatchObject({
    asOf: new Date(4).toISOString(),
    eventAt: 2,
    relevantUntil: 3,
  });
  expect(JSON.parse(result.evidence).sources).toEqual([
    expect.objectContaining({
      id: "source",
      authority: "whole_source",
      title: "Exhibit",
      sourceCreatedAt: "2026-07-01",
      text: "Original dated notice",
      truncated: false,
    }),
  ]);
});

test("accepts bounded already-verified reference views without pretending they are original documents", () => {
  const evidence = [
    { ref: "wiki:exhibit#claim:opening", text: "The opening is scheduled for July." },
  ];
  const result = briefEvidenceContext(db, { title: "Exhibit" }, [], 4, [], evidence)!;
  expect(JSON.parse(result.evidence)).toMatchObject({ sources: [], verifiedReferences: evidence });
  expect(() =>
    briefEvidenceContext(
      db,
      { title: "Exhibit" },
      [],
      4,
      [],
      [{ ref: "wiki:x", text: "x".repeat(24_001) }],
    ),
  ).toThrow("bounded context");
});

test("marks omitted original passages and retains selected quotes", () => {
  db.prepare("UPDATE documents SET content=? WHERE id='source'").run(
    "x".repeat(30_000) + "selected passage" + "x".repeat(30_000),
  );
  const result = briefEvidenceContext(db, { title: "Exhibit" }, ["source"], 4, [
    { evidenceDocId: "source", evidenceQuote: "selected passage" },
    { evidenceDocId: "source", evidenceQuote: "stale unsupported quote" },
  ])!;
  expect(JSON.parse(result.evidence).sources[0]).toMatchObject({
    truncated: true,
    authority: "selected_quote",
    selectedQuotes: ["x".repeat(24_000), "x".repeat(24_000), "selected passage"],
  });
  expect(JSON.parse(result.evidence).sources[0].text).not.toContain("selected passage");
  expect(result.evidence).not.toContain("stale unsupported quote");
  const frame = JSON.parse(result.evidence).sources[0];
  expect(
    frame.selectedQuotes.every((quote: string) => !quote.includes("[Source middle omitted]")),
  ).toBe(true);
  expect(
    frame.selectedQuotes.every((quote: string) =>
      ("x".repeat(30_000) + "selected passage" + "x".repeat(30_000)).includes(quote),
    ),
  ).toBe(true);
});

test("does not expose unavailable original evidence", () => {
  db.exec("DELETE FROM documents");
  expect(() => briefEvidenceContext(db, { title: "Exhibit" }, ["source"], 4)).toThrow(
    "unavailable",
  );
});

test("retains distinct exact head and tail spans without authorizing their artificial join", () => {
  const head = "a".repeat(24_000);
  const tail = "z".repeat(24_000);
  db.prepare("UPDATE documents SET content=? WHERE id='source'").run(head + "middle" + tail);
  const result = briefEvidenceContext(db, { title: "Exhibit" }, ["source"], 4)!;
  const frame = JSON.parse(result.evidence).sources[0];
  expect(frame).toMatchObject({
    authority: "selected_quote",
    truncated: true,
    selectedQuotes: [head, tail],
  });
  expect(frame.text).toContain("source head and tail, in that order");
  expect(frame.text).not.toContain(head);
  expect(result.evidence.length).toBeLessThan(50_000);
});

test("bounds selected witnesses including the two truncation spans", () => {
  expect(() =>
    briefEvidenceContext(
      db,
      { title: "Exhibit" },
      ["source"],
      4,
      Array.from({ length: 99 }, () => ({ evidenceDocId: "source", evidenceQuote: "Original" })),
    ),
  ).toThrow("bounded context");
});
