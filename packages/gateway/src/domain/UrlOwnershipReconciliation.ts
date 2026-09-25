// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sourceMatchesAnyPrefix, sourcePrefixPredicate } from "../data/source-addressing.js";
import { getCachedUrlIdPatterns } from "../db.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const OWNERSHIP_SCAN_EXAMINE_LIMIT = 20_000;
/** Maximum proposals of each ownership kind handed to one writer operation. */
export const OWNERSHIP_MUTATION_LIMIT = 50;

export interface LinkRetarget {
  linkId: number;
  previousTargetDocId: string;
  /** Null clears a reference-only target when no real target exists yet. */
  targetDocId: string | null;
  normalizedTarget: string;
  /** Only fallback representations are identity-linked to the new owner. */
  connectRepresentations: boolean;
}

export interface SameResourceUpdate {
  sourceDocId: string;
  normalizedTarget: string | null;
  targetDocId: string | null;
  expectedSourceUrl: string | null;
  expectedPriorNormalizedTarget: string | null;
  expectedPriorTargetDocId: string | null;
  expectedPriorTargetSourceUrl: string | null;
}

export interface UrlOwnershipRepairPlan {
  retargets: LinkRetarget[];
  sameResourceUpdates: SameResourceUpdate[];
  ownershipLinkScannedMaxId?: number;
  ownershipLinkCycleMaxId?: number;
  ownershipDocumentScannedMaxRowid?: number;
  ownershipDocumentCycleMaxRowid?: number;
  examinedAny: boolean;
}

export function extractIdFromUrl(
  db: Db,
  normalizedTarget: string,
): { id: string; sourceTypePrefix: string } | null {
  for (const pattern of getCachedUrlIdPatterns(db)) {
    const match = pattern.regex.exec(normalizedTarget);
    if (match?.[1]) return { id: match[1], sourceTypePrefix: pattern.sourceTypePrefix };
  }
  return null;
}

export function resolveUrlLink(
  db: Db,
  normalizedTarget: string,
  fallbackRepresentationSourcePrefixes: readonly string[] = [],
  referenceOnlySourcePrefixes: readonly string[] = [],
): { docId: string } | null {
  // Let SQLite select the owner from the exact source_url index range. This
  // avoids an arbitrary candidate cap: even a URL with hundreds of fallback
  // or reference representations still finds a real owner later in the range.
  const fallbackPredicate = sourcePrefixPredicate(
    "source_id",
    fallbackRepresentationSourcePrefixes,
  );
  const referencePredicate = sourcePrefixPredicate("source_id", referenceOnlySourcePrefixes);
  const ownerSql = DIRECT_URL_OWNER_LOOKUP_SQL.replace(
    "/*FALLBACK_PREDICATE*/",
    fallbackPredicate.sql,
  ).replace("/*REFERENCE_PREDICATE*/", referencePredicate.sql);
  const owner = db
    .prepare<unknown[], { id: string }>(ownerSql)
    .get(normalizedTarget, ...fallbackPredicate.params, ...referencePredicate.params);
  if (owner) return { docId: owner.id };
  const fallbackSql = DIRECT_URL_FALLBACK_LOOKUP_SQL.replace(
    "/*FALLBACK_PREDICATE*/",
    fallbackPredicate.sql,
  ).replace("/*REFERENCE_PREDICATE*/", referencePredicate.sql);
  const fallback = db
    .prepare<unknown[], { id: string }>(fallbackSql)
    .get(normalizedTarget, ...fallbackPredicate.params, ...referencePredicate.params);
  if (fallback) return { docId: fallback.id };

  const extracted = extractIdFromUrl(db, normalizedTarget);
  if (!extracted) return null;
  const patternReference = sourcePrefixPredicate("source_id", referenceOnlySourcePrefixes);
  const patternSource = sourcePrefixPredicate("source_id", [extracted.sourceTypePrefix]);
  const patternRow = db
    .prepare<
      unknown[],
      { id: string }
    >(PATTERN_OWNER_LOOKUP_SQL.replace("/*SOURCE_PREDICATE*/", patternSource.sql).replace("/*REFERENCE_PREDICATE*/", patternReference.sql))
    .get(extracted.id, ...patternSource.params, ...patternReference.params);
  return patternRow ? { docId: patternRow.id } : null;
}

function resolveSameResourceOwner(
  db: Db,
  normalizedTarget: string,
  sourceDocId: string,
  fallbackRepresentationSourcePrefixes: readonly string[],
  referenceOnlySourcePrefixes: readonly string[],
): { docId: string } | null {
  const fallbackPredicate = sourcePrefixPredicate(
    "source_id",
    fallbackRepresentationSourcePrefixes,
  );
  const referencePredicate = sourcePrefixPredicate("source_id", referenceOnlySourcePrefixes);
  const ownerSql = DIRECT_URL_OWNER_LOOKUP_SQL.replace(
    "/*FALLBACK_PREDICATE*/",
    fallbackPredicate.sql,
  ).replace("/*REFERENCE_PREDICATE*/", referencePredicate.sql);
  const owner = db
    .prepare<unknown[], { id: string }>(ownerSql.replace("LIMIT 1", "AND id != ? LIMIT 1"))
    .get(normalizedTarget, ...fallbackPredicate.params, ...referencePredicate.params, sourceDocId);
  return owner ? { docId: owner.id } : null;
}

