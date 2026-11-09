// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, deleteDocumentsByIds, upsertDocuments } from "../db.js";
import { DocumentChunker } from "./chunker.js";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  getAllIndexedDocumentIds,
  getIndexedDocument,
  getWatermark,
  setWatermark,
} from "./db.js";
import { DirectDocumentSource } from "./direct-document-source.js";
import { Indexer } from "./indexer.js";
import { readScanProgress, VERIFIED_WATERMARK_KEY } from "./scan-progress.js";
import type { Embedder } from "./types.js";
import type { DocumentInput } from "@omnesis/types";

const SOURCE_ID = "notes:fictional@example.org";
const NOTE = /field note (\S+)/;

let directory: string;
let gatewayWriter: Database.Database;
let gatewayReader: Database.Database;
let indexDb: Database.Database;
let source: DirectDocumentSource;

beforeEach(() => {
  directory = mkdtempSync(join(process.env.OMNESIS_TEST_TMP ?? tmpdir(), "omnesis-scan-resume-"));
  const path = join(directory, "gateway.db");
  gatewayWriter = createDatabase(path);
  gatewayReader = new Database(path, { readonly: true });
  source = new DirectDocumentSource(gatewayReader);
  indexDb = createIndexDatabase(join(directory, "index.db"));
});

afterEach(() => {
  indexDb.close();
  gatewayReader.close();
  gatewayWriter.close();
  rmSync(directory, { recursive: true, force: true });
});

