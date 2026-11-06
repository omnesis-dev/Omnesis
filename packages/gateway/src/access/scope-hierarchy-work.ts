// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { documentsMetadataCodec } from "../data/json-columns.js";
import { getSourceScopes } from "./scope-descriptors.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import { dirtyHierarchyNode } from "./scope-hierarchy.js";
import { completeScopeRefresh } from "./scope-refresh-requirements.js";
import type { DocumentMetadata } from "@omnesis/types";
import type { Db } from "../data/types.js";

/** Catalogue omission and descendant work commit in bounded, restartable units. */
export function drainHierarchyWork(db: Db, budget = 128, token?: { requested(): boolean }): number {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 128)
    throw new Error("Invalid hierarchy work budget.");
  let processed = 0;
  while (processed < budget && !token?.requested()) {
    const lastCatalogue = db
      .prepare<[], { catalogue_source_id: string }>(
        "SELECT catalogue_source_id FROM scope_hierarchy_work_cursor WHERE id=1",
      )
      .get()!.catalogue_source_id;
    const after =
      processed % 2 === 0 || !db.prepare("SELECT 1 FROM scope_hierarchy_dirty LIMIT 1").get();
    const catalogue = db.prepare<
      [string],
      {
        source_id: string;
        snapshot_id: string;
        cursor_entity_id: string;
        release_refresh: number;
        publish_ready: number;
        refresh_epoch: string | null;
      }
    >(
      "SELECT * FROM scope_hierarchy_catalogues WHERE phase='prune' AND source_id>? ORDER BY source_id LIMIT 1",
    );
    const currentCatalogue = after
      ? (catalogue.get(lastCatalogue) ?? catalogue.get(""))
      : undefined;
    if (currentCatalogue) {
      const catalogue = currentCatalogue;
      db.transaction(() => {
        db.prepare("UPDATE scope_hierarchy_work_cursor SET catalogue_source_id=? WHERE id=1").run(
          catalogue.source_id,
        );
        const stale = (operator: "<" | ">") =>
          db
            .prepare<[string, string], { entity_id: string }>(
              `SELECT entity_id FROM scope_hierarchy_nodes
          WHERE source_id=? AND kind='folder' AND snapshot_id${operator}? ORDER BY snapshot_id,entity_id LIMIT 1`,
            )
            .get(catalogue.source_id, catalogue.snapshot_id);
        const node = stale("<") ?? stale(">");
        if (node) {
          dirtyHierarchyNode(db, catalogue.source_id, node.entity_id);
          db.prepare(
            "UPDATE scope_hierarchy_nodes SET deleted=1,complete=0,snapshot_id=? WHERE source_id=? AND kind='folder' AND entity_id=?",
          ).run(catalogue.snapshot_id, catalogue.source_id, node.entity_id);
          db.prepare(
            "DELETE FROM scope_entities WHERE source_id=? AND kind='folder' AND entity_id=?",
          ).run(catalogue.source_id, node.entity_id);
          db.prepare(
            "UPDATE scope_hierarchy_catalogues SET cursor_entity_id=? WHERE source_id=? AND kind='folder'",
          ).run(node.entity_id, catalogue.source_id);
        } else {
          db.prepare(
            "UPDATE scope_hierarchy_catalogues SET phase='idle' WHERE source_id=? AND kind='folder'",
          ).run(catalogue.source_id);
          const released =
            catalogue.release_refresh &&
            completeScopeRefresh(
              db,
              catalogue.source_id,
              "folder",
              catalogue.refresh_epoch ?? undefined,
            );
          if (released)
            db.prepare(
              "UPDATE source_scope_refreshes SET active=0 WHERE source_id=? AND kind='folder'",
            ).run(catalogue.source_id);
          if (
            catalogue.publish_ready &&
            !db
              .prepare(
                "SELECT 1 FROM source_scope_refreshes WHERE source_id=? AND kind='folder' AND active=1",
              )
              .get(catalogue.source_id)
          )
            db.prepare(
              "UPDATE source_scope_kind_readiness SET ready=1 WHERE source_id=? AND kind='folder'",
            ).run(catalogue.source_id);
        }
      })();
      processed++;
      continue;
    }
    const cursor = db
      .prepare<[], { source_id: string; entity_id: string }>(
        "SELECT source_id,entity_id FROM scope_hierarchy_work_cursor WHERE id=1",
      )
      .get()!;
    const next = db.prepare<
      [string, string],
      { source_id: string; entity_id: string; revision: string; cursor_document_id: string }
    >(
      "SELECT * FROM scope_hierarchy_dirty WHERE (source_id,entity_id)>(?,?) ORDER BY source_id,entity_id LIMIT 1",
    );
    const task = next.get(cursor.source_id, cursor.entity_id) ?? next.get("", "");
    if (!task) break;
    db.transaction(() => {
      db.prepare("UPDATE scope_hierarchy_work_cursor SET source_id=?,entity_id=? WHERE id=1").run(
        task.source_id,
        task.entity_id,
      );
      const row = db
        .prepare<
          [string, string, string],
          {
            id: string;
            provider_id: string;
            stream_id: string;
            external_id: string;
            metadata: string;
          }
        >(
          `SELECT d.id,d.provider_id,d.stream_id,d.external_id,d.metadata FROM scope_hierarchy_dependencies h JOIN documents d ON d.id=h.document_id
        WHERE h.source_id=? AND h.kind='folder' AND h.entity_id=? AND h.document_id>? ORDER BY h.document_id LIMIT 1`,
        )
        .get(task.source_id, task.entity_id, task.cursor_document_id);
      if (!row) {
        db.prepare(
          "DELETE FROM scope_hierarchy_dirty WHERE source_id=? AND kind='folder' AND entity_id=? AND revision=?",
        ).run(task.source_id, task.entity_id, task.revision);
        return;
      }
      const source = db
        .prepare<[string], { type: string }>("SELECT type FROM sources WHERE id=?")
        .get(task.source_id);
      const scopes = source ? getSourceScopes(db, source.type) : null;
      if (scopes) {
        let metadata: DocumentMetadata;
        try {
          metadata = documentsMetadataCodec.parse(row.metadata, {
            rowId: row.id,
          }) as DocumentMetadata;
        } catch {
          metadata = {};
        }
        projectStoredDocumentScopes(
          db,
          {
            id: row.id,
            sourceId: task.source_id,
            providerId: row.provider_id,
            streamId: row.stream_id,
            externalId: row.external_id,
            metadata,
            historical: true,
          },
          scopes,
        );
      }
      db.prepare(
        "UPDATE scope_hierarchy_dirty SET cursor_document_id=? WHERE source_id=? AND kind='folder' AND entity_id=? AND revision=?",
      ).run(row.id, task.source_id, task.entity_id, task.revision);
    })();
    processed++;
  }
  return processed;
}
