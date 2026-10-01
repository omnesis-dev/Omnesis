// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../../enrichment/dates/storage.js";
import { insertTemporalAnnotation } from "../../enrichment/temporal-annotations/storage.js";
import type { StatusCache } from "../services/StatusCache.js";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";

describe("GET /temporal/window", () => {
  let db: Database.Database;
  let dbPath: string;
  let statusCache: StatusCache | undefined;
  let gateActive = false;
  let app: ReturnType<typeof createServer>;
  let token: string;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
    token = createToken(db, device.id, [SCOPE_ADMIN]).token;
    gateActive = false;
    // The Brain is off: no briefs feature status at all.
    app = createServer(db, dbPath, {
      mentionWorthGateActive: () => gateActive,
      onStatusCache: (cache) => {
        statusCache = cache;
      },
    });
  });

  afterEach(() => {
    statusCache?.stop();
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  function seedMention(externalId: string, verdict?: "keep" | "drop"): string {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: "fictional-mail:primary" as DocumentInput["sourceId"],
      externalId,
      title: `Subject ${externalId}`,
      content: "See you on 12 October 2026.",
      contentHash: `hash-${externalId}`,
      metadata: { documentType: "email" },
      sourceCreatedAt: "2026-10-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-10-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    const id = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
    applyExtractedDates(db, [
      {
        id,
        dates: [
          {
            kind: "date",
            resolvedStart: "2026-10-12",
            resolvedEnd: null,
            relative: false,
            text: "12 October 2026",
            timex: "2026-10-12",
            charStart: 11,
            charEnd: 26,
          },
        ],
        mentions: [{ startDay: "2026-10-12", endDay: "2026-10-13", deadline: false }],
        threadKey: null,
      },
    ]);
    if (verdict) {
      db.prepare("UPDATE date_mention_judgements SET verdict = ? WHERE document_id = ?").run(
        verdict,
        id,
      );
    }
    return id;
  }

  const read = async (origins = "projection,annotation,mention") => {
    const from = Date.UTC(2026, 9, 12);
    const res = await app.request(
      `/temporal/window?from=${from}&to=${from + 86_400_000}&timeZone=UTC&origins=${origins}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      items: Array<{ origin: string; mention?: { documentId: string } }>;
      coverage: { mentions?: { unworthyHidden?: true } };
    };
  };

  test("serves date mentions with the Brain off, and hides unworthy mail while the gate is active", async () => {
    const kept = seedMention("kept", "keep");
    const dropped = seedMention("dropped", "drop");

    const all = await read();
    expect(all.items.map((item) => item.mention?.documentId).sort()).toEqual(
      [kept, dropped].sort(),
    );
    expect(all.coverage.mentions?.unworthyHidden).toBeUndefined();

    gateActive = true;
    const gated = await read();
    expect(gated.items.map((item) => item.mention?.documentId)).toEqual([kept]);
    expect(gated.coverage.mentions?.unworthyHidden).toBe(true);

    // Mentions come only when named.
    expect((await read("projection,annotation")).items).toEqual([]);
  });

  test("opens a recognized date directly in the requested zone, even outside the current window", async () => {
    const documentId = seedMention("direct-date", "drop");
    const row = db
      .prepare("SELECT id FROM document_extracted_dates WHERE document_id = ?")
      .get(documentId) as { id: number };
    const id = `dm_${String(row.id).padStart(16, "0")}`;
    gateActive = true;
    const url = `/temporal/items/${id}?timeZone=America%2FLos_Angeles`;
    const response = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      item: {
        id,
        origin: "mention",
        start: "2026-10-12T07:00:00.000Z",
        endExclusive: "2026-10-13T07:00:00.000Z",
        mention: { documentId },
      },
    });
    expect((await app.request(url)).status).toBe(401);
    expect(
      (
        await app.request(`/temporal/items/${id}?timeZone=invalid`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);

    // Editing a document retires its old recognized dates until extraction completes.
    db.prepare("UPDATE documents SET dates_extracted_at = NULL WHERE id = ?").run(documentId);
    expect((await app.request(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      404,
    );
  });

  test.each(["annotations", "items"])(
    "%s detail returns live annotation quotes and rejects missing or invalidated notes",
    async (endpoint) => {
      const documentId = seedMention("annotation-support");
      insertTemporalAnnotation(
        db,
        {
          id: "ta_calendar_detail",
          intervalStartMs: Date.UTC(2026, 9, 12),
          intervalEndMs: Date.UTC(2026, 9, 12, 23, 59, 59, 999),
          precision: "day",
          canonical: "2026-10-12",
          sentence: "A design review is planned for 12 October.",
          kind: "appointment",
          documentIds: [documentId],
          evidence: [
            { docId: documentId, quote: "12 October 2026" },
            { docId: documentId, quote: "An older supporting phrase." },
          ],
          createdByRun: "run_synthetic_calendar",
        },
        Date.UTC(2026, 9, 1),
      );
      db.prepare(
        "UPDATE temporal_annotation_evidence SET broken_at = 1 WHERE annotation_id = ? AND position = 1",
      ).run("ta_calendar_detail");
      const request = (id: string) =>
        app.request(`/temporal/${endpoint}/${id}?timeZone=UTC`, {
          headers: { authorization: `Bearer ${token}` },
        });

      const detail = await request("ta_calendar_detail");
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        item: { id: "ta_calendar_detail", origin: "annotation" },
        evidence: [{ documentId, quote: "12 October 2026" }],
      });
      expect((await request("missing")).status).toBe(404);
      db.prepare("UPDATE temporal_annotations SET invalidated_at = 1 WHERE id = ?").run(
        "ta_calendar_detail",
      );
      expect((await request("ta_calendar_detail")).status).toBe(404);
    },
  );

  test.each(["annotations", "items"])(
    "%s supporting quotes remain admin scoped",
    async (endpoint) => {
      const device = createDevice(db, { name: "fictional-reader", kind: "cli" });
      const readToken = createToken(db, device.id, [SCOPE_READ]).token;
      const response = await app.request(`/temporal/${endpoint}/missing?timeZone=UTC`, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      expect(response.status).toBe(403);
    },
  );
});
