// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { isAnalyticsLeaseRejection, type IngestAnalyticsResponse } from "@omnesis/source-sdk";
import { HttpGatewayClient, chunkDocuments } from "./http-gateway-client.js";
import { DEFAULT_UPSERT_CHUNK, DEFAULT_UPSERT_CHUNK_BYTES } from "./tunables.js";
import type { DocumentInput } from "@omnesis/types";
import type { Server } from "node:http";
type Db = Database.Database;
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";

const API_KEY = "integration-test-key";
const PORT = 17602;

let db: Db;
let server: Server;
let client: HttpGatewayClient;
let dbPath: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDoc(externalId = "msg-1"): DocumentInput {
  return {
    providerId: "google",
    sourceId: "gmail",
    externalId,
    title: `Email ${externalId}`,
    content: `Content of ${externalId}`,
    contentHash: `hash-${externalId}`,
    metadata: { author: "test@test.com" },
    sourceCreatedAt: "2024-01-15T10:00:00Z",
    sourceUpdatedAt: "2024-01-15T10:00:00Z",
  };
}

/**
 * Minimal inline gateway for integration testing.
 * Avoids cross-package source imports.
 */
// Spy log of POST /documents calls — exposed at module scope so the
// chunking tests can assert per-request payload sizes without
// instrumenting the test gateway further.
const postDocCalls: Array<{ docCount: number }> = [];
const ocrRequestBodies: string[] = [];
const withCursorBodies: Array<Record<string, unknown>> = [];
const reconcileBodies: Array<Record<string, unknown>> = [];
// Spy log of POST /analytics/ingest calls: asserts deletes-only pages
// still reach the gateway with the rows they name.
const ingestAnalyticsCalls: Array<{
  tableName: string;
  recordCount: number;
  deletedIds?: string[];
  deletedKeys?: Record<string, unknown>[];
  presentKeys?: Record<string, unknown>[];
  deleteKeyColumn?: string;
  hasSchema: boolean;
  sourceId?: string;
  writeEpoch?: number;
  presentIds?: string[];
  observationId?: string;
}> = [];

