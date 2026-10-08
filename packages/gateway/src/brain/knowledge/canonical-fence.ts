// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeOrganizationVersion } from "./organization-context.js";
import { readKnowledgeOwner, type KnowledgeOwnerKind } from "./owner-adapters.js";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { getKnowledgeNode } from "./storage-read.js";
import { knowledgeHash, resolveKnowledgeReference } from "./storage-validation.js";
import { parseClaimReference } from "./references.js";
import { KnowledgeStorageError } from "./types.js";
import {
  assertKnowledgeReconciliation,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import type Database from "better-sqlite3";

export interface KnowledgeCanonicalFence extends KnowledgeRunFence {
  collections?: KnowledgeReconciliationReceipt[];
  briefCreateGuard?: { loopIds: string[]; supersedes: string[]; force: boolean };
  owners: Array<{ kind: KnowledgeOwnerKind; id: string; version: string | null }>;
  evidenceVersions: Record<string, string | number | null>;
  inputs: Array<{ nodeId: string; fingerprint: string; versions: Record<string, string | number> }>;
}
export function knowledgeCanonicalOwnerVersion(
  db: Database.Database,
  kind: KnowledgeOwnerKind,
  id: string,
): string | null {
  try {
    const owner = readKnowledgeOwner(db, kind, id).versionFingerprint;
    // These children are surfaced by fetch but absent from the owner adapter's
    // operational snapshot. Preserve their read version too, including changes
    // that happen at the same virtual-clock millisecond.
    const ledger =
      kind === "loop" &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='open_loop_ledger' AND type='table'").get()
        ? db.prepare("SELECT MAX(seq) AS seq FROM open_loop_ledger WHERE loop_id=?").get(id)
        : null;
    const claims =
      kind === "brief" &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='brief_claims' AND type='table'").get()
        ? db
            .prepare(
              "SELECT * FROM brief_claims WHERE brief_id=? AND invalidated_at IS NULL ORDER BY id LIMIT 1025",
            )
            .all(id)
        : [];
    if (claims.length > 1024)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical brief claim snapshot exceeds its bounded read budget",
      );
    return knowledgeHash([owner, ledger, claims]);
  } catch (error) {
    if (error instanceof KnowledgeStorageError && error.code === "reference_invalid") return null;
    throw error;
  }
}
export function refreshKnowledgeCanonicalOwners(
  db: Database.Database,
  fence: KnowledgeCanonicalFence,
): KnowledgeCanonicalFence["owners"] {
  return fence.owners.map((owner) => ({
    ...owner,
    version: knowledgeCanonicalOwnerVersion(db, owner.kind, owner.id),
  }));
}
function captureOwners(
  db: Database.Database,
  tool: string,
  args: unknown,
): KnowledgeCanonicalFence["owners"] {
  if (!args || typeof args !== "object") return [];
  const input = args as Record<string, unknown>;
  const kind: KnowledgeOwnerKind | undefined = tool.startsWith("open_loop_")
    ? "loop"
    : tool.startsWith("brief_")
      ? "brief"
      : tool.startsWith("person_annotation_") || tool === "annotate_person"
        ? "person_annotation"
        : tool.startsWith("annotation_") || tool === "annotate_durable"
          ? "doc_annotation"
          : undefined;
  if (!kind) return [];
  const ids = new Set<string>();
  if (typeof input.id === "string") ids.add(input.id);
  if (typeof input.supersedes === "string") ids.add(input.supersedes);
  if (typeof input.supersededBy === "string") ids.add(input.supersededBy);
  if (Array.isArray(input.supersedes))
    for (const id of input.supersedes) if (typeof id === "string") ids.add(id);
  if (ids.size > 128)
    throw new KnowledgeStorageError("revision_conflict", "Too many canonical owner targets");
  return [...ids].map((id) => ({
    kind,
    id,
    version: knowledgeCanonicalOwnerVersion(db, kind, id),
  }));
}

/** Canonical argument document identities are read from the DB; caller hashes are ignored. */
function citedDocumentIds(args: unknown): Set<string> {
  const ids = new Set<string>();
  let budget = 8192;
  const walk = (value: unknown, depth: number) => {
    if (--budget < 0 || depth > 32)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical evidence arguments exceed the bounded read budget",
      );
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (["docId", "documentId", "evidenceDocId"].includes(key) && typeof entry === "string")
        ids.add(entry);
      if ((key === "docs" || key === "citations") && Array.isArray(entry))
        for (const id of entry) if (typeof id === "string") ids.add(id);
      if (entry && typeof entry === "object") walk(entry, depth + 1);
    }
  };
  walk(args, 0);
  if (ids.size > 1024)
    throw new KnowledgeStorageError("revision_conflict", "Too many canonical evidence documents");
  return ids;
}
function evidenceVersion(db: Database.Database, id: string): string | number | null {
  try {
    return resolveKnowledgeReference(db, parseClaimReference(`source:${id}`)).revision;
  } catch {
    return null;
  }
}