export const DIRECT_URL_OWNER_LOOKUP_SQL = `SELECT id FROM documents
  WHERE source_url = ?
    AND NOT (/*FALLBACK_PREDICATE*/)
    AND NOT (/*REFERENCE_PREDICATE*/)
  LIMIT 1`;

export const DIRECT_URL_FALLBACK_LOOKUP_SQL = `SELECT id FROM documents
  WHERE source_url = ?
    AND (/*FALLBACK_PREDICATE*/)
    AND NOT (/*REFERENCE_PREDICATE*/)
  LIMIT 1`;

export const PATTERN_OWNER_LOOKUP_SQL = `SELECT id FROM documents
  WHERE LOWER(external_id) = LOWER(?) AND (/*SOURCE_PREDICATE*/)
    AND NOT (/*REFERENCE_PREDICATE*/)
  LIMIT 1`;

export const OWNERSHIP_LINK_SCAN_SQL = `SELECT dl.id, dl.link_type, dl.normalized_target, dl.target_doc_id,
              target.source_id AS target_source_id, target.source_url AS target_source_url
         FROM document_links dl
         LEFT JOIN documents target ON target.id = dl.target_doc_id
        WHERE dl.id > ? AND dl.id <= ?
        ORDER BY dl.id
        LIMIT ?`;

export const OWNERSHIP_DOCUMENT_SCAN_SQL = `WITH scanned AS (
          SELECT rowid AS document_rowid, id, source_id, source_url
            FROM documents
           WHERE rowid > ? AND rowid <= ?
           ORDER BY rowid
           LIMIT ?
        )
        SELECT scanned.document_rowid, scanned.id, scanned.source_id, scanned.source_url,
               existing.normalized_target AS existing_normalized_target,
               existing.target_doc_id AS existing_target_doc_id,
               target.source_url AS existing_target_source_url
          FROM scanned
          LEFT JOIN document_links existing ON existing.id = (
            SELECT id FROM document_links
             WHERE source_doc_id = scanned.id AND link_type = 'same-resource'
             ORDER BY id LIMIT 1
          )
          LEFT JOIN documents target ON target.id = existing.target_doc_id
         ORDER BY scanned.document_rowid`;

function readOwnershipCursors(db: Db): {
  link: number;
  linkMax: number;
  document: number;
  documentMax: number;
} {
  const row = db
    .prepare<
      [],
      {
        ownership_link_cursor: number;
        ownership_link_max_id: number;
        ownership_document_cursor: number;
        ownership_document_max_rowid: number;
      }
    >(
      `SELECT ownership_link_cursor, ownership_link_max_id,
              ownership_document_cursor, ownership_document_max_rowid
         FROM link_reconcile_state WHERE id = 1`,
    )
    .get();
  return {
    link: row?.ownership_link_cursor ?? 0,
    linkMax: row?.ownership_link_max_id ?? 0,
    document: row?.ownership_document_cursor ?? 0,
    documentMax: row?.ownership_document_max_rowid ?? 0,
  };
}

