// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Hidden-from-general-search sources: the bypass rule, and its
 * enforcement at the two `POST /search` candidate choke points (the
 * lexical WHERE builder and the vector JS post-filter). The `open-loops`
 * system source is the live registry entry, so these tests double as the
 * "open loops never leak into general search" guarantee.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import {
  OPEN_LOOP_DOCUMENT_TYPE,
  OPEN_LOOP_SOURCE_ID,
} from "../brain/open-loop-source/source-meta.js";
import { closeTempDb } from "./test-utils.js";
import { hnswSearchCandidates } from "./vector-hnsw.js";
import { buildMetadataFilter } from "./metadata.js";
import {
  HIDDEN_SEARCH_SOURCES,
  hiddenSourceIdsToExclude,
  isHiddenSearchType,
  withHiddenSourcesExcluded,
} from "./hidden-sources.js";
import type { UsearchReadHandle } from "../indexer/usearch-index.js";

describe("registry", () => {
  test("the open-loops system source is registered hidden", () => {
    expect(HIDDEN_SEARCH_SOURCES).toContainEqual({
      sourceId: OPEN_LOOP_SOURCE_ID,
      documentTypes: [OPEN_LOOP_DOCUMENT_TYPE],
    });
  });
});

describe("hiddenSourceIdsToExclude — the bypass rule", () => {
  test("unscoped retrieval excludes every hidden source", () => {
    expect(hiddenSourceIdsToExclude()).toEqual([OPEN_LOOP_SOURCE_ID]);
    expect(hiddenSourceIdsToExclude({})).toEqual([OPEN_LOOP_SOURCE_ID]);
    expect(hiddenSourceIdsToExclude({ sourceIds: ["gmail"] })).toEqual([OPEN_LOOP_SOURCE_ID]);
    expect(hiddenSourceIdsToExclude({ documentTypes: ["email"] })).toEqual([OPEN_LOOP_SOURCE_ID]);
  });

  test("explicitly naming the source id bypasses the exclusion", () => {
    expect(hiddenSourceIdsToExclude({ sourceIds: [OPEN_LOOP_SOURCE_ID] })).toEqual([]);
    expect(hiddenSourceIdsToExclude({ sourceIds: ["gmail", OPEN_LOOP_SOURCE_ID] })).toEqual([]);
  });

  test("explicitly naming an emitted document type bypasses the exclusion", () => {
    expect(hiddenSourceIdsToExclude({ documentTypes: [OPEN_LOOP_DOCUMENT_TYPE] })).toEqual([]);
    expect(hiddenSourceIdsToExclude({ documentTypes: ["email", OPEN_LOOP_DOCUMENT_TYPE] })).toEqual(
      [],
    );
  });

  test("a custom registry is honoured (mechanism is generic, not open-loop-specific)", () => {
    const registry = [{ sourceId: "diagnostics", documentTypes: ["diag-report"] as const }];
    expect(hiddenSourceIdsToExclude({}, registry)).toEqual(["diagnostics"]);
    expect(hiddenSourceIdsToExclude({ documentTypes: ["diag-report"] }, registry)).toEqual([]);
  });

  test("includeHidden opts every hidden source back in (the cognitive-projection flip)", () => {
    // The single logical flip: nothing is excluded, so the mirrors surface.
    expect(hiddenSourceIdsToExclude({ includeHidden: true })).toEqual([]);
    // Composes with (does not fight) the existing type/source bypass.
    expect(hiddenSourceIdsToExclude({ includeHidden: true, sourceIds: ["gmail"] })).toEqual([]);
    // Without the flag, still excluded (opt-in, not default).
    expect(hiddenSourceIdsToExclude({ includeHidden: false })).toEqual([OPEN_LOOP_SOURCE_ID]);
  });
});

describe("isHiddenSearchType — the ranking down-weight key", () => {
  test("recognises hidden cognitive mirror types, rejects ordinary + nullish types", () => {
    expect(isHiddenSearchType(OPEN_LOOP_DOCUMENT_TYPE)).toBe(true);
    expect(isHiddenSearchType("email")).toBe(false);
    expect(isHiddenSearchType(null)).toBe(false);
    expect(isHiddenSearchType(undefined)).toBe(false);
  });
});

