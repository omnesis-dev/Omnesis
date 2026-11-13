// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { documentsMetadataCodec } from "../data/json-columns.js";
import { getSourceScopes } from "./scope-descriptors.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import { applyConversationScopeUpdates } from "./scope-conversations.js";
import { applyHierarchyUpdates, deferHierarchyControl } from "./scope-hierarchy.js";
import {
  canCompleteScopeRefresh,
  completeScopeRefresh,
  beginScopeRefresh,
} from "./scope-refresh-requirements.js";
import { documentScopeFactsSchema, sourceScopeUpdatesSchema } from "./scope-update-schema.js";
import type {
  DocumentMetadata,
  DocumentScopeFacts,
  SourceScopeUpdates,
  ScopeRef,
} from "@omnesis/types";
import type { Db } from "../data/types.js";

interface ScopeUpdateContext {
  sourceId: string;
  providerId: string;
  streamId: string;
  writeEpoch?: number;
  authorityId?: string;
  snapshotAuthority?: boolean;
}

/** The caller's cursor transaction owns these bounded, source-bound metadata writes. */
export function applySourceScopeUpdates(
  db: Db,
  context: ScopeUpdateContext,
  input: SourceScopeUpdates,
): void {
  const updates = sourceScopeUpdatesSchema.parse(input);
  const source = db
    .prepare<[string], { type: string }>("SELECT type FROM sources WHERE id = ?")
    .get(context.sourceId);
  const scopes = source ? getSourceScopes(db, source.type) : null;
  if (!scopes) throw new Error("Source has not declared filter metadata support.");
  const declared = new Set(scopes.items.map((item) => item.kind));
  const requiredKinds: ScopeRef["kind"][] = [
    ...(updates.documents ?? []).flatMap((update) => update.kinds),
    ...(updates.entities ?? []).map((entity) => entity.kind),
    ...(updates.replaceEntityKinds ?? []),
    ...(updates.readiness ?? []).map((state) => state.kind),
    ...(updates.refreshes ?? []).map((state) => state.kind),
    ...(updates.hierarchy ? [updates.hierarchy.kind] : []),
    ...((updates.conversations?.length ?? 0) > 0
      ? ["conversation" as const, "participant" as const]
      : []),
  ];
  if (requiredKinds.some((kind) => !declared.has(kind))) {
    throw new Error("Source does not support the submitted scope kind.");
  }
  for (const state of updates.refreshes ?? []) {
    if (
      state.active &&
      !beginScopeRefresh(
        db,
        context.sourceId,
        state.kind,
        state.epoch,
        state.restart,
        state.requestId,
      )
    )
      continue;
    if (
      !state.active &&
      (context.snapshotAuthority === false ||
        !canCompleteScopeRefresh(db, context.sourceId, state.kind, state.epoch))
    )
      continue;
    if (
      !state.active &&
      deferHierarchyControl(db, context.sourceId, state.kind, "refresh", state.epoch)
    )
      continue;
    if (!state.active && !completeScopeRefresh(db, context.sourceId, state.kind, state.epoch))
      continue;
    db.prepare(
      `INSERT INTO source_scope_refreshes(source_id,kind,active) VALUES(?,?,?)
      ON CONFLICT(source_id,kind) DO UPDATE SET active=excluded.active
      WHERE source_scope_refreshes.active <> excluded.active`,
    ).run(context.sourceId, state.kind, +state.active);
  }
  if (updates.hierarchy) applyHierarchyUpdates(db, context, updates.hierarchy, scopes);
  for (const kind of updates.replaceEntityKinds ?? []) {
    db.prepare("DELETE FROM scope_entities WHERE source_id = ? AND kind = ?").run(
      context.sourceId,
      kind,
    );
  }
  const entity =
    db.prepare(`INSERT INTO scope_entities(source_id,kind,entity_id,label,parent_id) VALUES(?,?,?,?,?)
    ON CONFLICT(source_id,kind,entity_id) DO UPDATE SET label=excluded.label,parent_id=excluded.parent_id`);
  for (const item of updates.entities ?? [])
    entity.run(context.sourceId, item.kind, item.id, item.label, item.parentId ?? null);
  const lookup = db.prepare<[string, string, string, string], { id: string; metadata: string }>(
    "SELECT id,metadata FROM documents WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id = ?",
  );
  const write = db.prepare("UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?");
  for (const update of updates.documents ?? []) {
    const row = lookup.get(
      context.providerId,
      context.sourceId,
      context.streamId,
      update.externalId,
    );
    if (!row) continue;
    const metadata = documentsMetadataCodec.parse(row.metadata, {
      rowId: row.id,
    }) as DocumentMetadata;
    const existing = documentScopeFactsSchema.safeParse(metadata.scopeFacts);
    const oldFacts: DocumentScopeFacts = existing.success
      ? existing.data
      : { facts: [], complete: [] };
    const replaced = new Set(update.kinds);
    const refreshEpochs = { ...oldFacts.refreshEpochs };
    for (const kind of update.kinds) delete refreshEpochs[kind];
    for (const kind of update.kinds)
      if (update.facts.refreshEpochs?.[kind])
        refreshEpochs[kind] = update.facts.refreshEpochs[kind];
    metadata.scopeFacts = {
      ...(Object.keys(refreshEpochs).length ? { refreshEpochs } : {}),
      kinds: [
        ...new Set([
          ...(oldFacts.kinds ?? [...oldFacts.facts.map((fact) => fact.kind), ...oldFacts.complete]),
          ...update.kinds,
        ]),
      ],
      facts: [...oldFacts.facts.filter((fact) => !replaced.has(fact.kind)), ...update.facts.facts],
      complete: [
        ...oldFacts.complete.filter((kind) => !replaced.has(kind)),
        ...update.facts.complete,
      ],
    };
    if (update.tags !== undefined) metadata.tags = update.tags;
    if (update.relevanceScore !== undefined) metadata.relevanceScore = update.relevanceScore;
    write.run(documentsMetadataCodec.serialize({ ...metadata }), new Date().toISOString(), row.id);
    projectStoredDocumentScopes(
      db,
      { ...context, id: row.id, externalId: update.externalId, metadata },
      scopes,
    );
  }
  if (updates.conversations?.length)
    applyConversationScopeUpdates(db, context, updates.conversations);
  for (const state of updates.readiness ?? []) {
    if (
      state.complete &&
      (context.snapshotAuthority === false ||
        db
          .prepare("SELECT 1 FROM source_scope_refreshes WHERE source_id=? AND kind=? AND active=1")
          .get(context.sourceId, state.kind))
    ) {
      if (state.kind === "folder") deferHierarchyControl(db, context.sourceId, state.kind, "ready");
      continue;
    }
    if (state.complete && deferHierarchyControl(db, context.sourceId, state.kind, "ready"))
      continue;
    db.prepare(
      `INSERT INTO source_scope_kind_readiness(source_id,kind,ready) VALUES(?,?,?)
      ON CONFLICT(source_id,kind) DO UPDATE SET ready=excluded.ready`,
    ).run(context.sourceId, state.kind, +state.complete);
  }
}