/** Captured before a canonical tool can await a model/verifier. */
export function captureKnowledgeCanonicalFence(
  db: Database.Database,
  run: KnowledgeRunFence,
  args?: unknown,
  tool = "",
): KnowledgeCanonicalFence {
  assertKnowledgeRunFence(db, run);
  const rows = db
    .prepare<
      [string],
      { node_id: string; input_fingerprint: string; input_versions_json: string }
    >("SELECT node_id,input_fingerprint,input_versions_json FROM knowledge_frontier WHERE batch_id=? AND status='offered' ORDER BY node_id LIMIT 257")
    .all(run.batchId);
  if (!rows.length || rows.length > 256)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Canonical maintenance requires a bounded offered frontier",
    );
  const owners = captureOwners(db, tool, args);
  const documentIds = citedDocumentIds(args);
  for (const owner of owners)
    if (owner.version !== null) {
      for (const id of readKnowledgeOwner(db, owner.kind, owner.id).evidenceDocumentIds)
        documentIds.add(id);
    }
  if (documentIds.size > 1024)
    throw new KnowledgeStorageError("revision_conflict", "Too many canonical evidence documents");
  return {
    ...run,
    owners,
    evidenceVersions: Object.fromEntries(
      [...documentIds].map((id) => [id, evidenceVersion(db, id)]),
    ),
    inputs: rows.map((row) => ({
      nodeId: row.node_id,
      fingerprint: row.input_fingerprint,
      versions: JSON.parse(row.input_versions_json),
    })),
  };
}
/** Runs in the same writer transaction as the canonical mutation. */
export function assertKnowledgeCanonicalFence(
  db: Database.Database,
  fence: KnowledgeCanonicalFence,
): void {
  assertKnowledgeRunFence(db, fence);
  for (const receipt of fence.collections ?? []) assertKnowledgeReconciliation(db, receipt);
  if (fence.owners.length > 128)
    throw new KnowledgeStorageError("revision_conflict", "Too many canonical owner targets");
  for (const owner of fence.owners)
    if (knowledgeCanonicalOwnerVersion(db, owner.kind, owner.id) !== owner.version)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical owner changed before maintenance mutation",
      );
  if (!fence.inputs.length || fence.inputs.length > 256)
    throw new KnowledgeStorageError("revision_conflict", "Maintenance frontier is unavailable");
  if (Object.keys(fence.evidenceVersions).length > 1024)
    throw new KnowledgeStorageError("revision_conflict", "Too many canonical evidence documents");
  for (const [id, expected] of Object.entries(fence.evidenceVersions))
    if (evidenceVersion(db, id) !== expected)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Cited evidence changed before canonical mutation",
      );
  let budget = 8192;
  for (const input of fence.inputs) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM knowledge_frontier WHERE batch_id=? AND node_id=? AND input_fingerprint=? AND status='offered'",
        )
        .get(fence.batchId, input.nodeId, input.fingerprint)
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Maintenance input is no longer offered",
      );
    for (const [ref, expected] of Object.entries(input.versions)) {
      if (--budget < 0)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Maintenance input exceeds the write budget",
        );
      let actual: string | number;
      if (ref.startsWith("node:"))
        actual = getKnowledgeNode(db, ref.slice(5))?.revision ?? "missing";
      else if (ref.startsWith("organization:"))
        actual = knowledgeOrganizationVersion(db, ref.slice(13));
      else if (ref.startsWith("orientation:"))
        actual = getKnowledgeNode(db, ref.slice(12))?.meaningRevision ?? "missing";
      else if (ref.startsWith("blocked_by:"))
        actual = getKnowledgeNode(db, ref.slice(11))?.meaningRevision ?? "missing";
      else {
        try {
          actual = resolveKnowledgeReference(db, parseClaimReference(ref)).revision;
        } catch {
          actual = "missing";
        }
      }
      if (actual !== expected)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Maintenance evidence changed before canonical mutation",
        );
    }
  }
}
