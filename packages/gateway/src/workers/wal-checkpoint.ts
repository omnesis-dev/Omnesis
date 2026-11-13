// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer's WAL checkpoints, run on the writer's own connection between
 * ops — never on a second writable handle (see `writer-worker.ts`).
 *
 * A checkpoint copies every page written since the last one back into
 * `omnesis.db`, so its cost grows with the frames waiting. One a minute left a
 * minute of writes per checkpoint: seconds of writer hold on a large encrypted
 * install. Checkpointing whenever `pendingFrames` frames wait keeps each copy
 * small in steady state, and an idle tick picks up the rest.
 *
 * SQLite offers no limit on how many frames one checkpoint copies, so two
 * cases stay one uncapped copy: a backlog the WAL already holds (the gateway
 * drains it at boot, before the writer starts), and the catch-up after a long
 * reader. A reader holding an old snapshot pins every frame written after it,
 * and the first checkpoint after it finishes copies all of them at once.
 *
 * A checkpoint does not shrink the WAL: the next writer only rewinds it once
 * every frame is copied and no reader still reads from it
 * (https://sqlite.org/wal.html#ckpt). With readers always running, that
 * instant never comes and the WAL grows without bound. Once it passes
 * `restartFrames` the writer makes the instant: it finishes the copy, then
 * runs a RESTART that waits at most `restartWaitMs` for the reads in flight.
 * A reader that starts after the copy is complete reads the database file,
 * not the WAL, so only reads already running can hold the rewind off; a
 * longer one makes the attempt give up, and the next waits a backoff that
 * doubles while readers keep it off, so a scan of a minute costs the writer a
 * few percent of its time, and a rewind follows soon after the scan ends.
 * A checkpoint that throws (an I/O error, a full disk) backs off the same way
 * instead of retrying after every op.
 *
 * A WAL that starts over keeps the file at its largest size, which after a
 * long reader can be hundreds of MiB. It starts over after a rewind, and also
 * by itself, at the first commit after a copy that caught up while no reader
 * was on the WAL. SQLite's `journal_size_limit` cuts the file back in that
 * commit, as one `ftruncate` that frees every block past the limit: hundreds
 * of milliseconds for a few hundred MiB, charged to whichever write comes
 * next, a user's included. So the writer's connection sets no limit, and the
 * checkpointer, which sees the WAL start over as fewer frames than at its
 * previous probe, cuts the file itself between ops, at most `cutSliceBytes`
 * per step, until it is back to `sizeLimitBytes`. A cut
 * never reaches the frames the WAL holds: only frames up to its last one are
 * ever read, which is the same bound SQLite's own cut keeps, and between ops
 * no commit is appending one.
 *
 * Every checkpoint mode used here copies frames and rewrites the wal-index
 * header in place. None truncates or resizes `-shm`, and none is TRUNCATE.
 */

import { statSync, truncateSync } from "node:fs";
import type Database from "better-sqlite3";
type Db = Database.Database;

export interface WalCheckpointPolicy {
  /** Uncopied frames that start a checkpoint between ops. */
  pendingFrames: number;
  /** WAL length, in frames, past which the writer rewinds it. */
  restartFrames: number;
  /** Longest one rewind attempt waits for readers, ms. */
  restartWaitMs: number;
  /**
   * The wait before retrying a rewind readers held off, or any checkpoint
   * that threw, ms: doubled on each further failure up to
   * `restartRetryMaxMs`, reset by a success.
   */
  restartRetryMinMs: number;
  restartRetryMaxMs: number;
  /** The connection's `busy_timeout` outside a rewind, ms. */
  busyTimeoutMs: number;
  /** WAL file size a WAL that started over is cut back to, bytes. */
  sizeLimitBytes: number;
  /** The most one step cuts from the end of the WAL file, bytes. */
  cutSliceBytes: number;
}

/** Bytes the WAL file is cut back to once the WAL starts over. */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * About 8 MiB of 4 KiB pages per checkpoint, tens of milliseconds encrypted;
 * a rewind once the WAL holds about 64 MiB, the size it is then cut back to,
 * 16 MiB per step.
 */
export const DEFAULT_WAL_CHECKPOINT_POLICY: WalCheckpointPolicy = {
  pendingFrames: 2_000,
  restartFrames: 16_384,
  restartWaitMs: 100,
  restartRetryMinMs: 250,
  restartRetryMaxMs: 5_000,
  busyTimeoutMs: 5_000,
  sizeLimitBytes: WAL_SIZE_LIMIT_BYTES,
  cutSliceBytes: 16 * 1024 * 1024,
};

export interface WalCheckpointRun {
  /** The checkpoint mode run, or `CUT` for a step that shortened the file. */
  mode: "PASSIVE" | "RESTART" | "CUT";
  /**
   * `copied`: frames were copied and the WAL was not rewound, including a
   * rewind whose own copy spent its whole wait. `rewound`: the next commit
   * starts the WAL over. `deferred`: readers kept the rewind off. `cut`: the
   * file was shortened by `cutBytes`.
   */
  outcome: "copied" | "rewound" | "deferred" | "cut";
  /** Frames in the WAL when the run ended; 0 once rewound. */
  log: number;
  /** Frames copied into the database when the run ended; 0 once rewound. */
  checkpointed: number;
  /** Frames a rewind let go of. */
  rewoundFrames?: number;
  /** Bytes a cut removed from the end of the WAL file. */
  cutBytes?: number;
  ms: number;
}

interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

const RESTART_POLL_MS = 2;
/** The WAL file's header, before its first frame. */
const WAL_HEADER_BYTES = 32;
/** Each frame's header, before its page. */
const WAL_FRAME_HEADER_BYTES = 24;

export class WalCheckpointer {
  private readonly probe: Database.Statement<[], CheckpointRow>;
  private readonly passive: Database.Statement<[], CheckpointRow>;
  private readonly restart: Database.Statement<[], CheckpointRow>;
  private readonly sleepCell = new Int32Array(new SharedArrayBuffer(4));
  private readonly walPath: string;
  private readonly frameBytes: number;
  /**
   * Set until the file is back to its size limit: from the start, since a WAL
   * may start long, and again whenever the WAL starts over.
   */
  private cutPending = true;
  /** Frames the WAL held at the previous probe. */
  private lastLog = 0;
  private nextRestartMs = Number.NEGATIVE_INFINITY;
  private restartRetryMs = 0;
  private nextAttemptMs = Number.NEGATIVE_INFINITY;
  private failureRetryMs = 0;

  constructor(
    private readonly db: Db,
    private readonly policy: WalCheckpointPolicy = DEFAULT_WAL_CHECKPOINT_POLICY,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.probe = db.prepare("PRAGMA wal_checkpoint(NOOP)");
    this.passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
    this.restart = db.prepare("PRAGMA wal_checkpoint(RESTART)");
    this.walPath = `${db.name}-wal`;
    this.frameBytes = (db.pragma("page_size", { simple: true }) as number) + WAL_FRAME_HEADER_BYTES;
  }

  /**
   * Between ops, one of: rewind once the WAL is long, copy once `minPending`
   * frames wait (the policy's `pendingFrames` by default), or else cut the
   * file of a WAL that started over back toward its size limit. Returns what ran, or null
   * when nothing did. A database not in WAL mode reports no frames and has no
   * WAL file, so nothing runs. After a throw, calls return null until the
   * backoff has passed.
   */
  maintain(minPending = this.policy.pendingFrames): WalCheckpointRun | null {
    const startedMs = this.now();
    if (startedMs < this.nextAttemptMs) return null;
    try {
      const run = this.runOnce(minPending, startedMs);
      this.failureRetryMs = 0;
      return run;
    } catch (err) {
      this.failureRetryMs = this.backoff(this.failureRetryMs);
      this.nextAttemptMs = this.now() + this.failureRetryMs;
      throw err;
    }
  }

  private runOnce(minPending: number, startedMs: number): WalCheckpointRun | null {
    const state = this.probe.get()!;
    // Fewer frames than last time means the WAL started over. A rewind is not
    // the only way: once a copy has caught up and no reader is on the WAL, the
    // next commit starts it over by itself, at whatever size the file has.
    if (state.log < this.lastLog) this.cutPending = true;
    this.lastLog = state.log;
    if (state.log >= this.policy.restartFrames && startedMs >= this.nextRestartMs) {
      let run: WalCheckpointRun | undefined;
      try {
        run = this.rewind(startedMs);
        return run;
      } finally {
        if (run?.outcome !== "copied") {
          this.restartRetryMs = run?.outcome === "rewound" ? 0 : this.backoff(this.restartRetryMs);
          this.nextRestartMs = this.now() + this.restartRetryMs;
        }
      }
    }
    if (state.log > 0 && state.log - state.checkpointed >= Math.max(1, minPending)) {
      const row = this.passive.get()!;
      return this.result("PASSIVE", "copied", row, startedMs);
    }
    return this.cutPending ? this.cut(state, startedMs) : null;
  }

  /**
   * Shorten the WAL file by at most `cutSliceBytes`, never below the size
   * limit or the end of the last frame the WAL holds. Until the commit after
   * a rewind starts the WAL over, that last frame is still the old one, so
   * nothing is cut.
   */
  private cut(state: CheckpointRow, startedMs: number): WalCheckpointRun | null {
    let size: number;
    try {
      size = statSync(this.walPath).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      size = 0;
    }
    if (size <= this.policy.sizeLimitBytes) {
      this.cutPending = false;
      return null;
    }
    const floor = Math.max(
      this.policy.sizeLimitBytes,
      WAL_HEADER_BYTES + Math.max(0, state.log) * this.frameBytes,
    );
    if (size <= floor) return null;
    const target = Math.max(floor, size - this.policy.cutSliceBytes);
    truncateSync(this.walPath, target);
    return {
      ...this.result("CUT", "cut", state, startedMs),
      cutBytes: size - target,
    };
  }

  private backoff(previousMs: number): number {
    return Math.min(
      this.policy.restartRetryMaxMs,
      Math.max(this.policy.restartRetryMinMs, previousMs * 2),
    );
  }

  /**
   * Copy every frame, then wait for the reads still on the WAL. Readers
   * holding a snapshot older than the last commit pin frames a copy may not
   * overwrite; each returns to the latest snapshot at its next statement, so
   * the copy is retried until it is complete or the wait is spent. A copy
   * that completes with no wait left is not a deferral: the next call tries
   * again with the copy already done.
   */
  private rewind(startedMs: number): WalCheckpointRun {
    const deadline = startedMs + this.policy.restartWaitMs;
    let row = this.passive.get()!;
    while (row.checkpointed < row.log && this.now() < deadline) {
      Atomics.wait(this.sleepCell, 0, 0, RESTART_POLL_MS);
      row = this.passive.get()!;
    }
    if (row.checkpointed < row.log) return this.result("RESTART", "deferred", row, startedMs);
    const remainingMs = Math.floor(deadline - this.now());
    if (remainingMs <= 0) return this.result("RESTART", "copied", row, startedMs);
    this.db.pragma(`busy_timeout = ${remainingMs}`);
    try {
      row = this.restart.get()!;
    } finally {
      this.db.pragma(`busy_timeout = ${this.policy.busyTimeoutMs}`);
    }
    if (row.busy !== 0) return this.result("RESTART", "deferred", row, startedMs);
    return {
      ...this.result("RESTART", "rewound", { busy: 0, log: 0, checkpointed: 0 }, startedMs),
      rewoundFrames: row.log,
    };
  }

  private result(
    mode: WalCheckpointRun["mode"],
    outcome: WalCheckpointRun["outcome"],
    row: CheckpointRow,
    startedMs: number,
  ): WalCheckpointRun {
    return {
      mode,
      outcome,
      log: row.log,
      checkpointed: row.checkpointed,
      ms: this.now() - startedMs,
    };
  }
}
