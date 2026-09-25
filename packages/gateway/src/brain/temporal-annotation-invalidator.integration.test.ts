// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Content-change invalidation of temporal annotations, wired end to end: a
 * real document upsert through `DocumentService.ingest` → the
 * `document.upserted` event `EventService` emits → the subscriber's read
 * guard → the write gate's surgical storage op, all on a real SQLite file
 * with an injectable clock.
 *
 * The unit suites either drive the storage function directly or stub the
 * invalidate seam, so neither can tell whether a real ingest reaches it with
 * the right document id, the right `contentChanged` verdict, and content the
 * quote test can actually read. That join is what this file covers: a quote
 * surviving an append keeps its annotation, losing the quote invalidates it
 * with cause `content_change`, restoring the quote heals the atom and
 * resurrects the entry, a deliberate delete never comes back, one broken atom
 * of two leaves the annotation standing, and a metadata-only upsert changes
 * nothing.
 *
 * The `invalidate` closure is the production wiring from `feature-gate.ts`
 * (`writeGate.invalidateTemporalAnnotationsForDoc`) with the returned promise
 * recorded, so the test can await a hop the hot path deliberately does not.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import { EventBus } from "../events.js";
import { directWriteGate, type WriteGate } from "../write-gate.js";
import { DocumentService } from "../http/services/DocumentService.js";
import { SourceDataRemovalService } from "../http/services/SourceDataRemovalService.js";
import { EventService } from "../http/services/EventService.js";
import {
  insertTemporalAnnotation,
  listTemporalAnnotationEvidence,
  listTemporalAnnotationsAwaitingRefile,
  type TemporalAnnotationEvidenceRow,
  type TemporalAnnotationInvalidationResult,
} from "../enrichment/temporal-annotations/storage.js";
import { subscribeTemporalAnnotationInvalidator } from "./temporal-annotation-invalidator.js";
import type { Db } from "../data/types.js";
import type { Logger } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";

const NOW = Date.parse("2026-07-08T12:00:00Z");
const PROVIDER = "google" as DocumentInput["providerId"];
const SOURCE = "gmail:maya.reeves@example.com" as DocumentInput["sourceId"];

/** The rehearsal thread's first version — the grounding quote lives here. */
const PLAN_V1 = [
  "Maya Reeves confirmed the Studio Northstar rehearsal for 20 July 2026.",
  "Jamie Lopez is drafting the stage plan.",
].join("\n");

/** The quote the annotation is grounded in. */
const PLAN_QUOTE = "confirmed the Studio Northstar rehearsal for 20 July 2026";

/** An edit that appends without touching the quote. */
const PLAN_APPENDED = `${PLAN_V1}\nDavid Lin is booking the van.`;

/** An edit that removes the quote outright. */
const PLAN_QUOTE_REMOVED = [
  "Maya Reeves cancelled the Studio Northstar booking.",
  "Jamie Lopez is drafting the stage plan.",
].join("\n");

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

let db: Db;
let dbPath: string;
let writeGate: WriteGate;
let bus: EventBus;
let documents: DocumentService;
/** Read by the subscriber's clock seam; advanced by the tests. */
let now: number;
/** How many times the wiring reached the write gate. */
let invalidateCalls: number;
/** In-flight invalidate promises the hot path fires without awaiting. */
let pending: Promise<TemporalAnnotationInvalidationResult>[];

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/**
 * A document page as a source would post it. The content hash is derived from
 * the body so identical content always hashes identically — the quote test's
 * normalized-body cache is keyed on that hash, and a hash reused across
 * different bodies would serve it a stale haystack.
 */
function docInput(externalId: string, content: string, title = "Rehearsal plan"): DocumentInput {
  return {
    providerId: PROVIDER,
    sourceId: SOURCE,
    externalId,
    title,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    metadata: {},
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
  };
}

async function ingest(externalId: string, content: string, title?: string): Promise<void> {
  await documents.ingest([docInput(externalId, content, title)]);
}

/** Await every invalidate the ingests since the last settle kicked off. */
async function settle(): Promise<TemporalAnnotationInvalidationResult[]> {
  const results = await Promise.all(pending);
  pending = [];
  return results;
}

