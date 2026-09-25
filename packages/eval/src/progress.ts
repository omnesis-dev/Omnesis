// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createWriteStream,
  type WriteStream,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ProgressEvent } from "./types.js";

/**
 * Append-only JSONL progress stream + a single-line `<base>.txt` status
 * file written alongside. The status file is rewritten in place after
 * each query so monitors can do a one-line read instead of tail-following.
 *
 * Run-level usage: one ProgressEmitter per `omnesis eval run` invocation,
 * created at run start and explicitly closed at run end.
 */
export class ProgressEmitter {
  private stream: WriteStream;
  private statusPath: string;
  private startMs: number;
  private completedQueries = 0;
  private totalQueries = 0;
  private runId = "";

  constructor(jsonlPath: string, statusPath: string) {
    mkdirSync(dirname(jsonlPath), { recursive: true });
    this.stream = createWriteStream(jsonlPath, { flags: "a" });
    this.statusPath = statusPath;
    this.startMs = Date.now();
  }

  emit(event: ProgressEvent): void {
    this.stream.write(JSON.stringify(event) + "\n");
    if (event.type === "run_started") {
      this.totalQueries = event.total_queries;
      this.runId = event.run_id;
      this.startMs = Date.now();
      this.writeStatus(`0/${this.totalQueries} — starting`);
    } else if (event.type === "warmup_started") {
      this.writeStatus(
        `warmup — ${event.warmup_calls} call(s) — a cold model load can take tens of seconds`,
      );
    } else if (event.type === "warmup_completed") {
      this.writeStatus(
        `warmup done in ${Math.round(event.elapsed_ms / 1000)}s — starting timed bench`,
      );
    } else if (event.type === "query_completed") {
      this.completedQueries++;
      const eta = event.eta_ms ?? this.estimateEtaMs();
      this.writeStatus(
        `${this.completedQueries}/${this.totalQueries} — last ${Math.round(event.elapsed_ms)}ms — ETA ${formatEta(eta)}`,
      );
    } else if (event.type === "run_completed") {
      this.writeStatus(
        `done — ${this.totalQueries}/${this.totalQueries} — ${Math.round(event.duration_ms / 1000)}s`,
      );
    }
  }

  private estimateEtaMs(): number {
    if (this.completedQueries === 0) return 0;
    const elapsed = Date.now() - this.startMs;
    const perQuery = elapsed / this.completedQueries;
    return perQuery * (this.totalQueries - this.completedQueries);
  }

  private writeStatus(line: string): void {
    // Single line; trailing newline so `cat` shows it cleanly.
    writeFileSync(this.statusPath, line + "\n");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
    // Best-effort fsync so a watching process sees the final line.
    try {
      const fd = openSync(this.statusPath, "r+");
      fsyncSync(fd);
      closeSync(fd);
    } catch {
      // Best-effort; not fatal.
    }
  }
}

function formatEta(ms: number): string {
  if (ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** Helper for callers that want to construct events without typing the full shape every time. */
export const events = {
  runStarted(runId: string, totalQueries: number): ProgressEvent {
    return {
      type: "run_started",
      ts: new Date().toISOString(),
      run_id: runId,
      total_queries: totalQueries,
    };
  },
  warmupStarted(warmupCalls: number): ProgressEvent {
    return {
      type: "warmup_started",
      ts: new Date().toISOString(),
      warmup_calls: warmupCalls,
    };
  },
  warmupCompleted(elapsedMs: number): ProgressEvent {
    return {
      type: "warmup_completed",
      ts: new Date().toISOString(),
      elapsed_ms: elapsedMs,
    };
  },
  queryStarted(queryIdx: number, queryId: string): ProgressEvent {
    return {
      type: "query_started",
      ts: new Date().toISOString(),
      query_idx: queryIdx,
      query_id: queryId,
    };
  },
  queryCompleted(
    queryIdx: number,
    queryId: string,
    elapsedMs: number,
    etaMs?: number,
  ): ProgressEvent {
    return {
      type: "query_completed",
      ts: new Date().toISOString(),
      query_idx: queryIdx,
      query_id: queryId,
      elapsed_ms: elapsedMs,
      eta_ms: etaMs,
    };
  },
  runCompleted(runId: string, durationMs: number): ProgressEvent {
    return {
      type: "run_completed",
      ts: new Date().toISOString(),
      run_id: runId,
      duration_ms: durationMs,
    };
  },
};
