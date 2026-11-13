// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The filter check reads a record's people through SQL functions that exist
 * only on a connection they were registered on. A statement using the check
 * on any other connection fails to prepare, so it can never run unchecked;
 * each connection the gateway reads filtered data on must register them.
 *
 * The indexer worker's own handles are opened inside the worker and are not
 * reachable from a test; the worker registers them where it opens them.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import {
  buildFilterCopyBatch,
  refreshFilterListCopy,
  writeFilterCopyBatch,
} from "../indexer/filter-copy.js";
import { createIndexDatabase, upsertChunks } from "../indexer/db.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { ioGateFromScheduler } from "../scheduler/io-ops.js";
import { openSearchSnapshotHandle } from "../search/snapshot-handle.js";
import {
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "../search/search-config.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import { filterFieldsFor } from "./filter-fields.js";
import { filterReadableDocumentIds, type DocumentAccessGrant } from "./filter-decision.js";
import {
  INDEX_FILTER_TABLES,
  compileSourceFilter,
  sourceFilterInclusionSql,
  type FilterSql,
} from "./filter-sql.js";
import {
  LEDGER_PROFILE,
  hide,
  insertDocument,
  person,
  publishProfile,
} from "./filter-test-utils.js";
import type { CandidateGenRequest } from "../search/candidate-gen.js";
import type { Db } from "../data/types.js";

const LEDGER = "ledger:northstar";
const policy = hide(LEDGER, [person("Maya", ["email", "maya@example.org"])]);
const grant: DocumentAccessGrant = {
  capabilityGranted: true,
  permittedSourceIds: null,
  filters: [policy],
};

let dir: string;
let corpusPath: string;
let indexPath: string;
let corpus: Db;
let index: Db;

function mail(id: string, sender: string): void {
  insertDocument(corpus, {
    id,
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "entry", people: [{ role: "sender", emails: [sender] }], extra: {} },
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-filter-connections-"));
  corpusPath = join(dir, "corpus.db");
  indexPath = join(dir, "index.db");
  corpus = createDatabase(corpusPath) as unknown as Db;
  publishProfile(corpus, "ledger", 5, LEDGER_PROFILE);
  mail("from-maya", "maya@example.org");
  mail("from-jamie", "jamie@example.io");
  index = createIndexDatabase(indexPath);
  upsertChunks(
    index,
    ["from-maya", "from-jamie"].map((id) => ({
      id: `chunk-${id}`,
      documentId: id,
      sourceId: LEDGER,
      chunkIndex: 0,
      content: `invented telescope note ${id.replace("-", " ")}`,
      title: id,
      sourceCreatedAt: "2027-03-01T09:00:00.000Z",
      embedding: null,
    })),
  );
  refreshFilterListCopy({ corpusDb: corpus, indexDb: index });
  writeFilterCopyBatch(index, buildFilterCopyBatch(corpus, ["from-maya", "from-jamie"]));
});

afterAll(() => {
  index.close();
  corpus.close();
  rmSync(dir, { recursive: true, force: true });
});

function compiled() {
  return compileSourceFilter(policy, filterFieldsFor(corpus, "ledger"));
}

function corpusCheck(): FilterSql {
  return sourceFilterInclusionSql([compiled()], "d.id", "d.source_id", { row: "d" });
}

function indexCheck(): FilterSql {
  return sourceFilterInclusionSql([compiled()], "c.document_id", "c.source_id", {
    map: INDEX_FILTER_TABLES,
  });
}

function readable(db: Db, check: FilterSql): string[] {
  return db
    .prepare<unknown[], { id: string }>(
      `SELECT d.id FROM documents d WHERE ${check.sql} ORDER BY d.id`,
    )
    .all(...check.params)
    .map((row) => row.id);
}

function offered(db: Db, check: FilterSql): string[] {
  return db
    .prepare<unknown[], { id: string }>(
      `SELECT DISTINCT c.document_id AS id FROM chunks c WHERE ${check.sql} ORDER BY id`,
    )
    .all(...check.params)
    .map((row) => row.id);
}

describe("a connection without the functions", () => {
  it("cannot prepare the check on the corpus", () => {
    const raw = new Database(corpusPath, { readonly: true }) as unknown as Db;
    try {
      expect(() => readable(raw, corpusCheck())).toThrow(/no such function/);
    } finally {
      raw.close();
    }
  });

  it("cannot prepare the check on the index copy", () => {
    const raw = new Database(indexPath, { readonly: true }) as unknown as Db;
    try {
      expect(() => offered(raw, indexCheck())).toThrow(/no such function/);
    } finally {
      raw.close();
    }
  });
});

describe("every connection the gateway opens has them", () => {
  it("the gateway's own handle, `createDatabase`", () => {
    const second = createDatabase(corpusPath) as unknown as Db;
    try {
      expect(readable(second, corpusCheck())).toEqual(["from-jamie"]);
    } finally {
      second.close();
    }
  });

  it("the search snapshot handle on the index", () => {
    const handle = openSearchSnapshotHandle(indexPath);
    try {
      expect(offered(handle.db, indexCheck())).toEqual(["from-jamie"]);
    } finally {
      handle.close();
    }
  });

  it("a search worker's index handle", async () => {
    const pool = new SearchWorkerPool({
      indexDbPath: indexPath,
      configDir: dir,
      concurrency: 1,
      maxInflightBeforeFallback: 2,
      heartbeatIntervalMs: 1000,
      heartbeatWarnGapMs: 10000,
      workerUrl: new URL("../workers/search-worker.ts", import.meta.url),
      workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
    });
    await pool.start();
    try {
      const settings = resolveSearchSettings(undefined);
      const request: CandidateGenRequest = {
        mode: "browse",
        bm25Text: "",
        embedderPresent: false,
        queryVector: null,
        queryModelId: null,
        embedMs: 0,
        filters: {},
        allowedDocumentIds: undefined,
        candidateLimit: 10,
        limit: 10,
        settings,
        vectorConfig: resolveVectorConfig(undefined),
        sourcePriors: resolveSourcePriorsConfig(
          undefined,
          {},
          { docCounts: [], rrfK: settings.params.rrfK },
        ),
        diversity: resolveDiversityConfig(undefined),
        commonTokenThreshold: 0,
        scopeAuthorization: { filters: [compiled()] },
      };
      const result = await pool.candidateGen(request);
      expect(result.results.map((row) => row.documentId)).toEqual(["from-jamie"]);
    } finally {
      await pool.dispose();
    }
  }, 30_000);

  it("an IO worker's corpus handle", async () => {
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(
      new IoTaskRunner({
        gatewayDbPath: corpusPath,
        heartbeatIntervalMs: 1000,
        heartbeatWarnGapMs: 10000,
        workerUrl: new URL("../workers/io-worker.ts", import.meta.url),
        workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
      }),
    );
    try {
      await scheduler.start();
      const ids = ["from-maya", "from-jamie"];
      const worker = await ioGateFromScheduler(scheduler).filterReadableDocumentIds(grant, ids);
      expect(worker).toEqual([...filterReadableDocumentIds(corpus, grant, ids)]);
      expect(worker).toEqual(["from-jamie"]);
    } finally {
      await scheduler.dispose();
    }
  }, 30_000);
});
