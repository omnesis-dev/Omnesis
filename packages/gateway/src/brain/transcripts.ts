// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-run Cognition Steward transcripts — operator debug artifacts, one JSON
 * file per run attempt on the gateway's filesystem (like logs, and like
 * the conversation store's JSON-file convention).
 *
 * Deliberate non-properties, per the feature contract:
 *   - transcripts are NEVER indexed as documents (nothing here touches
 *     the corpus or the indexer);
 *   - future runs never read them (the open-loop ledger carries the
 *     durable history of reasoning);
 *   - they are exempt from the privacy-delete cascade (debug artifacts,
 *     like logs) — the retention prune is their only deletion path.
 *
 * Retention: the gateway-wide activity-retention task prunes files once
 * their run finished outside the configured window. The legacy
 * `brain.transcriptRetention` setting can override that window for these
 * files. The finished-at instant is encoded in the filename
 * (`<finishedAt>-<runId>-a<attempt>.json`) so pruning needs no JSON parsing
 * and no reliance on fs mtimes — which also keeps it honest under a
 * compressed test clock.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dir,
} from "node:fs";
import { opendir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import type { AgentContextAssessment } from "@omnesis/core";
import type { CognitionRunKind, CognitionRunUsage } from "./storage/types.js";

/**
 * Canonical transcripts directory under a gateway config dir — the single
 * place the path shape is decided (the composition root wires it into the
 * run driver; the operator admin routes read from the same place).
 */
export function cognitionTranscriptsDir(configDir: string): string {
  return join(configDir, "briefs", "transcripts");
}

/** One persisted run-attempt transcript. */
export interface CognitionRunTranscript {
  runId: string;
  /** 1-based attempt number (a re-claimed run writes a separate file). */
  attempt: number;
  kind: CognitionRunKind;
  /**
   * The queue payload the run executed (per-kind shape; see
   * run-payloads.ts). The queue row's payload is cleared when the run
   * settles, so this copy is what the operator decision view keys on —
   * e.g. resolving which datum a `data` run processed. Absent on
   * transcripts written before the field existed.
   */
  payload?: unknown;
  startedAt: number;
  finishedAt: number;
  /** The exact prompt the run was sent. */
  prompt: string;
  /** The full agent event stream, in order (type + payload, verbatim). */
  events: Array<{ type: string; payload: unknown }>;
  /** The assistant's final text, if any. */
  finalText: string;
  outcome: "completed" | "failed";
  errorMessage?: string;
  /** Stable terminal failure code when the model turn supplied one. */
  failureCode?: string;
  /** Context-window assessment captured from the terminal model event. */
  context?: AgentContextAssessment;
  usage: CognitionRunUsage | null;
}

/** A stored transcript file, decoded from its filename. */
export interface CognitionTranscriptRef {
  fileName: string;
  runId: string;
  attempt: number;
  finishedAt: number;
}

/** Stable key for walking transcript refs newest-first. */
export interface CognitionTranscriptCursor {
  finishedAt: number;
  fileName: string;
}

// Middle group = exactly the charset `sanitizeRunId` can produce — in
// particular no path separators, so a name that matches can never
// resolve outside the transcripts directory.
const FILE_PATTERN = /^(\d+)-([A-Za-z0-9._:-]+)-a(\d+)\.json$/;

interface IndexScanState {
  directory: Dir | null;
}

// Every transcript consumer can hold its own store façade. Legacy discovery
// and retention are nevertheless one process-wide operation per archive:
// serializing them prevents a delayed discovery flush from resurrecting a ref
// another façade just unlinked. The scan's open directory handle survives
// between bounded calls; inserted refs are durable, so a restart safely
// restarts the unfinished enumeration with idempotent upserts.
const INDEX_OPERATION_TAILS = new Map<string, Promise<void>>();
const INDEX_SCAN_STATES = new Map<string, IndexScanState>();

function parseRef(fileName: string): CognitionTranscriptRef | null {
  const match = FILE_PATTERN.exec(fileName);
  if (!match) return null;
  return {
    fileName,
    finishedAt: Number(match[1]),
    runId: match[2]!,
    attempt: Number(match[3]),
  };
}

/** Filesystem-safe projection of a run id (run ids are caller-chosen). */
function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._:-]/g, "_");
}

