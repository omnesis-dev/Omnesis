// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl, type UrlCanonicalizerSpec } from "@omnesis/core";
import {
  collectorRosterRevisionMatches,
  collectorRosterSnapshot,
} from "../collector-declaration-roster.js";
import { markLinkStatsDirty } from "../data/DirtyMarks.js";
import { documentsMetadataCodec } from "../data/json-columns.js";
import {
  getRecanonicalizeFingerprint,
  setRecanonicalizeFingerprint,
} from "../data/repositories/CanonicalizationStateRepository.js";
import {
  fingerprintUrlCanonicalizerSpecs,
  getCachedSafeUrlCanonicalizerRegistry,
} from "../known-url-pattern-safety.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export const SOURCE_URL_RECANONICALIZE_PAGE_SIZE = 50;

export interface SourceUrlRecanonicalizationCursor {
  fingerprint: string;
  expectedDeclarationRevision: number;
  cycleMaxRowid: number;
  afterRowid: number;
  scanned: number;
}

export interface SourceUrlRecanonicalizationMutation {
  id: string;
  expectedUpdatedAt: string;
  expectedSourceUrl: string | null;
  normalizedSourceUrl: string | null;
}

export interface SourceUrlRecanonicalizationPlan {
  cursor: SourceUrlRecanonicalizationCursor;
  mutations: SourceUrlRecanonicalizationMutation[];
  done: boolean;
  alreadyCurrent: boolean;
  abandoned: boolean;
}

export interface SourceUrlRecanonicalizationApplyResult {
  touched: number;
  abandoned: boolean;
}

/** Specs and hosts are sets, but rule order is semantic: the first match wins. */
export function fingerprintCanonicalizerSpecs(specs: readonly UrlCanonicalizerSpec[]): string {
  return fingerprintUrlCanonicalizerSpecs(specs);
}

/** Plan one finite page on a read handle. Parsing and regex work never touch the writer. */
export function planSourceUrlRecanonicalization(
  db: Db,
  specs: readonly UrlCanonicalizerSpec[],
  prior?: SourceUrlRecanonicalizationCursor,
): SourceUrlRecanonicalizationPlan {
  const fingerprint = prior?.fingerprint ?? fingerprintCanonicalizerSpecs(specs);
  const expectedDeclarationRevision =
    prior?.expectedDeclarationRevision ?? collectorRosterSnapshot(db).revision;
  const cycleMaxRowid =
    prior?.cycleMaxRowid ??
    db
      .prepare<
        [],
        { maxRowid: number }
      >("SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM documents")
      .get()!.maxRowid;
  const cursor: SourceUrlRecanonicalizationCursor = {
    fingerprint,
    expectedDeclarationRevision,
    cycleMaxRowid,
    afterRowid: prior?.afterRowid ?? 0,
    scanned: prior?.scanned ?? 0,
  };

  if (
    specs.length === 0 ||
    getRecanonicalizeFingerprint(db) === fingerprint ||
    !collectorRosterRevisionMatches(db, expectedDeclarationRevision)
  ) {
    return {
      cursor,
      mutations: [],
      done: true,
      alreadyCurrent: getRecanonicalizeFingerprint(db) === fingerprint,
      abandoned: !collectorRosterRevisionMatches(db, expectedDeclarationRevision),
    };
  }

  const rows = db
    .prepare<
      [number, number, number],
      { rowid: number; id: string; metadata: string; source_url: string | null; updated_at: string }
    >(
      `SELECT rowid, id, metadata, source_url, updated_at
         FROM documents
        WHERE rowid > ? AND rowid <= ?
        ORDER BY rowid
        LIMIT ?`,
    )
    .all(cursor.afterRowid, cursor.cycleMaxRowid, SOURCE_URL_RECANONICALIZE_PAGE_SIZE);
  const registry = getCachedSafeUrlCanonicalizerRegistry(specs, fingerprint);
  const mutations: SourceUrlRecanonicalizationMutation[] = [];
  for (const row of rows) {
    try {
      const metadata = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id });
      const rawUrl = typeof metadata["sourceUrl"] === "string" ? metadata["sourceUrl"] : null;
      const normalizedSourceUrl = rawUrl ? normalizeUrl(rawUrl, registry) : null;
      if (normalizedSourceUrl !== row.source_url) {
        mutations.push({
          id: row.id,
          expectedUpdatedAt: row.updated_at,
          expectedSourceUrl: row.source_url,
          normalizedSourceUrl,
        });
      }
    } catch {
      // A malformed legacy row does not abort the bounded read page.
    }
  }
  const afterRowid = rows.at(-1)?.rowid ?? cursor.afterRowid;
  const nextCursor = { ...cursor, afterRowid, scanned: cursor.scanned + rows.length };
  return {
    cursor: nextCursor,
    mutations,
    done: rows.length === 0 || afterRowid >= cursor.cycleMaxRowid,
    alreadyCurrent: false,
    abandoned: false,
  };
}

