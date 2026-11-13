// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ProviderId, SourceId, type DocumentInput, type ScopePolicy } from "@omnesis/types";
import { runSchemaSetup } from "../data/schema.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { upsertWithCursor } from "../data/repositories/DocumentRepository.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { applySourceScopeUpdates } from "./scope-updates.js";
import { drainHierarchyWork } from "./scope-hierarchy-work.js";
import { sourceScopeRefreshEpochs } from "./scope-refresh-requirements.js";
import { sourceScopeInclusionSql, scopePolicyKnownSql } from "./scope-sql.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";

// Facts are kept only while source filters are in use, which these tests take
// as given: experimental mode is on unless a test switches it off.
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

let db: SqliteDatabase.Database;
const sourceId = SourceId("fictional-drive:one");
const providerId = ProviderId("fictional:one");
const context = { sourceId, providerId, streamId: "", snapshotAuthority: true };
beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  runSchemaSetup(db);
  const actor = createDevice(db, {
    name: "Fictional collector",
    kind: "collector",
    capabilities: { sourceScopes: { min: 1, max: 2 } },
  });
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'fictional-drive','one',?,1,1)",
  ).run(sourceId, actor.id);
  upsertSourceScopes(
    db,
    [
      {
        sourceType: "fictional-drive",
        scopes: {
          revision: 3,
          items: [
            {
              kind: "folder",
              noun: { one: "folder", many: "folders" },
              picker: "tree",
              link: "hierarchy",
            },
          ],
        },
      },
    ],
    1,
  );
  db.prepare(
    "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional-drive','{}',1)",
  ).run(sourceId);
});
afterEach(() => db.close());
function node(id: string, parentIds: string[] = [], label = id, complete = true): void {
  applySourceScopeUpdates(db, context, {
    hierarchy: { kind: "folder", nodes: [{ id, parentIds, label, complete }] },
  });
}
function file(id: string, parentIds: string[], complete = true): void {
  const document: DocumentInput = {
    sourceId,
    providerId,
    externalId: id,
    title: "Invented observatory notes",
    content: "Fictional night sky notes",
    contentHash: id,
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { documentType: "file", scopeHierarchy: [{ kind: "folder", parentIds, complete }] },
  };
  upsertWithCursor(db, {
    sourceId,
    providerId,
    documents: [document],
    hasMore: false,
    cursor: { page: 1 },
  });
}
function policy(id: string, except = false): ScopePolicy {
  return {
    sourceId,
    audience: { accessLevel: "level", capability: "direct" },
    rules: [{ match: [{ kind: "folder", id }], action: except ? "hide" : "share" }],
    otherwise: except ? "share" : "hide",
  };
}
function visible(id: string, except = false): string[] {
  const sql = sourceScopeInclusionSql([policy(id, except)], "d.id", "d.source_id");
  return db
    .prepare<unknown[], { external_id: string }>(
      `SELECT d.external_id FROM documents d WHERE ${sql.sql} ORDER BY d.external_id`,
    )
    .all(...sql.params)
    .map((row) => row.external_id);
}
function settle(): void {
  let passes = 0;
  while (drainHierarchyWork(db, 128)) {
    if (++passes > 20) throw new Error("Hierarchy did not settle");
  }
}