export class FsCognitionTranscriptStore {
  private pruneDir: Dir | null = null;
  private backgroundIndexBuild: Promise<void> | null = null;

  constructor(private readonly dir: string) {
    this.reconcilePendingRefs();
  }

  /** Persist one attempt's transcript (creates the directory on demand). */
  save(transcript: CognitionRunTranscript): void {
    mkdirSync(this.dir, { recursive: true });
    const name = `${transcript.finishedAt}-${sanitizeRunId(transcript.runId)}-a${transcript.attempt}.json`;
    const ref = parseRef(name);
    if (ref) this.upsertIndexedRef(ref, "pending_save");
    const pendingPath = join(this.dir, `${name}.pending`);
    try {
      writeFileSync(pendingPath, JSON.stringify(transcript, null, 2), "utf8");
      renameSync(pendingPath, join(this.dir, name));
      if (ref) this.markIndexedRefState(name, "committed");
    } catch (err) {
      if (existsSync(pendingPath)) unlinkSync(pendingPath);
      throw err;
    }
  }

  /** All stored transcripts, oldest first. */
  list(): CognitionTranscriptRef[] {
    const refs: CognitionTranscriptRef[] = [];
    for (const fileName of this.readDir()) {
      const ref = parseRef(fileName);
      if (ref) refs.push(ref);
    }
    refs.sort((a, b) => a.finishedAt - b.finishedAt);
    return refs;
  }

  /**
   * Read a newest-first page from the small persisted ref index. Upgrading an
   * existing archive discovers legacy refs in bounded, serialized batches
   * before the first page is returned. The batch boundary releases the
   * archive-local operation queue, so retention and another reader can
   * interleave without a long synchronous critical section. Once discovery
   * completes, both latency and memory are proportional to `limit`, not
   * archive size.
   * A cursor is a strict `(finishedAt,fileName)` boundary, so equal timestamps
   * cannot duplicate or disappear between pages.
   */
  async listPage(opts: {
    limit: number;
    before?: CognitionTranscriptCursor;
    runId?: string;
  }): Promise<CognitionTranscriptRef[]> {
    return (await this.listPageWithStatus(opts)).items;
  }

  async listPageWithStatus(opts: {
    limit: number;
    before?: CognitionTranscriptCursor;
    runId?: string;
  }): Promise<{ items: CognitionTranscriptRef[]; indexComplete: boolean }> {
    const indexComplete = await this.withIndexOperation(() => this.advanceIndexBatch());
    if (!indexComplete) this.startBackgroundIndexBuild();
    const limit = Math.max(1, Math.floor(opts.limit));
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (opts.runId !== undefined) {
      conditions.push("run_id = ?");
      params.push(sanitizeRunId(opts.runId));
    }
    conditions.push("state = 'committed'");
    if (opts.before) {
      conditions.push("(finished_at < ? OR (finished_at = ? AND file_name < ?))");
      params.push(opts.before.finishedAt, opts.before.finishedAt, opts.before.fileName);
    }
    params.push(limit);
    const db = this.openIndex();
    try {
      const items = db
        .prepare<
          Array<string | number>,
          { file_name: string; run_id: string; attempt: number; finished_at: number }
        >(
          `SELECT file_name, run_id, attempt, finished_at
             FROM transcript_refs
             ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
             ORDER BY finished_at DESC, file_name DESC
             LIMIT ?`,
        )
        .all(...params)
        .map((row) => ({
          fileName: row.file_name,
          runId: row.run_id,
          attempt: row.attempt,
          finishedAt: row.finished_at,
        }));
      return { items, indexComplete };
    } finally {
      db.close();
    }
  }

  /**
   * Complete attempt history for one run. The `(run_id,finished_at)` index
   * keeps this proportional to the run's attempts, not the global archive.
   */
  async listForRun(runId: string): Promise<CognitionTranscriptRef[]> {
    return (await this.listForRunWithStatus(runId)).items;
  }

