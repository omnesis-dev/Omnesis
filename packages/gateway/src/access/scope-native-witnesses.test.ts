// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createScopeFactsSchema } from "./scope-schema.js";
import { replaceDocumentScopeFacts } from "./scope-facts.js";
import {
  replaceNativeScopeWitnesses,
  withNativeScopePublication,
} from "./scope-native-witnesses.js";
import {
  stageOrReplaceScopeFacts,
  drainScopeFactRebuilds,
  hasScopeFactRebuilds,
} from "./scope-fact-rebuilds.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";
import type { DocumentScopeFacts, ScopePolicy } from "@omnesis/types";

const sourceId = "fictional:one";
const selected: DocumentScopeFacts = {
  facts: [{ kind: "label", id: "chosen" }],
  complete: ["label"],
};
describe("native refresh witnesses", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT NOT NULL)");
    createScopeFactsSchema(db);
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional','{}',1)",
    ).run(sourceId);
    for (const id of ["fresh", "old", "missing"]) {
      db.prepare("INSERT INTO documents VALUES(?,?)").run(id, sourceId);
      replaceDocumentScopeFacts(db, id, selected);
    }
  });
  afterEach(() => db.close());
  function visible(action: "share" | "hide"): string[] {
    const policy: ScopePolicy = {
      sourceId,
      audience: { accessLevel: "new", capability: "direct" },
      rules: [{ match: [{ kind: "label", id: "chosen" }], action }],
      otherwise: action === "share" ? "hide" : "share",
    };
    const clause = sourceScopeInclusionSql([policy], "d.id", "d.source_id");
    return db
      .prepare<unknown[], { id: string }>(
        `SELECT d.id FROM documents d WHERE ${clause.sql} ORDER BY d.id`,
      )
      .all(...clause.params)
      .map((row) => row.id);
  }
  test("existing facts need no witness until a required refresh is issued", () => {
    expect(visible("share")).toEqual(["fresh", "missing", "old"]);
    expect(visible("hide")).toEqual([]);
  });
  test("omitted or deleted remote items stay unknown after the source refresh reopens", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','required-current')",
    ).run(sourceId);
    replaceNativeScopeWitnesses(db, "fresh", {
      ...selected,
      refreshEpochs: { label: "required-current" },
    });
    replaceNativeScopeWitnesses(db, "old", {
      ...selected,
      refreshEpochs: { label: "required-old" },
    });
    db.prepare("INSERT INTO source_scope_refreshes VALUES(?,'label',1)").run(sourceId);
    expect(visible("share")).toEqual([]);
    db.prepare("UPDATE source_scope_refreshes SET active=0 WHERE source_id=?").run(sourceId);
    expect(visible("share")).toEqual(["fresh"]);
    expect(visible("hide")).toEqual([]);
    replaceDocumentScopeFacts(db, "fresh", { facts: [], complete: ["label"] });
    expect(visible("hide")).toEqual([]);
    replaceNativeScopeWitnesses(db, "fresh", {
      facts: [],
      complete: ["label"],
      refreshEpochs: { label: "required-current" },
    });
    expect(visible("hide")).toEqual(["fresh"]);
  });
  test("epoch-less replacement revokes earlier proof instead of inheriting it", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','required-current')",
    ).run(sourceId);
    replaceNativeScopeWitnesses(db, "fresh", {
      ...selected,
      refreshEpochs: { label: "required-current" },
    });
    expect(visible("share")).toEqual(["fresh"]);
    replaceNativeScopeWitnesses(db, "fresh", selected);
    expect(visible("share")).toEqual([]);
  });
  test("incomplete chunks cannot become authorized merely by carrying an epoch", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','required-current')",
    ).run(sourceId);
    replaceDocumentScopeFacts(db, "fresh", { ...selected, complete: [] });
    replaceNativeScopeWitnesses(db, "fresh", {
      ...selected,
      complete: [],
      refreshEpochs: { label: "required-current" },
    });
    expect(db.prepare("SELECT * FROM scope_native_refresh_witnesses").all()).toEqual([]);
    expect(visible("share")).toEqual([]);
  });
  test("attachments inherit the parent's native proof and are revoked together", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','required-current')",
    ).run(sourceId);
    replaceNativeScopeWitnesses(db, "fresh", {
      ...selected,
      refreshEpochs: { label: "required-current" },
    });
    db.prepare("INSERT INTO documents VALUES('attachment',?)").run(sourceId);
    db.prepare(
      "INSERT INTO document_scope_subjects(document_id,subject_document_id) VALUES('attachment','fresh')",
    ).run();
    expect(visible("share")).toEqual(["attachment", "fresh"]);
    db.prepare("UPDATE source_scope_refresh_requirements SET epoch='newer' WHERE source_id=?").run(
      sourceId,
    );
    expect(visible("share")).toEqual([]);
  });
  test("one account's requirement cannot revoke another account and deletion cleans proof", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES('fictional:two','label','sibling')",
    ).run();
    expect(visible("share")).toEqual(["fresh", "missing", "old"]);
    replaceNativeScopeWitnesses(db, "fresh", {
      ...selected,
      refreshEpochs: { label: "required-current" },
    });
    db.prepare("DELETE FROM documents WHERE id='fresh'").run();
    expect(db.prepare("SELECT * FROM scope_native_refresh_witnesses").all()).toEqual([]);
  });

  test("a legacy fact or completeness writer cannot leave or resurrect a native proof", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','current')",
    ).run(sourceId);
    const prove = () =>
      replaceNativeScopeWitnesses(db, "fresh", {
        ...selected,
        refreshEpochs: { label: "current" },
      });
    prove();
    expect(visible("share")).toEqual(["fresh"]);
    db.prepare("UPDATE document_scope_facts SET entity_id='other' WHERE document_id='fresh'").run();
    expect(db.prepare("SELECT * FROM scope_native_desired_witnesses").all()).toEqual([]);
    db.prepare("UPDATE document_scope_completeness SET complete=1 WHERE document_id='fresh'").run();
    expect(visible("hide")).toEqual([]);
    prove();
    expect(visible("hide")).toEqual(["fresh"]);
    db.prepare("DELETE FROM document_scope_completeness WHERE document_id='fresh'").run();
    db.prepare("INSERT INTO document_scope_completeness VALUES('fresh','label',1)").run();
    expect(visible("hide")).toEqual([]);
  });

  test("large projections stage desired proof but publish it only after the last bounded fact chunk", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','current')",
    ).run(sourceId);
    const large: DocumentScopeFacts = {
      facts: Array.from({ length: 400 }, (_, index) => ({
        kind: "label",
        id: index === 0 ? "chosen" : `label-${index}`,
      })),
      complete: ["label"],
      refreshEpochs: { label: "current" },
    };
    stageOrReplaceScopeFacts(db, sourceId, "fresh", large);
    replaceNativeScopeWitnesses(db, "fresh", large);
    expect(db.prepare("SELECT * FROM scope_native_refresh_witnesses").all()).toEqual([]);
    expect(db.prepare("SELECT epoch FROM scope_native_desired_witnesses").get()).toEqual({
      epoch: "current",
    });
    while (hasScopeFactRebuilds(db, sourceId)) {
      const result = drainScopeFactRebuilds(db, sourceId);
      expect(result.processed).toBeLessThanOrEqual(128);
      if (result.pending) expect(visible("share")).toEqual([]);
    }
    expect(visible("share")).toEqual(["fresh"]);
    expect(db.prepare("SELECT * FROM scope_native_publication_context").all()).toEqual([]);
  });

  test("a legacy mutation between chunks destroys desired authority even if new code finishes that queue", () => {
    db.prepare(
      "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,'label','current')",
    ).run(sourceId);
    const large: DocumentScopeFacts = {
      facts: Array.from({ length: 400 }, (_, index) => ({ kind: "label", id: `label-${index}` })),
      complete: ["label"],
      refreshEpochs: { label: "current" },
    };
    stageOrReplaceScopeFacts(db, sourceId, "fresh", large);
    replaceNativeScopeWitnesses(db, "fresh", large);
    drainScopeFactRebuilds(db, sourceId);
    db.prepare(
      "INSERT OR REPLACE INTO document_scope_facts VALUES('fresh','label','legacy-extra')",
    ).run();
    while (hasScopeFactRebuilds(db, sourceId)) drainScopeFactRebuilds(db, sourceId);
    expect(visible("hide")).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_native_desired_witnesses").all()).toEqual([]);
  });

  test("publication context rolls back on error and cannot exempt a later writer", () => {
    replaceNativeScopeWitnesses(db, "fresh", { ...selected, refreshEpochs: { label: "current" } });
    expect(() =>
      withNativeScopePublication(db, "fresh", () => {
        db.prepare("DELETE FROM document_scope_facts WHERE document_id='fresh'").run();
        throw new Error("Invented interruption");
      }),
    ).toThrow("Invented interruption");
    expect(db.prepare("SELECT * FROM scope_native_publication_context").all()).toEqual([]);
    expect(db.prepare("SELECT epoch FROM scope_native_refresh_witnesses").get()).toEqual({
      epoch: "current",
    });
    db.prepare("DELETE FROM document_scope_facts WHERE document_id='fresh'").run();
    expect(db.prepare("SELECT * FROM scope_native_refresh_witnesses").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_native_desired_witnesses").all()).toEqual([]);
  });

  test("proof cleanup survives an older gateway replacing its shared document cleanup trigger", () => {
    const large: DocumentScopeFacts = {
      facts: Array.from({ length: 400 }, (_, index) => ({ kind: "label", id: `label-${index}` })),
      complete: ["label"],
      refreshEpochs: { label: "current" },
    };
    stageOrReplaceScopeFacts(db, sourceId, "fresh", large);
    replaceNativeScopeWitnesses(db, "fresh", large);
    expect(db.prepare("SELECT epoch FROM scope_native_desired_witnesses").get()).toEqual({
      epoch: "current",
    });
    db.exec("DROP TRIGGER document_scope_cleanup");
    db.prepare("DELETE FROM documents WHERE id='fresh'").run();
    expect(db.prepare("SELECT * FROM scope_native_desired_witnesses").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_native_refresh_witnesses").all()).toEqual([]);
  });
});
