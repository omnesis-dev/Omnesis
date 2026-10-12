// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { insertTemporalAnnotation } from "../../enrichment/temporal-annotations/storage.js";
import { advanceKnowledgeCascade } from "./storage-invalidation.js";
import {
  captureTemporalDocumentReceipt,
  temporalDocumentReceiptCurrent,
} from "./temporal-document-epochs.js";

let db: ReturnType<typeof createDatabase>;
function document(id: string) {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES(?,'test','fixture',?,'Example','Example source','body','{}','2032-01-01','2032-01-01','2032-01-01','2032-01-01')`,
  ).run(id, id);
}
function annotation(id: string, documentIds: string[]) {
  insertTemporalAnnotation(
    db,
    {
      id,
      intervalStartMs: 1,
      intervalEndMs: 2,
      precision: "day",
      canonical: "2032-01-01",
      sentence: "An invented event.",
      documentIds,
      createdByRun: "run",
    },
    1,
  );
}
function receipt(...ids: string[]) {
  return captureTemporalDocumentReceipt(db, ids)!;
}
beforeEach(() => {
  db = createDatabase(":memory:");
  document("a");
  document("b");
});
afterEach(() => db.close());

it("keeps disjoint negative reads current and rejects overlapping creation and ABA", () => {
  const a = receipt("a"),
    b = receipt("b");
  annotation("event", ["a"]);
  expect(temporalDocumentReceiptCurrent(db, a)).toBe(false);
  expect(temporalDocumentReceiptCurrent(db, b)).toBe(true);
  db.exec("DELETE FROM temporal_annotations WHERE id='event'");
  expect(temporalDocumentReceiptCurrent(db, a)).toBe(false);
});
it("guards both old and new document membership and annotation subject changes", () => {
  annotation("event", ["a"]);
  const a = receipt("a"),
    b = receipt("b");
  db.exec("UPDATE temporal_annotation_documents SET document_id='b' WHERE annotation_id='event'");
  expect(temporalDocumentReceiptCurrent(db, a)).toBe(false);
  expect(temporalDocumentReceiptCurrent(db, b)).toBe(false);
  const before = receipt("b");
  db.exec("INSERT INTO temporal_annotation_people VALUES('event','fictional-person')");
  expect(temporalDocumentReceiptCurrent(db, before)).toBe(false);
});
it.each([
  "UPDATE temporal_annotations SET invalidated_at=3 WHERE id='event'",
  "INSERT INTO temporal_annotation_projections VALUES('event','tp_example')",
  "INSERT INTO temporal_annotation_evidence(annotation_id,position,document_id,quote) VALUES('event',0,'b','Example')",
])("tracks scalar and child writes without relying on the annotation revision: %s", (sql) => {
  annotation("event", ["a"]);
  const before = receipt("a");
  db.exec(sql);
  expect(temporalDocumentReceiptCurrent(db, before)).toBe(false);
});
it("rolls back counters together with the mutation", () => {
  const before = receipt("a");
  expect(() =>
    db.transaction(() => {
      annotation("event", ["a"]);
      throw Error("rollback");
    })(),
  ).toThrow("rollback");
  expect(temporalDocumentReceiptCurrent(db, before)).toBe(true);
});
it("erases document keys but resets outstanding negative receipts across recreation", () => {
  annotation("event", ["a"]);
  const before = receipt("a"),
    other = receipt("b");
  db.prepare("DELETE FROM documents WHERE id=?").run("a");
  expect(
    db.prepare("SELECT * FROM knowledge_temporal_document_epochs WHERE document_id='a'").get(),
  ).toBeUndefined();
  expect(advanceKnowledgeCascade(db, 100, 10).pending).toBe(false);
  document("a");
  expect(temporalDocumentReceiptCurrent(db, before)).toBe(false);
  expect(temporalDocumentReceiptCurrent(db, other)).toBe(false);
});
it("fences document metadata, source identity and source removal", () => {
  const before = receipt("a");
  db.exec("UPDATE documents SET title='Changed title' WHERE id='a'");
  expect(temporalDocumentReceiptCurrent(db, before)).toBe(false);
  const next = receipt("a");
  db.exec("UPDATE documents SET source_id='another-source' WHERE id='a'");
  expect(temporalDocumentReceiptCurrent(db, next)).toBe(false);
  db.exec("UPDATE documents SET source_id='fixture' WHERE id='a'");
  expect(temporalDocumentReceiptCurrent(db, next)).toBe(false);
});
it("bounds explicit scope and legacy fanout while retaining the normal 100-link path", () => {
  expect(captureTemporalDocumentReceipt(db, [])).toBeNull();
  expect(
    captureTemporalDocumentReceipt(
      db,
      Array.from({ length: 17 }, () => "a"),
    ),
  ).toBeNull();
  const ids = Array.from({ length: 130 }, (_, i) => `doc-${i}`);
  for (const id of ids) document(id);
  const reset = receipt("b").reset;
  annotation("normal", ids.slice(0, 100));
  expect(receipt("b").reset).toBe(reset);
  expect(
    db.prepare("SELECT COUNT(*) n FROM knowledge_temporal_document_epochs").get(),
  ).toMatchObject({ n: 100 });
  annotation("legacy", ids);
  expect(receipt("b").reset).toBeGreaterThan(reset);
});

it("tracks loop linkage, evidence moves, and physical deletion before cascades", () => {
  annotation("event", ["a"]);
  db.exec(
    "INSERT INTO open_loops(id,created_by_run,confidence,importance,title,created_at,last_update) VALUES('loop','run',1,1,'Invented loop',1,1)",
  );
  const beforeLoop = receipt("a");
  db.exec("INSERT INTO temporal_annotation_loops VALUES('event','loop')");
  expect(temporalDocumentReceiptCurrent(db, beforeLoop)).toBe(false);
  db.exec(
    "INSERT INTO temporal_annotation_evidence(annotation_id,position,document_id,quote) VALUES('event',0,'a','Example')",
  );
  const a = receipt("a"),
    b = receipt("b");
  db.exec("UPDATE temporal_annotation_evidence SET document_id='b' WHERE annotation_id='event'");
  expect(temporalDocumentReceiptCurrent(db, a)).toBe(false);
  expect(temporalDocumentReceiptCurrent(db, b)).toBe(false);
  const linked = receipt("a");
  db.exec("DELETE FROM temporal_annotations WHERE id='event'");
  expect(temporalDocumentReceiptCurrent(db, linked)).toBe(false);
});

it("installs after historical migrations and preserves counters on reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "temporal-epoch-reopen-"));
  const path = join(directory, "state.db");
  let fileDb: ReturnType<typeof createDatabase> | undefined;
  try {
    fileDb = createDatabase(path);
    fileDb.exec(
      "INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at) VALUES('persisted','test','fixture','persisted','Example','Example','body','{}','2032-01-01','2032-01-01','2032-01-01','2032-01-01')",
    );
    const before = captureTemporalDocumentReceipt(fileDb, ["persisted"])!;
    fileDb.close();
    fileDb = createDatabase(path);
    expect(temporalDocumentReceiptCurrent(fileDb, before)).toBe(true);
    insertTemporalAnnotation(
      fileDb,
      {
        id: "persisted-event",
        intervalStartMs: 1,
        intervalEndMs: 2,
        precision: "day",
        canonical: "2032-01-01",
        sentence: "A fictional observation.",
        documentIds: ["persisted"],
        createdByRun: "run",
      },
      1,
    );
    expect(temporalDocumentReceiptCurrent(fileDb, before)).toBe(false);
    const after = captureTemporalDocumentReceipt(fileDb, ["persisted"])!;
    fileDb.close();
    fileDb = createDatabase(path);
    expect(temporalDocumentReceiptCurrent(fileDb, after)).toBe(true);
  } finally {
    fileDb?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
