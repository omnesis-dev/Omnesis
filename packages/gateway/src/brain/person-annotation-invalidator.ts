// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Person-annotation invalidation subscriber — the person-keyed sibling of
 * `annotation-invalidator.ts`. A person annotation is grounded only in its
 * evidence atoms (there is no subject document — the subject is a person),
 * so when a cited document's content changes the write op re-judges each
 * live row surgically per atom: the annotation soft-invalidates only when NO
 * live atom remains (kept for audit); a survivor keeps living — its mirror
 * promoted if evidence[0] broke — re-stamped `unverified` for the
 * re-verification sweep. The deletion-driven HARD purge rides the
 * DocumentService privacy-delete seam
 * (`cascadePersonAnnotationPrivacyDelete`), not the bus.
 *
 * Hot-path discipline mirrors the doc invalidator: a cheap indexed READ guard
 * on the read handle, then a fire-and-forget (single-writer) write op — never
 * blocking or failing document ingest.
 */

import { hasLivePersonAnnotationsForEvidenceDoc } from "./storage/person-annotations.js";
import type { AnnotationInvalidationResult } from "./storage/annotations.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { EventBus, DocumentUpsertedEvent } from "../events.js";

type Db = Database.Database;
type Clock = () => number;

export interface PersonAnnotationInvalidatorOpts {
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

/** Wire evidence-doc content-change → person-annotation invalidation. */
export function subscribePersonAnnotationInvalidator(
  opts: PersonAnnotationInvalidatorOpts,
): () => void {
  return opts.eventBus.on("document.upserted", (ev: DocumentUpsertedEvent) => {
    if (!ev.contentChanged || !opts.isEnabled()) return;
    const docId = ev.after.id;
    if (!hasLivePersonAnnotationsForEvidenceDoc(opts.db, docId)) return;
    void opts
      .invalidate(docId, opts.clock())
      .then((r) => {
        if (r.invalidated > 0 || r.flaggedUnverified > 0) {
          opts.log.info(
            `${docId} content change: ${r.invalidated} person annotation(s) invalidated, ${r.flaggedUnverified} kept unverified` +
              (r.promoted > 0 ? ` (${r.promoted} mirror(s) promoted)` : ""),
          );
        }
      })
      .catch((err: unknown) =>
        opts.log.warn(
          `person annotation invalidation failed for ${docId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  });
}
