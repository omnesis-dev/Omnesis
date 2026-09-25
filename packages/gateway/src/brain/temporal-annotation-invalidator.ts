// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Temporal-annotation invalidation subscriber — the content-change half of
 * keeping semantic annotations honest. When a document's content changes,
 * a live annotation grounded in it may describe a fact that no longer holds
 * (a rescheduled date edited in-place in the source). The writer op judges
 * each annotation's evidence quotes against the new content — surgical
 * per-atom survival, so an annotation citing a continuously-rewritten
 * document (a chat thread's daily doc) lives as long as its quote does — and
 * soft-invalidates only what lost every grounding atom (dropped from queries
 * and the calendar, kept for audit). The judgement runs both ways: a change
 * that restores a broken quote heals the atom and resurrects a
 * churn-invalidated annotation, so the read guard also fires for documents
 * only such an entry cites. The same upsert wakes the Cognition Steward's
 * data run, which re-files whatever the new content supports.
 * The deletion-driven HARD purge rides the DocumentService privacy-delete
 * seam (`cascadeTemporalAnnotationPrivacyDelete`), not the bus.
 *
 * Hot-path discipline mirrors the annotation invalidator: a cheap indexed
 * READ guard on the read handle, then the (single-writer) write op fired
 * WITHOUT awaiting — invalidation is idempotent and order-insensitive, so
 * it must never block or fail document ingest.
 */

import { hasLiveTemporalAnnotationsForDoc } from "../enrichment/temporal-annotations/storage.js";
import type { TemporalAnnotationInvalidationResult } from "../enrichment/temporal-annotations/storage.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { EventBus, DocumentUpsertedEvent } from "../events.js";

type Db = Database.Database;
type Clock = () => number;

export interface TemporalAnnotationInvalidatorOpts {
  /** Read handle for the cheap has-entries guard. */
  db: Db;
  eventBus: Pick<EventBus, "on">;
  /** Single-writer op; fired fire-and-forget off the hot path. */
  invalidate: (docId: string, now: number) => Promise<TemporalAnnotationInvalidationResult>;
  /** Live gate — inert unless the Briefs feature is active. */
  isEnabled: () => boolean;
  clock: Clock;
  log: Logger;
}

/** Wire content-change → temporal-annotation invalidation. Returns the unsubscribe. */
export function subscribeTemporalAnnotationInvalidator(
  opts: TemporalAnnotationInvalidatorOpts,
): () => void {
  return opts.eventBus.on("document.upserted", (ev: DocumentUpsertedEvent) => {
    if (!ev.contentChanged || !opts.isEnabled()) return;
    const docId = ev.after.id;
    // Cheap indexed guard so a high-throughput ingest never floods the writer
    // with no-op invalidations for documents no entry cites.
    if (!hasLiveTemporalAnnotationsForDoc(opts.db, docId)) return;
    void opts
      .invalidate(docId, opts.clock())
      .then((r) => {
        // Kept-only outcomes (every grounding quote survived) stay quiet —
        // that is the steady state for continuously-rewritten documents.
        if (r.invalidated > 0 || r.atomsBroken > 0 || r.atomsHealed > 0 || r.resurrected > 0) {
          opts.log.info(
            `temporal annotations after ${docId} content change: ${r.invalidated} invalidated, ${r.kept} kept, ${r.resurrected} resurrected, ${r.atomsBroken} atom(s) broken, ${r.atomsHealed} healed`,
          );
        }
      })
      .catch((err: unknown) =>
        opts.log.warn(
          `temporal-annotation invalidation failed for ${docId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  });
}
