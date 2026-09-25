// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeps the searchable open-loop document mirror in sync with the
 * authoritative `open_loops` tables (tables-as-truth): every loop
 * mutation regenerates the loop's corpus projection, and a loop delete
 * removes it (plus its search-index chunks — index.db is a separate
 * file, so the cascade is explicit, the omnesis-chat pattern).
 *
 * Mirror writes go through `writeGate.upsertDocuments`, which does NOT
 * emit `document.upserted` — so refreshing a mirror can never wake the
 * Cognition Steward (belt-and-braces with the waker's self-trigger guard).
 */

import { buildOpenLoopDocumentInput } from "../open-loop-source/document-projection.js";
import { OPEN_LOOP_PROVIDER_ID, OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";

type Db = Database.Database;

export interface OpenLoopMirrorDeps {
  /** Read-side handle (projection reads the fresh loop + ledger). */
  db: Db;
  writeGate: Pick<WriteGate, "upsertDocuments" | "deleteDocuments">;
  /**
   * index.db chunk cascade for deleted mirrors. Optional — without it a
   * deleted loop's chunks linger in the index until the next rebuild
   * (they can still surface as stale `open_loop_search` snippets).
   */
  deleteIndexChunks?: (docIds: string[]) => Promise<unknown>;
  log: Logger;
}

/** The mirror surface the tool layer drives. */
export interface OpenLoopMirror {
  /** Re-project one loop into its corpus document (no-op body when unchanged). */
  refresh(loopId: string): Promise<void>;
  /** Remove the mirror documents of deleted loops (+ index chunks). */
  remove(loopIds: readonly string[]): Promise<void>;
}

export function createOpenLoopMirror(deps: OpenLoopMirrorDeps): OpenLoopMirror {
  return {
    async refresh(loopId: string): Promise<void> {
      const loop = getOpenLoop(deps.db, loopId);
      if (!loop) {
        // The loop vanished between the mutation and the re-projection
        // (a concurrent delete); converge on "gone".
        await this.remove([loopId]);
        return;
      }
      const ledger = listOpenLoopLedger(deps.db, loopId);
      await deps.writeGate.upsertDocuments([buildOpenLoopDocumentInput(loop, ledger)]);
    },

    async remove(loopIds: readonly string[]): Promise<void> {
      if (loopIds.length === 0) return;
      const deletedDocIds = await deps.writeGate.deleteDocuments(
        OPEN_LOOP_PROVIDER_ID,
        OPEN_LOOP_SOURCE_ID,
        [...loopIds],
      );
      if (deletedDocIds.length === 0 || !deps.deleteIndexChunks) return;
      try {
        await deps.deleteIndexChunks(deletedDocIds);
      } catch (err) {
        deps.log.warn(
          `open-loop mirror index cascade failed for ${loopIds.join(", ")}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
