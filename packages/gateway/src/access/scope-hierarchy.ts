// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { documentsMetadataCodec } from "../data/json-columns.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import type { SourceScopeHierarchyUpdate, SourceScopes, DocumentMetadata } from "@omnesis/types";
import type { Db } from "../data/types.js";

export interface HierarchyContext {
  sourceId: string;
  providerId: string;
  streamId: string;
  snapshotAuthority?: boolean;
}
export function dirtyHierarchyNode(db: Db, sourceId: string, id: string): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM scope_hierarchy_dependencies WHERE source_id=? AND kind='folder' AND entity_id=? LIMIT 1",
      )
      .get(sourceId, id)
  )
    return;
  db.prepare(
    `INSERT INTO scope_hierarchy_dirty VALUES(?,'folder',?,?,'')
    ON CONFLICT(source_id,kind,entity_id) DO UPDATE SET revision=excluded.revision,cursor_document_id=''`,
  ).run(sourceId, id, randomUUID());
}

export function applyHierarchyUpdates(
  db: Db,
  context: HierarchyContext,
  update: SourceScopeHierarchyUpdate,
  scopes: SourceScopes,
): void {
  const required = db
    .prepare<[string], { epoch: string }>(
      "SELECT epoch FROM source_scope_refresh_requirements WHERE source_id=? AND kind='folder'",
    )
    .get(context.sourceId);
  if (required && required.epoch !== update.refreshEpoch) return;
  if (context.snapshotAuthority === false)
    throw new Error("Hierarchy updates require source snapshot authority.");
  if (!scopes.items.some((item) => item.kind === "folder" && item.link === "hierarchy"))
    throw new Error("Source does not declare a hierarchy.");
  const snapshot = update.snapshot;
  if (snapshot?.phase === "begin") {
    db.prepare(
      `INSERT INTO scope_hierarchy_catalogues VALUES(?,'folder',?,'scan','',0,0,NULL)
      ON CONFLICT(source_id,kind) DO UPDATE SET snapshot_id=excluded.snapshot_id,phase='scan',cursor_entity_id='',release_refresh=0,publish_ready=0
      WHERE scope_hierarchy_catalogues.snapshot_id<>excluded.snapshot_id`,
    ).run(context.sourceId, snapshot.id);
  }
  const catalogue = db
    .prepare<[string], { snapshot_id: string; phase: string }>(
      "SELECT snapshot_id,phase FROM scope_hierarchy_catalogues WHERE source_id=? AND kind='folder'",
    )
    .get(context.sourceId);
  if (snapshot && catalogue?.snapshot_id !== snapshot.id)
    throw new Error("Hierarchy snapshot changed.");
  for (const node of update.nodes ?? []) {
    const previous = db
      .prepare<[string, string], { parents_json: string; complete: number; deleted: number }>(
        "SELECT parents_json,complete,deleted FROM scope_hierarchy_nodes WHERE source_id=? AND kind='folder' AND entity_id=?",
      )
      .get(context.sourceId, node.id);
    const parents = JSON.stringify(node.parentIds);
    if (
      !previous ||
      previous.parents_json !== parents ||
      previous.complete !== +node.complete ||
      previous.deleted !== +(node.deleted ?? false)
    )
      dirtyHierarchyNode(db, context.sourceId, node.id);
    db.prepare(
      `INSERT INTO scope_hierarchy_nodes VALUES(?,'folder',?,?,?,?,?,?)
      ON CONFLICT(source_id,kind,entity_id) DO UPDATE SET label=excluded.label,parents_json=excluded.parents_json,
      complete=excluded.complete,deleted=excluded.deleted,snapshot_id=excluded.snapshot_id`,
    ).run(
      context.sourceId,
      node.id,
      node.label,
      parents,
      +node.complete,
      +(node.deleted ?? false),
      catalogue?.snapshot_id ?? "",
    );
    if (node.deleted)
      db.prepare(
        "DELETE FROM scope_entities WHERE source_id=? AND kind='folder' AND entity_id=?",
      ).run(context.sourceId, node.id);
    else
      db.prepare(
        `INSERT INTO scope_entities(source_id,kind,entity_id,label,parent_id) VALUES(?,'folder',?,?,?)
      ON CONFLICT(source_id,kind,entity_id) DO UPDATE SET label=excluded.label,parent_id=excluded.parent_id`,
      ).run(context.sourceId, node.id, node.label, node.parentIds[0] ?? null);
  }
  for (const patch of update.documents ?? []) {
    const row = db
      .prepare<[string, string, string, string], { id: string; metadata: string }>(
        "SELECT id,metadata FROM documents WHERE source_id=? AND provider_id=? AND stream_id=? AND external_id=?",
      )
      .get(context.sourceId, context.providerId, context.streamId, patch.externalId);
    if (!row) continue;
    const metadata = documentsMetadataCodec.parse(row.metadata, {
      rowId: row.id,
    }) as DocumentMetadata;
    metadata.scopeHierarchy = [
      {
        kind: "folder",
        parentIds: patch.parentIds,
        complete: patch.complete,
        refreshEpoch: patch.refreshEpoch,
      },
    ];
    db.prepare("UPDATE documents SET metadata=?,updated_at=? WHERE id=?").run(
      JSON.stringify(metadata),
      new Date().toISOString(),
      row.id,
    );
    projectStoredDocumentScopes(
      db,
      { ...context, id: row.id, externalId: patch.externalId, metadata },
      scopes,
    );
  }
  if (snapshot?.phase === "end")
    db.prepare(
      `UPDATE scope_hierarchy_catalogues SET phase='prune',cursor_entity_id=''
    WHERE source_id=? AND kind='folder' AND snapshot_id=? AND phase='scan'`,
    ).run(context.sourceId, snapshot.id);
}

/** A final upstream page cannot reopen authority before bounded omission pruning finishes. */
export function deferHierarchyControl(
  db: Db,
  sourceId: string,
  kind: string,
  control: "refresh" | "ready",
  epoch?: string,
): boolean {
  if (kind !== "folder") return false;
  const column = control === "refresh" ? "release_refresh" : "publish_ready";
  return (
    db
      .prepare(
        `UPDATE scope_hierarchy_catalogues SET ${column}=1${control === "refresh" ? ",refresh_epoch=?" : ""} WHERE source_id=? AND kind='folder' AND phase<>'idle'`,
      )
      .run(...(control === "refresh" ? [epoch ?? null] : []), sourceId).changes > 0
  );
}