/** Ingest, then wait for the fire-and-forget invalidation to finish. */
async function ingestAndSettle(
  externalId: string,
  content: string,
  title?: string,
): Promise<TemporalAnnotationInvalidationResult[]> {
  await ingest(externalId, content, title);
  return settle();
}

function docId(externalId: string): string {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  if (!row) throw new Error(`document ${externalId} was not ingested`);
  return row.id;
}

interface AnnotationState {
  invalidatedAt: number | null;
  cause: string | null;
  revision: number;
}

function annotationState(id: string): AnnotationState {
  const row = db
    .prepare<
      [string],
      { invalidated_at: number | null; invalidation_cause: string | null; revision: number }
    >("SELECT invalidated_at, invalidation_cause, revision FROM temporal_annotations WHERE id = ?")
    .get(id);
  if (!row) throw new Error(`annotation ${id} not found`);
  return {
    invalidatedAt: row.invalidated_at,
    cause: row.invalidation_cause,
    revision: row.revision,
  };
}

function atoms(annotationId: string): TemporalAnnotationEvidenceRow[] {
  return listTemporalAnnotationEvidence(db, annotationId);
}

/** Seed one day-precision entry grounded in `evidence`, an hour before NOW. */
function seedAnnotation(
  id: string,
  documentIds: readonly string[],
  evidence: readonly { docId: string; quote: string }[],
  sentence = "Studio Northstar rehearsal is booked",
): void {
  insertTemporalAnnotation(
    db,
    {
      id,
      intervalStartMs: Date.UTC(2026, 6, 20),
      intervalEndMs: Date.UTC(2026, 6, 21) - 1,
      precision: "day",
      canonical: "2026-07-20",
      sentence,
      kind: "event",
      documentIds,
      evidence,
      createdByRun: "run_seed",
    },
    NOW - 3_600_000,
  );
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  writeGate = directWriteGate(db);
  bus = new EventBus();
  now = NOW;
  invalidateCalls = 0;
  pending = [];
  documents = new DocumentService({
    db,
    writeGate,
    events: new EventService(db, bus, false),
    sourceDataRemoval: new SourceDataRemovalService({
      db,
      writeGate,
      purgeAnnotationsFor: async () => {},
    }),
  });
  subscribeTemporalAnnotationInvalidator({
    db,
    eventBus: bus,
    invalidate: (id, at) => {
      invalidateCalls += 1;
      const result = writeGate.invalidateTemporalAnnotationsForDoc(id, at);
      pending.push(result);
      return result;
    },
    isEnabled: () => true,
    clock: () => now,
    log: silentLog,
  });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("a change that leaves the quote standing", () => {
  test("an append keeps the annotation, its atom, and reports it kept", async () => {
    await ingest("plan", PLAN_V1);
    const plan = docId("plan");
    seedAnnotation("tix_plan", [plan], [{ docId: plan, quote: PLAN_QUOTE }]);

    now = NOW + 1_000;
    const [result] = await ingestAndSettle("plan", PLAN_APPENDED);

    expect(invalidateCalls).toBe(1);
    expect(result).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(annotationState("tix_plan").invalidatedAt).toBeNull();
    expect(atoms("tix_plan")).toHaveLength(1);
    expect(atoms("tix_plan")[0].brokenAt).toBeNull();
  });
});

describe("a change that drops the quote", () => {
  test("the atom breaks and the annotation is invalidated as content_change", async () => {
    await ingest("plan", PLAN_V1);
    const plan = docId("plan");
    seedAnnotation("tix_plan", [plan], [{ docId: plan, quote: PLAN_QUOTE }]);

    now = NOW + 1_000;
    const [result] = await ingestAndSettle("plan", PLAN_QUOTE_REMOVED);

    expect(result).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(annotationState("tix_plan")).toMatchObject({
      invalidatedAt: NOW + 1_000,
      cause: "content_change",
    });
    expect(atoms("tix_plan")[0].brokenAt).toBe(NOW + 1_000);
  });

  test("restoring the quote heals the atom and resurrects the annotation", async () => {
    await ingest("plan", PLAN_V1);
    const plan = docId("plan");
    seedAnnotation("tix_plan", [plan], [{ docId: plan, quote: PLAN_QUOTE }]);

    now = NOW + 1_000;
    await ingestAndSettle("plan", PLAN_QUOTE_REMOVED);
    expect(annotationState("tix_plan").cause).toBe("content_change");

    // The operator (or the source) puts the sentence back.
    now = NOW + 2_000;
    const [result] = await ingestAndSettle("plan", PLAN_V1);

    expect(invalidateCalls).toBe(2);
    expect(result).toEqual({
      invalidated: 0,
      kept: 0,
      atomsBroken: 0,
      atomsHealed: 1,
      resurrected: 1,
    });
    expect(annotationState("tix_plan")).toMatchObject({
      invalidatedAt: null,
      cause: null,
    });
    expect(atoms("tix_plan")[0].brokenAt).toBeNull();
  });
});

describe("a deliberately deleted annotation", () => {
  test("stays deleted when its document changes, and never joins the re-file set", async () => {
    // One document grounds two entries. The deleted one's quote SURVIVES the
    // change, so a candidate filter that forgot to exclude cause 'deleted'
    // would resurrect it; the live one's quote does not, so it becomes the
    // churn casualty the data run is meant to re-file.
    const stageQuote = "Jamie Lopez is drafting the stage plan";
    await ingest("plan", PLAN_V1);
    const plan = docId("plan");
    seedAnnotation("tix_rehearsal", [plan], [{ docId: plan, quote: PLAN_QUOTE }]);
    seedAnnotation(
      "tix_stage_plan",
      [plan],
      [{ docId: plan, quote: stageQuote }],
      "Stage plan is being drafted",
    );

    await writeGate.invalidateTemporalAnnotation("tix_rehearsal", NOW - 60_000);
    const deletedBefore = annotationState("tix_rehearsal");
    expect(deletedBefore.cause).toBe("deleted");

    // Keeps the rehearsal quote, drops the stage-plan one.
    now = NOW + 1_000;
    const [result] = await ingestAndSettle(
      "plan",
      "Maya Reeves confirmed the Studio Northstar rehearsal for 20 July 2026.",
    );

    expect(result).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    // Untouched: same invalidation stamp, same cause, same revision.
    expect(annotationState("tix_rehearsal")).toEqual(deletedBefore);
    expect(atoms("tix_rehearsal")[0].brokenAt).toBeNull();
    expect(annotationState("tix_stage_plan").cause).toBe("content_change");

    // The data run's re-file block sees the churn casualty only — re-filing a
    // curated-away entry would undo the delete.
    const casualties = listTemporalAnnotationsAwaitingRefile(db, plan, 10);
    expect(casualties.map((c) => c.id)).toEqual(["tix_stage_plan"]);
  });
});

describe("an annotation grounded in two documents", () => {
  test("survives losing one atom while the other holds", async () => {
    const contractV1 = "Studio Northstar holds the hall until 21 July 2026.";
    const contractQuote = "holds the hall until 21 July 2026";
    await ingest("plan", PLAN_V1);
    await ingest("contract", contractV1);
    const plan = docId("plan");
    const contract = docId("contract");
    seedAnnotation(
      "tix_booking",
      [plan, contract],
      [
        { docId: plan, quote: PLAN_QUOTE },
        { docId: contract, quote: contractQuote },
      ],
    );

    now = NOW + 1_000;
    const [result] = await ingestAndSettle("plan", PLAN_QUOTE_REMOVED);

    expect(result).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(annotationState("tix_booking").invalidatedAt).toBeNull();
    const [planAtom, contractAtom] = atoms("tix_booking");
    expect(planAtom).toMatchObject({ documentId: plan, brokenAt: NOW + 1_000 });
    expect(contractAtom).toMatchObject({ documentId: contract, brokenAt: null });
  });
});

describe("a metadata-only upsert", () => {
  test("never reaches the write gate and leaves the annotation alone", async () => {
    await ingest("plan", PLAN_V1);
    const plan = docId("plan");
    seedAnnotation("tix_plan", [plan], [{ docId: plan, quote: PLAN_QUOTE }]);

    // Same body and hash, different title: the event fires with
    // contentChanged false, which the subscriber must drop.
    now = NOW + 1_000;
    const results = await ingestAndSettle("plan", PLAN_V1, "Rehearsal plan (final)");

    expect(results).toEqual([]);
    expect(invalidateCalls).toBe(0);
    expect(annotationState("tix_plan").invalidatedAt).toBeNull();
    expect(atoms("tix_plan")[0].brokenAt).toBeNull();
  });
});
