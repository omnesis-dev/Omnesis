// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createDatabase } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createIndexDatabase } from "../indexer/db.js";
import { replaceDocumentScopeFacts } from "../access/scope-facts.js";
import { acknowledgeScopeReplay, readScopeSourceGenerations } from "../access/scope-generations.js";
import { withScopeSearchAuthorization } from "../search/scope-authorization.js";
import { browseByRecency } from "../search/browse.js";
import { IndexerWorkerProxy } from "./indexer-worker-proxy.js";
import type { ScopePolicy } from "@omnesis/types";

/** Real writer protocol, keyword-only indexer, and no inference backend. */
test("indexer mirrors metadata changes and acknowledges durable dirty work independently of embedding cadence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-scope-replay-worker-"));
  const corpus = createDatabase(join(dir, "corpus.db"));
  const index = createIndexDatabase(join(dir, "index.db"));
  let proxy: IndexerWorkerProxy | undefined;
  try {
    const source = "fictional:one";
    const host = createDevice(corpus, { name: "Synthetic collector", kind: "collector" }).id;
    corpus
      .prepare(
        "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES (?,'fictional','one',?,1,1)",
      )
      .run(source, host);
    corpus
      .prepare(
        "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES (?,'fictional','{}',1)",
      )
      .run(source);
    corpus
      .prepare(
        `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
      VALUES ('doc','fictional',?,'one','Telescope','Invented telescope plan','fictional-hash','{}','2026-04-03T12:00:00Z','2026-04-03T12:00:00Z','2026-04-03T12:00:00Z','2026-04-03T12:00:00Z')`,
      )
      .run(source);
    replaceDocumentScopeFacts(corpus, "doc", {
      facts: [{ kind: "conversation", id: "public" }],
      complete: ["conversation"],
    });
    const policy: ScopePolicy = {
      sourceId: source,
      audience: { accessLevel: "level", capability: "direct" },
      rules: [{ action: "hide", match: [{ kind: "conversation", id: "secret" }] }],
      otherwise: "share",
    };
    proxy = new IndexerWorkerProxy({
      lexicalOnly: true,
      modelPath: "unused",
      modelName: "keyword-only",
      embedDim: 1,
      gatewayDbPath: join(dir, "corpus.db"),
      indexDbPath: join(dir, "index.db"),
      cutoffs: { default: null, perSource: {} },
      indexIntervalMs: 3_600_000,
      indexBacklogIntervalMs: 3_600_000,
      dbWriteBatchSize: 5,
      reconcileIntervalMs: 3_600_000,
      reindexMissingIntervalMs: 3_600_000,
      embedConcurrency: 1,
      indexerPageSize: 5,
      indexerBetweenPageSleepMs: 0,
      reindexMissingAtBoot: false,
      chunkerChunkSize: 512,
      chunkerOverlap: 64,
      embedderContextSize: 2048,
      embedderTimeoutMs: 1000,
      embedderMaxInputChars: 8000,
      minFreeDiskMb: 0,
      embedderEncoding: { kind: "none" },
      usearchIndexPath: join(dir, "unused.usearch"),
      acknowledgeScopeReplay: async (completed) => acknowledgeScopeReplay(corpus, completed),
    });
    await proxy.whenReady();
    const visible = () =>
      withScopeSearchAuthorization(
        index,
        { policies: [policy], generations: readScopeSourceGenerations(corpus, [source]) },
        () => browseByRecency(index, {}, undefined, 5).map((row) => row.documentId),
      );
    await vi.waitFor(() => expect(visible()).toEqual(["doc"]), { timeout: 15000, interval: 25 });
    await vi.waitFor(
      () =>
        expect(corpus.prepare("SELECT COUNT(*) AS n FROM scope_replay_dirty").get()).toEqual({
          n: 0,
        }),
      { timeout: 15000, interval: 25 },
    );
    const before = index
      .prepare("SELECT embedding,indexed_at FROM chunks JOIN indexed_documents USING(document_id)")
      .get();
    replaceDocumentScopeFacts(corpus, "doc", {
      facts: [{ kind: "conversation", id: "secret" }],
      complete: ["conversation"],
    });
    expect(visible()).toEqual([]);
    await vi.waitFor(
      () =>
        expect(corpus.prepare("SELECT COUNT(*) AS n FROM scope_replay_dirty").get()).toEqual({
          n: 0,
        }),
      { timeout: 15000, interval: 25 },
    );
    expect(visible()).toEqual([]);
    expect(
      index
        .prepare(
          "SELECT embedding,indexed_at FROM chunks JOIN indexed_documents USING(document_id)",
        )
        .get(),
    ).toEqual(before);
  } finally {
    await proxy?.dispose();
    index.close();
    corpus.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