function createTestGateway(database: Db, apiKey: string) {
  return {
    port: PORT,
    fetch(
      req: Request,
    ): Response | Promise<Response> | globalThis.Response | Promise<globalThis.Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // Health — no auth
      if (path === "/health") {
        return Response.json({ status: "ok" });
      }

      // Config — returns gateway policy
      if (path === "/config" && req.method === "GET") {
        return Response.json({ dataRetention: {} });
      }

      // Auth check
      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${apiKey}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // POST /documents
      if (path === "/documents" && req.method === "POST") {
        return req.json().then((body: any) => {
          postDocCalls.push({ docCount: body.documents?.length ?? 0 });
          const now = new Date().toISOString();
          const stmt = database.prepare(
            `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider_id, source_id, external_id) DO UPDATE SET
               title=excluded.title, content=excluded.content, content_hash=excluded.content_hash,
               metadata=excluded.metadata, source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at
             WHERE excluded.content_hash != documents.content_hash`,
          );
          for (const doc of body.documents) {
            stmt.run(
              randomUUID(),
              doc.providerId,
              doc.sourceId,
              doc.externalId,
              doc.title,
              doc.content,
              doc.contentHash,
              JSON.stringify(doc.metadata),
              doc.sourceCreatedAt,
              doc.sourceUpdatedAt,
              now,
              now,
            );
          }
          return Response.json({ ingested: body.documents.length });
        });
      }

      // POST /inference/transcribe — echoes the audio bytes as the transcript,
      // with magic bodies to exercise the unavailable / disabled / error paths.
      if (path === "/inference/transcribe" && req.method === "POST") {
        return req.arrayBuffer().then(async (buf) => {
          const text = new TextDecoder().decode(new Uint8Array(buf));
          if (text === "TRIGGER_SLOW") {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (text === "TRIGGER_DISABLED")
            return Response.json({ error: "not enabled" }, { status: 404 });
          if (text === "TRIGGER_ERROR") return Response.json({ error: "boom" }, { status: 500 });
          if (text === "TRIGGER_UNAVAILABLE")
            return Response.json({ error: "model loading" }, { status: 503 });
          if (text === "TRIGGER_RATELIMIT")
            return Response.json(
              { error: "rate limited" },
              { status: 429, headers: { "Retry-After": "12" } },
            );
          if (text === "TRIGGER_NONE") return Response.json({ available: false });
          const language = url.searchParams.get("language") ?? "en";
          return Response.json({ available: true, text, language, durationSec: 1.5 });
        });
      }

      // POST /inference/ocr — echoes the image bytes as recognized text, with
      // magic bodies to exercise the unavailable / disabled / error paths.
      if (path === "/inference/ocr" && req.method === "POST") {
        return req.arrayBuffer().then(async (buf) => {
          const text = new TextDecoder().decode(new Uint8Array(buf));
          ocrRequestBodies.push(text);
          if (text === "TRIGGER_SLOW") {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (text === "TRIGGER_DISABLED")
            return Response.json({ error: "not enabled" }, { status: 404 });
          if (text === "TRIGGER_ERROR") return Response.json({ error: "boom" }, { status: 500 });
          if (text === "TRIGGER_UNAVAILABLE")
            return Response.json({ error: "model loading" }, { status: 503 });
          if (text === "TRIGGER_RATELIMIT")
            return Response.json(
              { error: "rate limited" },
              { status: 429, headers: { "Retry-After": "12" } },
            );
          if (text === "TRIGGER_NONE") return Response.json({ available: false });
          const language = url.searchParams.get("language") ?? "en";
          const pagesParam = url.searchParams.get("pages");
          if (pagesParam) {
            // Echo a page-aligned pageTexts so the client's parsing is covered.
            const reqPages = pagesParam.split(",").map(Number);
            const pageTexts = [...Array(Math.max(...reqPages))].map((_, i) =>
              reqPages.includes(i + 1) ? `ocr p${i + 1}` : "",
            );
            return Response.json({
              available: true,
              text,
              language,
              pages: reqPages.length,
              pageTexts,
            });
          }
          return Response.json({ available: true, text, language, pages: 1 });
        });
      }

      // POST /analytics/ingest
      if (path === "/analytics/ingest" && req.method === "POST") {
        return req.json().then((body: any) => {
          ingestAnalyticsCalls.push({
            tableName: body.tableName,
            recordCount: body.records?.length ?? 0,
            deletedIds: body.deletedIds,
            deletedKeys: body.deletedKeys,
            presentKeys: body.presentKeys,
            deleteKeyColumn: body.deleteKeyColumn,
            hasSchema: !!body.schema,
            sourceId: body.sourceId,
            writeEpoch: body.writeEpoch,
            presentIds: body.presentIds,
            observationId: body.observationId,
          });
          const response: IngestAnalyticsResponse =
            body.tableName === "paused_source"
              ? {
                  ingested: 0,
                  rejected: [{ sourceId: "fitness:watch", reason: "paused" }],
                }
              : {
                  ingested: body.records?.length ?? 0,
                  ...(body.presentIds !== undefined
                    ? {
                        absence: {
                          marked: 1,
                          cleared: 0,
                          absent: 1,
                          deferred: 0,
                          missing: 0,
                          stored: 2,
                          snapshot: body.presentIds.length,
                        },
                      }
                    : {}),
                };
          return Response.json(response);
        });
      }

      // The legacy response field is deliberately retained for an older
      // collector talking to a newer gateway.
      if (path === "/documents/with-cursor" && req.method === "POST") {
        return req.json().then((body: any) => {
          withCursorBodies.push(body);
          return Response.json({
            ingested: body.documents?.length ?? 0,
            reconciledDeleted: 0,
            indexCleanedRows: 0,
          });
        });
      }

      if (path === "/documents/reconcile" && req.method === "POST") {
        return req.json().then((body: any) => {
          reconcileBodies.push(body);
          return Response.json({
            deleted: 0,
            deletedIds: [],
            absence: {
              marked: 1,
              cleared: 0,
              absent: 1,
              deferred: 0,
              missing: 0,
              stored: 2,
              snapshot: 1,
            },
          });
        });
      }

      // POST /documents/delete
      if (path === "/documents/delete" && req.method === "POST") {
        return req.json().then((body: any) => {
          const placeholders = body.externalIds.map(() => "?").join(", ");
          database
            .prepare(
              `DELETE FROM documents WHERE provider_id = ? AND source_id = ? AND external_id IN (${placeholders})`,
            )
            .run(body.providerId, body.sourceId, ...body.externalIds);
          return Response.json({ deleted: body.externalIds.length });
        });
      }

      // GET /documents/count/:sourceId
      if (path.startsWith("/documents/count/") && req.method === "GET") {
        const sourceId = decodeURIComponent(path.split("/documents/count/")[1]);
        const row = database
          .prepare<[string], any>("SELECT COUNT(*) as count FROM documents WHERE source_id = ?")
          .get(sourceId);
        return Response.json({ count: row?.count ?? 0 });
      }

      // GET /sync-state/:sourceId
      if (path.startsWith("/sync-state/") && req.method === "GET") {
        const sourceId = decodeURIComponent(path.split("/sync-state/")[1]);
        const row = database
          .prepare<[string], any>("SELECT * FROM sync_state WHERE source_id = ?")
          .get(sourceId);
        if (!row) return Response.json({ cursor: null, lastSyncedAt: null });
        return Response.json({
          cursor: JSON.parse(row.cursor),
          lastSyncedAt: row.last_synced_at,
        });
      }

      // POST /sync-state/:sourceId/meta — metadata-only, cursor preserving.
      if (path.startsWith("/sync-state/") && path.endsWith("/meta") && req.method === "POST") {
        const sourceId = decodeURIComponent(path.slice("/sync-state/".length, -"/meta".length));
        return req.json().then((body: any) => {
          database
            .prepare(
              `INSERT INTO sync_state
                 (source_id, cursor, last_synced_at, label, content_retention)
               VALUES (?, '{}', '', ?, ?)
               ON CONFLICT(source_id) DO UPDATE SET
                 label = COALESCE(excluded.label, sync_state.label),
                 content_retention = COALESCE(excluded.content_retention, sync_state.content_retention)`,
            )
            .run(sourceId, body.label ?? null, body.contentRetention ?? null);
          return Response.json({ ok: true });
        });
      }

      // POST /sync-state/:sourceId
      if (path.startsWith("/sync-state/") && req.method === "POST") {
        const sourceId = decodeURIComponent(path.split("/sync-state/")[1]);
        return req.json().then((body: any) => {
          const now = new Date().toISOString();
          database
            .prepare(
              `INSERT INTO sync_state (source_id, cursor, last_synced_at) VALUES (?, ?, ?)
             ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor, last_synced_at=excluded.last_synced_at`,
            )
            .run(sourceId, JSON.stringify(body.cursor), now);
          return Response.json({ ok: true });
        });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  };
}

beforeAll(() => {
  dbPath = `/tmp/omnesis-integration-test-${randomUUID()}.db`;
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_id TEXT NOT NULL,
      external_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      source_created_at TEXT NOT NULL, source_updated_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider_id, source_id, external_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      source_id TEXT PRIMARY KEY,
      cursor TEXT NOT NULL DEFAULT '{}',
      last_synced_at TEXT NOT NULL,
      label TEXT,
      content_retention TEXT
    )
  `);

  const { port, fetch } = createTestGateway(db, API_KEY);
  server = serve({ fetch, port });
  client = new HttpGatewayClient(`http://localhost:${PORT}`, API_KEY);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  db.close();
  cleanupDb(dbPath);
});

describe("HttpGatewayClient.transcribe", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test("returns the transcript on success and forwards the language hint", async () => {
    const r = await client.transcribe(enc("hello from a voice note"), "audio/ogg", {
      language: "fr",
    });
    expect(r).toEqual({ text: "hello from a voice note", language: "fr", durationSec: 1.5 });
  });

  test("returns null when the gateway reports no transcriber available", async () => {
    expect(await client.transcribe(enc("TRIGGER_NONE"), "audio/ogg")).toBeNull();
  });

  test("returns null when STT is disabled (404) — permanent, no retry", async () => {
    // A 4xx is permanent ("the gateway won't transcribe this"): the caller
    // treats it as no transcript and the page advances. No throw.
    expect(await client.transcribe(enc("TRIGGER_DISABLED"), "audio/ogg")).toBeNull();
  });

  test("throws transient SyncError on a 5xx so the page retries", async () => {
    await expect(client.transcribe(enc("TRIGGER_ERROR"), "audio/ogg")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
    });
  });

  test("throws transient SyncError on a 503 (backend warming up)", async () => {
    await expect(client.transcribe(enc("TRIGGER_UNAVAILABLE"), "audio/ogg")).rejects.toBeInstanceOf(
      SyncError,
    );
  });

  test("throws transient SyncError when the gateway is unreachable", async () => {
    const bad = new HttpGatewayClient("http://localhost:19998", API_KEY);
    await expect(bad.transcribe(enc("x"), "audio/ogg")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
    });
  });

  test("throws transient SyncError on a 429 and carries Retry-After", async () => {
    await expect(client.transcribe(enc("TRIGGER_RATELIMIT"), "audio/ogg")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
      retryAfterMs: 12000,
    });
  });

  test("does not apply the optional OCR deadline to transcription", async () => {
    const shortOcrDeadline = new HttpGatewayClient(`http://localhost:${PORT}`, API_KEY, {
      ocrRequestTimeoutMs: 10,
    });
    await expect(
      shortOcrDeadline.transcribe(enc("TRIGGER_SLOW"), "audio/ogg"),
    ).resolves.toMatchObject({ text: "TRIGGER_SLOW" });
  });
});

