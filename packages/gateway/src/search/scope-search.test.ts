// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search under source filters: every candidate lane applies the filters to
 * the index's copy of each record's details, the copy can lag the corpus but
 * nothing it lets through is returned or counted unless the corpus agrees,
 * and a filtered search runs only on a search worker.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDatabase } from "../db.js";
import { filterFieldsFor } from "../access/filter-fields.js";
import { compileSourceFilter } from "../access/filter-sql.js";
import {
  LEDGER_PROFILE,
  hide,
  insertDocument,
  label,
  publishList,
  publishProfile,
} from "../access/filter-test-utils.js";
import {
  buildFilterCopyBatch,
  refreshFilterListCopy,
  writeFilterCopyBatch,
} from "../indexer/filter-copy.js";
import { createIndexDatabase, upsertChunks, setActiveIndexVersion } from "../indexer/db.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import {
  withScopeSearchAuthorization,
  type ScopeSearchAuthorization,
} from "./scope-authorization.js";
import { bm25Search } from "./bm25.js";
import { browseByRecency } from "./browse.js";
import { boundedExactVectorCandidates } from "./vector-bounded-exact.js";
import { hnswSearchCandidates } from "./vector-hnsw.js";
import { temporalLaneCandidates } from "./temporal-lane.js";
import {
  resolveSearchSettings,
  resolveDiversityConfig,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "./search-config.js";
import { FilteredSearchUnavailableError, SearchPipeline } from "./pipeline.js";
import type { CandidateGenRequest } from "./candidate-gen.js";
import type { Db } from "../data/types.js";

const SOURCE = "ledger:northstar";
const WHOLE = "ledger:archive";
const vector = new Float32Array([1, 0, 0, 0]);
const policy = hide(SOURCE, [label("L-secret")]);

let dir: string;
let corpus: Db;
let index: Db;
let pools: SearchWorkerPool[] = [];

beforeEach(() => {
  pools = [];
  dir = mkdtempSync(join(tmpdir(), "omnesis-scope-search-"));
  corpus = createDatabase(join(dir, "corpus.db")) as unknown as Db;
  corpus
    .prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('00000000-0000-4000-8000-0000000000c1', 'Invented collector', 'collector', 1)",
    )
    .run();
  for (const id of [SOURCE, WHOLE]) {
    corpus
      .prepare(
        "INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at) VALUES (?, 'ledger', ?, '00000000-0000-4000-8000-0000000000c1', 1, 1)",
      )
      .run(id, id.split(":")[1]);
  }
  publishProfile(corpus, "ledger", 5, LEDGER_PROFILE);
  publishList(corpus, { sourceId: SOURCE, field: "extra.labelIds" }, [
    { id: "L-secret", label: "Secret" },
    { id: "L-public", label: "Public" },
  ]);
  index = createIndexDatabase(join(dir, "index.db"));
});