describe("withHiddenSourcesExcluded — the /documents listing merge", () => {
  test("adds hidden sources to an absent or existing exclude list", () => {
    expect(withHiddenSourcesExcluded(undefined, undefined)).toEqual([OPEN_LOOP_SOURCE_ID]);
    expect(withHiddenSourcesExcluded(["gmail"], undefined)?.sort()).toEqual(
      ["gmail", OPEN_LOOP_SOURCE_ID].sort(),
    );
    // Already excluded: no duplicate entry.
    expect(withHiddenSourcesExcluded([OPEN_LOOP_SOURCE_ID], undefined)).toEqual([
      OPEN_LOOP_SOURCE_ID,
    ]);
  });

  test("an explicit include of the hidden source bypasses the merge", () => {
    expect(withHiddenSourcesExcluded(undefined, [OPEN_LOOP_SOURCE_ID])).toBeUndefined();
    expect(withHiddenSourcesExcluded(["gmail"], [OPEN_LOOP_SOURCE_ID])).toEqual(["gmail"]);
  });
});

describe("lexical choke point — buildMetadataFilter", () => {
  test("unscoped filters emit a NOT IN clause for the hidden source", () => {
    const { clause, params } = buildMetadataFilter({});
    expect(clause).toContain("c.source_id NOT IN (?)");
    expect(params).toContain(OPEN_LOOP_SOURCE_ID);
  });

  test("an explicit open-loop type filter emits no exclusion", () => {
    const { clause, params } = buildMetadataFilter({
      documentTypes: [OPEN_LOOP_DOCUMENT_TYPE],
    });
    expect(clause).not.toContain("NOT IN");
    expect(params).not.toContain(OPEN_LOOP_SOURCE_ID + "-never"); // params sanity
    expect(params).toContain(OPEN_LOOP_DOCUMENT_TYPE);
  });

  test("an explicit source-id filter naming the hidden source emits no exclusion", () => {
    const { clause } = buildMetadataFilter({ sourceIds: [OPEN_LOOP_SOURCE_ID] });
    expect(clause).not.toContain("NOT IN");
  });
});

describe("vector choke point — hnswSearchCandidates post-filter", () => {
  let db: Db;
  beforeEach(() => {
    db = createIndexDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  });
  afterEach(() => {
    closeTempDb(db);
  });

  function chunk(
    overrides: Partial<ChunkUpsertInput> & { id: string; documentId: string },
  ): ChunkUpsertInput {
    return {
      chunkIndex: 0,
      content: "",
      embedding: new Float32Array(EMBEDDING_DIM).fill(0),
      sourceId: "gmail",
      documentType: "email",
      title: "title",
      sourceCreatedAt: "2026-03-10T00:00:00Z",
      ...overrides,
    };
  }

  function rowidOf(documentId: string): bigint {
    const row = db
      .prepare<
        [string],
        { rowid: number }
      >("SELECT rowid FROM chunks WHERE document_id = ? AND chunk_index = 0")
      .get(documentId);
    if (!row) throw new Error(`no chunk for ${documentId}`);
    return BigInt(row.rowid);
  }

  function stubUsearch(entries: Array<{ key: bigint; distance: number }>): UsearchReadHandle {
    return {
      search(_vector: Float32Array, k: number) {
        return entries.slice(0, k);
      },
      reopen() {},
      close() {},
      size() {
        return entries.length;
      },
    } as unknown as UsearchReadHandle;
  }

  test("open-loop chunks are dropped from unscoped vector candidates, kept for an explicit type filter", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "dEmail", content: "quarterly plan" }),
      chunk({
        id: "b",
        documentId: "dLoopMirror",
        content: "Reply to the venue quote",
        sourceId: OPEN_LOOP_SOURCE_ID,
        documentType: OPEN_LOOP_DOCUMENT_TYPE,
      }),
    ]);
    const entries = [
      { key: rowidOf("dLoopMirror"), distance: 0.05 },
      { key: rowidOf("dEmail"), distance: 0.2 },
    ];
    const queryVec = new Float32Array(EMBEDDING_DIM).fill(0.01);

    const unscoped = hnswSearchCandidates(stubUsearch(entries), db, queryVec, {}, 10);
    expect(unscoped.map((c) => c.documentId)).toEqual(["dEmail"]);

    const scoped = hnswSearchCandidates(
      stubUsearch(entries),
      db,
      queryVec,
      { documentTypes: [OPEN_LOOP_DOCUMENT_TYPE] },
      10,
    );
    expect(scoped.map((c) => c.documentId)).toEqual(["dLoopMirror"]);
  });
});
