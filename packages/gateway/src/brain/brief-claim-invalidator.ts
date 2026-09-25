// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brief-claim invalidation subscriber — the content-change half of keeping
 * a brief's asserted claims honest. A claim is a user-facing assertion
 * resting on a verbatim evidence quote; when the cited document's content
 * changes, the write op re-checks every live claim grounded in it against
 * the new content and soft-invalidates the ones whose quote no longer
 * appears (kept for audit; see
 * `storage/brief-claims.ts#invalidateBriefClaimsForDoc`). The
 * deletion-driven HARD purge rides the DocumentService privacy-delete seam
 * (`cascadeBriefClaimPrivacyDelete`), not the bus.
 *
 * Hot-path discipline mirrors the annotation invalidator: a cheap indexed
 * READ guard on the read handle, then the (single-writer) write op fired
 * WITHOUT awaiting — invalidation is idempotent and order-insensitive, so
 * it must never block or fail document ingest.
 */

import { hasLiveBriefClaimsForDoc } from "./storage/brief-claims.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { EventBus, DocumentUpsertedEvent } from "../events.js";

type Db = Database.Database;
type Clock = () => number;

export interface BriefClaimInvalidatorOpts {
  /** Read handle for the cheap has-claims guard. */
  db: Db;
  eventBus: Pick<EventBus, "on">;
  /** Single-writer op; fired fire-and-forget off the hot path. */
  invalidate: (docId: string, now: number) => Promise<number>;
  /** Live gate — inert unless the Briefs feature is active. */
  isEnabled: () => boolean;
  clock: Clock;
  log: Logger;
}

/** Wire content-change → brief-claim invalidation. Returns the unsubscribe. */
export function subscribeBriefClaimInvalidator(opts: BriefClaimInvalidatorOpts): () => void {
  return opts.eventBus.on("document.upserted", (ev: DocumentUpsertedEvent) => {
    if (!ev.contentChanged || !opts.isEnabled()) return;
    const docId = ev.after.id;
    // Cheap indexed guard so a high-throughput ingest never floods the writer
    // with no-op invalidations for documents no claim cites.
    if (!hasLiveBriefClaimsForDoc(opts.db, docId)) return;
    void opts
      .invalidate(docId, opts.clock())
      .then((n) => {
        if (n > 0) {
          opts.log.info(`invalidated ${n} brief claim(s) after ${docId} content change`);
        }
      })
      .catch((err: unknown) =>
        opts.log.warn(
          `brief-claim invalidation failed for ${docId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  });
}
