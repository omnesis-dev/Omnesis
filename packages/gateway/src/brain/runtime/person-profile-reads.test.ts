// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPersonAnnotation,
  createPersonAnnotationStorageTables,
  DEFAULT_PERSON_PROFILE_BUDGET,
} from "../storage/person-annotations.js";
import { PersonProfileReads, MAX_PERSON_PROFILE_PAGE_BYTES } from "./person-profile-reads.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE people(id TEXT PRIMARY KEY,merged_into TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY); INSERT INTO people VALUES('person',NULL),('alias','person'),('other',NULL); INSERT INTO documents VALUES('source')",
  );
  createPersonAnnotationStorageTables(db);
});
afterEach(() => db.close());
function seed(id: string, personId = "person") {
  createPersonAnnotation(
    db,
    {
      id,
      personId,
      claimType: id,
      claimText: `Useful context ${id}`,
      evidenceDocId: "source",
      evidenceQuote: "Grounded context",
      confidence: 0.6,
      claimBasis: "quoted",
      createdByRun: "fixture",
    },
    1,
    { maxFacts: 200, maxCharacters: 20000 },
  );
}

it("requires every page of a large merged profile rather than treating the first page as complete", () => {
  for (let i = 0; i < 55; i++) seed(`fact-${i}`, i % 2 ? "alias" : "person");
  const reads = new PersonProfileReads(db);
  let page = reads.page("person", 20);
  expect(page.profile).toMatchObject({ totalFacts: 55, readComplete: false });
  expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).toThrow(
    /complete current profile/,
  );
  const ids = page.annotations.map((a) => a.id);
  while (page.nextCursor) {
    page = reads.page("person", 20, page.nextCursor);
    ids.push(...page.annotations.map((a) => a.id));
  }
  expect(new Set(ids).size).toBe(55);
  expect(page.profile.readComplete).toBe(true);
  expect(reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).toMatchObject({
    maxFacts: 20,
    maxCharacters: 4000,
    expectedProfileFingerprint: expect.any(String),
  });
});

it("rejects skipped or foreign pages and invalidates a receipt on same-timestamp content changes", () => {
  seed("first");
  seed("second");
  const reads = new PersonProfileReads(db);
  const first = reads.page("person", 1);
  expect(() => new PersonProfileReads(db).page("person", 1, first.nextCursor!)).toThrow();
  expect(() => reads.page("other", 1, first.nextCursor!)).toThrow();
  db.prepare("UPDATE person_annotations SET claim_text='Changed meaning' WHERE id='first'").run();
  expect(() => reads.page("person", 1, first.nextCursor!)).toThrow();
  reads.page("person", 50);
  expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).not.toThrow();
  db.prepare("UPDATE person_annotations SET claim_text='Another meaning' WHERE id='second'").run();
  expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).toThrow();
});

it("keeps unrelated profiles independent and excludes source-orphaned rows from readable totals", () => {
  seed("first");
  const reads = new PersonProfileReads(db);
  reads.page("person", 20);
  seed("unrelated", "other");
  expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).not.toThrow();
  db.prepare("DELETE FROM documents WHERE id='source'").run();
  expect(reads.page("person", 20)).toMatchObject({
    annotations: [],
    profile: { totalFacts: 0, totalCharacters: 0, readComplete: true },
  });
});

it("pages by serialized bytes without omitting facts or truncating control and Unicode evidence", () => {
  const quote = "\u0001😀".repeat(1200);
  for (let i = 0; i < 3; i++) {
    seed(`large-${i}`);
    db.prepare("UPDATE person_annotations SET evidence_quote=? WHERE id=?").run(
      quote,
      `large-${i}`,
    );
    db.prepare("UPDATE person_annotation_evidence SET evidence_quote=? WHERE annotation_id=?").run(
      quote,
      `large-${i}`,
    );
  }
  const reads = new PersonProfileReads(db);
  let page = reads.page("person", 50);
  expect(page.annotations).toHaveLength(1);
  expect(page.profile.readComplete).toBe(false);
  const ids: string[] = [];
  while (true) {
    expect(
      Buffer.byteLength(
        JSON.stringify({ kind: "structured", resultType: "annotation.search_results", data: page }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(MAX_PERSON_PROFILE_PAGE_BYTES);
    for (const row of page.annotations) {
      ids.push(row.id);
      expect(row.evidenceQuote).toBe(quote);
      expect(row.evidence[0]?.quote).toBe(quote);
    }
    if (!page.nextCursor) break;
    expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).toThrow();
    page = reads.page("person", 50, page.nextCursor);
  }
  expect(new Set(ids).size).toBe(3);
  expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).not.toThrow();
});

it("fails closed when one whole fact cannot fit and revokes a previously complete receipt", () => {
  seed("large");
  const reads = new PersonProfileReads(db);
  reads.page("person", 50);
  db.prepare("UPDATE person_annotations SET evidence_quote=? WHERE id='large'").run(
    "x".repeat(MAX_PERSON_PROFILE_PAGE_BYTES),
  );
  expect(() => reads.page("person", 50)).toThrow(/not truncated/);
  expect(() => reads.require("person", DEFAULT_PERSON_PROFILE_BUDGET)).toThrow(
    /complete current profile/,
  );
});
