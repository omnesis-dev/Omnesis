// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unified temporal Calendar E2E — the Calendar gateway contract on a
 * REAL spawned gateway with the Briefs feature active (a scripted
 * background-agent model; zero tokens — nothing here sends a model a
 * message).
 *
 * Covered:
 *  - `GET /briefs/temporal/window`: projections and annotations round-trip
 *    together with explicit provenance; origin and kind filters narrow
 *    server-side;
 *  - grounding-document changes invalidate stale annotations through the
 *    real ingestion and event paths.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitFor } from "./briefs-scorecard.js";
import { startScriptedLoopModelServer, type ScriptedLoopModelServer } from "./fake-loop-model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface TemporalItemDto {
  id: string;
  origin: "projection" | "annotation";
  start: string;
  endExclusive: string;
  precision: string;
  label: string;
  kind: string;
  projection?: {
    sourceId: string;
    documentId?: string;
    slot: string;
    revision: string;
  };
  annotation?: {
    documentIds: string[];
    projectionIds: string[];
    createdByRun: string;
    revision: number;
  };
}

describe("unified temporal Calendar (scripted backend)", () => {
  let harness: SyntheticE2EHarness;
  let server: ScriptedLoopModelServer;
  const now = Date.now();
  const deadlineId = `ta_e2e_${randomUUID().slice(0, 8)}`;
  const tripId = `ta_e2e_${randomUUID().slice(0, 8)}`;
  const projectionId = `tp_e2e_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    server = await startScriptedLoopModelServer({ behaviors: new Map() });
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "loops-test-life",
      embedderBackend: "fake",
      extraInference: {
        backends: { scripted: { type: "http", url: server.url } },
        assignments: {
          // Flips the feature gate on for the temporal annotation layer.
          "background-agent": `scripted/${server.modelId}`,
        },
      },
    });
    await harness.start();

    // Seed the store directly: one immutable source projection plus two
    // selective annotations. The
    // gateway owns the WAL; a single bounded write through a short-lived
    // handle is the established sidecar pattern (see briefs-scorecard's
    // enqueueCrashedDataRun).
    const db = new Database(harness.getDbPath());
    db.pragma("busy_timeout = 10000");
    try {
      const iso = new Date(now).toISOString();
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
           source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES ('doc_e2e_policy', 'demo-mail', 'demo-mail:inbox', 'msg_e2e_policy',
                 'Rental insurance policy — renewal terms', 'body', 'hash-e2e', ?, ?, ?, ?)`,
      ).run(iso, iso, iso, iso);
      const insertAnnotation = db.prepare(
        `INSERT INTO temporal_annotations
           (id, interval_start_ms, interval_end_ms, precision, canonical, sentence, kind,
            created_by_run, created_at, updated_at, invalidated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'run_e2e_seed', ?, ?, NULL)`,
      );
      insertAnnotation.run(
        deadlineId,
        now + 7 * DAY_MS,
        now + 8 * DAY_MS - 1,
        "day",
        new Date(now + 7 * DAY_MS).toISOString().slice(0, 10),
        "Rental insurance renewal decision is due.",
        "deadline",
        now,
        now,
      );
      insertAnnotation.run(
        tripId,
        now + 14 * DAY_MS,
        now + 20 * DAY_MS - 1,
        "range",
        "coast trip",
        "Coast trip — cottage is booked.",
        null,
        now,
        now,
      );
      db.prepare(
        "INSERT INTO temporal_annotation_documents (annotation_id, document_id) VALUES (?, 'doc_e2e_policy')",
      ).run(deadlineId);
      db.prepare(
        `INSERT INTO document_temporal_projections (
           id, source_id, document_id, document_external_id, slot,
           start_ms, end_exclusive_ms, start_canonical, end_canonical,
           precision, all_day, time_zone, label, kind, modality, status,
           source_updated_at, projected_at
         ) VALUES (?, 'demo-mail:inbox', 'doc_e2e_policy', 'msg_e2e_policy', 'scheduled',
           ?, ?, ?, ?, 'instant', 0, 'UTC', 'Policy review appointment',
           'event', 'scheduled', 'active', ?, ?)`,
      ).run(
        projectionId,
        now + 3 * DAY_MS,
        now + 3 * DAY_MS + 60 * 60 * 1000,
        new Date(now + 3 * DAY_MS).toISOString(),
        new Date(now + 3 * DAY_MS + 60 * 60 * 1000).toISOString(),
        iso,
        iso,
      );
      db.prepare(
        `INSERT OR IGNORE INTO sync_state (source_id, last_synced_at)
         VALUES ('demo-mail:inbox', ?)`,
      ).run(iso);
      db.prepare(
        `INSERT INTO document_temporal_projection_sources
           (source_id, slots_json, last_materialized_at, last_sync_at)
         VALUES ('demo-mail:inbox', '["scheduled"]', ?, ?)`,
      ).run(iso, iso);
    } finally {
      db.close();
    }
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    await server?.close();
  }, 30_000);

  const temporalWindowPath = () =>
    `/briefs/temporal/window?from=${now}&to=${now + 30 * DAY_MS}&timeZone=UTC`;

  test("the unified window returns projections and annotations with provenance and filters", async () => {
    const body = await harness.gatewayJson<{
      nowMs: number;
      items: TemporalItemDto[];
      coverage: {
        projectionSources: Array<{ sourceId: string; slots: string[] }>;
        annotations: { selective: boolean };
      };
      truncated: boolean;
    }>(temporalWindowPath());
    expect(typeof body.nowMs).toBe("number");
    expect(body.truncated).toBe(false);
    const byId = new Map(body.items.map((item) => [item.id, item]));
    const projection = byId.get(projectionId);
    expect(projection).toMatchObject({
      origin: "projection",
      label: "Policy review appointment",
      kind: "event",
      precision: "instant",
      projection: {
        sourceId: "demo-mail:inbox",
        documentId: "doc_e2e_policy",
        slot: "scheduled",
      },
    });
    expect(projection?.projection?.revision).toEqual(expect.any(String));
    const deadline = byId.get(deadlineId);
    expect(deadline).toMatchObject({
      origin: "annotation",
      label: "Rental insurance renewal decision is due.",
      kind: "deadline",
      precision: "day",
      annotation: {
        documentIds: ["doc_e2e_policy"],
        projectionIds: [],
        createdByRun: "run_e2e_seed",
        revision: 1,
      },
    });
    expect(byId.get(tripId)).toMatchObject({
      origin: "annotation",
      label: "Coast trip — cottage is booked.",
    });
    expect(body.coverage.annotations.selective).toBe(true);
    expect(body.coverage.projectionSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "demo-mail:inbox", slots: ["scheduled"] }),
      ]),
    );

    const filtered = await harness.gatewayJson<{ items: TemporalItemDto[] }>(
      `${temporalWindowPath()}&origins=annotation&kinds=deadline,expiry,reminder`,
    );
    expect(filtered.items.map((item) => item.id)).toEqual([deadlineId]);
  });

  test("a content change judges annotations by their evidence atoms end-to-end", async () => {
    // Ingest a document through the REAL push path (so the re-push below
    // emits document.upserted with contentChanged), then link two
    // annotations to it: one grounded by a quote from the content, one with
    // no atoms at all.
    const externalId = `temporal-e2e-lease-${randomUUID().slice(0, 8)}`;
    await harness.pushDocument({
      externalId,
      documentType: "note",
      title: "Lease renewal notice",
      content: "The renewal window closes on the 14th.",
    });
    const db = new Database(harness.getDbPath());
    db.pragma("busy_timeout = 10000");
    const groundedId = `ta_e2e_${randomUUID().slice(0, 8)}`;
    const ungroundedId = `ta_e2e_${randomUUID().slice(0, 8)}`;
    try {
      const doc = db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(externalId);
      expect(doc).toBeDefined();
      const insertAnnotation = db.prepare(
        `INSERT INTO temporal_annotations
           (id, interval_start_ms, interval_end_ms, precision, canonical, sentence, kind,
            created_by_run, created_at, updated_at, invalidated_at)
         VALUES (?, ?, ?, 'day', ?, ?, 'deadline',
                 'run_e2e_seed', ?, ?, NULL)`,
      );
      const day = new Date(now + 25 * DAY_MS).toISOString().slice(0, 10);
      insertAnnotation.run(
        groundedId,
        now + 25 * DAY_MS,
        now + 26 * DAY_MS - 1,
        day,
        "Lease renewal window closes.",
        now,
        now,
      );
      insertAnnotation.run(
        ungroundedId,
        now + 25 * DAY_MS,
        now + 26 * DAY_MS - 1,
        day,
        "Landlord walkthrough expected around the renewal.",
        now,
        now,
      );
      const link = db.prepare(
        "INSERT INTO temporal_annotation_documents (annotation_id, document_id) VALUES (?, ?)",
      );
      link.run(groundedId, doc!.id);
      link.run(ungroundedId, doc!.id);
      db.prepare(
        `INSERT INTO temporal_annotation_evidence (annotation_id, position, document_id, quote)
         VALUES (?, 0, ?, ?)`,
      ).run(groundedId, doc!.id, "renewal window closes on the 14th");
    } finally {
      db.close();
    }
    const windowPath = `${temporalWindowPath()}&origins=annotation`;
    const before = await harness.gatewayJson<{ items: TemporalItemDto[] }>(windowPath);
    expect(before.items.some((item) => item.id === groundedId)).toBe(true);
    expect(before.items.some((item) => item.id === ungroundedId)).toBe(true);

    // Same external id, new content dropping the grounded entry's quote —
    // the upsert path fires document.upserted with contentChanged, and the
    // invalidator (wired at boot behind the active feature gate) breaks the
    // atom and drops the grounded annotation.
    await harness.pushDocument({
      externalId,
      documentType: "note",
      title: "Lease renewal notice",
      content: "UPDATE: the renewal window moved to the 28th.",
    });
    await waitFor(
      "grounded annotation invalidated after its quote broke",
      async () => {
        const after = await harness.gatewayJson<{ items: TemporalItemDto[] }>(windowPath);
        return after.items.some((item) => item.id === groundedId) ? null : true;
      },
      20_000,
      250,
    );
    // The atom-less sibling has no quote to judge it by — the change is no
    // evidence against it, so it survives the same cascade (the woken data
    // run re-checks it instead).
    const after = await harness.gatewayJson<{ items: TemporalItemDto[] }>(windowPath);
    expect(after.items.some((item) => item.id === ungroundedId)).toBe(true);
  });
});
