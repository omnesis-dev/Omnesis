// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Throughput of the indexing scan over an invented corpus, at the configured
 * pace and with catch-up pacing, with and without backpressure.
 *
 * The embedder is a stand-in with a fixed cost per chunk on one sequential
 * slot, the shape of the local llama.cpp embedder with one indexing slot. The
 * default run is small enough for the unit lane and asserts the shape of the
 * result; `OMNESIS_INDEXER_BENCH=1` runs the larger, time-scaled corpus whose
 * figures the pull request reports (see `runBench` for the scaling).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, upsertDocuments } from "../db.js";
import { DocumentChunker } from "./chunker.js";
import { createIndexDatabase, EMBEDDING_DIM, getAllIndexedDocumentIds } from "./db.js";
import { DirectDocumentSource } from "./direct-document-source.js";
import { Indexer } from "./indexer.js";
import type { ScanPressureSignal } from "./scan-pacer.js";
import type { DocumentSource, Embedder } from "./types.js";
import type { DocumentInput } from "@omnesis/types";

const log = createLogger("indexer:bench");

let directory: string;
let gatewayWriter: Database.Database;
let gatewayReader: Database.Database;
let indexDb: Database.Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-scan-bench-"));
  const path = join(directory, "gateway.db");
  gatewayWriter = createDatabase(path);
  gatewayReader = new Database(path, { readonly: true });
  indexDb = createIndexDatabase(join(directory, "index.db"));
});

afterEach(() => {
  indexDb.close();
  gatewayReader.close();
  gatewayWriter.close();
  rmSync(directory, { recursive: true, force: true });
});

function seed(count: number, prefix: string, chunksPerDoc: number): void {
  const body = "Invented quarterly budget review line item for the north office. ";
  const content = body
    .repeat(Math.ceil((chunksPerDoc * 1800) / body.length))
    .slice(0, chunksPerDoc * 1800);
  for (let start = 0; start < count; start += 500) {
    const docs: DocumentInput[] = [];
    for (let i = start; i < Math.min(count, start + 500); i += 1) {
      docs.push({
        providerId: "notes" as DocumentInput["providerId"],
        sourceId: "notes:fictional@example.org" as DocumentInput["sourceId"],
        externalId: `${prefix}${i}`,
        title: `Budget note ${prefix}${i}`,
        content: `${prefix}${i} ${content}`,
        contentHash: `hash-${prefix}${i}`,
        metadata: { documentType: "note" },
        sourceCreatedAt: "2026-08-01T00:00:00.000Z",
        sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
      });
    }
    upsertDocuments(gatewayWriter, docs as never);
  }
}

