// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillDocumentScopes } from "./scope-backfill.js";
import { createScopeDescriptorsSchema, upsertSourceScopes } from "./scope-descriptors.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";
import type { SourceScopes, DocumentMetadata } from "@omnesis/types";

const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
  ],
  legacyProjection: {
    conversationIdPath: ["extra", "conversationId"],
    conversationLabelPath: ["extra", "chatName"],
  },
};

describe("bounded source scope backfill", () => {
  let db: Database.Database;
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-scope-backfill-"));
    path = join(dir, "test.db");
    db = new Database(path);
    db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,type TEXT); INSERT INTO sources VALUES('fictional:one','fictional');
      CREATE TABLE documents(id TEXT PRIMARY KEY,provider_id TEXT,source_id TEXT,stream_id TEXT,external_id TEXT,metadata TEXT,updated_at TEXT);
      CREATE INDEX documents_source ON documents(source_id);
      CREATE UNIQUE INDEX documents_external ON documents(provider_id,source_id,stream_id,external_id)`);
    createScopeDescriptorsSchema(db);
    upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function document(
    id: string,
    extra: Record<string, unknown> = {},
    options: { source?: string; stream?: string; type?: string } = {},
  ) {
    db.prepare("INSERT INTO documents VALUES(?, 'fictional', ?, ?, ?, ?, '2026-01-01')").run(
      id,
      options.source ?? "fictional:one",
      options.stream ?? "",
      id,
      JSON.stringify({
        documentType: options.type ?? "conversation",
        extra: { conversationId: "chat", chatName: "Cedar planning", ...extra },
      }),
    );
  }
  function state() {
    return db
      .prepare(
        "SELECT cursor_rowid,processed,ready FROM scope_fact_backfill WHERE source_id='fictional:one'",
      )
      .get();
  }
  function visible() {
    const restriction = sourceScopeInclusionSql(
      [
        {
          sourceId: "fictional:one",
          audience: { accessLevel: "level", capability: "direct" },
          rules: [{ match: [{ kind: "conversation", id: "chat" }], action: "share" }],
          otherwise: "hide",
        },
      ],
      "d.id",
      "d.source_id",
    );
    return db
      .prepare<string[], { id: string }>(
        `SELECT d.id FROM documents d WHERE ${restriction.sql} ORDER BY d.id`,
      )
      .all(...restriction.params)
      .map((row) => row.id);
  }

  it("resumes persisted bounded batches after reopening and fences reads until complete", () => {
    document("one");
    document("two");
    document("three");
    expect(backfillDocumentScopes(db, 2)).toEqual({
      processed: 2,
      sourcesCompleted: 0,
      subjectsResolved: 0,
    });
    expect(state()).toEqual({ cursor_rowid: 2, processed: 2, ready: 0 });
    expect(visible()).toEqual([]);
    db.close();
    db = new Database(path);
    expect(backfillDocumentScopes(db, 2)).toEqual({
      processed: 1,
      sourcesCompleted: 1,
      subjectsResolved: 0,
    });
    expect(state()).toEqual({ cursor_rowid: 3, processed: 3, ready: 1 });
    expect(visible()).toEqual(["one", "three", "two"]);
    expect(db.prepare("SELECT entity_id,label FROM scope_entities").all()).toEqual([
      { entity_id: "chat", label: "Cedar planning" },
    ]);
    expect(backfillDocumentScopes(db, 2).processed).toBe(0);
  });

  it("persistent legacy-write triggers revoke immediately and reproject only queued documents after reopening", () => {
    document("one");
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual(["one"]);
    db.prepare("UPDATE documents SET metadata=? WHERE id='one'").run(
      JSON.stringify({ documentType: "conversation", extra: { conversationId: "other" } }),
    );
    expect(visible()).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_native_reprojection_sources").all()).toEqual([
      { source_id: "fictional:one", pending: 1 },
    ]);
    db.close();
    db = new Database(path);
    const result = backfillDocumentScopes(db, 4);
    expect(result).toMatchObject({ processed: 0, nativeReprojected: 1 });
    expect(state()).toMatchObject({ processed: 1, ready: 1 });
    expect(visible()).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_native_reprojection").all()).toEqual([]);
    db.prepare("UPDATE documents SET metadata='malformed' WHERE id='one'").run();
    backfillDocumentScopes(db, 4);
    expect(
      db.prepare("SELECT * FROM document_scope_completeness WHERE document_id='one'").all(),
    ).toEqual([]);
    expect(visible()).toEqual([]);
  });

  it("legacy inserts after baseline completion are coalesced and processed in bounded batches", () => {
    backfillDocumentScopes(db, 4);
    for (let index = 0; index < 7; index++) document(`later-${index}`);
    expect(db.prepare("SELECT pending FROM scope_native_reprojection_sources").get()).toEqual({
      pending: 7,
    });
    let rounds = 0;
    while (db.prepare("SELECT 1 FROM scope_native_reprojection LIMIT 1").get()) {
      const result = backfillDocumentScopes(db, 4);
      expect(result.processed).toBe(0);
      expect(result.nativeReprojected).toBeGreaterThan(0);
      expect(result.nativeReprojected).toBeLessThanOrEqual(2);
      if (++rounds > 7) throw new Error("Legacy reprojection did not converge");
    }
    expect(visible()).toHaveLength(7);
    expect(state()).toMatchObject({ processed: 0, ready: 1 });
    expect(db.prepare("SELECT * FROM scope_native_reprojection_sources").all()).toEqual([]);
  });

  it("recovery never blesses a stale producer epoch retained in an old writer's metadata", () => {
    document("one");
    backfillDocumentScopes(db, 4);
    const metadata: DocumentMetadata = {
      documentType: "conversation",
      extra: { conversationId: "chat" },
      scopeFacts: {
        facts: [{ kind: "conversation", id: "chat" }],
        complete: ["conversation"],
        refreshEpochs: { conversation: "current" },
      },
    };
    db.prepare("UPDATE documents SET metadata=? WHERE id='one'").run(JSON.stringify(metadata));
    projectStoredDocumentScopes(
      db,
      {
        id: "one",
        providerId: "fictional",
        sourceId: "fictional:one",
        streamId: "",
        externalId: "one",
        metadata,
      },
      scopes,
    );
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES('fictional:one','conversation','current')",
    ).run();
    expect(visible()).toEqual(["one"]);
    db.prepare(
      "UPDATE documents SET metadata=json_set(metadata,'$.extra.legacyChanged',1) WHERE id='one'",
    ).run();
    expect(visible()).toEqual([]);
    db.close();
    db = new Database(path);
    expect(backfillDocumentScopes(db, 4)).toMatchObject({ processed: 0, nativeReprojected: 1 });
    expect(
      db
        .prepare(
          "SELECT json_extract(metadata,'$.scopeFacts.refreshEpochs.conversation') AS epoch FROM documents WHERE id='one'",
        )
        .get(),
    ).toEqual({ epoch: "current" });
    expect(db.prepare("SELECT * FROM scope_native_desired_witnesses").all()).toEqual([]);
    expect(visible()).toEqual([]);
    projectStoredDocumentScopes(
      db,
      {
        id: "one",
        providerId: "fictional",
        sourceId: "fictional:one",
        streamId: "",
        externalId: "one",
        metadata,
      },
      scopes,
    );
    expect(visible()).toEqual(["one"]);
  });

  it("a legacy attachment reparent cannot keep reading through its former allowed parent", () => {
    document("parent");
    document("other", { conversationId: "different" });
    document("child", { parentExternalId: "parent" }, { type: "attachment" });
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual(["child", "parent"]);
    db.prepare("UPDATE documents SET metadata=? WHERE id='child'").run(
      JSON.stringify({ documentType: "attachment", extra: { parentExternalId: "other" } }),
    );
    expect(visible()).toEqual(["parent"]);
    expect(
      db
        .prepare(
          "SELECT subject_document_id FROM document_scope_subjects WHERE document_id='child'",
        )
        .get(),
    ).toEqual({ subject_document_id: "" });
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual(["parent"]);
    expect(
      db
        .prepare(
          "SELECT subject_document_id FROM document_scope_subjects WHERE document_id='child'",
        )
        .get(),
    ).toEqual({ subject_document_id: "other" });
  });

  it("an unchanged historical baseline retains physical proof from an inline fresh producer", () => {
    document("one");
    const metadata: DocumentMetadata = {
      documentType: "conversation",
      extra: { conversationId: "chat" },
      scopeFacts: {
        facts: [{ kind: "conversation", id: "chat" }],
        complete: ["conversation"],
        refreshEpochs: { conversation: "current" },
      },
    };
    db.prepare("UPDATE documents SET metadata=? WHERE id='one'").run(JSON.stringify(metadata));
    projectStoredDocumentScopes(
      db,
      {
        id: "one",
        providerId: "fictional",
        sourceId: "fictional:one",
        streamId: "",
        externalId: "one",
        metadata,
      },
      scopes,
    );
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES('fictional:one','conversation','current')",
    ).run();
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual(["one"]);
    expect(
      db.prepare("SELECT epoch FROM scope_native_refresh_witnesses WHERE document_id='one'").get(),
    ).toEqual({ epoch: "current" });
  });

  it("preempts between committed documents without losing its position", () => {
    document("one");
    document("two");
    document("three");
    let checks = 0;
    expect(
      backfillDocumentScopes(db, 3, { token: { requested: () => ++checks > 1 } }).processed,
    ).toBe(1);
    expect(state()).toEqual({ cursor_rowid: 1, processed: 1, ready: 0 });
    expect(backfillDocumentScopes(db, 3).processed).toBe(2);
    expect(visible()).toHaveLength(3);
  });

  it("invalidates old facts immediately when a declaration changes and restarts the scan", () => {
    document("one");
    backfillDocumentScopes(db, 2);
    expect(visible()).toEqual(["one"]);
    const changed: SourceScopes = {
      ...scopes,
      legacyProjection: { conversationIdPath: ["extra", "newConversationId"] },
    };
    upsertSourceScopes(db, [{ sourceType: "fictional", scopes: changed }], 2);
    expect(state()).toEqual({ cursor_rowid: 0, processed: 0, ready: 0 });
    expect(visible()).toEqual([]);
    backfillDocumentScopes(db, 2);
    expect(visible()).toEqual([]);
    expect(db.prepare("SELECT * FROM document_scope_facts").all()).toEqual([]);
  });

  it("skips an unreadable declaration without starving another source", () => {
    document("one");
    db.prepare("INSERT INTO sources VALUES('fictional:two','second')").run();
    db.prepare(
      "INSERT INTO documents VALUES('second','fictional','fictional:two','','second',?, '2026-01-01')",
    ).run(JSON.stringify({ extra: { conversationId: "chat" } }));
    upsertSourceScopes(db, [{ sourceType: "second", scopes }], 2);
    db.prepare(
      "UPDATE source_scope_descriptors SET scopes_json = '{}' WHERE source_type = 'fictional'",
    ).run();
    expect(backfillDocumentScopes(db, 2).processed).toBe(0);
    expect(backfillDocumentScopes(db, 2).processed).toBe(1);
    expect(
      db.prepare("SELECT ready FROM scope_fact_backfill WHERE source_id='fictional:one'").get(),
    ).toEqual({ ready: 0 });
    expect(
      db.prepare("SELECT ready FROM scope_fact_backfill WHERE source_id='fictional:two'").get(),
    ).toEqual({ ready: 1 });
  });

  it("revokes children when their parent becomes a derived document", () => {
    document("hidden", { conversationId: "hidden-chat" });
    document("parent");
    document("child", { parentExternalId: "parent" }, { type: "file" });
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual(["child", "parent"]);
    const metadata = {
      documentType: "file",
      extra: { conversationId: "chat", parentExternalId: "hidden" },
    };
    db.prepare("UPDATE documents SET metadata = ? WHERE id='parent'").run(JSON.stringify(metadata));
    projectStoredDocumentScopes(
      db,
      {
        id: "parent",
        providerId: "fictional",
        sourceId: "fictional:one",
        streamId: "",
        externalId: "parent",
        metadata,
      },
      scopes,
    );
    expect(visible()).toEqual([]);
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual([]);
  });

  it("cleans catalogue and readiness before a source ID can be reused", () => {
    document("one");
    backfillDocumentScopes(db, 2);
    db.prepare("INSERT INTO source_scope_kind_readiness VALUES ('fictional:one','label',1)").run();
    db.prepare("DELETE FROM sources WHERE id='fictional:one'").run();
    expect(state()).toBeUndefined();
    expect(db.prepare("SELECT * FROM scope_entities").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM source_scope_kind_readiness").all()).toEqual([]);
    expect(visible()).toEqual([]);
    db.prepare("INSERT INTO sources VALUES ('fictional:one','fictional')").run();
    backfillDocumentScopes(db, 2);
    expect(visible()).toEqual(["one"]);
  });

  it("inherits file parent relations and hides an attachment missing its parent ID", () => {
    document("parent", { conversationId: "other" });
    document("file-child", { parentExternalId: "parent" }, { type: "file" });
    document("missing-parent", {}, { type: "attachment" });
    backfillDocumentScopes(db, 4);
    expect(visible()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT subject_document_id FROM document_scope_subjects WHERE document_id='file-child'",
        )
        .get(),
    ).toEqual({ subject_document_id: "parent" });
  });

  it("keeps corrupt metadata unknown while allowing the rest of the source to complete", () => {
    document("one");
    document("corrupt");
    db.prepare("UPDATE documents SET metadata = 'not-json' WHERE id='corrupt'").run();
    backfillDocumentScopes(db, 3);
    expect(visible()).toEqual(["one"]);
    expect(state()).toMatchObject({ processed: 2, ready: 1 });
  });

  it("inherits the parent decision across out-of-order arrival and never across account or stream", () => {
    document("child", { parentExternalId: "parent" }, { type: "attachment" });
    document(
      "foreign-child",
      { parentExternalId: "parent" },
      { type: "attachment", stream: "other" },
    );
    backfillDocumentScopes(db, 3);
    expect(visible()).toEqual([]);
    document("parent");
    // Live ingestion projects this parent before the retry tick.
    projectStoredDocumentScopes(
      db,
      {
        id: "parent",
        providerId: "fictional",
        sourceId: "fictional:one",
        streamId: "",
        externalId: "parent",
        metadata: { documentType: "conversation", extra: { conversationId: "chat" } },
      },
      scopes,
    );
    expect(backfillDocumentScopes(db, 2).subjectsResolved).toBe(1);
    expect(visible()).toEqual(["child", "parent"]);
    db.prepare("DELETE FROM documents WHERE id = 'parent'").run();
    expect(visible()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT subject_document_id FROM document_scope_subjects WHERE document_id='child'",
        )
        .get(),
    ).toEqual({ subject_document_id: "" });
  });
});
