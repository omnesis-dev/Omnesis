// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createScopeFactsDocumentTriggers, createScopeFactsSchema } from "./scope-schema.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";
import {
  captureScopeFactRebuildTargets,
  drainScopeFactRebuilds,
  hasScopeFactRebuilds,
  stageOrReplaceScopeFacts,
} from "./scope-fact-rebuilds.js";
import type { DocumentScopeFacts } from "@omnesis/types";

const sourceId = "fictional:labels";
function labels(count: number, prefix = "label"): DocumentScopeFacts {
  return {
    facts: Array.from({ length: count }, (_, i) => ({
      kind: "label" as const,
      id: `${prefix}-${i}`,
      label: `Invented ${prefix} ${i}`,
    })),
    complete: ["label"],
  };
}

describe("bounded scope fact publication", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT, provider_id TEXT, stream_id TEXT, external_id TEXT)",
    );
    createScopeFactsSchema(db);
    createScopeFactsDocumentTriggers(db);
    db.prepare("INSERT INTO sources VALUES(?)").run(sourceId);
    db.prepare("INSERT INTO documents VALUES('doc',?,'fictional','','item')").run(sourceId);
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional','{}',1)",
    ).run(sourceId);
  });
  afterEach(() => db.close());
  function visible(exclude = false): boolean {
    const clause = sourceScopeInclusionSql(
      [
        {
          sourceId,
          audience: { accessLevel: "level", capability: "direct" },
          rules: [
            { match: [{ kind: "label", id: "label-0" }], action: exclude ? "hide" : "share" },
          ],
          otherwise: exclude ? "share" : "hide",
        },
      ],
      "d.id",
      "d.source_id",
    );
    return !!db
      .prepare(`SELECT 1 FROM documents d WHERE d.id='doc' AND ${clause.sql}`)
      .get(...clause.params);
  }
  function finish(): number {
    let ticks = 0;
    while (hasScopeFactRebuilds(db, sourceId)) {
      const result = drainScopeFactRebuilds(db, sourceId);
      expect(result.processed).toBeGreaterThan(0);
      expect(result.processed).toBeLessThanOrEqual(128);
      if (++ticks > 30) throw new Error("Fact publication did not converge");
    }
    return ticks;
  }
  test("keeps both modes unknown until every chunk and label is published", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    expect(visible()).toBe(false);
    expect(visible(true)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM scope_entities").get()).toEqual({ n: 0 });
    expect(drainScopeFactRebuilds(db, sourceId)).toEqual({ processed: 128, pending: true });
    expect(db.prepare("SELECT count(*) AS n FROM scope_entities").get()).toEqual({ n: 128 });
    expect(visible()).toBe(false);
    expect(visible(true)).toBe(false);
    finish();
    expect(visible()).toBe(true);
    expect(visible(true)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM document_scope_facts").get()).toEqual({ n: 400 });
  });
  test("replays an interrupted identical snapshot without rewinding its durable cursor", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    drainScopeFactRebuilds(db, sourceId);
    const before = db.prepare("SELECT revision,phase,cursor FROM scope_fact_rebuilds").get();
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    expect(db.prepare("SELECT revision,phase,cursor FROM scope_fact_rebuilds").get()).toEqual(
      before,
    );
    createScopeFactsSchema(db);
    createScopeFactsDocumentTriggers(db);
    expect(finish()).toBe(3);
    expect(visible()).toBe(true);
  });
  test("does not adopt a superseding sibling snapshot when draining an old page", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    const targets = captureScopeFactRebuildTargets(
      db,
      { sourceId, providerId: "fictional", streamId: "" },
      ["item"],
    );
    expect(targets).toHaveLength(1);
    drainScopeFactRebuilds(db, sourceId, 128, targets);
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(350, "fresh"));
    expect(drainScopeFactRebuilds(db, sourceId, 128, targets)).toEqual({
      processed: 0,
      pending: false,
    });
    expect(hasScopeFactRebuilds(db, sourceId)).toBe(true);
    expect(visible(true)).toBe(false);
    finish();
    expect(visible()).toBe(false);
    expect(visible(true)).toBe(true);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM document_scope_facts WHERE entity_id LIKE 'label-%'")
        .get(),
    ).toEqual({ n: 0 });
  });
  test("bounds deletion of an old large projection before publishing a small replacement", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    finish();
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(1, "new"));
    expect(visible(true)).toBe(false);
    expect(drainScopeFactRebuilds(db, sourceId)).toEqual({ processed: 128, pending: true });
    expect(db.prepare("SELECT count(*) AS n FROM document_scope_facts").get()).toEqual({ n: 272 });
    finish();
    expect(db.prepare("SELECT entity_id FROM document_scope_facts").all()).toEqual([
      { entity_id: "new-0" },
    ]);
    expect(visible(true)).toBe(true);
  });
  test("captures only the owning source, provider, stream and external IDs", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    for (const context of [
      { sourceId, providerId: "other", streamId: "" },
      { sourceId, providerId: "fictional", streamId: "other" },
      { sourceId: "other", providerId: "fictional", streamId: "" },
    ])
      expect(captureScopeFactRebuildTargets(db, context, ["item"])).toEqual([]);
    expect(
      captureScopeFactRebuildTargets(db, { sourceId, providerId: "fictional", streamId: "" }, [
        "other",
      ]),
    ).toEqual([]);
  });
  test("future pending formats remain hidden without starving healthy work", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    db.prepare("UPDATE scope_fact_rebuilds SET projection=?").run('{"version":99}');
    db.prepare("INSERT INTO documents VALUES('healthy',?,'fictional','','healthy')").run(sourceId);
    stageOrReplaceScopeFacts(db, sourceId, "healthy", labels(200));
    finish();
    expect(visible()).toBe(false);
    expect(visible(true)).toBe(false);
    expect(
      db.prepare("SELECT phase FROM scope_fact_rebuilds WHERE document_id='doc'").get(),
    ).toEqual({ phase: "blocked" });
    expect(
      db
        .prepare("SELECT count(*) AS n FROM document_scope_facts WHERE document_id='healthy'")
        .get(),
    ).toEqual({ n: 200 });
  });
  test.each([-1, 401])("invalid persisted cursor %s cannot publish incomplete facts", (cursor) => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    db.prepare("UPDATE scope_fact_rebuilds SET phase='write',cursor=?").run(cursor);
    expect(drainScopeFactRebuilds(db, sourceId)).toEqual({ processed: 1, pending: false });
    expect(visible()).toBe(false);
    expect(visible(true)).toBe(false);
  });
  test("deletes pending publication with its document or source", () => {
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    db.prepare("DELETE FROM documents WHERE id='doc'").run();
    expect(hasScopeFactRebuilds(db, sourceId)).toBe(false);
    db.prepare("INSERT INTO documents VALUES('doc',?,'fictional','','item')").run(sourceId);
    stageOrReplaceScopeFacts(db, sourceId, "doc", labels(400));
    db.prepare("DELETE FROM sources WHERE id=?").run(sourceId);
    expect(hasScopeFactRebuilds(db, sourceId)).toBe(false);
  });
});