describe("HttpGatewayClient.ocr", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test("returns the recognized text on success and forwards the language hint", async () => {
    const r = await client.ocr(enc("INVOICE #42"), "image/png", { language: "fr" });
    expect(r).toEqual({ text: "INVOICE #42", language: "fr", pages: 1 });
  });

  test("preserves a successful OCR response with no recognized text", async () => {
    expect(await client.ocr(enc(""), "image/png")).toEqual({
      text: "",
      language: "en",
      pages: 1,
    });
  });

  test("returns null when the gateway reports no OCR backend available", async () => {
    expect(await client.ocr(enc("TRIGGER_NONE"), "image/png")).toBeNull();
  });

  test("returns null when OCR is disabled (404) — permanent, no retry", async () => {
    // A 4xx is permanent: the attachment is treated as unextractable binary and
    // the page advances. No throw.
    expect(await client.ocr(enc("TRIGGER_DISABLED"), "image/png")).toBeNull();
  });

  test("throws transient SyncError on a 5xx so the page retries", async () => {
    await expect(client.ocr(enc("TRIGGER_ERROR"), "image/png")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
    });
  });

  test("throws transient SyncError on a 503 (backend warming up)", async () => {
    await expect(client.ocr(enc("TRIGGER_UNAVAILABLE"), "image/png")).rejects.toBeInstanceOf(
      SyncError,
    );
  });

  test("throws transient SyncError when the gateway is unreachable", async () => {
    const bad = new HttpGatewayClient("http://localhost:19998", API_KEY);
    await expect(bad.ocr(enc("x"), "image/png")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
    });
  });

  test("throws transient SyncError on a 429 and carries Retry-After", async () => {
    await expect(client.ocr(enc("TRIGGER_RATELIMIT"), "image/png")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
      retryAfterMs: 12000,
    });
  });

  test("aborts a pathological request and suppresses OCR during the cooldown", async () => {
    const shortDeadline = new HttpGatewayClient(`http://localhost:${PORT}`, API_KEY, {
      ocrRequestTimeoutMs: 100,
      ocrTimeoutCooldownMs: 350,
    });
    const requestsBefore = ocrRequestBodies.length;
    await expect(shortDeadline.ocr(enc("TRIGGER_SLOW"), "image/png")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
      message: "OCR request timed out after 100ms",
    });
    await expect(shortDeadline.ocr(enc("suppressed"), "image/png")).rejects.toMatchObject({
      name: "SyncError",
      kind: "transient",
      message: "OCR requests paused after a request timeout",
    });
    expect(ocrRequestBodies.slice(requestsBefore)).toEqual(["TRIGGER_SLOW"]);

    // Let both the server's abandoned handler and the client cooldown settle.
    await new Promise((resolve) => setTimeout(resolve, 370));
    await expect(shortDeadline.ocr(enc("recovered"), "image/png")).resolves.toMatchObject({
      text: "recovered",
    });
    expect(ocrRequestBodies.slice(requestsBefore)).toEqual(["TRIGGER_SLOW", "recovered"]);
  });

  test("keeps concurrent OCR request deadlines isolated", async () => {
    const shortDeadline = new HttpGatewayClient(`http://localhost:${PORT}`, API_KEY, {
      ocrRequestTimeoutMs: 150,
      ocrTimeoutCooldownMs: 180,
    });
    const slow = shortDeadline.ocr(enc("TRIGGER_SLOW"), "image/png");
    const fast = shortDeadline.ocr(enc("concurrent-fast"), "image/png");
    await expect(fast).resolves.toMatchObject({ text: "concurrent-fast" });
    await expect(slow).rejects.toMatchObject({
      name: "SyncError",
      message: "OCR request timed out after 150ms",
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
  });

  test.each([0, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an unsafe OCR timeout override (%s)",
    (ocrRequestTimeoutMs) => {
      expect(
        () => new HttpGatewayClient(`http://localhost:${PORT}`, API_KEY, { ocrRequestTimeoutMs }),
      ).toThrow(RangeError);
    },
  );

  test("rejects an unsafe OCR cooldown override", () => {
    expect(
      () =>
        new HttpGatewayClient(`http://localhost:${PORT}`, API_KEY, {
          ocrTimeoutCooldownMs: 0,
        }),
    ).toThrow(RangeError);
  });

  test("forwards a PDF page subset and parses page-aligned pageTexts", async () => {
    const r = await client.ocr(enc("scan"), "application/pdf", { pages: [2] });
    expect(r?.pageTexts).toEqual(["", "ocr p2"]); // page-aligned, page 1 not OCR'd
  });
});

describe("HttpGatewayClient", () => {
  test("ping returns true when gateway is up", async () => {
    expect(await client.ping()).toBe(true);
  });

  test("ping returns false when gateway is down", async () => {
    const badClient = new HttpGatewayClient("http://localhost:19999", API_KEY);
    expect(await badClient.ping()).toBe(false);
  });

  test("upserts documents via gateway", async () => {
    await client.upsertDocuments([makeDoc("int-1"), makeDoc("int-2")]);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBeGreaterThanOrEqual(2);
  });

  test("deletes documents via gateway", async () => {
    await client.upsertDocuments([makeDoc("del-1"), makeDoc("del-2")]);
    await client.deleteDocuments("google", "gmail", ["del-1"]);

    const row = db
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) as count FROM documents WHERE external_id = ?")
      .get("del-1");
    expect(row?.count).toBe(0);
  });

  test("sync state round-trip", async () => {
    const cursor = { historyId: "99999", phase: "incremental" };

    const initial = await client.getSyncState("int-test-source");
    expect(initial).toBeNull();

    await client.setSyncState("int-test-source", cursor);

    const state = await client.getSyncState("int-test-source");
    expect(state).not.toBeNull();
    expect(state!.cursor).toEqual(cursor);
    expect(state!.sourceId).toBe("int-test-source");
    expect(state!.lastSyncedAt).toBeTruthy();
  });

  test("source metadata refresh leaves a newer cursor untouched", async () => {
    const sourceId = SourceId("meta-race-source");
    const cursor = { revision: 7 };
    await client.setSyncState(sourceId, cursor);

    await client.setSourceMeta(sourceId, {
      label: "Fictional source",
      contentRetention: "best-effort",
    });

    expect((await client.getSyncState(sourceId))?.cursor).toEqual(cursor);
    expect(
      db
        .prepare<
          [string],
          { label: string; content_retention: string }
        >("SELECT label, content_retention FROM sync_state WHERE source_id = ?")
        .get(sourceId),
    ).toEqual({ label: "Fictional source", content_retention: "best-effort" });
  });

  test("getDocumentCount returns count for a source", async () => {
    await client.upsertDocuments([makeDoc("cnt-1"), makeDoc("cnt-2")]);
    const count = await client.getDocumentCount("gmail");
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("throws on auth failure", async () => {
    const badClient = new HttpGatewayClient(`http://localhost:${PORT}`, "wrong-key");
    await expect(badClient.upsertDocuments([makeDoc()])).rejects.toThrow(/Gateway error 401/);
  });

  test("chunkDocuments closes a chunk by count or by serialized size, never splitting one document", () => {
    const small = (id: number) => ({ id, content: "x".repeat(10) });
    // Count bound: 120 small documents → 50 + 50 + 20.
    expect(
      chunkDocuments(
        Array.from({ length: 120 }, (_, i) => small(i)),
        50,
        1_000_000,
      ).map((c) => c.length),
    ).toEqual([50, 50, 20]);
    // Size bound: three 32-byte documents under a 70-byte ceiling → 2 + 1.
    expect(chunkDocuments([small(1), small(2), small(3)], 50, 70).map((c) => c.length)).toEqual([
      2, 1,
    ]);
    // A document larger than the ceiling on its own still travels, alone.
    const huge = { id: 9, content: "y".repeat(500) };
    expect(chunkDocuments([small(1), huge, small(2)], 50, 70).map((c) => c.length)).toEqual([
      1, 1, 1,
    ]);
    expect(chunkDocuments([], 50, 70)).toEqual([]);
    // Several maximum-size text exports (10 MiB each) can never share one request.
    expect(DEFAULT_UPSERT_CHUNK_BYTES).toBeLessThan(2 * 10 * 1024 * 1024);
    expect(DEFAULT_UPSERT_CHUNK).toBe(50);
  });

  test("upsertDocuments chunks large batches into ≤50-doc requests", async () => {
    // Generate 175 docs — should split into 4 requests (50 + 50 + 50 + 25).
    const docs: DocumentInput[] = [];
    for (let i = 0; i < 175; i++) docs.push(makeDoc(`chunk-${i}`));

    // Spy on the inline test gateway: count POSTs to /documents and
    // sniff the per-request payload size.
    const beforeCalls = postDocCalls.slice();
    await client.upsertDocuments(docs);
    const newCalls = postDocCalls.slice(beforeCalls.length);

    expect(newCalls.length).toBe(4);
    expect(newCalls[0].docCount).toBe(50);
    expect(newCalls[1].docCount).toBe(50);
    expect(newCalls[2].docCount).toBe(50);
    expect(newCalls[3].docCount).toBe(25);

    // All 175 docs landed in the DB.
    const inserted = db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM documents WHERE external_id LIKE 'chunk-%'")
      .get();
    expect(inserted?.count).toBe(175);
  });

  test("upsertDocuments single batch ≤50 stays one request (no extra round-trip)", async () => {
    const docs: DocumentInput[] = [];
    for (let i = 0; i < 30; i++) docs.push(makeDoc(`small-${i}`));

    const beforeCalls = postDocCalls.length;
    await client.upsertDocuments(docs);
    expect(postDocCalls.length - beforeCalls).toBe(1);
  });

  test("upsertDocuments empty array is a no-op (no request)", async () => {
    const beforeCalls = postDocCalls.length;
    await client.upsertDocuments([]);
    expect(postDocCalls.length).toBe(beforeCalls);
  });

  test("a deletes-only page reaches the gateway", async () => {
    const before = ingestAnalyticsCalls.length;
    const response = await client.ingestAnalyticsPage({
      tableName: "txns",
      records: [],
      sourceId: "finance:acct",
      deletedKeys: [{ external_id: "tx-1" }, { external_id: "tx-2" }],
    });
    // A deletes-only page is NOT skipped — it reaches the gateway with its
    // tombstones, so a vanished upstream row stops poisoning aggregates.
    expect(ingestAnalyticsCalls.length - before).toBe(1);
    const call = ingestAnalyticsCalls[ingestAnalyticsCalls.length - 1]!;
    expect(call.recordCount).toBe(0);
    expect(call.deletedKeys).toEqual([{ external_id: "tx-1" }, { external_id: "tx-2" }]);
    expect(response.ingested).toBe(0);
  });

  test("a snapshot page carries the absence diagnostics back", async () => {
    expect(
      await client.ingestAnalyticsPage({
        tableName: "txns",
        records: [],
        sourceId: "finance:acct",
        presentIds: ["tx-1"],
      }),
    ).toMatchObject({
      ingested: 0,
      absence: { marked: 1, absent: 1, snapshot: 1 },
    });
  });

  test("analytics page preserves a per-source paused rejection", async () => {
    const response = await client.ingestAnalyticsPage({
      tableName: "paused_source",
      records: [{ day: "2024-01-01", steps: 1 }],
    });
    expect(response).toEqual({
      ingested: 0,
      rejected: [{ sourceId: "fitness:watch", reason: "paused" }],
    });
    expect(isAnalyticsLeaseRejection(response)).toBe(false);
    expect(
      isAnalyticsLeaseRejection({
        ingested: 0,
        rejected: true,
        reason: "lease",
        holder: "dev-alpha",
      }),
    ).toBe(true);
  });

  test("analytics snapshot forwards its stable observation identity", async () => {
    const before = ingestAnalyticsCalls.length;
    await client.ingestAnalyticsPage({
      tableName: "txns",
      records: [],
      sourceId: "finance:acct",
      presentIds: ["tx-1"],
      writeEpoch: 7,
      observationId: "7:attempt-a",
    });
    expect(ingestAnalyticsCalls.slice(before)).toEqual([
      expect.objectContaining({
        presentIds: ["tx-1"],
        writeEpoch: 7,
        observationId: "7:attempt-a",
      }),
    ]);
  });

  test("with-cursor keeps reconciledDeleted zero for an older collector", async () => {
    const response = await client.upsertWithCursor({
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail"),
      documents: [],
      hasMore: false,
      cursor: {},
    });
    expect(response.reconciledDeleted).toBe(0);
    // This is the exact arithmetic the previous collector performs on every
    // page; an omitted field poisons the status counter with NaN.
    expect(0 + response.reconciledDeleted).toBe(0);
  });

  test("with-cursor forwards the snapshot observation identity", async () => {
    const before = withCursorBodies.length;
    await client.upsertWithCursor({
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail"),
      documents: [],
      presentExternalIds: ["msg-1"],
      observationId: "7:attempt-a",
      hasMore: false,
      cursor: {},
    });
    expect(withCursorBodies.slice(before)).toEqual([
      expect.objectContaining({ observationId: "7:attempt-a" }),
    ]);
  });

  test("snapshot outcome is additive to the legacy numeric reconcile API", async () => {
    const before = reconcileBodies.length;
    const args = [ProviderId("google"), SourceId("gmail"), ["msg-1"]] as const;
    expect(await client.reconcileSnapshot(...args)).toBe(0);
    expect(await client.reconcileSnapshotAbsence(...args)).toMatchObject({
      marked: 1,
      absent: 1,
    });
    const bodies = reconcileBodies.slice(before);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.observationId).toEqual(expect.any(String));
    expect(bodies[1]?.observationId).toEqual(expect.any(String));
    expect(bodies[0]?.observationId).not.toBe(bodies[1]?.observationId);
  });

  test("attempt context fences direct provider analytics writes", async () => {
    const before = ingestAnalyticsCalls.length;
    await client.runWithSourceWriteEpoch(SourceId("finance:acct"), 7, () =>
      client.ingestAnalyticsPage({
        tableName: "txns",
        records: [{ id: "tx-1" }],
        sourceId: "finance:acct",
      }),
    );

    expect(ingestAnalyticsCalls.length - before).toBe(1);
    expect(ingestAnalyticsCalls.at(-1)?.writeEpoch).toBe(7);
  });

  test("a page with no records and no deletes is a no-op", async () => {
    const before = ingestAnalyticsCalls.length;
    const response = await client.ingestAnalyticsPage({ tableName: "txns", records: [] });
    expect(ingestAnalyticsCalls.length).toBe(before);
    expect(response.ingested).toBe(0);
  });

  test("a schema-only registration still reaches the gateway", async () => {
    const before = ingestAnalyticsCalls.length;
    const schema = {
      tableName: "txns",
      displayName: "Txns",
      description: "test",
      columns: [{ name: "id", type: "VARCHAR" as const, description: "id" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    // Empty records but a schema is given: the call must still reach the gateway
    // so it refreshes the catalog row (record-citation contract) — not skipped.
    const response = await client.ingestAnalyticsPage({
      tableName: "txns",
      records: [],
      schema,
      sourceId: "finance:acct",
    });
    expect(ingestAnalyticsCalls.length - before).toBe(1);
    const call = ingestAnalyticsCalls[ingestAnalyticsCalls.length - 1]!;
    expect(call.recordCount).toBe(0);
    expect(call.hasSchema).toBe(true);
    expect(call.sourceId).toBe("finance:acct");
    expect(response.ingested).toBe(0);
  });
});