/** Plan bounded URL-target and fallback-representation repairs on a read handle. */
export function computeUrlOwnershipRepairs(
  db: Db,
  limit: number,
  fallbackRepresentationSourcePrefixes: readonly string[],
  referenceOnlySourcePrefixes: readonly string[],
  urlTargetRolesReady: boolean,
): UrlOwnershipRepairPlan {
  const mutationLimit = Math.min(limit, OWNERSHIP_MUTATION_LIMIT);
  const cursors = readOwnershipCursors(db);
  const linkEnabled =
    mutationLimit > 0 &&
    urlTargetRolesReady &&
    (fallbackRepresentationSourcePrefixes.length > 0 || referenceOnlySourcePrefixes.length > 0);
  const documentEnabled =
    mutationLimit > 0 && urlTargetRolesReady && fallbackRepresentationSourcePrefixes.length > 0;
  const linkCycleMaxId = !linkEnabled
    ? undefined
    : cursors.linkMax > 0
      ? cursors.linkMax
      : (db
          .prepare<
            [],
            { max_id: number }
          >("SELECT COALESCE(MAX(id), 0) AS max_id FROM document_links")
          .get()?.max_id ?? 0);
  const documentCycleMaxRowid = !documentEnabled
    ? undefined
    : cursors.documentMax > 0
      ? cursors.documentMax
      : (db
          .prepare<
            [],
            { max_rowid: number }
          >("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM documents")
          .get()?.max_rowid ?? 0);

  const linkRows = !linkEnabled
    ? []
    : db
        .prepare<
          [number, number, number],
          {
            id: number;
            link_type: string;
            normalized_target: string;
            target_doc_id: string | null;
            target_source_id: string | null;
            target_source_url: string | null;
          }
        >(OWNERSHIP_LINK_SCAN_SQL)
        .all(cursors.link, linkCycleMaxId ?? 0, OWNERSHIP_SCAN_EXAMINE_LIMIT);
  const retargets: LinkRetarget[] = [];
  let linkScannedMaxId = 0;
  for (const row of linkRows) {
    linkScannedMaxId = row.id;
    if (
      row.link_type !== "url" ||
      row.target_doc_id === null ||
      row.target_source_id === null ||
      row.target_source_url !== row.normalized_target ||
      (!sourceMatchesAnyPrefix(row.target_source_id, fallbackRepresentationSourcePrefixes) &&
        !sourceMatchesAnyPrefix(row.target_source_id, referenceOnlySourcePrefixes))
    ) {
      continue;
    }
    const targetIsFallback = sourceMatchesAnyPrefix(
      row.target_source_id,
      fallbackRepresentationSourcePrefixes,
    );
    const preferred = targetIsFallback
      ? resolveSameResourceOwner(
          db,
          row.normalized_target,
          row.target_doc_id,
          fallbackRepresentationSourcePrefixes,
          referenceOnlySourcePrefixes,
        )
      : resolveUrlLink(
          db,
          row.normalized_target,
          fallbackRepresentationSourcePrefixes,
          referenceOnlySourcePrefixes,
        );
    if (!preferred && targetIsFallback) continue;
    retargets.push({
      linkId: row.id,
      previousTargetDocId: row.target_doc_id,
      targetDocId: preferred?.docId ?? null,
      normalizedTarget: row.normalized_target,
      connectRepresentations: targetIsFallback,
    });
    if (retargets.length >= mutationLimit) break;
  }

  const documentRows = !documentEnabled
    ? []
    : db
        .prepare<
          [number, number, number],
          {
            document_rowid: number;
            id: string;
            source_id: string;
            source_url: string | null;
            existing_normalized_target: string | null;
            existing_target_doc_id: string | null;
            existing_target_source_url: string | null;
          }
        >(OWNERSHIP_DOCUMENT_SCAN_SQL)
        .all(cursors.document, documentCycleMaxRowid ?? 0, OWNERSHIP_SCAN_EXAMINE_LIMIT);
  const sameResourceUpdates: SameResourceUpdate[] = [];
  let documentScannedMaxRowid = 0;
  for (const row of documentRows) {
    documentScannedMaxRowid = row.document_rowid;
    const existing = row.existing_normalized_target
      ? {
          normalizedTarget: row.existing_normalized_target,
          targetDocId: row.existing_target_doc_id,
          targetSourceUrl: row.existing_target_source_url,
        }
      : undefined;
    if (!sourceMatchesAnyPrefix(row.source_id, fallbackRepresentationSourcePrefixes)) {
      if (existing) {
        sameResourceUpdates.push({
          sourceDocId: row.id,
          normalizedTarget: null,
          targetDocId: null,
          expectedSourceUrl: row.source_url,
          expectedPriorNormalizedTarget: existing.normalizedTarget,
          expectedPriorTargetDocId: existing.targetDocId,
          expectedPriorTargetSourceUrl: existing.targetSourceUrl,
        });
        if (sameResourceUpdates.length >= mutationLimit) break;
      }
      continue;
    }
    const preferred = row.source_url
      ? resolveSameResourceOwner(
          db,
          row.source_url,
          row.id,
          fallbackRepresentationSourcePrefixes,
          referenceOnlySourcePrefixes,
        )
      : null;
    if (
      preferred &&
      existing?.normalizedTarget === row.source_url &&
      existing.targetDocId === preferred.docId
    ) {
      continue;
    }
    if (!existing && !preferred) continue;
    sameResourceUpdates.push({
      sourceDocId: row.id,
      normalizedTarget: row.source_url,
      targetDocId: preferred?.docId ?? null,
      expectedSourceUrl: row.source_url,
      expectedPriorNormalizedTarget: existing?.normalizedTarget ?? null,
      expectedPriorTargetDocId: existing?.targetDocId ?? null,
      expectedPriorTargetSourceUrl: existing?.targetSourceUrl ?? null,
    });
    if (sameResourceUpdates.length >= mutationLimit) break;
  }

  return {
    retargets,
    sameResourceUpdates,
    ownershipLinkScannedMaxId: linkEnabled ? linkScannedMaxId : undefined,
    ownershipLinkCycleMaxId: linkEnabled ? linkCycleMaxId : undefined,
    ownershipDocumentScannedMaxRowid: documentEnabled ? documentScannedMaxRowid : undefined,
    ownershipDocumentCycleMaxRowid: documentEnabled ? documentCycleMaxRowid : undefined,
    examinedAny: linkRows.length > 0 || documentRows.length > 0,
  };
}
