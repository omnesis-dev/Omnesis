// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Annotation invalidation subscriber — the "reground, don't trust a
 * stale prior" half of the evidence firewall. When a document's content
 * changes, the write op re-judges every live annotation touching it
 * SURGICALLY against the new content, per evidence ATOM: an atom whose quote
 * broke is stamped broken, the annotation soft-invalidates only when NO live
 * atom remains (kept for audit), a survivor whose evidence[0] broke gets the
 * next atom promoted into its scalar mirror, and every survivor is re-stamped
 * `unverified` for the re-verification sweep to re-judge (see
 * `storage/annotations.ts#invalidateAnnotationsForDoc`). The deletion-driven
 * HARD purge rides the DocumentService privacy-delete seam
 * (`cascadeAnnotationPrivacyDelete`), not the bus — `document.deleted` is not
 * emitted in this build.
 *
 * Hot-path discipline mirrors the waker: the bus handler does a cheap indexed
 * READ guard on the read handle and only then fires the (single-writer) write
 * op, WITHOUT awaiting it — invalidation is idempotent and order-insensitive,
 * so it must never block or fail document ingest.
 */

import { hasLiveAnnotationsForDoc } from "./storage/annotations.js";
import type { AnnotationInvalidationResult } from "./storage/annotations.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { EventBus, DocumentUpsertedEvent } from "../events.js";

type Db = Database.Database;
type Clock = () => number;

export interface AnnotationInvalidatorOpts {
  /** Read handle for the cheap has-annotations guard. */
  db: Db;
  eventBus: Pick<EventBus, "on">;
  /** Single-writer op; fired fire-and-forget off the hot path. */
  invalidate: (docId: string, now: number) => Promise<AnnotationInvalidationResult>;
  /** Live gate — only invalidate while annotations are enabled. */
  isEnabled: () => boolean;
  clock: Clock;
  log: Logger;
}

/** Wire content-change → annotation invalidation. Returns the unsubscribe. */
export function subscribeAnnotationInvalidator(opts: AnnotationInvalidatorOpts): () => void {
  return opts.eventBus.on("document.upserted", (ev: DocumentUpsertedEvent) => {
    if (!ev.contentChanged || !opts.isEnabled()) return;
    const docId = ev.after.id;
    // Cheap indexed guard so a high-throughput ingest never floods the writer
    // with no-op invalidations for documents that were never annotated.
    if (!hasLiveAnnotationsForDoc(opts.db, docId)) return;
    void opts
      .invalidate(docId, opts.clock())
      .then((r) => {
        if (r.invalidated > 0 || r.flaggedUnverified > 0) {
          opts.log.info(
            `${docId} content change: ${r.invalidated} annotation(s) invalidated, ${r.flaggedUnverified} kept unverified` +
              (r.promoted > 0 ? ` (${r.promoted} mirror(s) promoted)` : ""),
          );
        }
      })
      .catch((err: unknown) =>
        opts.log.warn(
          `annotation invalidation failed for ${docId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  });
}