  async listForRunWithStatus(
    runId: string,
  ): Promise<{ items: CognitionTranscriptRef[]; indexComplete: boolean }> {
    const complete = await this.withIndexOperation(() => this.advanceIndexBatch());
    if (!complete) this.startBackgroundIndexBuild();
    const db = this.openIndex();
    try {
      const items = db
        .prepare<
          [string],
          { file_name: string; run_id: string; attempt: number; finished_at: number }
        >(
          `SELECT file_name, run_id, attempt, finished_at
             FROM transcript_refs
             WHERE run_id = ? AND state = 'committed'
             ORDER BY finished_at DESC, file_name DESC`,
        )
        .all(sanitizeRunId(runId))
        .map((row) => ({
          fileName: row.file_name,
          runId: row.run_id,
          attempt: row.attempt,
          finishedAt: row.finished_at,
        }));
      return { items, indexComplete: complete };
    } finally {
      db.close();
    }
  }

  /** Validate and decode one caller-provided stored filename without a scan. */
  ref(fileName: string): CognitionTranscriptRef | null {
    return parseRef(fileName);
  }

  /**
   * Load one transcript by its stored file name. The name must match the
   * store's own naming pattern — file names arrive from HTTP callers
   * (the operator transcript route), and the pattern check keeps a
   * crafted name from escaping the transcripts directory.
   */
  load(fileName: string): CognitionRunTranscript {
    if (!FILE_PATTERN.test(fileName)) {
      throw new Error(`not a transcript file name: ${fileName}`);
    }
    return JSON.parse(readFileSync(join(this.dir, fileName), "utf8")) as CognitionRunTranscript;
  }