it("moves a multi-level subtree without receiving descendant documents and preserves unrelated trees", () => {
  node("root-a");
  node("root-b");
  node("branch", ["root-a"]);
  node("leaf", ["branch"]);
  file("nested", ["leaf"]);
  file("unaffected", ["root-a"]);
  settle();
  expect(visible("root-a")).toEqual(["nested", "unaffected"]);
  node("branch", ["root-b"]);
  expect(visible("root-a")).toEqual(["unaffected"]);
  expect(visible("root-a", true)).toEqual([]);
  const known = scopePolicyKnownSql(policy("root-a"), "d.id");
  expect(
    db
      .prepare(`SELECT ${known.sql} AS known FROM documents d WHERE external_id='nested'`)
      .get(...known.params),
  ).toEqual({ known: 0 });
  drainHierarchyWork(db, 1);
  const snapshot = db.serialize();
  db.close();
  db = new SqliteDatabase(snapshot);
  settle();
  expect(visible("root-a")).toEqual(["unaffected"]);
  expect(visible("root-b")).toEqual(["nested"]);
  expect(visible("root-a", true)).toEqual(["nested"]);
  expect(db.prepare("SELECT content FROM documents WHERE external_id='nested'").get()).toEqual({
    content: "Fictional night sky notes",
  });
});
it("uses stable IDs across rename and a distinct ID across recreation", () => {
  node("root");
  node("original", ["root"]);
  file("kept", ["original"]);
  settle();
  node("original", ["root"], "Renamed folder");
  expect(visible("original")).toEqual(["kept"]);
  expect(db.prepare("SELECT 1 FROM scope_hierarchy_dirty").get()).toBeUndefined();
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      nodes: [
        { id: "original", label: "Renamed folder", parentIds: [], complete: false, deleted: true },
      ],
    },
  });
  node("recreated", ["root"], "Renamed folder");
  file("new", ["recreated"]);
  settle();
  expect(visible("original")).toEqual([]);
  expect(visible("recreated")).toEqual(["new"]);
});
it("keeps missing ancestors, cycles and absent native edges unknown, and resolves a later ancestor", () => {
  node("root");
  file("missing", ["later"]);
  file("unknown", [], false);
  node("cycle-a", ["cycle-b"]);
  node("cycle-b", ["cycle-a"]);
  file("cycle", ["cycle-a"]);
  settle();
  expect(visible("root", true)).toEqual([]);
  node("later", ["root"]);
  settle();
  expect(visible("root")).toEqual(["missing"]);
});
it("does not clear a newer dirty task when an interrupted rebuild is superseded", () => {
  node("a");
  node("b");
  node("c");
  node("branch", ["a"]);
  file("one", ["branch"]);
  file("two", ["branch"]);
  settle();
  node("branch", ["b"]);
  drainHierarchyWork(db, 1);
  node("branch", ["c"]);
  settle();
  expect(visible("b")).toEqual([]);
  expect(visible("c")).toEqual(["one", "two"]);
});
it("bounds catalogue omission pruning and defers readiness and refresh reopening", () => {
  node("a");
  node("b");
  file("old", ["b"]);
  settle();
  applySourceScopeUpdates(db, context, {
    refreshes: [{ kind: "folder", active: true }],
    readiness: [{ kind: "folder", complete: false }],
  });
  const epoch = sourceScopeRefreshEpochs(db, sourceId).folder!;
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      refreshEpoch: epoch,
      snapshot: { id: "new-cut", phase: "begin" },
      nodes: [{ id: "a", label: "Root A", parentIds: [], complete: true }],
    },
  });
  applySourceScopeUpdates(db, context, {
    hierarchy: { kind: "folder", refreshEpoch: epoch, snapshot: { id: "new-cut", phase: "end" } },
    refreshes: [
      { kind: "folder", active: false, epoch: sourceScopeRefreshEpochs(db, sourceId).folder },
    ],
    readiness: [{ kind: "folder", complete: true }],
  });
  expect(
    db.prepare("SELECT active FROM source_scope_refreshes WHERE source_id=?").get(sourceId),
  ).toEqual({ active: 1 });
  expect(drainHierarchyWork(db, 1)).toBe(1);
  expect(
    db.prepare("SELECT entity_id FROM scope_entities WHERE kind='folder' ORDER BY entity_id").all(),
  ).toEqual([{ entity_id: "a" }]);
  settle();
  expect(visible("b", true)).toEqual([]);
  expect(
    db.prepare("SELECT active FROM source_scope_refreshes WHERE source_id=?").get(sourceId),
  ).toEqual({ active: 0 });
});
it("keeps a completed catalogue ready when bounded historical work finds unknown ancestors", () => {
  file("unknown", ["unavailable-parent"]);
  applySourceScopeUpdates(db, context, {
    refreshes: [{ kind: "folder", active: true }],
    readiness: [{ kind: "folder", complete: false }],
  });
  const epoch = sourceScopeRefreshEpochs(db, sourceId).folder!;
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      refreshEpoch: epoch,
      snapshot: { id: "unknown-catalogue", phase: "begin" },
      nodes: [
        { id: "unavailable-parent", label: "Unavailable parent", parentIds: [], complete: false },
      ],
    },
  });
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      refreshEpoch: epoch,
      snapshot: { id: "unknown-catalogue", phase: "end" },
    },
    refreshes: [{ kind: "folder", active: false, epoch }],
    readiness: [{ kind: "folder", complete: true }],
  });
  const ready = () =>
    db
      .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='folder'")
      .get(sourceId);
  expect(drainHierarchyWork(db, 1)).toBe(1);
  expect(ready()).toEqual({ ready: 1 });
  expect(drainHierarchyWork(db, 1)).toBe(1);
  settle();
  expect(ready()).toEqual({ ready: 1 });
  expect(visible("unavailable-parent")).toEqual([]);
  expect(visible("unavailable-parent", true)).toEqual([]);
  expect(db.prepare("SELECT phase FROM scope_hierarchy_catalogues").get()).toEqual({
    phase: "idle",
  });
});
it("keeps explicit native unknown files hidden without revoking catalogue readiness", () => {
  node("known-root");
  file("known", ["known-root"]);
  applySourceScopeUpdates(db, context, { readiness: [{ kind: "folder", complete: true }] });
  file("native-unknown", [], false);
  expect(
    db
      .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='folder'")
      .get(sourceId),
  ).toEqual({ ready: 1 });
  expect(visible("known-root")).toEqual(["known"]);
  expect(visible("other-root", true)).toEqual(["known"]);
});
it("recovers an installed idle catalogue only after a fresh native readiness publication", () => {
  applySourceScopeUpdates(db, context, {
    refreshes: [{ kind: "folder", active: true }],
    readiness: [{ kind: "folder", complete: false }],
  });
  const epoch = sourceScopeRefreshEpochs(db, sourceId).folder!;
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      refreshEpoch: epoch,
      snapshot: { id: "installed-catalogue", phase: "begin" },
    },
  });
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      refreshEpoch: epoch,
      snapshot: { id: "installed-catalogue", phase: "end" },
    },
    refreshes: [{ kind: "folder", active: false, epoch }],
    readiness: [{ kind: "folder", complete: true }],
  });
  settle();
  const ready = () =>
    db
      .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='folder'")
      .get(sourceId);
  expect(ready()).toEqual({ ready: 1 });
  db.prepare(
    "UPDATE source_scope_kind_readiness SET ready=0 WHERE source_id=? AND kind='folder'",
  ).run(sourceId);
  expect(drainHierarchyWork(db)).toBe(0);
  expect(ready()).toEqual({ ready: 0 });
  applySourceScopeUpdates(db, context, { readiness: [{ kind: "folder", complete: true }] });
  expect(ready()).toEqual({ ready: 1 });
  applySourceScopeUpdates(db, context, { refreshes: [{ kind: "folder", active: true }] });
  db.prepare(
    "UPDATE source_scope_kind_readiness SET ready=0 WHERE source_id=? AND kind='folder'",
  ).run(sourceId);
  applySourceScopeUpdates(db, context, { readiness: [{ kind: "folder", complete: true }] });
  expect(ready()).toEqual({ ready: 0 });
});
it("fresh source readiness cannot restore a legacy-invalidated document witness from stored echoes", () => {
  node("known-root");
  applySourceScopeUpdates(db, context, { refreshes: [{ kind: "folder", active: true }] });
  const epoch = sourceScopeRefreshEpochs(db, sourceId).folder!;
  const document: DocumentInput = {
    sourceId,
    providerId,
    externalId: "native-file",
    title: "Invented memo",
    content: "Fictional outline",
    contentHash: "native-file",
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {
      documentType: "file",
      scopeHierarchy: [
        { kind: "folder", parentIds: ["known-root"], complete: true, refreshEpoch: epoch },
      ],
    },
  };
  upsertWithCursor(db, { sourceId, providerId, documents: [document], hasMore: false, cursor: {} });
  applySourceScopeUpdates(db, context, {
    refreshes: [{ kind: "folder", active: false, epoch }],
    readiness: [{ kind: "folder", complete: true }],
  });
  expect(visible("known-root")).toEqual(["native-file"]);
  const row = db
    .prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id='native-file'")
    .get()!;
  expect(
    db.prepare("SELECT epoch FROM scope_native_refresh_witnesses WHERE document_id=?").get(row.id),
  ).toEqual({ epoch });
  db.prepare(
    "UPDATE documents SET content='Changed by a legacy writer',content_hash='legacy-change' WHERE id=?",
  ).run(row.id);
  expect(
    db.prepare("SELECT epoch FROM scope_native_refresh_witnesses WHERE document_id=?").get(row.id),
  ).toBeUndefined();
  db.prepare(
    "UPDATE source_scope_kind_readiness SET ready=0 WHERE source_id=? AND kind='folder'",
  ).run(sourceId);
  applySourceScopeUpdates(db, context, { readiness: [{ kind: "folder", complete: true }] });
  projectStoredDocumentScopes(
    db,
    {
      ...context,
      id: row.id,
      externalId: document.externalId,
      metadata: document.metadata,
      historical: true,
    },
    {
      items: [
        {
          kind: "folder",
          noun: { one: "folder", many: "folders" },
          picker: "tree",
          link: "hierarchy",
        },
      ],
    },
  );
  expect(
    db
      .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='folder'")
      .get(sourceId),
  ).toEqual({ ready: 1 });
  expect(
    db.prepare("SELECT epoch FROM scope_native_refresh_witnesses WHERE document_id=?").get(row.id),
  ).toBeUndefined();
  expect(visible("known-root")).toEqual([]);
  expect(visible("other-root", true)).toEqual([]);
});

it("binds metadata-only direct-parent patches to source provider and stream", () => {
  node("a");
  node("b");
  file("same", ["a"]);
  settle();
  applySourceScopeUpdates(
    db,
    { ...context, streamId: "another" },
    {
      hierarchy: {
        kind: "folder",
        documents: [{ externalId: "same", parentIds: ["b"], complete: true }],
      },
    },
  );
  expect(visible("a")).toEqual(["same"]);
  applySourceScopeUpdates(db, context, {
    hierarchy: {
      kind: "folder",
      documents: [{ externalId: "same", parentIds: ["b"], complete: true }],
    },
  });
  expect(visible("a")).toEqual([]);
  expect(visible("b")).toEqual(["same"]);
});
