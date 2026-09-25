// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A sync page containing only a tombstone commits its document and cursor
 * changes before the index and Brain stores can be cleaned. Exercise the real
 * HTTP route, writer, indexer and restart drain, including failures on each
 * side of that cross-store boundary.
 */
import "./synth-env.js";

import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { waitForCondition } from "./multi-collector-harness.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const SOURCE = "synthetic:test@example.com";
const PROVIDER = SOURCE;
const VICTIMS = ["sync-index-failure", "sync-cognition-failure"] as const;
const CONTROL = "sync-cascade-control";

let harness: SyntheticE2EHarness;
const mirrorIds = new Map<string, string>();

function withDb<T>(path: string, readonly: boolean, use: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly });
  if (!readonly) db.pragma("busy_timeout = 5000");
  try {
    return use(db);
  } finally {
    db.close();
  }
}

const gatewayDb = <T>(use: (db: Database.Database) => T, readonly = true): T =>
  withDb(harness.getDbPath(), readonly, use);
const indexDb = <T>(use: (db: Database.Database) => T, readonly = true): T =>
  withDb(join(harness.getConfigDir(), "index.db"), readonly, use);

function documentIdFor(sourceId: string, externalId: string): string {
  return gatewayDb((db) => {
    const row = db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
      .get(sourceId, externalId);
    if (!row) throw new Error(`fixture document ${externalId} did not land`);
    return row.id;
  });
}

const documentId = (externalId: string): string => documentIdFor(SOURCE, externalId);

function documentExists(externalId: string): boolean {
  return documentExistsFor(SOURCE, externalId);
}

function documentExistsFor(sourceId: string, externalId: string): boolean {
  return gatewayDb(
    (db) =>
      db
        .prepare<
          [string, string],
          { present: number }
        >("SELECT 1 AS present FROM documents WHERE source_id = ? AND external_id = ?")
        .get(sourceId, externalId) !== undefined,
  );
}

function chunkCount(id: string): number {
  return indexDb(
    (db) =>
      db
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?")
        .get(id)!.n,
  );
}

function pendingCascade(id: string): { indexDone: boolean; cognitionDone: boolean } | undefined {
  return gatewayDb((db) => {
    const rows = db
      .prepare<
        [],
        { document_ids: string; index_done: number; cognition_done: number }
      >("SELECT document_ids, index_done, cognition_done FROM snapshot_absence_cascade_outbox")
      .all();
    const row = rows.find((item) => (JSON.parse(item.document_ids) as string[]).includes(id));
    return row
      ? { indexDone: row.index_done !== 0, cognitionDone: row.cognition_done !== 0 }
      : undefined;
  });
}

function annotationExists(id: string): boolean {
  return gatewayDb(
    (db) =>
      db
        .prepare<
          [string],
          { present: number }
        >("SELECT 1 AS present FROM doc_annotations WHERE id = ?")
        .get(id) !== undefined,
  );
}

function rowExists(table: "open_loops" | "briefs" | "brief_claims", id: string): boolean {
  return gatewayDb(
    (db) =>
      db
        .prepare<[string], { present: number }>(`SELECT 1 AS present FROM ${table} WHERE id = ?`)
        .get(id) !== undefined,
  );
}

function loopId(externalId: string): string {
  return `loop-${externalId}`;
}
function briefId(externalId: string): string {
  return `brief-${externalId}`;
}
function claimId(externalId: string): string {
  return `claim-${externalId}`;
}

function seedLoopAndBrief(externalId: string, docId: string): void {
  gatewayDb(
    (db) =>
      db.transaction(() => {
        const now = Date.now();
        db.prepare(
          `INSERT INTO open_loops
         (id, created_by_run, state, confidence, importance, title, description, created_at, last_update)
       VALUES (?, 'run-sync-cascade-test', 'open', 0.8, 0.7, ?, ?, ?, ?)`,
        ).run(loopId(externalId), "Fictional project review", "Review the project note", now, now);
        db.prepare("INSERT INTO open_loop_docs (loop_id, doc_id) VALUES (?, ?)").run(
          loopId(externalId),
          docId,
        );
        db.prepare(
          `INSERT INTO briefs
         (id, created_by_run, kind, title, description, confidence, urgency, created_at, updated_at)
       VALUES (?, 'run-sync-cascade-test', 'awareness', ?, ?, 0.8, 0.5, ?, ?)`,
        ).run(
          briefId(externalId),
          "Fictional project brief",
          "A project note needs review",
          now,
          now,
        );
        db.prepare("INSERT INTO brief_citations (brief_id, position, doc_id) VALUES (?, 0, ?)").run(
          briefId(externalId),
          docId,
        );
        db.prepare("INSERT INTO brief_related_loops (brief_id, loop_id) VALUES (?, ?)").run(
          briefId(externalId),
          loopId(externalId),
        );
        db.prepare(
          `INSERT INTO brief_claims
         (id, brief_id, claim_text, evidence_doc_id, evidence_quote, claim_basis, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, 'quoted', 0.8, ?)`,
        ).run(
          claimId(externalId),
          briefId(externalId),
          "The project is scheduled for review",
          docId,
          "project review",
          now,
        );
      })(),
    false,
  );
}