  /** Asynchronous counterpart for HTTP reads and bounded index traversal. */
  async loadAsync(fileName: string): Promise<CognitionRunTranscript> {
    if (!FILE_PATTERN.test(fileName)) {
      throw new Error(`not a transcript file name: ${fileName}`);
    }
    try {
      return JSON.parse(await readFile(join(this.dir, fileName), "utf8")) as CognitionRunTranscript;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // A manual filesystem cleanup or retention race may leave an indexed
        // ref briefly visible. Serialize cleanup with incremental discovery so
        // a delayed discovery flush cannot resurrect the dead ref.
        await this.withIndexOperation(async () => {
          await this.advanceIndexBatch();
          this.removeIndexedRefs([fileName]);
        });
      }
      throw err;
    }
  }

  /**
   * Asynchronously drop at most `limit` expired transcripts. The directory
   * read happens in libuv's filesystem pool and deletion is capped, so one
   * retention tick cannot monopolize the gateway event loop. A rotating scan
   * cursor ensures expired files are eventually reached even when directory
   * enumeration does not happen to be oldest-first.
   */
  async pruneBatch(cutoff: number, limit = 100): Promise<{ deleted: number; hasMore: boolean }> {
    return this.withIndexOperation(async () => {
      // Advance legacy discovery by a fixed amount, then perform one fixed
      // prune scan. Neither archive size can stretch this scheduler unit.
      const indexComplete = await this.advanceIndexBatch();
      const deleteLimit = Math.max(1, limit);
      const scanLimit = Math.max(100, deleteLimit * 10);
      let deleted = 0;
      let scanned = 0;
      let exhausted = false;
      try {
        while (scanned < scanLimit && deleted < deleteLimit) {
          if (!this.pruneDir) {
            try {
              this.pruneDir = await opendir(this.dir);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return { deleted: 0, hasMore: !indexComplete };
              }
              throw err;
            }
          }
          const entry = await this.pruneDir.read();
          if (!entry) {
            await this.pruneDir.close().catch(() => {});
            this.pruneDir = null;
            exhausted = true;
            break;
          }
          scanned += 1;
          if (!entry.isFile()) continue;
          const match = FILE_PATTERN.exec(entry.name);
          if (!match || Number(match[1]) >= cutoff) continue;
          this.markIndexedRefState(entry.name, "deleting");
          try {
            await this.unlinkTranscript(entry.name);
            this.removeIndexedRefs([entry.name]);
            deleted += 1;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              this.removeIndexedRefs([entry.name]);
              continue;
            }
            this.markIndexedRefState(entry.name, "committed");
            throw err;
          }
        }
      } finally {
        // Ref transitions are committed per file around its unlink.
      }
      return { deleted, hasMore: !indexComplete || !exhausted };
    });
  }

  /**
   * Delete every stored attempt of the named runs.
   *
   * Targeted deletion, as against {@link pruneBatch}'s age-based sweep: it
   * exists for the case where a run's history is retired deliberately rather
   * than aged out. It goes through the store — and through the same
   * `withIndexOperation` gate the sweep uses — because the directory and the
   * ref index are two stores that must agree: files unlinked behind the
   * index's back leave refs resolving to ENOENT, which `listPage` shows as
   * phantom attempts until each one is touched.
   *
   * Reports how many files went. Missing files are counted as already gone
   * rather than as errors, so the operation is idempotent.
   */
  async evictRuns(runIds: readonly string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    return this.withIndexOperation(async () => {
      // Legacy discovery has to finish first. An archive upgraded from before
      // the ref index existed holds files the index has never seen, and a
      // lookup by run id would find no rows and report a clean eviction over
      // files still sitting on disk.
      while (!(await this.advanceIndexBatch())) {
        // Each batch commits its refs; the loop ends at directory EOF.
      }
      let deleted = 0;
      for (const runId of runIds) {
        const db = this.openIndex();
        let names: string[];
        try {
          names = db
            .prepare<[string], { file_name: string }>(
              "SELECT file_name FROM transcript_refs WHERE run_id = ?",
            )
            .all(sanitizeRunId(runId))
            .map((row) => row.file_name);
        } finally {
          db.close();
        }
        for (const name of names) {
          this.markIndexedRefState(name, "deleting");
          try {
            await this.unlinkTranscript(name);
            deleted += 1;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              this.markIndexedRefState(name, "committed");
              throw err;
            }
          }
          this.removeIndexedRefs([name]);
        }
      }
      return deleted;
    });
  }

  private unlinkTranscript(fileName: string): Promise<void> {
    return unlink(join(this.dir, fileName));
  }

  private indexPath(): string {
    return join(this.dir, ".transcript-index.sqlite");
  }

  private openIndex(): Sqlite.Database {
    mkdirSync(this.dir, { recursive: true });
    const db = new Sqlite(this.indexPath());
    const empty =
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'index')")
        .get()?.count === 0;
    if (empty) db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_refs (
        file_name TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'committed'
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_refs_newest
        ON transcript_refs(finished_at DESC, file_name DESC);
      CREATE INDEX IF NOT EXISTS idx_transcript_refs_run
        ON transcript_refs(run_id, finished_at DESC, file_name DESC);
      CREATE TABLE IF NOT EXISTS transcript_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('transcript_refs')")
      .all()
      .map((row) => row.name);
    if (!columns.includes("state")) {
      db.exec("ALTER TABLE transcript_refs ADD COLUMN state TEXT NOT NULL DEFAULT 'committed'");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transcript_refs_state_newest
        ON transcript_refs(state, finished_at DESC, file_name DESC);
      CREATE INDEX IF NOT EXISTS idx_transcript_refs_run_state
        ON transcript_refs(run_id, state, finished_at DESC, file_name DESC);
    `);
    return db;
  }

  private upsertIndexedRef(
    ref: CognitionTranscriptRef,
    state: "pending_save" | "committed" = "committed",
  ): void {
    const db = this.openIndex();
    try {
      db.prepare(
        `INSERT INTO transcript_refs (file_name, run_id, attempt, finished_at, state)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file_name) DO UPDATE SET
           run_id = excluded.run_id,
           attempt = excluded.attempt,
           finished_at = excluded.finished_at,
           state = excluded.state`,
      ).run(ref.fileName, ref.runId, ref.attempt, ref.finishedAt, state);
    } finally {
      db.close();
    }
  }

  private markIndexedRefState(
    fileName: string,
    state: "pending_save" | "committed" | "deleting",
  ): void {
    const db = this.openIndex();
    try {
      db.prepare("UPDATE transcript_refs SET state = ? WHERE file_name = ?").run(state, fileName);
    } finally {
      db.close();
    }
  }

  /** Reconcile only interrupted two-store transitions; committed archives stay O(1). */
  private reconcilePendingRefs(): void {
    const db = this.openIndex();
    try {
      const pending = db
        .prepare<
          [],
          { file_name: string }
        >("SELECT file_name FROM transcript_refs WHERE state != 'committed'")
        .all();
      const remove = db.prepare("DELETE FROM transcript_refs WHERE file_name = ?");
      const commit = db.prepare(
        "UPDATE transcript_refs SET state = 'committed' WHERE file_name = ?",
      );
      db.transaction(() => {
        for (const row of pending) {
          const pendingPath = join(this.dir, `${row.file_name}.pending`);
          if (existsSync(pendingPath)) unlinkSync(pendingPath);
          if (existsSync(join(this.dir, row.file_name))) commit.run(row.file_name);
          else remove.run(row.file_name);
        }
      })();
    } finally {
      db.close();
    }
  }

  private removeIndexedRefs(fileNames: readonly string[]): void {
    if (fileNames.length === 0) return;
    const db = this.openIndex();
    try {
      const remove = db.prepare("DELETE FROM transcript_refs WHERE file_name = ?");
      db.transaction((names: readonly string[]) => {
        for (const fileName of names) remove.run(fileName);
      })(fileNames);
      if ((db.pragma("auto_vacuum", { simple: true }) as number) === 2) {
        db.exec("PRAGMA incremental_vacuum(16)");
      }
    } finally {
      db.close();
    }
  }

  private startBackgroundIndexBuild(): void {
    if (this.backgroundIndexBuild) return;
    this.backgroundIndexBuild = (async () => {
      let complete = false;
      while (!complete) {
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        complete = await this.withIndexOperation(() => this.advanceIndexBatch());
      }
    })()
      .catch(() => {
        // A later list/retention tick retries the idempotent discovery batch.
      })
      .finally(() => {
        this.backgroundIndexBuild = null;
      });
  }

  private async withIndexOperation<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.indexPath());
    const previous = INDEX_OPERATION_TAILS.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    INDEX_OPERATION_TAILS.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (INDEX_OPERATION_TAILS.get(key) === tail) INDEX_OPERATION_TAILS.delete(key);
    }
  }

  /**
   * Discover at most `entryLimit` legacy directory entries and flush their refs
   * in one SQLite transaction. Returns true only after reaching directory EOF.
   */
  private async advanceIndexBatch(entryLimit = 100): Promise<boolean> {
    let db = this.openIndex();
    try {
      if (
        db
          .prepare<
            [string],
            { value: string }
          >("SELECT value FROM transcript_index_meta WHERE key = ?")
          .get("scan-complete")?.value === "1"
      ) {
        return true;
      }
    } finally {
      db.close();
    }

    const key = resolve(this.indexPath());
    const state = INDEX_SCAN_STATES.get(key) ?? { directory: null };
    INDEX_SCAN_STATES.set(key, state);
    if (!state.directory) state.directory = await opendir(this.dir);
    const refs: CognitionTranscriptRef[] = [];
    let scanned = 0;
    let complete = false;
    try {
      while (scanned < Math.max(1, Math.floor(entryLimit))) {
        const entry = await state.directory.read();
        if (!entry) {
          await state.directory.close().catch(() => {});
          state.directory = null;
          INDEX_SCAN_STATES.delete(key);
          complete = true;
          break;
        }
        scanned += 1;
        if (!entry.isFile()) continue;
        const ref = parseRef(entry.name);
        if (ref) refs.push(ref);
      }
    } catch (err) {
      await state.directory?.close().catch(() => {});
      state.directory = null;
      INDEX_SCAN_STATES.delete(key);
      throw err;
    }

    db = this.openIndex();
    try {
      const insert = db.prepare(
        `INSERT INTO transcript_refs (file_name, run_id, attempt, finished_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(file_name) DO NOTHING`,
      );
      db.transaction((batch: readonly CognitionTranscriptRef[]) => {
        for (const ref of batch) {
          insert.run(ref.fileName, ref.runId, ref.attempt, ref.finishedAt);
        }
      })(refs);
      if (complete) {
        db.prepare(
          `INSERT INTO transcript_index_meta (key, value) VALUES ('scan-complete', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run();
      }
      return complete;
    } catch (err) {
      // Directory iteration is stateful. If a transaction fails after reads
      // advanced the handle, restart discovery from the beginning so those
      // entries are retried; the successful earlier upserts are idempotent.
      await state.directory?.close().catch(() => {});
      state.directory = null;
      INDEX_SCAN_STATES.delete(key);
      throw err;
    } finally {
      db.close();
    }
  }

  private readDir(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      // Directory not created yet — no transcripts.
      return [];
    }
  }
}
