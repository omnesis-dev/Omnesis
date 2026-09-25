// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deleting a run's transcript file when its row was deleted by a migration.
 *
 * A migration can only reach SQL. A transcript is a file on the gateway's
 * filesystem, under a directory a migration is not given and could not resolve
 * — so a step that retires a class of runs deletes the rows and leaves the
 * artifacts behind, orphaned and invisible except through the transcript
 * routes that still serve them by run id.
 *
 * This is the other half. The migration records the run ids it destroyed
 * under {@link TRANSCRIPT_EVICTION_KEY}; the gateway drains that list once at
 * start, when the transcripts directory is finally in scope, and clears it.
 * The handoff is durable because the two halves cannot share a transaction: a
 * crash between them leaves the list in place and the next start finishes the
 * job.
 */

import { createLogger, type Logger } from "@omnesis/core";
import { getCognitionEngineState, setCognitionEngineState } from "./storage/engine-state.js";
import type { Db } from "../data/types.js";

const log: Logger = createLogger("gateway").child("brain:transcripts");

/**
 * Where a migration leaves the run ids whose transcripts must go.
 *
 * A JSON array of run ids in `cognition_engine_state`. Deliberately a queue
 * rather than a flag: the drain has to know *which* files to delete, and after
 * the rows are gone there is nothing left in SQL to derive that from.
 */
export const TRANSCRIPT_EVICTION_KEY = "transcript_evictions";

/** The transcript-store verb the drain needs. */
export interface EvictableTranscriptStore {
  evictRuns(runIds: readonly string[]): Promise<number>;
}

/**
 * The one write-gate verb the drain needs.
 *
 * The drain runs on the main thread, whose handle on the main database is
 * **read-only**: since the single-writer invariant, one worker owns the only
 * writable connection and every write reaches it through the gate. The
 * migration that queues the ids runs before that handle exists and writes
 * directly; the drain cannot, and a direct write here fails with
 * `attempt to write a readonly database` — after the files are already gone,
 * so the queue survives and every subsequent start retries a job with nothing
 * left to do.
 */
export interface TranscriptEvictionSink {
  setCognitionEngineState(key: string, value: string): Promise<void>;
}

/**
 * Queue a set of run ids for transcript eviction. Called from a migration,
 * inside its transaction, right before (or after) the rows themselves go.
 *
 * Appends rather than replaces, so two migrations in one upgrade both get
 * their files deleted.
 */
export function queueTranscriptEviction(db: Db, runIds: readonly string[]): void {
  if (runIds.length === 0) return;
  const existing = readQueue(db);
  const merged = [...new Set([...existing, ...runIds])];
  setCognitionEngineState(db, TRANSCRIPT_EVICTION_KEY, JSON.stringify(merged));
}

/**
 * Delete the queued transcripts and clear the queue.
 *
 * Never throws: a failed eviction leaves debug artifacts on disk, which must
 * not stop a gateway from starting. The queue is cleared only after the
 * deletion returned, so a crash mid-eviction retries the whole list — the
 * store's own eviction is idempotent, so a second pass over files already gone
 * is a no-op.
 */
export async function drainTranscriptEvictions(
  db: Db,
  transcripts: EvictableTranscriptStore,
  writeGate: TranscriptEvictionSink,
): Promise<number> {
  const queued = readQueue(db);
  if (queued.length === 0) return 0;
  try {
    const deleted = await transcripts.evictRuns(queued);
    await writeGate.setCognitionEngineState(TRANSCRIPT_EVICTION_KEY, "[]");
    log.info(
      `deleted ${deleted} transcript file(s) for ${queued.length} retired run(s) — their rows were dropped by a migration`,
    );
    return deleted;
  } catch (err) {
    log.warn(
      `could not delete the transcripts of ${queued.length} retired run(s); will retry at the next start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}

function readQueue(db: Db): string[] {
  const raw = getCognitionEngineState(db, TRANSCRIPT_EVICTION_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // A value this build cannot read is not worth failing a start over; the
    // cost is transcript files that outlive their rows.
    log.warn(`the transcript eviction queue is unreadable and was skipped`);
    return [];
  }
}
