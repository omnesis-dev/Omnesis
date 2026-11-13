// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AccountId,
  ProviderId,
  SourceId,
  SourceType,
  type DocumentInput,
  type SourceScopes,
} from "@omnesis/types";
import { createDatabase, upsertDocuments, upsertWithCursorYieldable } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createSourceWithId } from "../data/repositories/SourceRepository.js";
import { reconcileSourceFilterActivation, sourceFiltersActive } from "./scope-activation.js";
import { backfillDocumentScopes } from "./scope-backfill.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { sourceScopeReadiness } from "./scope-editor-readiness.js";
import { sourceFiltersInUse } from "./source-filters-in-use.js";
import { createAccessLevel, deleteAccessLevel, updateAccessLevel } from "./store-levels.js";

/**
 * Source filters cost an install something only while they are in use:
 * experimental mode is on, or a filter saved while it was still stands. These
 * tests hold the other side of that line — what an ordinary sync, a gateway
 * start and the background task write when they are not — and what happens to
 * the facts when an install crosses it in either direction.
 */

const SOURCE = SourceId("fictional-chat:one");
const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
  ],
  legacyProjection: { conversationIdPath: ["extra", "conversationId"] },
};

function document(index: number): DocumentInput {
  return {
    providerId: ProviderId("fictional"),
    sourceId: SOURCE,
    externalId: `message-${index}`,
    title: `Invented message ${index}`,
    content: `Invented body ${index}.`,
    contentHash: `hash-${index}`,
    metadata: { documentType: "conversation", extra: { conversationId: `chat-${index % 3}` } },
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
}
const documents = (from: number, count: number) =>
  Array.from({ length: count }, (_, offset) => document(from + offset));

let db: ReturnType<typeof createDatabase>;
let dir: string;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  dir = mkdtempSync(join(tmpdir(), "omnesis-scope-activation-"));
  db = createDatabase(join(dir, "test.db"));
  const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
  createSourceWithId(db, SOURCE, {
    type: SourceType("fictional-chat"),
    accountId: AccountId("one"),
    deviceId: device.id,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** Every row of every table that exists for source filters. */
function scopeState(): Record<string, string[]> {
  const tables = db
    .prepare<[], { name: string }>(
      // `document_absence_scopes` belongs to snapshot reconciliation, not to filters.
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%scope%' AND name <> 'document_absence_scopes' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}
/** The triggers that exist for source filters on a table every install writes to. */
function filterTriggers(table: "documents" | "sources"): string[] {
  return db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?
         AND (name GLOB '*scope*' OR name GLOB 'native_*') ORDER BY name`,
    )
    .all(table)
    .map((row) => row.name);
}
function count(table: string): number {
  return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}
/** A token that never asks to stop, counting how often the writer offered to. */
function countingToken() {
  const token = { polls: 0, requested: () => (token.polls++, false) };
  return token;
}
function saveFilter(): string {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const level = createAccessLevel(
    db,
    {
      name: "Fictional level",
      rules: [
        {
          capability: "direct",
          sources: { mode: "all", sourceIds: [] },
          scopePolicies: [
            {
              sourceId: SOURCE,
              audience: { accessLevel: "new", capability: "direct" },
              rules: [{ match: [{ kind: "conversation", id: "chat-1" }], action: "share" }],
              otherwise: "hide",
            },
          ],
        },
      ],
      actorTokenId: "owner",
    },
    1,
  );
  if (!level.ok) throw new Error(level.error);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  return level.value.id;
}
function ready(): boolean {
  return sourceScopeReadiness(db, SOURCE).every((kind) => kind.ready);
}

describe("an install where source filters are not in use", () => {
  test("starting the gateway writes nothing for them, however often", () => {
    const before = scopeState();
    reconcileSourceFilterActivation(db);
    reconcileSourceFilterActivation(db);
    expect(scopeState()).toEqual(before);
    expect(count("source_scope_descriptors")).toBe(0);
  });

  test("no filter trigger exists on documents or sources, and writing a document touches no filter table", () => {
    expect(filterTriggers("documents")).toEqual([]);
    expect(filterTriggers("sources")).toEqual([]);
    const before = scopeState();
    upsertDocuments(db, documents(0, 3));
    db.prepare("UPDATE documents SET metadata = '{}', content_hash = 'edited'").run();
    db.prepare("DELETE FROM documents WHERE external_id = 'message-1'").run();
    expect(scopeState()).toEqual(before);
    expect(filterTriggers("documents")).toEqual([]);
  });

  test("an ordinary sync writes no filter state, even for a source type with a stored declaration", () => {
    // A declaration left behind by an earlier run with experimental mode on.
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);
    const before = scopeState();

    upsertDocuments(db, documents(0, 4));
    const page = upsertWithCursorYieldable(
      db,
      {
        providerId: ProviderId("fictional"),
        sourceId: SOURCE,
        documents: documents(4, 120),
        hasMore: false,
        cursor: {},
      },
      { token: countingToken() },
    );
    expect(page.kind).toBe("done");
    // An edit, a metadata-only change and a delete of stored documents.
    upsertDocuments(db, [{ ...document(1), content: "Edited.", contentHash: "edited" }]);
    upsertDocuments(db, [{ ...document(2), metadata: { documentType: "conversation" } }]);
    db.prepare("DELETE FROM documents WHERE external_id = 'message-3'").run();
    backfillDocumentScopes(db, 100);

    expect(count("documents")).toBe(123);
    expect(scopeState()).toEqual(before);
  });

  test("documents are committed in the batches they were before filters, not one at a time", () => {
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);
    const closed = countingToken();
    upsertDocuments(db, documents(0, 12), { token: closed });
    // Chunks of five: the writer offers to yield after the first two of three.
    expect(closed.polls).toBe(2);

    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const open = countingToken();
    upsertDocuments(db, documents(12, 12), { token: open });
    expect(open.polls).toBe(11);
  });

  test("a source without a declaration queues no reprojection, in use or not", () => {
    for (const experimental of ["0", "1"]) {
      vi.stubEnv("OMNESIS_EXPERIMENTAL", experimental);
      upsertDocuments(db, documents(experimental === "0" ? 0 : 20, 20));
      db.prepare("UPDATE documents SET metadata = '{}' WHERE external_id LIKE 'message-1%'").run();
      for (let pass = 0; pass < 3; pass++) backfillDocumentScopes(db, 100);
      expect(count("scope_native_reprojection")).toBe(0);
      expect(count("scope_native_reprojection_sources")).toBe(0);
    }
  });

  test("an entry queued for a source that keeps no facts is removed by the next pass once filters are in use", () => {
    upsertDocuments(db, documents(0, 3));
    db.prepare(
      "INSERT INTO scope_native_reprojection SELECT id, source_id FROM documents ORDER BY id",
    ).run();
    expect(count("scope_native_reprojection")).toBe(3);
    backfillDocumentScopes(db, 100);
    expect(count("scope_native_reprojection")).toBe(3);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    backfillDocumentScopes(db, 100);
    expect(count("scope_native_reprojection")).toBe(0);
  });
});

describe("an install that takes source filters into use", () => {
  test("experimental mode alone puts them in use, and a saved filter keeps them in use after it is switched off", () => {
    expect(sourceFiltersInUse(db)).toBe(false);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    expect(sourceFiltersInUse(db)).toBe(true);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect(sourceFiltersInUse(db)).toBe(false);

    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional-chat','{}',1)",
    ).run(SOURCE);
    saveFilter();
    expect(sourceFiltersInUse(db)).toBe(true);
    // Documents keep their facts while the filter stands.
    upsertDocuments(db, documents(0, 3));
    expect(count("document_scope_facts")).toBe(3);
  });

  test("the gateway start after experimental mode is switched on prepares stored documents by itself", () => {
    upsertDocuments(db, documents(0, 6));
    expect(count("document_scope_facts")).toBe(0);

    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    reconcileSourceFilterActivation(db);
    // The packaged declarations are in place; this fictional type declares its own.
    expect(count("source_scope_descriptors")).toBeGreaterThan(0);
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);

    backfillDocumentScopes(db, 4);
    // Part-way through, the source is not offered to a filter.
    expect(ready()).toBe(false);
    for (let pass = 0; pass < 3; pass++) backfillDocumentScopes(db, 4);
    expect(ready()).toBe(true);
    expect(count("document_scope_facts")).toBe(6);
  });
});

describe("the filter triggers on documents", () => {
  test("appear when experimental mode is on, stay while a live level holds a filter, and go when it is deleted", () => {
    expect(filterTriggers("documents")).toEqual([]);

    // Experimental mode on: the first write activates the corpus.
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);
    upsertDocuments(db, documents(0, 3));
    expect(filterTriggers("documents")).toEqual([
      "document_scope_cleanup",
      "native_document_delete",
      "native_document_insert",
      "native_document_update",
      "scope_generation_documents_delete",
      "scope_generation_documents_insert",
      "scope_generation_documents_move",
      "scope_generation_documents_update",
    ]);
    expect(filterTriggers("sources")).not.toEqual([]);
    for (let pass = 0; pass < 2; pass++) backfillDocumentScopes(db, 10);

    // A filter saved, then experimental mode off: still active, facts still kept.
    const levelId = saveFilter();
    upsertDocuments(db, documents(3, 2));
    expect(filterTriggers("documents")).toHaveLength(8);
    expect(count("document_scope_facts")).toBe(5);

    // The last live level holding a filter is deleted: inactive at once.
    expect(deleteAccessLevel(db, { levelId, actorTokenId: "owner" }, 3).ok).toBe(true);
    expect(filterTriggers("documents")).toEqual([]);
    expect(filterTriggers("sources")).toEqual([]);
    expect(count("document_scope_facts")).toBe(0);
    expect(count("scope_fact_backfill")).toBe(0);
    const inactive = scopeState();
    upsertDocuments(db, documents(5, 2));
    db.prepare("DELETE FROM documents WHERE external_id = 'message-0'").run();
    expect(scopeState()).toEqual(inactive);
  });

  test("are created by a gateway start with experimental mode on and removed by one with it off", () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    reconcileSourceFilterActivation(db);
    expect(filterTriggers("documents")).toHaveLength(8);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    reconcileSourceFilterActivation(db);
    expect(filterTriggers("documents")).toEqual([]);
  });

  test("the answer on the write path is remembered: no read of the database per batch", () => {
    upsertDocuments(db, documents(0, 2));
    const prepare = vi.spyOn(db, "prepare");
    expect(sourceFiltersActive(db)).toBe(false);
    expect(sourceFiltersActive(db)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });
});

describe("an install that stops using source filters", () => {
  function prepared(): void {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);
    upsertDocuments(db, documents(0, 6));
    for (let pass = 0; pass < 3; pass++) backfillDocumentScopes(db, 10);
    expect(ready()).toBe(true);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  }

  test("forgets its fact state on the next write, and prepares every document again before a filter can be saved", () => {
    prepared();
    upsertDocuments(db, documents(6, 2));
    expect(filterTriggers("documents")).toEqual([]);
    expect(count("scope_fact_backfill")).toBe(0);
    expect(count("scope_source_generations")).toBe(0);
    expect(count("document_scope_facts")).toBe(0);
    expect(ready()).toBe(false);
    // Later writes, deletes included, leave no filter state behind.
    const inactive = scopeState();
    upsertDocuments(db, documents(8, 2));
    db.prepare("DELETE FROM documents WHERE external_id = 'message-0'").run();
    expect(scopeState()).toEqual(inactive);

    // Back in use, as on first activation: nothing is ready, and no filter
    // can be saved, until every stored document is prepared again.
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    backfillDocumentScopes(db, 4);
    expect(filterTriggers("documents")).toHaveLength(8);
    expect(ready()).toBe(false);
    expect(() => saveFilter()).toThrow();
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    for (let pass = 0; pass < 4; pass++) backfillDocumentScopes(db, 4);
    expect(ready()).toBe(true);
    // The document deleted while inactive left nothing behind.
    expect(count("document_scope_facts")).toBe(9);
  });

  test("a kind a collector had reported needs a new refresh after the facts are forgotten", () => {
    prepared();
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    db.prepare("INSERT INTO scope_native_kinds VALUES(?, 'label')").run(SOURCE);
    db.prepare("INSERT INTO source_scope_kind_readiness VALUES(?, 'label', 1)").run(SOURCE);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    upsertDocuments(db, documents(6, 1));
    expect(
      db.prepare("SELECT ready FROM source_scope_kind_readiness WHERE kind='label'").get(),
    ).toEqual({ ready: 0 });
    expect(
      db.prepare("SELECT active FROM source_scope_refreshes WHERE kind='label'").get(),
    ).toEqual({ active: 1 });
    expect(count("source_scope_refresh_requirements")).toBe(1);
  });

  test("a gateway start forgets the fact state once", () => {
    prepared();
    reconcileSourceFilterActivation(db);
    expect(count("scope_fact_backfill")).toBe(0);
    expect(count("scope_source_generations")).toBe(0);
    expect(ready()).toBe(false);
    const inactive = scopeState();
    reconcileSourceFilterActivation(db);
    expect(scopeState()).toEqual(inactive);
  });

  test("the last filter leaving its level with experimental mode off stops the work", () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes }], 1);
    upsertDocuments(db, documents(0, 3));
    for (let pass = 0; pass < 2; pass++) backfillDocumentScopes(db, 10);
    saveFilter();
    expect(sourceFiltersInUse(db)).toBe(true);
    // With experimental mode off a filter can only leave with its source.
    const device = db.prepare<[], { id: string }>("SELECT id FROM devices").get()!.id;
    createSourceWithId(db, SourceId("fictional-notes:two"), {
      type: SourceType("fictional-notes"),
      accountId: AccountId("two"),
      deviceId: device as never,
    });
    const level = db
      .prepare<[], { id: string; revision: number }>("SELECT id, revision FROM access_levels")
      .get()!;
    const cleared = updateAccessLevel(
      db,
      {
        levelId: level.id,
        expectedRevision: level.revision,
        rules: [
          {
            capability: "direct",
            sources: { mode: "denylist", sourceIds: [SOURCE] },
            filterRevision: 1,
            scopePolicies: [],
          },
        ],
        actorTokenId: "owner",
      },
      2,
    );
    expect(cleared.ok).toBe(true);
    expect(sourceFiltersInUse(db)).toBe(false);
    upsertDocuments(db, documents(3, 2));
    expect(ready()).toBe(false);
    expect(count("scope_fact_backfill")).toBe(0);
    expect(filterTriggers("documents")).toEqual([]);
  });
});