afterEach(async () => {
  await Promise.all(pools.map((pool) => pool.dispose()));
  index.close();
  corpus.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A record in the corpus with its labels, and its chunk in the index. */
function document(
  id: string,
  labels: string[] = ["L-public"],
  options: { sourceId?: string; embedding?: Float32Array; createdAt?: string } = {},
) {
  const sourceId = options.sourceId ?? SOURCE;
  insertDocument(corpus, {
    id,
    sourceId,
    version: 3,
    metadata: { documentType: "entry", extra: { labelIds: labels } },
  });
  upsertChunks(index, [
    {
      id: `chunk-${id}`,
      documentId: id,
      sourceId,
      documentType: "entry",
      chunkIndex: 0,
      content: `invented telescope observatory plan ${id}`,
      title: id,
      sourceCreatedAt: options.createdAt ?? "2026-04-03T12:00:00Z",
      embedding: options.embedding ?? vector,
    },
  ]);
}

function relabel(id: string, labels: string[]) {
  corpus
    .prepare("UPDATE documents SET metadata = ? WHERE id = ?")
    .run(JSON.stringify({ documentType: "entry", extra: { labelIds: labels } }), id);
}

/** Bring the index's copy in line with the corpus. */
function sync() {
  refreshFilterListCopy({ corpusDb: corpus, indexDb: index });
  const ids = corpus
    .prepare<[], { id: string }>("SELECT id FROM documents")
    .all()
    .map((row) => row.id);
  writeFilterCopyBatch(index, buildFilterCopyBatch(corpus, ids));
}

function authorization(): ScopeSearchAuthorization {
  return { filters: [compileSourceFilter(policy, filterFieldsFor(corpus, "ledger"))] };
}

function offered(auth = authorization()) {
  return withScopeSearchAuthorization(index, auth, () =>
    browseByRecency(index, {}, undefined, 50).map((item) => item.documentId),
  );
}

async function attachSearchPool(pipeline: SearchPipeline) {
  const pool = new SearchWorkerPool({
    indexDbPath: join(dir, "index.db"),
    configDir: dir,
    concurrency: 1,
    maxInflightBeforeFallback: 2,
    heartbeatIntervalMs: 1000,
    heartbeatWarnGapMs: 10000,
    workerUrl: new URL("../workers/search-worker.ts", import.meta.url),
    workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
  });
  pools.push(pool);
  await pool.start();
  pipeline.setSearchPool(pool);
  return pool;
}

function pipeline() {
  const value = new SearchPipeline({ indexDb: index });
  value.setGatewayDb(corpus);
  return value;
}

test("every candidate lane applies the filters before ranking and skips the unfiltered rankers", () => {
  for (let i = 0; i < 12; i++) document(`hidden-${i}`, ["L-secret"]);
  document("allowed", ["L-public"], { embedding: new Float32Array([0.8, 0.2, 0, 0]) });
  sync();
  withScopeSearchAuthorization(index, authorization(), () => {
    const rank = vi.fn(() => {
      throw new Error("Memory ranker must not consume a filtered pool");
    });
    const lexical = bm25Search(index, "telescope", {}, 1, { ranker: { rank } });
    expect(lexical.candidates.map((item) => item.documentId)).toEqual(["allowed"]);
    expect(rank).not.toHaveBeenCalled();
    expect(browseByRecency(index, {}, undefined, 1).map((item) => item.documentId)).toEqual([
      "allowed",
    ]);
    expect(
      boundedExactVectorCandidates(index, vector, {}, 1, 1)?.map((item) => item.documentId),
    ).toEqual(["allowed"]);
    const search = vi.fn(() => {
      throw new Error("Unfiltered ANN must not consume a filtered candidate budget");
    });
    expect(
      hnswSearchCandidates({ search, maybeRefresh() {}, size: () => 13 }, index, vector, {}, 1).map(
        (item) => item.documentId,
      ),
    ).toEqual(["allowed"]);
    expect(search).not.toHaveBeenCalled();
    const temporal = temporalLaneCandidates(
      index,
      undefined,
      {
        windows: [{ start: "2026-04-01", endExclusive: "2026-04-10" }],
        eventDocumentIds: [],
        text: "telescope",
        vector,
        weight: 1,
      },
      {},
      undefined,
      1,
      { commonTokenThreshold: 0 },
    );
    expect(temporal.candidates.map((item) => item.documentId)).toEqual(["allowed"]);
  });
});

test("a record the copy does not hold, or holds under an older declaration, is offered by no lane", () => {
  document("copied");
  sync();
  document("not-copied");
  expect(offered()).toEqual(["copied"]);
  // A new declaration of the source: every row written under the old one is unknown.
  publishProfile(corpus, "ledger", 6, {
    ...LEDGER_PROFILE,
    metadataFields: LEDGER_PROFILE.metadataFields!.slice(0, 1),
  } as typeof LEDGER_PROFILE);
  expect(offered()).toEqual([]);
  sync();
  expect(offered().sort()).toEqual(["copied", "not-copied"]);
});

test("a hidden label added after the copy was written is never returned or counted, and the copy needs no reembedding", async () => {
  document("turned-secret", ["L-public"], { createdAt: "2026-04-05T12:00:00Z" });
  document("still-public");
  document("whole", ["L-public"], { sourceId: WHOLE });
  sync();
  const search = pipeline();
  await attachSearchPool(search);
  const ask = () =>
    search.search(
      { text: "telescope", limit: 10 },
      { sourceIds: [SOURCE, WHOLE], scopePolicies: [policy] },
    );
  expect((await ask()).results.map((row) => row.documentId).sort()).toEqual([
    "still-public",
    "turned-secret",
    "whole",
  ]);
  const embedding = index
    .prepare("SELECT embedding FROM chunks WHERE document_id = ?")
    .get("turned-secret");

  relabel("turned-secret", ["L-public", "L-secret"]);
  // The copy still says "public": candidate generation offers the record.
  expect(offered()).toContain("turned-secret");
  const stale = await ask();
  expect(stale.results.map((row) => row.documentId).sort()).toEqual(["still-public", "whole"]);
  expect(stale.facets).toEqual({
    byType: { entry: 2 },
    bySource: { [SOURCE]: 1, [WHOLE]: 1 },
  });

  sync();
  expect(offered()).not.toContain("turned-secret");
  expect((await ask()).results.map((row) => row.documentId).sort()).toEqual([
    "still-public",
    "whole",
  ]);
  expect(
    index.prepare("SELECT embedding FROM chunks WHERE document_id = ?").get("turned-secret"),
  ).toEqual(embedding);
});

test("a filter on one account keeps the other accounts whole, and an empty source list reads nothing", async () => {
  document("filtered");
  document("hidden", ["L-secret"]);
  document("whole", ["L-secret"], { sourceId: WHOLE });
  sync();
  const search = pipeline();
  await attachSearchPool(search);
  const result = await search.search({ text: "telescope", limit: 5 }, { scopePolicies: [policy] });
  expect(result.results.map((row) => row.documentId).sort()).toEqual(["filtered", "whole"]);
  const none = await search.search(
    { text: "telescope", limit: 5 },
    { sourceIds: [], scopePolicies: [policy] },
  );
  expect(none.results).toEqual([]);
});

test("a real search worker applies compiled filters to both the lexical and the browse pool", async () => {
  document("hidden", ["L-secret"]);
  document("allowed");
  sync();
  const pool = new SearchWorkerPool({
    indexDbPath: join(dir, "index.db"),
    configDir: dir,
    concurrency: 1,
    maxInflightBeforeFallback: 2,
    heartbeatIntervalMs: 1000,
    heartbeatWarnGapMs: 10000,
    workerUrl: new URL("../workers/search-worker.ts", import.meta.url),
    workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
  });
  pools.push(pool);
  await pool.start();
  const settings = resolveSearchSettings(undefined);
  const request: CandidateGenRequest = {
    mode: "hybrid",
    bm25Text: "telescope",
    embedderPresent: false,
    queryVector: null,
    queryModelId: null,
    embedMs: 0,
    filters: {},
    allowedDocumentIds: undefined,
    candidateLimit: 5,
    limit: 5,
    settings,
    vectorConfig: resolveVectorConfig(undefined),
    sourcePriors: resolveSourcePriorsConfig(
      undefined,
      {},
      { docCounts: [], rrfK: settings.params.rrfK },
    ),
    diversity: resolveDiversityConfig(undefined),
    commonTokenThreshold: 0,
    scopeAuthorization: authorization(),
  };
  expect((await pool.candidateGen(request)).results.map((row) => row.documentId)).toEqual([
    "allowed",
  ]);
  expect(
    (await pool.candidateGen({ ...request, mode: "browse", bm25Text: "" })).results.map(
      (row) => row.documentId,
    ),
  ).toEqual(["allowed"]);
  // The filter travels as compiled SQL, never as a list of readable ids.
  expect(request.allowedDocumentIds).toBeUndefined();
});

test("a filtered search with no search worker fails, while an unfiltered one runs inline", async () => {
  document("one");
  sync();
  const search = pipeline();
  const filtered = search.search({ text: "telescope", limit: 5 }, { scopePolicies: [policy] });
  await expect(filtered).rejects.toBeInstanceOf(FilteredSearchUnavailableError);
  await expect(filtered).rejects.toThrow("gateway.searchWorker.concurrency");
  expect(
    (await search.search({ text: "telescope", limit: 5 })).results.map((row) => row.documentId),
  ).toEqual(["one"]);
});

test("filtered exact vectors keep the embedding generation guard during same-dimension model swaps", () => {
  document("one");
  sync();
  index
    .prepare(
      "INSERT INTO index_versions(version,state,embed_model,embed_dim,created_at) VALUES(1,'active','new-model',4,'2026-01-01')",
    )
    .run();
  setActiveIndexVersion(index, 1);
  withScopeSearchAuthorization(index, authorization(), () => {
    expect(() =>
      boundedExactVectorCandidates(index, vector, {}, 1, 500, undefined, "old-model"),
    ).toThrow("different embedding generation");
    expect(
      boundedExactVectorCandidates(index, vector, {}, 1, 500, undefined, "new-model")?.map(
        (row) => row.documentId,
      ),
    ).toEqual(["one"]);
  });
});
