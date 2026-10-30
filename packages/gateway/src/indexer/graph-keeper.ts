// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeps the indexer's writable HNSW graph durable and inside the memory
 * budget. Runs in the indexer worker, which owns the graph.
 *
 * Durable: every save stamps what the file holds — its vector change log
 * position and, during a cold rebuild, its backfill cursor — and the stamps
 * travel with the graph (in `index_meta` for the plaintext file, in the header
 * of the encrypted sidecar). A start loads the newest persisted graph and
 * catches it up from the log, or resumes its rebuild, so a crash or kill costs
 * the changes since the last checkpoint, never the whole graph. Under storage
 * encryption the plaintext file does not outlive the process, so the keeper
 * also writes the encrypted sidecar: at each rebuild checkpoint, when the
 * graph is opened, and at most every 15 minutes after that.
 *
 * Within budget: the graph is the one consumer that grows with the whole
 * corpus. It is admitted at start only if it fits in the remaining budget with
 * room to spare, and shed — saved, then released — when headroom runs short.
 * Either way search answers from the keyword lane alone and reports semantic
 * search degraded, instead of the kernel killing the gateway.
 */

import { existsSync } from "node:fs";

import {
  describeMemoryBudget,
  estimateHnswGraphBytes,
  formatMemory,
  graphAdmissionReserve,
  graphShedFloor,
  memoryHeadroom,
  type MemoryBudget,
} from "../memory-budget.js";
import {
  getIndexEmbedModel,
  getUsearchBackfillCursor,
  getUsearchSavedChangeSeq,
  getUsearchSavedSeq,
  getVectorChangeHead,
  getVectorChangesPrunedThrough,
  getVectorWriteSeq,
  hasPendingVectorDeletes,
  pruneVectorChanges,
  setUsearchBackfillCursor,
  setUsearchSavedChangeSeq,
  setUsearchSavedSeq,
} from "./db.js";
import { encryptSidecar, readSidecarFingerprint } from "./usearch-sidecar-crypto.js";
import type { GraphBuildOutcome, UsearchWriteHandle } from "./usearch-index.js";
import type { SemanticSearchStatus } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

/** Least time between encrypted checkpoints outside a rebuild. */
const PERSIST_INTERVAL_MS = 15 * 60_000;

/**
 * Whether a graph of `vectors` vectors fits: its estimated size plus the
 * reserve for the rest of the gateway must be within the current headroom.
 */
export function planGraphAdmission(opts: {
  vectors: number;
  dim: number;
  budget: MemoryBudget;
  headroom: number;
  /** Whether the graph comes from a complete file rather than a (resumed) build. */
  loading: boolean;
}): { admitted: true } | { admitted: false; reason: string } {
  const estimate = estimateHnswGraphBytes(opts.vectors, opts.dim, opts.loading ? "load" : "build");
  const reserve = graphAdmissionReserve(opts.budget);
  if (estimate + reserve <= opts.headroom) return { admitted: true };
  const free =
    opts.headroom > 0
      ? `${formatMemory(opts.headroom)} of the ${describeMemoryBudget(opts.budget)} memory budget is free`
      : `the gateway already uses all of its ${describeMemoryBudget(opts.budget)} memory budget`;
  return {
    admitted: false,
    reason:
      `the HNSW graph needs about ${formatMemory(estimate)} and ${free}, short of that plus the ` +
      `${formatMemory(reserve)} kept for the rest of the gateway`,
  };
}

export interface GraphKeeperDeps {
  indexDb: Database.Database;
  handle: UsearchWriteHandle;
  graphPath: string;
  /** Whether a graph file was on disk when the handle loaded it. */
  graphFileExisted: boolean;
  /** The index-db key on an encrypted install, else null (the plaintext file is durable). */
  indexDbKey: Buffer | null;
  /** Null disables the memory guard. */
  budget: MemoryBudget | null;
  pageSize?: number;
  checkpointIntervalMs?: number;
  /** Replaceable for tests. */
  headroom?: () => number;
  onProgress: (fraction: number) => void;
  onState: (state: SemanticSearchStatus) => void;
  log: (level: "info" | "warn", message: string) => void;
}

