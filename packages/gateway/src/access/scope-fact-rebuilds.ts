// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { scopeFactRebuildProjectionCodec } from "../data/json-columns.js";
import { replaceDocumentScopeFacts } from "./scope-facts.js";
import {
  withNativeScopePublication,
  publishNativeScopeWitnesses,
} from "./scope-native-witnesses.js";
import type { DocumentScopeFacts, ScopeRef } from "@omnesis/types";
import type { Db } from "../data/types.js";

const FACT_BATCH_SIZE = 128;
type Kind = ScopeRef["kind"];
interface Fact {
  kind: Kind;
  entityId: string;
  label?: string;
}
interface Projection {
  version: 1;
  facts: Fact[];
  complete: Kind[];
}
export interface ScopeFactRebuildTarget {
  documentId: string;
  revision: string;
}
interface Pending extends ScopeFactRebuildTarget {
  sourceId: string;
  projection: string;
  phase: string;
  cursor: number;
}

export function createScopeFactRebuildSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_fact_rebuilds (
    document_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, revision TEXT NOT NULL,
    projection TEXT NOT NULL, phase TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_scope_fact_rebuilds_source ON scope_fact_rebuilds(source_id,document_id);
  CREATE INDEX IF NOT EXISTS idx_scope_fact_rebuilds_pending ON scope_fact_rebuilds(document_id) WHERE phase<>'blocked';
  CREATE INDEX IF NOT EXISTS idx_scope_fact_rebuilds_pending_source ON scope_fact_rebuilds(source_id,document_id) WHERE phase<>'blocked';
  CREATE TABLE IF NOT EXISTS scope_fact_rebuild_cursor(id INTEGER PRIMARY KEY CHECK(id=1), document_id TEXT NOT NULL);
  INSERT OR IGNORE INTO scope_fact_rebuild_cursor VALUES(1,'');`);
}

function flatten(projection: DocumentScopeFacts): Projection {
  const facts: Fact[] = [];
  for (const fact of projection.facts) {
    if (fact.kind === "participant") {
      const { type, value } = fact.identifier;
      facts.push({ kind: fact.kind, entityId: `${type}:${value}` });
      if (type === "email" && value.includes("@"))
        facts.push({
          kind: fact.kind,
          entityId: `domain:${value.slice(value.lastIndexOf("@") + 1)}`,
        });
    } else
      facts.push({
        kind: fact.kind,
        entityId: fact.id,
        ...(fact.label ? { label: fact.label } : {}),
      });
  }
  return { version: 1, facts, complete: projection.complete };
}

function entityLabel(db: Db, sourceId: string, fact: Fact): void {
  if (!fact.label) return;
  db.prepare(
    `INSERT INTO scope_entities(source_id,kind,entity_id,label) VALUES(?,?,?,?)
    ON CONFLICT(source_id,kind,entity_id) DO UPDATE SET label=excluded.label
    WHERE scope_entities.label<>excluded.label`,
  ).run(sourceId, fact.kind, fact.entityId, fact.label);
}

/** Oversized projections revoke completeness before any chunk can publish facts. */
export function stageOrReplaceScopeFacts(
  db: Db,
  sourceId: string,
  documentId: string,
  projection: DocumentScopeFacts,
): void {
  const flat = flatten(projection);
  const serialized = scopeFactRebuildProjectionCodec.serialize(flat);
  db.transaction(() => {
    const existing = db
      .prepare<[string], { source_id: string; projection: string }>(
        "SELECT source_id,projection FROM scope_fact_rebuilds WHERE document_id=?",
      )
      .get(documentId);
    if (existing?.source_id === sourceId && existing.projection === serialized) return;
    if (flat.facts.length <= FACT_BATCH_SIZE) {
      db.prepare("DELETE FROM scope_fact_rebuilds WHERE document_id=?").run(documentId);
      // Replacing a formerly large projection still needs bounded old-fact deletion.
      const old = db
        .prepare<[string, number], { n: number }>(
          "SELECT count(*) AS n FROM (SELECT 1 FROM document_scope_facts WHERE document_id=? LIMIT ?)",
        )
        .get(documentId, FACT_BATCH_SIZE + 1)!;
      if (old.n + flat.facts.length <= FACT_BATCH_SIZE) {
        replaceDocumentScopeFacts(db, documentId, projection);
        for (const fact of flat.facts) entityLabel(db, sourceId, fact);
        return;
      }
    }
    db.prepare("DELETE FROM document_scope_completeness WHERE document_id=?").run(documentId);
    db.prepare(
      `INSERT INTO scope_fact_rebuilds(document_id,source_id,revision,projection,phase,cursor) VALUES(?,?,?,?,'clear',0)
      ON CONFLICT(document_id) DO UPDATE SET source_id=excluded.source_id,revision=excluded.revision,
        projection=excluded.projection,phase='clear',cursor=0`,
    ).run(documentId, sourceId, randomUUID(), serialized);
  })();
}

function targetClause(targets?: readonly ScopeFactRebuildTarget[]): {
  sql: string;
  params: string[];
} {
  return targets === undefined
    ? { sql: "1", params: [] }
    : {
        sql: "(document_id,revision) IN (SELECT json_extract(value,'$.documentId'),json_extract(value,'$.revision') FROM json_each(?))",
        params: [JSON.stringify(targets)],
      };
}

/** Capture only this page's current rebuilds; a newer sibling projection supersedes its target. */
export function captureScopeFactRebuildTargets(
  db: Db,
  context: { sourceId: string; providerId: string; streamId: string },
  externalIds: readonly string[],
): ScopeFactRebuildTarget[] {
  return db
    .prepare<[string, string, string, string], ScopeFactRebuildTarget>(
      `SELECT r.document_id AS documentId,r.revision FROM scope_fact_rebuilds r
    JOIN documents d ON d.id=r.document_id WHERE d.source_id=? AND d.provider_id=? AND d.stream_id=?
      AND d.external_id IN (SELECT value FROM json_each(?)) AND r.phase<>'blocked'`,
    )
    .all(context.sourceId, context.providerId, context.streamId, JSON.stringify(externalIds));
}

export function hasScopeFactRebuilds(
  db: Db,
  sourceId: string | undefined,
  targets?: readonly ScopeFactRebuildTarget[],
): boolean {
  const target = targetClause(targets);
  return !!db
    .prepare(
      `SELECT 1 FROM scope_fact_rebuilds WHERE phase<>'blocked' AND (? IS NULL OR source_id=?) AND ${target.sql} LIMIT 1`,
    )
    .get(sourceId ?? null, sourceId ?? null, ...target.params);
}

function decode(raw: string): Projection | null {
  try {
    return scopeFactRebuildProjectionCodec.parse(raw);
  } catch {
    return null;
  }
}

/** Each call commits at most budget fact operations; the caller owns admission/preemption. */
export function drainScopeFactRebuilds(
  db: Db,
  sourceId?: string,
  budget = FACT_BATCH_SIZE,
  targets?: readonly ScopeFactRebuildTarget[],
): { processed: number; pending: boolean } {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > FACT_BATCH_SIZE)
    throw new Error("Invalid fact rebuild budget.");
  let processed = 0;
  const target = targetClause(targets);
  while (processed < budget) {
    const cursor = db
      .prepare<[], { document_id: string }>(
        "SELECT document_id FROM scope_fact_rebuild_cursor WHERE id=1",
      )
      .get()!.document_id;
    const source =
      sourceId === undefined
        ? { sql: "1", params: [] }
        : { sql: "source_id=?", params: [sourceId] };
    const next = db.prepare<
      unknown[],
      Pending
    >(`SELECT document_id AS documentId,source_id AS sourceId,revision,projection,phase,cursor FROM scope_fact_rebuilds
      WHERE phase<>'blocked' AND ${source.sql} AND ${target.sql} AND document_id>?
      ORDER BY document_id LIMIT 1`);
    const parameters = [...source.params, ...target.params];
    const row = next.get(...parameters, cursor) ?? next.get(...parameters, "");
    if (!row) break;
    withNativeScopePublication(db, row.documentId, () => {
      db.prepare("UPDATE scope_fact_rebuild_cursor SET document_id=? WHERE id=1").run(
        row.documentId,
      );
      const snapshot = decode(row.projection);
      if (
        !snapshot ||
        !["clear", "write"].includes(row.phase) ||
        !Number.isSafeInteger(row.cursor) ||
        row.cursor < 0 ||
        row.cursor > snapshot.facts.length
      ) {
        db.prepare(
          "UPDATE scope_fact_rebuilds SET phase='blocked' WHERE document_id=? AND revision=?",
        ).run(row.documentId, row.revision);
        processed++;
        return;
      }
      if (row.phase === "clear") {
        const removed = db
          .prepare(
            `DELETE FROM document_scope_facts WHERE document_id=? AND (kind,entity_id) IN
          (SELECT kind,entity_id FROM document_scope_facts WHERE document_id=? LIMIT ?)`,
          )
          .run(row.documentId, row.documentId, budget - processed).changes;
        processed += removed;
        if (
          !db
            .prepare("SELECT 1 FROM document_scope_facts WHERE document_id=? LIMIT 1")
            .get(row.documentId)
        )
          db.prepare(
            "UPDATE scope_fact_rebuilds SET phase='write' WHERE document_id=? AND revision=?",
          ).run(row.documentId, row.revision);
        if (removed) return;
      }
      const stop = Math.min(row.cursor + budget - processed, snapshot.facts.length);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO document_scope_facts(document_id,kind,entity_id) VALUES(?,?,?)",
      );
      for (let i = row.cursor; i < stop; i++) {
        const fact = snapshot.facts[i]!;
        insert.run(row.documentId, fact.kind, fact.entityId);
        entityLabel(db, row.sourceId, fact);
        processed++;
      }
      if (stop === snapshot.facts.length) {
        const complete = db.prepare(
          "INSERT OR IGNORE INTO document_scope_completeness(document_id,kind,complete) VALUES(?,?,1)",
        );
        for (const kind of snapshot.complete) complete.run(row.documentId, kind);
        db.prepare("DELETE FROM scope_fact_rebuilds WHERE document_id=? AND revision=?").run(
          row.documentId,
          row.revision,
        );
        publishNativeScopeWitnesses(db, row.documentId);
        if (stop === row.cursor) processed++;
      } else
        db.prepare(
          "UPDATE scope_fact_rebuilds SET cursor=?,phase='write' WHERE document_id=? AND revision=?",
        ).run(stop, row.documentId, row.revision);
    });
  }
  return { processed, pending: hasScopeFactRebuilds(db, sourceId, targets) };
}