function seedAnnotation(annotationId: string, docId: string): void {
  gatewayDb((db) => {
    db.prepare(
      `INSERT INTO doc_annotations
         (id, doc_id, claim_type, claim_text, evidence_doc_id, evidence_quote,
          confidence, created_by_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      annotationId,
      docId,
      "topic",
      "A fictional project has a review",
      docId,
      "project review",
      0.8,
      "run-sync-cascade-test",
      Date.now(),
    );
    db.prepare(
      `INSERT INTO doc_annotation_evidence
         (annotation_id, position, evidence_doc_id, evidence_quote)
       VALUES (?, 0, ?, ?)`,
    ).run(annotationId, docId, "project review");
  }, false);
}

async function searchIds(term: string): Promise<string[]> {
  const response = await harness.gatewayJson<{ results: Array<{ documentId: string }> }>(
    "/search",
    { method: "POST", body: JSON.stringify({ text: term, limit: 20 }) },
  );
  return response.results.map((result) => result.documentId);
}

async function deleteOnlyPage(externalId: string, cursor: number): Promise<Response> {
  const { wipeEpoch } = await harness.gatewayJson<{ wipeEpoch: number }>(
    `/sync-state/${encodeURIComponent(SOURCE)}`,
  );
  return fetch(`${harness.gatewayUrl}/documents/with-cursor`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${harness.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      providerId: PROVIDER,
      sourceId: SOURCE,
      documents: [],
      deletedExternalIds: [externalId],
      hasMore: false,
      cursor: { tombstonePage: cursor },
      wipeEpoch,
    }),
  });
}

describe("sync tombstone cascade survives derived-store failures", () => {
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      embedderBackend: "fake",
    });
    await harness.start();
    const drained = await harness.stopSyncLoopsAndDrain(60_000);
    expect(drained.timedOut).toBe(false);

    await harness.pushDocuments([
      {
        externalId: VICTIMS[0],
        title: "Cedar archive note",
        content: "Acedarivory project review is scheduled",
      },
      {
        externalId: VICTIMS[1],
        title: "Maple archive note",
        content: "Bmapleindigo project review is scheduled",
      },
      {
        externalId: CONTROL,
        title: "Pine archive note",
        content: "Cpineviolet project review is scheduled",
      },
    ]);
    for (const externalId of [...VICTIMS, CONTROL]) {
      const id = documentId(externalId);
      await waitForCondition(
        () => {
          try {
            return chunkCount(id) > 0;
          } catch {
            return false;
          }
        },
        120_000,
        `index chunks for ${externalId}`,
      );
      seedAnnotation(`annotation-${externalId}`, id);
    }
    for (const externalId of VICTIMS) {
      seedLoopAndBrief(externalId, documentId(externalId));
      // The loop's corpus projection must be taken with its parent loop.
      await harness.pushDocument({
        providerId: "system",
        sourceId: "open-loops",
        externalId: loopId(externalId),
        documentType: "open-loop",
        title: "Fictional project review",
        content: "The fictional project review is pending",
      });
      expect(documentExistsFor("open-loops", loopId(externalId))).toBe(true);
      const mirrorId = documentIdFor("open-loops", loopId(externalId));
      mirrorIds.set(externalId, mirrorId);
      await waitForCondition(
        () => {
          try {
            return chunkCount(mirrorId) > 0;
          } catch {
            return false;
          }
        },
        120_000,
        `mirror index chunks for ${externalId}`,
      );
    }
    await harness.refreshSearchSnapshot();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 30_000);

  test("an index delete failure leaves a durable cascade that a restart finishes", async () => {
    const victimId = documentId(VICTIMS[0]);
    const controlId = documentId(CONTROL);
    expect(await searchIds("Acedarivory")).toContain(victimId);
    indexDb(
      (db) =>
        db.exec(
          `CREATE TRIGGER fail_sync_index_delete BEFORE DELETE ON chunks
       WHEN OLD.document_id = '${victimId}'
       BEGIN SELECT RAISE(ABORT, 'synthetic index delete failure'); END`,
        ),
      false,
    );

    const response = await deleteOnlyPage(VICTIMS[0], 1);
    expect(response.status).toBe(500);
    expect(documentExists(VICTIMS[0])).toBe(false);
    expect(chunkCount(victimId)).toBeGreaterThan(0);
    expect(annotationExists(`annotation-${VICTIMS[0]}`)).toBe(false);
    expect(pendingCascade(victimId)).toEqual({ indexDone: false, cognitionDone: true });
    expect(rowExists("open_loops", loopId(VICTIMS[0]))).toBe(false);
    expect(rowExists("briefs", briefId(VICTIMS[0]))).toBe(false);
    expect(rowExists("brief_claims", claimId(VICTIMS[0]))).toBe(false);
    expect(documentExistsFor("open-loops", loopId(VICTIMS[0]))).toBe(false);
    const mirrorId = mirrorIds.get(VICTIMS[0])!;
    expect(chunkCount(mirrorId)).toBeGreaterThan(0);
    expect(pendingCascade(mirrorId)).toEqual({ indexDone: false, cognitionDone: false });

    await harness.restartGateway(() => {
      indexDb((db) => db.exec("DROP TRIGGER fail_sync_index_delete"), false);
    });
    await waitForCondition(
      () =>
        pendingCascade(victimId) === undefined &&
        pendingCascade(mirrorId) === undefined &&
        chunkCount(victimId) === 0 &&
        chunkCount(mirrorId) === 0 &&
        !annotationExists(`annotation-${VICTIMS[0]}`),
      120_000,
      "restarted gateway to finish the index and Brain cascade",
    );
    expect(await searchIds("Acedarivory")).not.toContain(victimId);
    expect(chunkCount(controlId)).toBeGreaterThan(0);
    expect(annotationExists(`annotation-${CONTROL}`)).toBe(true);
    expect(await searchIds("Cpineviolet")).toContain(controlId);
  }, 180_000);

  test("a Brain delete failure preserves the remaining obligation across restart", async () => {
    const victimId = documentId(VICTIMS[1]);
    const controlId = documentId(CONTROL);
    expect(await searchIds("Bmapleindigo")).toContain(victimId);
    gatewayDb(
      (db) =>
        db.exec(
          `CREATE TRIGGER fail_sync_brain_delete BEFORE DELETE ON brief_claims
       WHEN OLD.id = '${claimId(VICTIMS[1])}'
       BEGIN SELECT RAISE(ABORT, 'synthetic Brain delete failure'); END`,
        ),
      false,
    );

    const response = await deleteOnlyPage(VICTIMS[1], 2);
    const responseBody = await response.text();
    expect(response.status).toBe(500);
    expect(documentExists(VICTIMS[1]), responseBody).toBe(false);
    expect(chunkCount(victimId)).toBe(0);
    // Document annotations are purged in the primary writer transaction;
    // the claim and loop are the separate Brain cascade this trigger stops.
    expect(annotationExists(`annotation-${VICTIMS[1]}`)).toBe(false);
    expect(rowExists("brief_claims", claimId(VICTIMS[1]))).toBe(true);
    expect(rowExists("open_loops", loopId(VICTIMS[1]))).toBe(true);
    expect(documentExistsFor("open-loops", loopId(VICTIMS[1]))).toBe(true);
    const mirrorId = mirrorIds.get(VICTIMS[1])!;
    expect(chunkCount(mirrorId)).toBeGreaterThan(0);
    expect(pendingCascade(victimId)).toEqual({ indexDone: true, cognitionDone: false });

    await harness.restartGateway(() => {
      gatewayDb((db) => db.exec("DROP TRIGGER fail_sync_brain_delete"), false);
    });
    await waitForCondition(
      () =>
        pendingCascade(victimId) === undefined &&
        pendingCascade(mirrorId) === undefined &&
        !rowExists("brief_claims", claimId(VICTIMS[1])) &&
        !rowExists("open_loops", loopId(VICTIMS[1])) &&
        !documentExistsFor("open-loops", loopId(VICTIMS[1])) &&
        chunkCount(mirrorId) === 0,
      120_000,
      "restarted gateway to finish the Brain cascade",
    );
    expect(await searchIds("Bmapleindigo")).not.toContain(victimId);
    expect(chunkCount(mirrorId)).toBe(0);
    expect(chunkCount(controlId)).toBeGreaterThan(0);
    expect(annotationExists(`annotation-${CONTROL}`)).toBe(true);
    expect(await searchIds("Cpineviolet")).toContain(controlId);
  }, 180_000);
});
