// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A sync page containing only a tombstone commits its document and cursor
 * changes before the index and Brain cascades finish. Exercise the real HTTP
 * route, writer, indexer and restart drain, including failures on each side of
 * that cross-store boundary. The document's own rows always go; what the Brain
 * built on it (an annotation, a loop and its mirror, an observation) is kept,
 * loses its link to the document and is queued for review.
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
      .prepare<[string, string], { id: string }>(
        "SELECT id FROM documents WHERE source_id = ? AND external_id = ?",
      )
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
        .prepare<[string, string], { present: number }>(
          "SELECT 1 AS present FROM documents WHERE source_id = ? AND external_id = ?",
        )
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
      .prepare<[], { document_ids: string; index_done: number; cognition_done: number }>(
        "SELECT document_ids, index_done, cognition_done FROM snapshot_absence_cascade_outbox",
      )
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
        .prepare<[string], { present: number }>(
          "SELECT 1 AS present FROM doc_annotations WHERE id = ?",
        )
        .get(id) !== undefined,
  );
}

/** A kept annotation's liveness and verification state. */
function annotationState(
  id: string,
): { invalidated_at: number | null; verification_state: string | null } | undefined {
  return gatewayDb((db) =>
    db
      .prepare<[string], { invalidated_at: number | null; verification_state: string | null }>(
        "SELECT invalidated_at, verification_state FROM doc_annotations WHERE id = ?",
      )
      .get(id),
  );
}

/** Whether a loop still links to a document. */
function loopCites(loop: string, docId: string): boolean {
  return gatewayDb(
    (db) =>
      db
        .prepare("SELECT 1 FROM open_loop_docs WHERE loop_id = ? AND doc_id = ?")
        .get(loop, docId) !== undefined,
  );
}

function rowExists(table: "open_loops" | "observations", id: string): boolean {
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
function observationId(externalId: string): string {
  return `obs-${externalId}`;
}

function seedLoopAndObservation(externalId: string, docId: string): void {
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
          `INSERT INTO observations
         (id, created_by_run, summary, why, claims_json, created_at, updated_at)
       VALUES (?, 'run-sync-cascade-test', ?, ?, ?, ?, ?)`,
        ).run(
          observationId(externalId),
          "A project note needs review",
          "The project is scheduled for review",
          JSON.stringify([{ docId, quote: "project review", verification: "unverified" }]),
          now,
          now,
        );
        db.prepare(
          "INSERT INTO observation_citations (observation_id, position, doc_id) VALUES (?, 0, ?)",
        ).run(observationId(externalId), docId);
        db.prepare(
          "INSERT INTO observation_related_loops (observation_id, loop_id) VALUES (?, ?)",
        ).run(observationId(externalId), loopId(externalId));
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
      seedLoopAndObservation(externalId, documentId(externalId));
      // The loop's corpus projection stays with its parent loop.
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
    expect(pendingCascade(victimId)).toEqual({ indexDone: false, cognitionDone: true });
    // What the Brain built on the document is kept, unlinked and queued for review.
    expect(annotationState(`annotation-${VICTIMS[0]}`)).toEqual({
      invalidated_at: null,
      verification_state: "unverified",
    });
    expect(rowExists("open_loops", loopId(VICTIMS[0]))).toBe(true);
    expect(loopCites(loopId(VICTIMS[0]), victimId)).toBe(false);
    expect(rowExists("observations", observationId(VICTIMS[0]))).toBe(true);
    expect(documentExistsFor("open-loops", loopId(VICTIMS[0]))).toBe(true);
    const mirrorId = mirrorIds.get(VICTIMS[0])!;
    expect(pendingCascade(mirrorId)).toBeUndefined();

    await harness.restartGateway(() => {
      indexDb((db) => db.exec("DROP TRIGGER fail_sync_index_delete"), false);
    });
    await waitForCondition(
      () => pendingCascade(victimId) === undefined && chunkCount(victimId) === 0,
      120_000,
      "restarted gateway to finish the index cascade",
    );
    expect(await searchIds("Acedarivory")).not.toContain(victimId);
    expect(annotationState(`annotation-${VICTIMS[0]}`)?.invalidated_at).toBeNull();
    expect(rowExists("open_loops", loopId(VICTIMS[0]))).toBe(true);
    expect(chunkCount(mirrorId)).toBeGreaterThan(0);
    expect(chunkCount(controlId)).toBeGreaterThan(0);
    expect(annotationExists(`annotation-${CONTROL}`)).toBe(true);
    expect(await searchIds("Cpineviolet")).toContain(controlId);
  }, 180_000);

  test("a Brain cascade failure preserves the remaining obligation across restart", async () => {
    const victimId = documentId(VICTIMS[1]);
    const controlId = documentId(CONTROL);
    expect(await searchIds("Bmapleindigo")).toContain(victimId);
    // The cascade's coverage arm retracts the coverage of a source that no
    // longer exists; failing it stops the Brain cascade after the writer
    // transaction committed.
    gatewayDb((db) => {
      db.prepare(
        `INSERT INTO cognition_coverage (source_id, workflow_id, workflow_version, eligible, processed, skipped, prompt_tokens, completion_tokens, last_progress_at, status)
         VALUES ('fictional:removed@example.com', 'wf', 1, 1, 1, 0, 0, 0, 1, 'live')`,
      ).run();
      db.exec(
        `CREATE TRIGGER fail_sync_brain_cascade BEFORE DELETE ON cognition_coverage
         BEGIN SELECT RAISE(ABORT, 'synthetic Brain cascade failure'); END`,
      );
    }, false);

    const response = await deleteOnlyPage(VICTIMS[1], 2);
    const responseBody = await response.text();
    expect(response.status).toBe(500);
    expect(documentExists(VICTIMS[1]), responseBody).toBe(false);
    expect(chunkCount(victimId)).toBe(0);
    // The review of what the Brain built on the document is part of the
    // deleting transaction, so it landed whatever happened after.
    expect(annotationState(`annotation-${VICTIMS[1]}`)?.verification_state).toBe("unverified");
    expect(rowExists("observations", observationId(VICTIMS[1]))).toBe(true);
    expect(rowExists("open_loops", loopId(VICTIMS[1]))).toBe(true);
    expect(loopCites(loopId(VICTIMS[1]), victimId)).toBe(false);
    expect(documentExistsFor("open-loops", loopId(VICTIMS[1]))).toBe(true);
    expect(pendingCascade(victimId)).toEqual({ indexDone: true, cognitionDone: false });

    await harness.restartGateway(() => {
      gatewayDb((db) => db.exec("DROP TRIGGER fail_sync_brain_cascade"), false);
    });
    await waitForCondition(
      () => pendingCascade(victimId) === undefined,
      120_000,
      "restarted gateway to finish the Brain cascade",
    );
    expect(await searchIds("Bmapleindigo")).not.toContain(victimId);
    expect(rowExists("observations", observationId(VICTIMS[1]))).toBe(true);
    expect(rowExists("open_loops", loopId(VICTIMS[1]))).toBe(true);
    expect(documentExistsFor("open-loops", loopId(VICTIMS[1]))).toBe(true);
    expect(
      gatewayDb((db) =>
        db
          .prepare(
            "SELECT 1 FROM cognition_coverage WHERE source_id = 'fictional:removed@example.com'",
          )
          .get(),
      ),
    ).toBeUndefined();
    expect(chunkCount(controlId)).toBeGreaterThan(0);
    expect(annotationExists(`annotation-${CONTROL}`)).toBe(true);
    expect(await searchIds("Cpineviolet")).toContain(controlId);
  }, 180_000);
});