/** One sequential embedding slot costing `msPerChunk` per input. */
class SlotEmbedder implements Embedder {
  chunks = 0;
  private busy: Promise<void> = Promise.resolve();
  constructor(private readonly msPerChunk: number) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    const run = this.busy.then(
      () => new Promise<void>((r) => setTimeout(r, this.msPerChunk * texts.length)),
    );
    this.busy = run;
    await run;
    this.chunks += texts.length;
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

/** The gateway source, recording the page size of every scan. */
function recordingSource(pages: number[]): DocumentSource {
  const inner = new DirectDocumentSource(gatewayReader);
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "listUpdatedLightweight") {
        return (since: string | null, limit: number, afterId?: string) => {
          pages.push(limit);
          return target.listUpdatedLightweight(since, limit, afterId);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

interface Pace {
  pageSize: number;
  sleepMs: number;
  dbWriteBatchSize: number;
  catchUp: boolean;
  maxPageSize?: number;
  minSleepMs?: number;
}

async function scan(
  pace: Pace,
  msPerChunk: number,
  pressure: () => ScanPressureSignal = () => ({ userActive: false, walPendingFrames: 0 }),
): Promise<{ ms: number; indexed: number; pages: number[] }> {
  const pages: number[] = [];
  const indexer = new Indexer(
    indexDb,
    recordingSource(pages),
    new DocumentChunker(),
    new SlotEmbedder(msPerChunk),
    {
      pageSize: pace.pageSize,
      betweenPageSleepMs: pace.sleepMs,
      dbWriteBatchSize: pace.dbWriteBatchSize,
      ...(pace.catchUp
        ? {
            catchUp: {
              enabled: true,
              maxPageSize: pace.maxPageSize ?? 1000,
              minSleepMs: pace.minSleepMs ?? 0,
            },
          }
        : {}),
      getPressure: pressure,
    },
  );
  const started = performance.now();
  const result = await indexer.indexUpdated();
  return { ms: performance.now() - started, indexed: result.indexed, pages };
}

/**
 * A corpus where `indexedShare` of the documents are already indexed and the
 * rest are pending, spread over the id space the way a backlog is once a
 * source keeps ingesting while the indexer runs; the watermark is cleared, as
 * the boot-time reset leaves it, so the scan walks everything.
 */
async function backlog(total: number, indexedShare: number, chunksPerDoc: number): Promise<number> {
  const done = Math.round(total * indexedShare);
  seed(done, "done", chunksPerDoc);
  await scan({ pageSize: 500, sleepMs: 0, dbWriteBatchSize: 50, catchUp: false }, 0);
  indexDb.prepare("DELETE FROM watermark").run();
  seed(total - done, "todo", chunksPerDoc);
  return total - done;
}

function reset(): void {
  indexDb.exec("DELETE FROM chunks; DELETE FROM indexed_documents; DELETE FROM watermark;");
}

describe("indexing scan throughput", () => {
  const FIXED: Pace = { pageSize: 10, sleepMs: 20, dbWriteBatchSize: 1, catchUp: false };
  const CATCH_UP: Pace = { ...FIXED, catchUp: true };

  test("catch-up drains a mostly indexed backlog at least twice as fast as the fixed pace", async () => {
    const pending = await backlog(900, 0.75, 1);
    const fixed = await scan(FIXED, 1);
    expect(fixed.indexed).toBe(pending);
    expect(fixed.pages.every((n) => n === 10)).toBe(true);

    indexDb.exec("DELETE FROM watermark");
    const todo = gatewayReader
      .prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id LIKE 'todo%'")
      .all()
      .map((r) => r.id);
    const del = indexDb.prepare("DELETE FROM indexed_documents WHERE document_id = ?");
    const delChunks = indexDb.prepare("DELETE FROM chunks WHERE document_id = ?");
    for (const id of todo) {
      delChunks.run(id);
      del.run(id);
    }
    const adaptive = await scan(CATCH_UP, 1);
    expect(adaptive.indexed).toBe(pending);
    expect(Math.max(...adaptive.pages)).toBeGreaterThan(10);
    expect(adaptive.ms).toBeLessThan(fixed.ms / 2);
    log.info(
      `bench (unit): fixed ${Math.round(fixed.ms)}ms over ${fixed.pages.length} pages, catch-up ${Math.round(adaptive.ms)}ms over ${adaptive.pages.length} pages`,
    );
  });

  test("a user request in flight holds the scan to the configured page size", async () => {
    const pending = await backlog(300, 0.5, 1);
    const held = await scan(CATCH_UP, 1, () => ({ userActive: true, walPendingFrames: 0 }));
    expect(held.indexed).toBe(pending);
    expect(held.pages.every((n) => n === 10)).toBe(true);
  });

  test("a backed-up index WAL drops the page to the configured size until it clears", async () => {
    const pending = await backlog(600, 0.8, 1);
    let calls = 0;
    const held = await scan({ ...CATCH_UP, sleepMs: 1 }, 1, () => {
      calls += 1;
      return { userActive: false, walPendingFrames: calls >= 6 && calls < 10 ? 50_000 : 0 };
    });
    expect(held.indexed).toBe(pending);
    // Pages 1-5 grow; settles 6-9 see the WAL over its limit, so pages 7-10
    // are back at the configured size; growth resumes after.
    expect(held.pages[5]).toBeGreaterThan(10);
    expect(held.pages.slice(6, 10)).toEqual([10, 10, 10, 10]);
    expect(Math.max(...held.pages.slice(10))).toBeGreaterThan(10);
  });

  test("the missing-document pass grows its batches while catching up and holds them under pressure", async () => {
    seed(400, "gap", 1);
    const batches = (userActive: boolean) => {
      const sizes: number[] = [];
      const inner = new DirectDocumentSource(gatewayReader);
      const source = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "getByIds") {
            return (ids: string[]) => {
              sizes.push(ids.length);
              return target.getByIds(ids);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const indexer = new Indexer(indexDb, source, new DocumentChunker(), new SlotEmbedder(0), {
        pageSize: 10,
        betweenPageSleepMs: 1,
        dbWriteBatchSize: 1,
        catchUp: { enabled: true, maxPageSize: 1000, minSleepMs: 0 },
        getPressure: () => ({ userActive, walPendingFrames: 0 }),
      });
      return { indexer, sizes };
    };
    const held = batches(true);
    await held.indexer.reindexMissing();
    expect(getAllIndexedDocumentIds(indexDb).size).toBe(400);
    expect(held.sizes.every((n) => n <= 10)).toBe(true);

    reset();
    const free = batches(false);
    await free.indexer.reindexMissing();
    expect(getAllIndexedDocumentIds(indexDb).size).toBe(400);
    expect(Math.max(...free.sizes)).toBeGreaterThan(10);
    expect(free.sizes.length).toBeLessThan(held.sizes.length);
  });

  const bench = process.env.OMNESIS_INDEXER_BENCH === "1" ? test : test.skip;

  /**
   * The pilot's shape, time-scaled by `SCALE` so it runs in minutes: a
   * 10-document page and a 500 ms pause, one write transaction per document,
   * an embedder at ~20 chunks/s on its one indexing slot (50 ms a chunk), two
   * chunks a document. Every duration is divided by `SCALE`; rates are
   * multiplied back, so the figures logged are at the pilot's real speed.
   */
  bench(
    "pilot-shaped backlog, time-scaled",
    async () => {
      const SCALE = Number(process.env.OMNESIS_INDEXER_BENCH_SCALE ?? 25);
      const TOTAL = Number(process.env.OMNESIS_INDEXER_BENCH_DOCS ?? 6000);
      const msPerChunk = 50 / SCALE;
      const pilot: Pace = {
        pageSize: 10,
        sleepMs: 500 / SCALE,
        dbWriteBatchSize: 1,
        catchUp: false,
      };
      const scenarios: Array<{
        name: string;
        share: number;
        pace: Pace;
        slots: number;
        user?: boolean;
      }> = [
        { name: "re-walk, 95% indexed, fixed", share: 0.95, pace: pilot, slots: 1 },
        {
          name: "re-walk, 95% indexed, catch-up",
          share: 0.95,
          pace: { ...pilot, catchUp: true, minSleepMs: 10 / SCALE },
          slots: 1,
        },
        { name: "backlog, 52% indexed, fixed", share: 0.52, pace: pilot, slots: 1 },
        {
          name: "backlog, 52% indexed, catch-up",
          share: 0.52,
          pace: { ...pilot, catchUp: true, minSleepMs: 10 / SCALE },
          slots: 1,
        },
        {
          name: "backlog, 52% indexed, catch-up, user always active",
          share: 0.52,
          pace: { ...pilot, catchUp: true, minSleepMs: 10 / SCALE },
          slots: 1,
          user: true,
        },
        {
          name: "backlog, 52% indexed, catch-up, 3 indexing slots",
          share: 0.52,
          pace: { ...pilot, catchUp: true, minSleepMs: 10 / SCALE },
          slots: 3,
        },
        { name: "backlog, 0% indexed, fixed", share: 0, pace: pilot, slots: 1 },
        {
          name: "backlog, 0% indexed, catch-up",
          share: 0,
          pace: { ...pilot, catchUp: true, minSleepMs: 10 / SCALE },
          slots: 1,
        },
      ];
      for (const s of scenarios) {
        reset();
        gatewayWriter.exec("DELETE FROM documents");
        const pending = await backlog(TOTAL, s.share, 2);
        const r = await scan(s.pace, msPerChunk / s.slots, () => ({
          userActive: s.user === true,
          walPendingFrames: 0,
        }));
        expect(r.indexed).toBe(pending);
        expect(getAllIndexedDocumentIds(indexDb).size).toBe(TOTAL);
        const realSec = (r.ms * SCALE) / 1000;
        log.info(
          `bench: ${s.name}: ${TOTAL} scanned, ${pending} newly indexed in ${realSec.toFixed(0)}s at pilot speed — ${(TOTAL / realSec).toFixed(1)} scanned/s, ${(pending / realSec).toFixed(2)} indexed/s, ${r.pages.length} pages, max page ${Math.max(...r.pages)}`,
        );
      }
    },
    3_600_000,
  );
});