function note(externalId: string, revision = 1): DocumentInput {
  return {
    providerId: "notes" as DocumentInput["providerId"],
    sourceId: SOURCE_ID as DocumentInput["sourceId"],
    externalId,
    title: `Field note ${externalId}`,
    content: `Invented field note ${externalId} revision ${revision} about a marathon training plan.`,
    contentHash: `hash-${externalId}-${revision}`,
    metadata: { documentType: "note" },
    sourceCreatedAt: "2026-08-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function seed(count: number, prefix = "n"): void {
  const docs = Array.from({ length: count }, (_, i) => note(`${prefix}${i}`));
  upsertDocuments(gatewayWriter, docs as never);
}

function idOf(externalId: string): string {
  return gatewayReader
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

function sortedIds(): string[] {
  return gatewayReader
    .prepare<[], { id: string }>("SELECT id FROM documents ORDER BY id")
    .all()
    .map((r) => r.id);
}

/**
 * Embedder that records which notes it embedded and lets a test act after a
 * given number of embed calls — stop the indexer (a graceful shutdown) or
 * never answer (a crash mid-page).
 */
class RecordingEmbedder implements Embedder {
  readonly embedded = new Map<string, number>();
  calls = 0;
  constructor(public after: { calls: number; action: "stop" | "hang"; target?: Indexer } | null) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    for (const text of texts) {
      const match = NOTE.exec(text);
      if (match) this.embedded.set(match[1], (this.embedded.get(match[1]) ?? 0) + 1);
    }
    if (this.after && this.calls >= this.after.calls) {
      if (this.after.action === "hang") return new Promise<Float32Array[]>(() => {});
      this.after.target?.stop();
    }
    await new Promise((r) => setTimeout(r, 1));
    return texts.map(() => {
      const v = new Float32Array(EMBEDDING_DIM);
      v[0] = 1;
      return v;
    });
  }
  async embedQuery(): Promise<Float32Array> {
    return new Float32Array(EMBEDDING_DIM);
  }
  async dispose(): Promise<void> {}
}

function indexerWith(
  embedder: Embedder,
  opts: { catchUp?: boolean; pageSize?: number } = {},
): Indexer {
  return new Indexer(indexDb, source, new DocumentChunker(), embedder, {
    pageSize: opts.pageSize ?? 20,
    betweenPageSleepMs: 0,
    progressWriteIntervalMs: 0,
    ...(opts.catchUp ? { catchUp: { enabled: true, maxPageSize: 200, minSleepMs: 0 } } : {}),
  });
}

/** Notes each embedded once at least once, summed across embedders. */
function mergedCounts(...embedders: RecordingEmbedder[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of embedders) {
    for (const [k, v] of e.embedded) out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
}

describe("indexing scan resume", () => {
  test.each([false, true])(
    "a stopped scan resumes after its last committed page; every document is embedded exactly once (catch-up %s)",
    async (catchUp) => {
      seed(300);
      const first = new RecordingEmbedder(null);
      const interrupted = indexerWith(first, { catchUp });
      first.after = { calls: 4, action: "stop", target: interrupted };

      const partial = await interrupted.indexUpdated();
      expect(partial.scannedThrough).toBeUndefined();
      const progress = readScanProgress(indexDb);
      expect(progress).not.toBeNull();
      expect(progress!.since).toBeNull();
      expect(progress!.afterId).not.toBeNull();
      // The interrupted scan has not published a watermark: it never reached
      // the documents after its cursor.
      expect(getWatermark(indexDb, "last_updated_at")).toBeNull();
      const indexedBefore = getAllIndexedDocumentIds(indexDb);
      expect(indexedBefore.size).toBeGreaterThan(0);
      expect(indexedBefore.size).toBeLessThan(300);
      // Everything at or before the cursor is indexed; nothing after it is.
      for (const id of sortedIds()) {
        expect(indexedBefore.has(id)).toBe(id <= progress!.afterId!);
      }

      // A new process: a fresh Indexer over the same databases.
      const second = new RecordingEmbedder(null);
      const resumed = await indexerWith(second, { catchUp }).indexUpdated();
      expect(resumed.resumed).toBe(true);
      expect(resumed.scannedThrough).toBe(progress!.boundary);
      expect(readScanProgress(indexDb)).toBeNull();
      expect(getWatermark(indexDb, "last_updated_at")).toBe(progress!.boundary);
      expect(getAllIndexedDocumentIds(indexDb).size).toBe(300);

      const counts = mergedCounts(first, second);
      expect(counts.size).toBe(300);
      for (const [, n] of counts) expect(n).toBe(1);
      // The resumed run did not revisit the committed prefix.
      expect(second.embedded.size).toBe(300 - indexedBefore.size);
    },
  );

  test("a crash mid-page loses at most the uncommitted pages, and the restart indexes every document", async () => {
    seed(200);
    const crashing = new RecordingEmbedder({ calls: 5, action: "hang" });
    void indexerWith(crashing).indexUpdated();
    // Let the scan reach the page whose embedding never answers.
    for (let i = 0; i < 200 && crashing.calls < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 20));
    // The hung page and, pipelined behind it, the next one.
    expect(crashing.calls).toBeGreaterThanOrEqual(5);
    expect(crashing.calls).toBeLessThanOrEqual(6);
    const progress = readScanProgress(indexDb);
    expect(progress?.afterId).toBeTruthy();
    const committed = getAllIndexedDocumentIds(indexDb);
    for (const id of committed) expect(id <= progress!.afterId!).toBe(true);

    const restarted = new RecordingEmbedder(null);
    const result = await indexerWith(restarted).indexUpdated();
    expect(result.resumed).toBe(true);
    expect(getAllIndexedDocumentIds(indexDb).size).toBe(200);
    // Nothing committed before the crash is embedded again.
    for (const id of committed) {
      const externalId = gatewayReader
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM documents WHERE id = ?",
        )
        .get(id)!.external_id;
      expect(restarted.embedded.has(externalId)).toBe(false);
    }
  });

  test("edits, deletes and inserts on either side of the cursor while a scan is interrupted", async () => {
    seed(240);
    const first = new RecordingEmbedder(null);
    const interrupted = indexerWith(first);
    first.after = { calls: 5, action: "stop", target: interrupted };
    await interrupted.indexUpdated();
    const progress = readScanProgress(indexDb)!;
    const cursor = progress.afterId!;

    const byId = new Map(
      gatewayReader
        .prepare<[], { id: string; external_id: string }>("SELECT id, external_id FROM documents")
        .all()
        .map((r) => [r.id, r.external_id]),
    );
    const ids = sortedIds();
    const behind = ids.filter((id) => id <= cursor);
    const ahead = ids.filter((id) => id > cursor);
    expect(behind.length).toBeGreaterThan(3);
    expect(ahead.length).toBeGreaterThan(3);

    const editedBehind = byId.get(behind[0])!;
    const editedAhead = byId.get(ahead[0])!;
    const deletedBehind = behind[1];
    const deletedAhead = ahead[1];
    await new Promise((r) => setTimeout(r, 5));
    upsertDocuments(gatewayWriter, [note(editedBehind, 2), note(editedAhead, 2)] as never);
    deleteDocumentsByIds(gatewayWriter, [deletedBehind, deletedAhead]);
    seed(20, "late");

    const resumer = indexerWith(new RecordingEmbedder(null));
    const resumed = await resumer.indexUpdated();
    expect(resumed.resumed).toBe(true);
    // The finished scan's watermark is capped at the boundary captured when it
    // began, so the edit behind its cursor is still ahead of the watermark.
    const watermark = getWatermark(indexDb, "last_updated_at")!;
    expect(watermark <= progress.boundary!).toBe(true);

    // The next ordinary cycle picks up what the resumed scan's cursor had passed.
    await resumer.indexUpdated();
    await resumer.reconcileDeletedDocuments();

    expect(getIndexedDocument(indexDb, idOf(editedBehind))?.content_hash).toBe(
      `hash-${editedBehind}-2`,
    );
    expect(getIndexedDocument(indexDb, idOf(editedAhead))?.content_hash).toBe(
      `hash-${editedAhead}-2`,
    );
    const indexed = getAllIndexedDocumentIds(indexDb);
    expect(indexed.has(deletedBehind)).toBe(false);
    expect(indexed.has(deletedAhead)).toBe(false);
    for (let i = 0; i < 20; i += 1) expect(indexed.has(idOf(`late${i}`))).toBe(true);
    expect(indexed.size).toBe(240 - 2 + 20);
    expect(readScanProgress(indexDb)).toBeNull();
  });

  test("a document that failed before the restart is retried by the resumed scan", async () => {
    seed(120);
    const failedId = sortedIds()[0];
    const failedNote = gatewayReader
      .prepare<[string], { external_id: string }>("SELECT external_id FROM documents WHERE id = ?")
      .get(failedId)!.external_id;
    const failing = new (class extends RecordingEmbedder {
      override async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.some((t) => t.includes(`field note ${failedNote} `))) {
          throw new Error("embedder timed out");
        }
        return super.embed(texts);
      }
    })(null);
    const interrupted = indexerWith(failing);
    failing.after = { calls: 6, action: "stop", target: interrupted };
    await interrupted.indexUpdated();
    expect(readScanProgress(indexDb)!.afterId! >= failedId).toBe(true);
    expect(getAllIndexedDocumentIds(indexDb).has(failedId)).toBe(false);

    await indexerWith(new RecordingEmbedder(null)).indexUpdated();
    expect(getAllIndexedDocumentIds(indexDb).has(failedId)).toBe(true);
  });

  test("only a scan that covered everything before it verifies the watermark it publishes", async () => {
    seed(30);
    const indexer = indexerWith(new RecordingEmbedder(null));
    await indexer.indexUpdated();
    const full = getWatermark(indexDb, "last_updated_at");
    expect(getWatermark(indexDb, VERIFIED_WATERMARK_KEY)).toBe(full);

    // An incremental scan from a verified watermark keeps it verified.
    await new Promise((r) => setTimeout(r, 5));
    seed(3, "next");
    await indexer.indexUpdated();
    const incremental = getWatermark(indexDb, "last_updated_at");
    expect(incremental! > full!).toBe(true);
    expect(getWatermark(indexDb, VERIFIED_WATERMARK_KEY)).toBe(incremental);

    // One from a watermark an earlier version wrote without verification does not.
    indexDb.prepare("DELETE FROM watermark").run();
    setWatermark(indexDb, "last_updated_at", incremental!);
    await new Promise((r) => setTimeout(r, 5));
    seed(3, "later");
    await indexer.indexUpdated();
    expect(getWatermark(indexDb, "last_updated_at")! > incremental!).toBe(true);
    expect(getWatermark(indexDb, VERIFIED_WATERMARK_KEY)).toBeNull();
  });

  test("a single-page cycle leaves no scan record behind", async () => {
    seed(5);
    await indexerWith(new RecordingEmbedder(null)).indexUpdated();
    expect(readScanProgress(indexDb)).toBeNull();
    expect(getWatermark(indexDb, "last_updated_at")).not.toBeNull();
  });
});
