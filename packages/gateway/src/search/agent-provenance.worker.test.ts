// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent search provenance on the real io worker against a temp database: for
 * every query over a synthetic corpus, the worker returns exactly what the
 * same walk returns on a direct handle, for agent search and for per-hit graph
 * context, so moving the walk off the main event loop changes nothing a
 * search returns. A worker that cannot read, or has shut down, rejects rather
 * than hangs.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_V2_SETTINGS } from "@omnesis/config";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { ioGateFromScheduler, type IoGate } from "../scheduler/io-ops.js";
import {
  getUrlTraversalHubSources,
  resetUrlGraphRoles,
  setUrlGraphRoles,
} from "../url-graph-roles.js";
import {
  enrichAgentSearch,
  enrichGraphContextHits,
  type AgentSearchProvenanceOptions,
} from "./agent-provenance.js";
import {
  buildProvenanceCorpus,
  CORPUS_HUB_SOURCE,
  type ProvenanceCorpus,
} from "./__fixtures__/provenance-corpus.js";
import type { SearchResultItem } from "./types.js";

const WORKER_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const paths: string[] = [];
const schedulers: Scheduler[] = [];
const handles: Database.Database[] = [];

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.dispose();
  for (const handle of handles.splice(0)) handle.close();
  for (const path of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  resetUrlGraphRoles();
});

function tempPath(): string {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  paths.push(path);
  return path;
}

async function ioWorker(path: string): Promise<{ scheduler: Scheduler; gate: IoGate }> {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: path,
      concurrency: 2,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  schedulers.push(scheduler);
  return { scheduler, gate: ioGateFromScheduler(scheduler) };
}

function optionsFor(
  corpus: ProvenanceCorpus,
  hits: readonly SearchResultItem[],
): AgentSearchProvenanceOptions {
  return {
    ...DEFAULT_SEARCH_V2_SETTINGS,
    limit: 20,
    cleanRefCounts: true,
    excludeExternalDocuments: corpus.excludeExternalDocuments,
    indexedContentHashes: corpus.indexedContentHashes,
    readableDocumentIds: new Set(hits.map((hit) => hit.documentId)),
    urlTraversalHubSources: [...getUrlTraversalHubSources()],
  };
}

describe("agent search provenance on the io worker", () => {
  it.each([
    ["an empty corpus", 0],
    ["a small corpus", 1],
    ["a larger corpus", 3],
  ])("returns what the direct walk returns over %s", async (_label, scale) => {
    const path = tempPath();
    const db = createDatabase(path) as unknown as Database.Database;
    handles.push(db);
    const corpus = buildProvenanceCorpus(db, scale);
    setUrlGraphRoles("fixture", [CORPUS_HUB_SOURCE], [], []);
    const { gate } = await ioWorker(path);
    let enriched = 0;
    for (const hits of [...corpus.queries, []]) {
      const options = optionsFor(corpus, hits);
      const direct = enrichAgentSearch(db, hits, options);
      expect(await gate.agentSearchProvenance(hits, options)).toStrictEqual(direct);
      enriched += direct.filter((hit) => hit.provenance).length;
      const top = hits.slice(0, options.topN);
      expect(await gate.graphContextProvenance(top, options)).toStrictEqual(
        enrichGraphContextHits(db, top, options),
      );
    }
    // The corpus exercises the walk, not only its empty path.
    if (scale > 0) expect(enriched).toBeGreaterThan(corpus.queries.length);
  });

  it("resolves an exclusion by source identity against what is committed when it runs", async () => {
    const path = tempPath();
    const db = createDatabase(path) as unknown as Database.Database;
    handles.push(db);
    const corpus = buildProvenanceCorpus(db, 1);
    const { gate } = await ioWorker(path);
    const hits = corpus.queries[0]!;
    const target = (await gate.agentSearchProvenance(hits, optionsFor(corpus, hits)))[0]!;
    const options = {
      ...optionsFor(corpus, hits),
      excludeExternalDocuments: [
        { providerId: "example-transcripts", sourceId: target.sourceId, externalId: "turn-1" },
      ],
    };
    const before = await gate.agentSearchProvenance(hits, options);
    expect(before.map((hit) => hit.documentId)).toContain(target.documentId);
    // The document takes the excluded identity after the request was built,
    // as a transcript is ingested while a search waits on its lanes.
    db.prepare(
      "UPDATE documents SET provider_id='example-transcripts', external_id='turn-1' WHERE id=?",
    ).run(target.documentId);
    const after = await gate.agentSearchProvenance(hits, options);
    expect(after.map((hit) => hit.documentId)).not.toContain(target.documentId);
    expect(JSON.stringify(after)).not.toContain(`"${target.documentId}"`);
    expect(after).toStrictEqual(enrichAgentSearch(db, hits, options));
  });

  it("rejects when the worker's read fails", async () => {
    // A store with documents but no link graph: the walk's statements fail.
    const path = tempPath();
    const bare = new Database(path);
    handles.push(bare);
    bare.pragma("journal_mode = WAL");
    bare.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, source_id TEXT)");
    const { gate } = await ioWorker(path);
    const hit: SearchResultItem = {
      documentId: "note-1",
      sourceId: "notes:example",
      title: "Example note",
      documentType: "note",
      sourceCreatedAt: "2026-03-01T09:00:00.000Z",
      chunkText: "An invented note.",
      score: 1,
    };
    const options = optionsFor(
      { queries: [], indexedContentHashes: {}, excludeExternalDocuments: [] },
      [hit],
    );
    await expect(gate.agentSearchProvenance([hit], options)).rejects.toThrow(/no such/);
    await expect(gate.graphContextProvenance([hit], options)).rejects.toThrow(/no such/);
  });

  it("rejects instead of waiting once the worker pool has shut down", async () => {
    const path = tempPath();
    const db = createDatabase(path) as unknown as Database.Database;
    handles.push(db);
    const corpus = buildProvenanceCorpus(db, 1);
    const { scheduler, gate } = await ioWorker(path);
    const hits = corpus.queries[0]!;
    await scheduler.dispose();
    schedulers.splice(schedulers.indexOf(scheduler), 1);
    const options = optionsFor(corpus, hits);
    await expect(gate.agentSearchProvenance(hits, options)).rejects.toThrow(/dispos|shut/i);
    await expect(gate.graphContextProvenance(hits.slice(0, 1), options)).rejects.toThrow(
      /dispos|shut/i,
    );
  });
});