/** Apply at most one reader-planned page with cheap OCC checks only. */
export function applySourceUrlRecanonicalizationPage(
  db: Db,
  cursor: SourceUrlRecanonicalizationCursor,
  mutations: readonly SourceUrlRecanonicalizationMutation[],
): SourceUrlRecanonicalizationApplyResult {
  if (mutations.length > SOURCE_URL_RECANONICALIZE_PAGE_SIZE) {
    throw new Error(
      `source URL recanonicalization page exceeds ${SOURCE_URL_RECANONICALIZE_PAGE_SIZE}`,
    );
  }
  return db.transaction(() => {
    if (!collectorRosterRevisionMatches(db, cursor.expectedDeclarationRevision)) {
      return { touched: 0, abandoned: true };
    }
    const update = db.prepare<[string | null, string, string, string, string | null]>(
      `UPDATE documents
          SET source_url = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND source_url IS ?`,
    );
    // A url edge's `normalized_target` is the same derived quantity as
    // `documents.source_url` — both are `normalizeUrl(rawUrl, registry)`. Moving
    // only the document side would leave every edge already resolved to this
    // document carrying the retired canonical form, and the URL-ownership repair
    // skips a link whose stored target text no longer equals its target's
    // `source_url`. That edge could then never be handed over to the owning
    // source's document once that source is added, so the two canonical forms
    // move together, under the document's own OCC check.
    //
    // Both statements are point lookups on `(target_doc_id, link_type)` and run
    // at most once per changed document, so a page stays bounded writer work.
    const dropSupersededEdge = db.prepare<[string, string, string]>(
      `DELETE FROM document_links
        WHERE target_doc_id = ? AND link_type = 'url' AND normalized_target = ?
          AND EXISTS (
            SELECT 1 FROM document_links canonical
             WHERE canonical.source_doc_id = document_links.source_doc_id
               AND canonical.link_type = 'url'
               AND canonical.normalized_target = ?
          )`,
    );
    const recanonicalizeEdge = db.prepare<[string, string, string]>(
      `UPDATE document_links SET normalized_target = ?
        WHERE target_doc_id = ? AND link_type = 'url' AND normalized_target = ?`,
    );
    const now = new Date().toISOString();
    let touched = 0;
    let removedEdges = 0;
    for (const mutation of mutations) {
      const changes = update.run(
        mutation.normalizedSourceUrl,
        now,
        mutation.id,
        mutation.expectedUpdatedAt,
        mutation.expectedSourceUrl,
      ).changes;
      touched += changes;
      if (changes === 0) continue;
      const { expectedSourceUrl, normalizedSourceUrl } = mutation;
      if (expectedSourceUrl === null || normalizedSourceUrl === null) continue;
      // A source document holding both flavours of the URL (possible only on an
      // additive-retention source, whose extraction never deletes) would break
      // `UNIQUE(source_doc_id, link_type, normalized_target)` on the rewrite.
      // The canonical sibling already carries the relationship, so the retired
      // duplicate goes.
      removedEdges += dropSupersededEdge.run(
        mutation.id,
        expectedSourceUrl,
        normalizedSourceUrl,
      ).changes;
      recanonicalizeEdge.run(normalizedSourceUrl, mutation.id, expectedSourceUrl);
    }
    if (removedEdges > 0) markLinkStatsDirty(db);
    return { touched, abandoned: false };
  })();
}

/** Publish completion only if the exact declaration generation is still current. */
export function finishSourceUrlRecanonicalization(
  db: Db,
  cursor: SourceUrlRecanonicalizationCursor,
): boolean {
  return db.transaction(() => {
    if (!collectorRosterRevisionMatches(db, cursor.expectedDeclarationRevision)) return false;
    setRecanonicalizeFingerprint(db, cursor.fingerprint);
    return true;
  })();
}

export interface SourceUrlRecanonicalizationGates {
  plan(
    specs: readonly UrlCanonicalizerSpec[],
    cursor?: SourceUrlRecanonicalizationCursor,
  ): Promise<SourceUrlRecanonicalizationPlan>;
  apply(
    cursor: SourceUrlRecanonicalizationCursor,
    mutations: readonly SourceUrlRecanonicalizationMutation[],
  ): Promise<SourceUrlRecanonicalizationApplyResult>;
  finish(cursor: SourceUrlRecanonicalizationCursor): Promise<boolean>;
}

/** Serialize whole recomputes so an older collector generation cannot finish after a newer one. */
export class SourceUrlRecanonicalizationService {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly gates: SourceUrlRecanonicalizationGates) {}

  recompute(specs: readonly UrlCanonicalizerSpec[]): Promise<{ scanned: number; touched: number }> {
    const result = this.queue.then(() => this.run(specs));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async run(
    specs: readonly UrlCanonicalizerSpec[],
  ): Promise<{ scanned: number; touched: number }> {
    let cursor: SourceUrlRecanonicalizationCursor | undefined;
    let touched = 0;
    for (;;) {
      const plan = await this.gates.plan(specs, cursor);
      cursor = plan.cursor;
      if (plan.abandoned) {
        throw new Error("source URL recanonicalization abandoned after declarations changed");
      }
      if (plan.mutations.length > 0) {
        const applied = await this.gates.apply(cursor, plan.mutations);
        if (applied.abandoned) {
          throw new Error("source URL recanonicalization abandoned after declarations changed");
        }
        touched += applied.touched;
      }
      if (!plan.done) continue;
      if (!plan.alreadyCurrent && !(await this.gates.finish(cursor))) {
        throw new Error("source URL recanonicalization abandoned after declarations changed");
      }
      return { scanned: cursor.scanned, touched };
    }
  }
}
