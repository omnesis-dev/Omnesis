// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Carries temporal annotation links across projection ids the analytics store
 * changed.
 *
 * An annotation in the main store names the projections it is grounded in by
 * id. A table rekey, a legacy claim or a partitioned adoption changes those ids
 * in DuckDB, and the main store is written by the SQLite writer, so the two
 * cannot commit together. DuckDB records each change in its move ledger in the
 * transaction that makes it; this drains the ledger one generation at a time,
 * oldest first: the links follow on the writer, then the generation is
 * forgotten. A crash between the two commits leaves the generation in the
 * ledger, and replaying it is harmless — a link already moved is not found
 * under its old id again — so the next drain, at boot or after the next move,
 * finishes the job.
 */

import type { Logger } from "@omnesis/core";
import type { TemporalProjectionMove } from "./temporal-projection-store.js";

/** Moves per writer call, so a large rekey never holds the writer for long. */
const RELINK_BATCH = 2_000;

export interface TemporalProjectionMoveLedger {
  nextTemporalProjectionMoves(): Promise<{
    generation: number;
    moves: TemporalProjectionMove[];
  } | null>;
  settleTemporalProjectionMoves(generation: number): Promise<void>;
}

export interface TemporalProjectionRelinker {
  /** Drain the move ledger; concurrent calls share one drain. Resolves to the links moved. */
  drain(): Promise<number>;
}

export function createTemporalProjectionRelinker(opts: {
  ledger: TemporalProjectionMoveLedger;
  relink: (moves: readonly TemporalProjectionMove[]) => Promise<number>;
  log: Logger;
}): TemporalProjectionRelinker {
  let running: Promise<number> | null = null;
  let again = false;

  async function drainOnce(): Promise<number> {
    let relinked = 0;
    let moved = 0;
    for (;;) {
      const next = await opts.ledger.nextTemporalProjectionMoves();
      if (!next) break;
      for (let offset = 0; offset < next.moves.length; offset += RELINK_BATCH)
        relinked += await opts.relink(next.moves.slice(offset, offset + RELINK_BATCH));
      await opts.ledger.settleTemporalProjectionMoves(next.generation);
      moved += next.moves.length;
    }
    if (moved > 0)
      opts.log.info(
        `Temporal annotations followed ${moved} projection id change(s): ${relinked} link(s) moved`,
      );
    return relinked;
  }

  return {
    drain(): Promise<number> {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        let relinked = 0;
        try {
          do {
            again = false;
            relinked += await drainOnce();
          } while (again);
          return relinked;
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