export class GraphKeeper {
  /**
   * Whether a save may stamp the file as reflecting the log's head. False
   * while a loaded graph is still behind its own stamps (before its catch-up),
   * when a save would claim changes the graph does not have yet.
   */
  private certified = false;
  private persisted: { changeSeq: number; cursor: number | null } | null = null;
  private persistedAt = 0;
  private guard: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: GraphKeeperDeps) {
    if (deps.indexDbKey) {
      const header = readSidecarFingerprint(`${deps.graphPath}.enc`);
      if (header?.changeSeq !== undefined) {
        this.persisted = { changeSeq: header.changeSeq, cursor: header.backfillCursor ?? null };
      }
    }
    deps.handle.setOnSaved(() => this.onSaved());
  }

  /**
   * Bring the graph level with `index.db`: catch a persisted graph up from the
   * change log and resume its rebuild if one was cut short, keep a graph that
   * already matches, or rebuild. Sheds the graph if memory runs short on the way.
   */
  async open(): Promise<void> {
    const { indexDb, handle } = this.deps;
    if (handle.isDetached) return;
    const savedChange = getUsearchSavedChangeSeq(indexDb);
    const cursor = getUsearchBackfillCursor(indexDb);
    const shouldStop = () => this.memoryShort();
    let outcome: GraphBuildOutcome;
    if (
      this.deps.graphFileExisted &&
      savedChange !== null &&
      savedChange >= getVectorChangesPrunedThrough(indexDb)
    ) {
      const caughtUp = await handle.catchUpFromChangeLog(indexDb, savedChange, {
        upToRowid: cursor,
        shouldStop,
      });
      if (caughtUp === "stopped") {
        this.shed(this.shortReason("while catching the graph up"));
        return;
      }
      this.certified = true;
      outcome = await handle.backfillFromDbCooperatively(
        indexDb,
        this.buildOptions(cursor === null ? {} : { resumeAfterRowid: cursor }),
      );
    } else {
      // A graph stamped before the change log existed is trusted only on the
      // exact write-seq match; anything else rebuilds.
      const consistent =
        this.deps.graphFileExisted &&
        savedChange === null &&
        getUsearchSavedSeq(indexDb) === getVectorWriteSeq(indexDb);
      this.certified = consistent;
      outcome = await handle.backfillFromDbCooperatively(
        indexDb,
        this.buildOptions({ forceRebuild: !consistent }),
      );
    }
    if (outcome === "stopped") {
      this.shed(this.shortReason("while building the graph"));
      return;
    }
    this.certified = true;
    handle.save();
    this.stamp();
    this.persist(true);
    this.deps.onState({ state: "ready" });
  }

  /** Check headroom every `intervalMs` and shed the graph when it runs short. */
  startGuard(intervalMs: number): void {
    if (!this.deps.budget || this.guard) return;
    this.guard = setInterval(() => this.shedIfShort(), intervalMs);
    this.guard.unref?.();
  }

  stop(): void {
    if (this.guard) clearInterval(this.guard);
    this.guard = null;
  }

  shedIfShort(): void {
    if (this.deps.handle.isDetached || !this.memoryShort()) return;
    this.shed(this.shortReason("while serving"));
  }

  private buildOptions(extra: {
    resumeAfterRowid?: number;
    forceRebuild?: boolean;
  }): Parameters<UsearchWriteHandle["backfillFromDbCooperatively"]>[1] {
    return {
      ...extra,
      pageSize: this.deps.pageSize,
      checkpointIntervalMs: this.deps.checkpointIntervalMs,
      onProgress: this.deps.onProgress,
      shouldStop: () => this.memoryShort(),
      onRebuildStart: () => {
        // A rebuild reads every chunk after this point, so the empty graph
        // already reflects every change logged so far.
        this.certified = true;
        setUsearchSavedChangeSeq(this.deps.indexDb, getVectorChangeHead(this.deps.indexDb));
      },
      onCheckpoint: () => this.persist(true),
    };
  }

  private onSaved(): void {
    if (!this.certified) return;
    this.stamp();
    this.persist(false);
  }

  /**
   * Record what the file just saved holds. The log position is read before
   * the pending-delete check: a main-thread removal logged at or below it
   * that the worker has not applied yet keeps its `pending_vector_deletes`
   * row until a save after it, so while any row is pending the position stays
   * where it was — the graph's last fully applied one.
   */
  private stamp(): void {
    const { indexDb, handle } = this.deps;
    const head = getVectorChangeHead(indexDb);
    setUsearchSavedSeq(indexDb, getVectorWriteSeq(indexDb));
    if (!hasPendingVectorDeletes(indexDb)) setUsearchSavedChangeSeq(indexDb, head);
    setUsearchBackfillCursor(indexDb, handle.backfillCursor);
  }

  /**
   * Make the saved graph the one a restart loads, and drop the change log
   * below it. A plaintext install's file already is; an encrypted install
   * writes its sidecar, at most every 15 minutes unless forced.
   */
  private persist(force: boolean): void {
    const { indexDb, indexDbKey, graphPath } = this.deps;
    const changeSeq = getUsearchSavedChangeSeq(indexDb);
    if (changeSeq === null) return;
    if (!indexDbKey) {
      pruneVectorChanges(indexDb, changeSeq);
      return;
    }
    const cursor = getUsearchBackfillCursor(indexDb);
    if (this.persisted?.changeSeq === changeSeq && this.persisted.cursor === cursor) return;
    if (!force && Date.now() - this.persistedAt < PERSIST_INTERVAL_MS) return;
    const model = getIndexEmbedModel(indexDb);
    if (!model || !existsSync(graphPath)) return;
    try {
      encryptSidecar(graphPath, `${graphPath}.enc`, indexDbKey, {
        vectorWriteSeq: getUsearchSavedSeq(indexDb),
        embedModel: model.name,
        embedDim: model.dim,
        changeSeq,
        backfillCursor: cursor,
      });
    } catch (err) {
      this.deps.log(
        "warn",
        `encrypted HNSW checkpoint failed (the previous one stays): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.persisted = { changeSeq, cursor };
    this.persistedAt = Date.now();
    pruneVectorChanges(indexDb, changeSeq);
  }

  private headroom(): number {
    if (this.deps.headroom) return this.deps.headroom();
    return this.deps.budget ? memoryHeadroom(this.deps.budget) : Number.POSITIVE_INFINITY;
  }

  private memoryShort(): boolean {
    return this.deps.budget !== null && this.headroom() < graphShedFloor(this.deps.budget);
  }

  private shortReason(when: string): string {
    const budget = this.deps.budget!;
    return `memory ran short ${when}: ${formatMemory(Math.max(0, this.headroom()))} left of the ${describeMemoryBudget(budget)} budget`;
  }

  /**
   * Save what the graph has, make it durable, and release it. Search falls
   * back to the keyword lane until a restart finds the memory to load it; the
   * changes made meanwhile wait in the change log.
   */
  private shed(why: string): void {
    const { handle } = this.deps;
    if (handle.isDetached) return;
    this.stop();
    if (this.certified) {
      try {
        handle.save();
        this.persist(true);
      } catch (err) {
        this.deps.log(
          "warn",
          `HNSW save before release failed (the last checkpoint stays): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    handle.release();
    const reason = `${why}; the HNSW graph was released from memory`;
    this.deps.log("warn", `semantic search degraded, keyword search only: ${reason}`);
    this.deps.onState({ state: "degraded", reason });
  }
}
