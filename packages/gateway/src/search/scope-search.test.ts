// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createScopeFactsSchema } from "../access/scope-schema.js";
import {
  initializeScopeGenerationEpoch,
  readScopeSourceGenerations,
  changedScopeSources,
  acknowledgeScopeReplay,
  SCOPE_REPLAY_ACK_BATCH_SIZE,
} from "../access/scope-generations.js";
import { replaceDocumentScopeFacts } from "../access/scope-facts.js";
import { replayScopeMirror } from "../indexer/scope-mirror.js";
import {
  createIndexDatabase,
  upsertChunks,
  openIndexDb,
  setActiveIndexVersion,
} from "../indexer/db.js";
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
import { SearchPipeline } from "./pipeline.js";
import type { CandidateGenRequest } from "./candidate-gen.js";
import type { ScopePolicy } from "@omnesis/types";

let dir: string;
let corpus: Database.Database;
let index: Database.Database;
let pools: SearchWorkerPool[] = [];
const source = "fictional:one";
const vector = new Float32Array([1, 0, 0, 0]);
const policy: ScopePolicy = {
  sourceId: source,
  audience: { accessLevel: "test", capability: "direct" },
  rules: [{ action: "hide", match: [{ kind: "conversation", id: "secret" }] }],
  otherwise: "share",
};
beforeEach(() => {
  pools = [];
  dir = mkdtempSync(join(tmpdir(), "omnesis-scope-search-"));
  corpus = new Database(join(dir, "corpus.db"));
  corpus.pragma("journal_mode = WAL");
  corpus.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT); CREATE INDEX source_docs ON documents(source_id); CREATE TABLE sources(id TEXT PRIMARY KEY,type TEXT)",
  );
  createScopeFactsSchema(corpus);
  corpus.prepare("INSERT INTO sources VALUES (?, 'fictional')").run(source);
  corpus
    .prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES (?, 'fictional','{}',1)",
    )
    .run(source);
  index = createIndexDatabase(join(dir, "index.db"));
});
afterEach(async () => {
  await Promise.all(pools.map((pool) => pool.dispose()));
  index.close();
  corpus.close();
  rmSync(dir, { recursive: true, force: true });
});
function document(id: string, conversation = "public", embedding = vector) {
  corpus.prepare("INSERT INTO documents VALUES (?,?)").run(id, source);
  replaceDocumentScopeFacts(corpus, id, {
    facts: [{ kind: "conversation", id: conversation }],
    complete: ["conversation"],
  });
  upsertChunks(index, [
    {
      id: `chunk-${id}`,
      documentId: id,
      sourceId: source,
      chunkIndex: 0,
      content: "invented telescope observatory plan",
      title: id,
      sourceCreatedAt: "2026-04-03T12:00:00Z",
      embedding,
    },
  ]);
}
function authorization(): ScopeSearchAuthorization {
  return { policies: [policy], generations: readScopeSourceGenerations(corpus, [source]) };
}
function sync() {
  for (let i = 0; i < 200; i++) {
    const result = replayScopeMirror(corpus, index, { batchSize: 3, maxBatches: 1 });
    if (!result.pages) return;
  }
  throw new Error("Replay did not converge");
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
function visible(auth = authorization()) {
  return withScopeSearchAuthorization(index, auth, () =>
    browseByRecency(index, {}, undefined, 50).map((item) => item.documentId),
  );
}

test("legacy pending participant recovery is generation-fenced and mirrored as compact source state", () => {
  document("allowed");
  replaceDocumentScopeFacts(corpus, "allowed", {
    facts: [{ kind: "participant", identifier: { type: "email", value: "person@example.org" } }],
    complete: ["participant"],
  });
  const participant: ScopePolicy = {
    ...policy,
    rules: [
      {
        action: "share",
        match: [
          {
            kind: "participant",
            label: "Fictional person",
            identifiers: [{ type: "email", value: "person@example.org" }],
          },
        ],
      },
    ],
    otherwise: "hide",
  };
  const auth = (): ScopeSearchAuthorization => ({
    policies: [participant],
    generations: readScopeSourceGenerations(corpus, [source]),
  });
  sync();
  expect(visible(auth())).toEqual(["allowed"]);
  corpus.prepare("INSERT INTO scope_native_reprojection VALUES('unmapped-legacy',?)").run(source);
  expect(visible(auth())).toEqual([]);
  sync();
  expect(index.prepare("SELECT * FROM scope_native_reprojection_sources").all()).toEqual([
    { source_id: source, pending: 1 },
  ]);
  expect(visible(auth())).toEqual([]);
  corpus.prepare("DELETE FROM scope_native_reprojection WHERE document_id='unmapped-legacy'").run();
  expect(visible(auth())).toEqual([]);
  sync();
  expect(visible(auth())).toEqual(["allowed"]);
  expect(index.prepare("SELECT * FROM scope_native_reprojection_sources").all()).toEqual([]);
});

test("all candidate lanes apply policies before ranking and ignore the lexical memory ranker", () => {
  for (let i = 0; i < 12; i++) document(`hidden-${i}`, "secret");
  document("allowed", "public", new Float32Array([0.8, 0.2, 0, 0]));
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

test("metadata-only narrowing fences a stale mirror immediately and needs no reembedding", () => {
  document("allowed");
  sync();
  expect(visible()).toEqual(["allowed"]);
  const embedding = index.prepare("SELECT embedding FROM chunks").get();
  replaceDocumentScopeFacts(corpus, "allowed", {
    facts: [{ kind: "conversation", id: "secret" }],
    complete: ["conversation"],
  });
  expect(visible()).toEqual([]);
  sync();
  expect(visible()).toEqual([]);
  expect(index.prepare("SELECT embedding FROM chunks").get()).toEqual(embedding);
});

test("interrupted replay remains unpublished and restarts when its corpus generation changes", () => {
  document("one");
  document("two");
  document("three");
  replayScopeMirror(corpus, index, { batchSize: 1, maxBatches: 2 });
  expect(visible()).toEqual([]);
  replaceDocumentScopeFacts(corpus, "one", {
    facts: [{ kind: "conversation", id: "secret" }],
    complete: ["conversation"],
  });
  index.close();
  index = createIndexDatabase(join(dir, "index.db"));
  sync();
  expect(visible().sort()).toEqual(["three", "two"]);
});

test("the generation comparison uses the same pinned index snapshot as candidate SQL", () => {
  document("one");
  sync();
  const pinned = openIndexDb(join(dir, "index.db"), { readonly: true });
  pinned.exec("BEGIN");
  pinned.prepare("SELECT * FROM index_scope_generations").all();
  replaceDocumentScopeFacts(corpus, "one", {
    facts: [{ kind: "conversation", id: "secret" }],
    complete: ["conversation"],
  });
  sync();
  expect(
    withScopeSearchAuthorization(pinned, authorization(), () =>
      browseByRecency(pinned, {}, undefined, 50),
    ),
  ).toEqual([]);
  pinned.exec("ROLLBACK");
  pinned.close();
});

test("epoch rotation and source reuse never revive an older matching mirror", () => {
  document("one");
  sync();
  const previous = authorization().generations;
  initializeScopeGenerationEpoch(corpus);
  expect(changedScopeSources(previous, authorization().generations)).toEqual([source]);
  expect(visible()).toEqual([]);
  sync();
  expect(visible()).toEqual(["one"]);
  corpus.prepare("DELETE FROM sources WHERE id=?").run(source);
  corpus.prepare("INSERT INTO sources VALUES (?, 'fictional')").run(source);
  expect(visible()).toEqual([]);
});

test("source generations are checked again after asynchronous search work", async () => {
  document("one");
  sync();
  const pipeline = new SearchPipeline({ indexDb: index });
  await attachSearchPool(pipeline);
  let reads = 0;
  pipeline.setScopeAuthorizationReads({
    scopeSourceGenerations: async (ids) => {
      reads++;
      if (reads === 2)
        replaceDocumentScopeFacts(corpus, "one", {
          facts: [{ kind: "conversation", id: "secret" }],
          complete: ["conversation"],
        });
      return readScopeSourceGenerations(corpus, ids);
    },
  });
  const result = await pipeline.search(
    { text: "telescope", limit: 5 },
    { sourceIds: [source], scopePolicies: [policy] },
  );
  expect(result.results).toEqual([]);
  expect(reads).toBe(4);
});

test("policy-only authorization preserves unrelated unconfigured source documents", async () => {
  document("scoped");
  sync();
  upsertChunks(index, [
    {
      id: "internal",
      documentId: "internal",
      sourceId: "internal:journal",
      chunkIndex: 0,
      content: "invented telescope journal",
      title: "journal",
      sourceCreatedAt: "2026-04-03T12:00:00Z",
      embedding: vector,
    },
  ]);
  const pipeline = new SearchPipeline({ indexDb: index });
  await attachSearchPool(pipeline);
  pipeline.setScopeAuthorizationReads({
    scopeSourceGenerations: async (ids) => readScopeSourceGenerations(corpus, ids),
  });
  const result = await pipeline.search(
    { text: "telescope", limit: 5 },
    { scopePolicies: [policy] },
  );
  expect(result.results.map((row) => row.documentId).sort()).toEqual(["internal", "scoped"]);
  const none = await pipeline.search(
    { text: "telescope", limit: 5 },
    { sourceIds: [], scopePolicies: [policy] },
  );
  expect(none.results).toEqual([]);
});

test("real candidate workers receive compact generation fences and filter both lexical and browse pools", async () => {
  document("hidden", "secret");
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
  await pool.start();
  try {
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
      candidateLimit: 1,
      limit: 1,
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
    replaceDocumentScopeFacts(corpus, "allowed", {
      facts: [{ kind: "conversation", id: "secret" }],
      complete: ["conversation"],
    });
    expect(
      (await pool.candidateGen({ ...request, scopeAuthorization: authorization() })).results,
    ).toEqual([]);
    expect(request.allowedDocumentIds).toBeUndefined();
    expect(JSON.stringify(request.scopeAuthorization).length).toBeLessThan(1000);
  } finally {
    await pool.dispose();
  }
});

test("initial replay progresses while existing subjects keep changing between pages", () => {
  for (let i = 0; i < 40; i++) document(`item-${i}`);
  let copied = 0,
    published = 0;
  const cursors: number[] = [];
  for (let page = 0; page < 80; page++) {
    replaceDocumentScopeFacts(corpus, "item-0", {
      facts: [{ kind: "conversation", id: page % 2 ? "secret" : "public" }],
      complete: ["conversation"],
    });
    const result = replayScopeMirror(corpus, index, { batchSize: 3, maxBatches: 1 });
    copied += result.copied;
    const state = index
      .prepare<[], { phase: string; cursor: number }>("SELECT phase,cursor FROM index_scope_replay")
      .get();
    if (state?.phase === "documents") cursors.push(state.cursor);
    if (result.published) {
      published++;
      break;
    }
  }
  expect(published).toBe(1);
  expect(copied).toBeLessThanOrEqual(43);
  expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
  expect(visible().length).toBeGreaterThanOrEqual(39);
});

test("ordinary metadata mutations replay only dirty subjects after the initial snapshot", () => {
  for (let i = 0; i < 30; i++) document(`item-${i}`);
  sync();
  replaceDocumentScopeFacts(corpus, "item-0", {
    facts: [{ kind: "conversation", id: "secret" }],
    complete: ["conversation"],
  });
  const result = replayScopeMirror(corpus, index, { batchSize: 3, maxBatches: 1 });
  expect(result.copied).toBe(1);
  expect(result.published).toBe(1);
  expect(visible()).not.toContain("item-0");
  expect(visible()).toHaveLength(29);
});

test("durable replay acknowledgement is bounded and never erases newer dirty facts", () => {
  document("one");
  sync();
  const old = authorization().generations[0]!;
  replaceDocumentScopeFacts(corpus, "one", {
    facts: [{ kind: "conversation", id: "secret" }],
    complete: ["conversation"],
  });
  expect(acknowledgeScopeReplay(corpus, { ...old, epoch: "different-boot" })).toBe(0);
  acknowledgeScopeReplay(corpus, old);
  expect(
    corpus.prepare("SELECT subject_document_id FROM scope_replay_dirty WHERE kind='subject'").all(),
  ).toEqual([{ subject_document_id: "one" }]);
  const current = authorization().generations[0]!;
  const insert = corpus.prepare("INSERT INTO scope_replay_dirty VALUES (?, 'subject', ?, ?)");
  corpus.transaction(() => {
    for (let i = 0; i < SCOPE_REPLAY_ACK_BATCH_SIZE + 5; i++)
      insert.run(source, `removed-${i}`, current.generation);
  })();
  expect(acknowledgeScopeReplay(corpus, current)).toBe(SCOPE_REPLAY_ACK_BATCH_SIZE);
  expect(
    (corpus.prepare("SELECT COUNT(*) AS n FROM scope_replay_dirty").get() as { n: number }).n,
  ).toBeGreaterThan(0);
});

test("filtered requests refuse heavy main-thread fallback when workers are disabled", async () => {
  document("one");
  sync();
  const pipeline = new SearchPipeline({ indexDb: index });
  pipeline.setScopeAuthorizationReads({
    scopeSourceGenerations: async (ids) => readScopeSourceGenerations(corpus, ids),
  });
  await expect(
    pipeline.search({ text: "telescope", limit: 5 }, { scopePolicies: [policy] }),
  ).rejects.toThrow("gateway.searchWorker.concurrency");
  expect(
    (await pipeline.search({ text: "telescope", limit: 5 })).results.map((row) => row.documentId),
  ).toEqual(["one"]);
});

test("a fresh ranked retry fills the limit from an unaffected source after its first head loses authority", async () => {
  document("changed-top");
  upsertChunks(index, [
    {
      id: "below",
      documentId: "below",
      sourceId: "fictional:whole",
      chunkIndex: 0,
      content: "invented telescope journal",
      title: "below",
      sourceCreatedAt: "2025-04-03T12:00:00Z",
      embedding: vector,
    },
  ]);
  sync();
  const pipeline = new SearchPipeline({ indexDb: index });
  await attachSearchPool(pipeline);
  let reads = 0;
  pipeline.setScopeAuthorizationReads({
    scopeSourceGenerations: async (ids) => {
      reads++;
      if (reads === 2)
        replaceDocumentScopeFacts(corpus, "changed-top", {
          facts: [{ kind: "conversation", id: "secret" }],
          complete: ["conversation"],
        });
      return readScopeSourceGenerations(corpus, ids);
    },
  });
  const result = await pipeline.search(
    { text: "", limit: 1 },
    { sourceIds: [source, "fictional:whole"], scopePolicies: [policy] },
  );
  expect(result.results.map((row) => row.documentId)).toEqual(["below"]);
  expect(reads).toBe(4);
});

test("continuously changing authority fails explicitly after one bounded ranked retry", async () => {
  document("changing");
  sync();
  const pipeline = new SearchPipeline({ indexDb: index });
  await attachSearchPool(pipeline);
  let reads = 0;
  pipeline.setScopeAuthorizationReads({
    scopeSourceGenerations: async (ids) => {
      reads++;
      if (reads === 2 || reads === 4)
        replaceDocumentScopeFacts(corpus, "changing", {
          facts: [{ kind: "conversation", id: reads === 2 ? "secret" : "public" }],
          complete: ["conversation"],
        });
      return readScopeSourceGenerations(corpus, ids);
    },
  });
  await expect(
    pipeline.search({ text: "telescope", limit: 1 }, { scopePolicies: [policy] }),
  ).rejects.toThrow("Source permissions changed");
  expect(reads).toBe(4);
});

test("scoped exact vectors retain the embedding generation guard during same-dimension model swaps", () => {
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

test("one hundred thousand dirty hierarchy entities replay in bounded pages while document writes continue", () => {
  document("anchor");
  corpus
    .prepare(
      `WITH RECURSIVE entities(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM entities WHERE i<99999)
    INSERT INTO scope_hierarchy_dirty(source_id,kind,entity_id,revision,cursor_document_id)
    SELECT ?,'folder',printf('folder-%06d',i),'initial','' FROM entities`,
    )
    .run(source);
  const batchSize = 256;
  let published = false,
    pages = 0,
    lastCount = 0;
  for (; pages < 450; pages++) {
    const result = replayScopeMirror(corpus, index, { batchSize, maxBatches: 1 });
    expect(result.pages).toBe(1);
    expect(result.copied).toBeLessThanOrEqual(batchSize);
    const count = index
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM scope_hierarchy_dirty")
      .get()!.count;
    expect(count - lastCount).toBeLessThanOrEqual(batchSize);
    lastCount = count;
    if (result.published) {
      published = true;
      break;
    }
    corpus
      .prepare(
        "UPDATE scope_hierarchy_dirty SET revision=? WHERE source_id=? AND kind='folder' AND entity_id='folder-000000'",
      )
      .run(`revision-${pages}`, source);
    replaceDocumentScopeFacts(corpus, "anchor", {
      facts: [{ kind: "conversation", id: "public" }],
      complete: ["conversation"],
    });
  }
  expect(published).toBe(true);
  expect(lastCount).toBe(100000);
  expect(
    index
      .prepare(
        "SELECT revision FROM scope_hierarchy_dirty WHERE source_id=? AND kind='folder' AND entity_id='folder-000000'",
      )
      .get(source),
  ).toEqual(
    corpus
      .prepare(
        "SELECT revision FROM scope_hierarchy_dirty WHERE source_id=? AND kind='folder' AND entity_id='folder-000000'",
      )
      .get(source),
  );
  expect(
    index.prepare("SELECT generation FROM index_scope_generations WHERE source_id=?").get(source),
  ).toEqual(
    corpus.prepare("SELECT generation FROM scope_source_generations WHERE source_id=?").get(source),
  );
}, 30000);

test("a wire-bounded large subject publishes all facts and completeness atomically without changing chunks", () => {
  document("large");
  sync();
  const before = index
    .prepare("SELECT content,embedding FROM chunks WHERE document_id='large'")
    .get();
  replaceDocumentScopeFacts(corpus, "large", {
    facts: Array.from({ length: 16384 }, (_, i) => ({ kind: "label" as const, id: `label-${i}` })),
    complete: ["label"],
  });
  const largePolicy: ScopePolicy = {
    ...policy,
    rules: [{ action: "share", match: [{ kind: "label", id: "label-16383" }] }],
    otherwise: "hide",
  };
  const auth = () => ({
    policies: [largePolicy],
    generations: readScopeSourceGenerations(corpus, [source]),
  });
  withScopeSearchAuthorization(index, auth(), () =>
    expect(browseByRecency(index, {}, undefined, 1)).toEqual([]),
  );
  sync();
  expect(
    index
      .prepare("SELECT COUNT(*) AS count FROM document_scope_facts WHERE document_id='large'")
      .get(),
  ).toEqual({ count: 16384 });
  withScopeSearchAuthorization(index, auth(), () =>
    expect(browseByRecency(index, {}, undefined, 1).map((item) => item.documentId)).toEqual([
      "large",
    ]),
  );
  expect(
    index.prepare("SELECT content,embedding FROM chunks WHERE document_id='large'").get(),
  ).toEqual(before);
});
