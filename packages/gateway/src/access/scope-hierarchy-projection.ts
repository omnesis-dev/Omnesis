// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hierarchyParentsSchema, documentHierarchySchema } from "./scope-hierarchy-validation.js";
import type { DocumentScopeFacts, SourceScopes } from "@omnesis/types";
import type { ScopeProjectionDocument } from "./scope-projection.js";
import type { Db } from "../data/types.js";

const MAX_ANCESTORS = 64;
function parents(raw: string): string[] | null {
  try {
    const result = hierarchyParentsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Flatten only trusted native edges; neither a display path nor supplied ancestor facts authorize. */
export function projectDocumentHierarchyScopes(
  db: Db,
  doc: ScopeProjectionDocument,
  scopes: SourceScopes,
  projection: DocumentScopeFacts,
): DocumentScopeFacts {
  if (!scopes.items.some((item) => item.kind === "folder" && item.link === "hierarchy"))
    return projection;
  const parsed = documentHierarchySchema.safeParse(doc.metadata.scopeHierarchy);
  const metadata = parsed.success ? parsed.data.find((item) => item.kind === "folder") : undefined;
  const direct = hierarchyParentsSchema.safeParse(metadata?.parentIds);
  let complete = metadata?.complete === true && direct.success;
  const ids = new Set<string>();
  const read = db.prepare<
    [string, string],
    { parents_json: string; complete: number; deleted: number }
  >(
    "SELECT parents_json,complete,deleted FROM scope_hierarchy_nodes WHERE source_id=? AND kind='folder' AND entity_id=?",
  );
  const visit = (id: string, path: Set<string>): void => {
    if (path.has(id)) {
      complete = false;
      return;
    }
    if (ids.has(id)) return;
    if (ids.size >= MAX_ANCESTORS) {
      complete = false;
      return;
    }
    ids.add(id);
    const node = read.get(doc.sourceId, id);
    const above = node ? parents(node.parents_json) : null;
    if (!node || !node.complete || node.deleted || above === null) {
      complete = false;
      return;
    }
    const nextPath = new Set(path).add(id);
    for (const parent of above) visit(parent, nextPath);
  };
  if (direct.success) for (const id of direct.data) visit(id, new Set());
  const child =
    doc.metadata.documentType === "attachment" ||
    Object.prototype.hasOwnProperty.call(doc.metadata.extra ?? {}, "parentExternalId");
  if (!child) {
    db.prepare(
      `INSERT INTO scope_document_hierarchy VALUES(?,'folder',?,?,?)
      ON CONFLICT(document_id,kind) DO UPDATE SET source_id=excluded.source_id,
      parents_json=excluded.parents_json,complete=excluded.complete`,
    ).run(
      doc.id,
      doc.sourceId,
      JSON.stringify(direct.success ? direct.data : []),
      +(metadata?.complete === true && direct.success),
    );
    db.prepare(
      "DELETE FROM scope_hierarchy_dependencies WHERE document_id=? AND kind='folder'",
    ).run(doc.id);
    const insert = db.prepare("INSERT INTO scope_hierarchy_dependencies VALUES(?,?,'folder',?)");
    for (const id of ids) insert.run(doc.id, doc.sourceId, id);
  }
  const refreshEpochs = { ...projection.refreshEpochs };
  delete refreshEpochs.folder;
  if (metadata?.refreshEpoch) refreshEpochs.folder = metadata.refreshEpoch;
  return {
    refreshEpochs,
    kinds: [...new Set([...(projection.kinds ?? []), "folder" as const])],
    facts: [
      ...projection.facts.filter((fact) => fact.kind !== "folder"),
      ...[...ids].map((id) => ({ kind: "folder" as const, id })),
    ],
    complete: [
      ...projection.complete.filter((kind) => kind !== "folder"),
      ...(complete && !child ? ["folder" as const] : []),
    ],
  };
}
