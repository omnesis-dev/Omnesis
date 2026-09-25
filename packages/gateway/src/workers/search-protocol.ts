// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Message types for the search worker (Slice 3B — search-worker relocation).
 *
 * The search worker is a read-only sibling of the io worker, but on a
 * different database and a different resource set: it owns a READ-ONLY
 * `index.db` handle plus its own {@link UsearchReadRegistry}, and runs the
 * synchronous candidate-generation core (`runCandidateGen`) off the main
 * event loop. Unlike the io worker it holds NO `omnesis.db` handle — the
 * pre-stage (person/source resolve) and the metadata hydration stay on main
 * (Scope X).
 *
 * Wire format mirrors the io/writer envelope (id-correlated call → result with
 * queueMs/execMs/cpu) so the pool's metrics + correlation code reads uniform
 * across workers. The one deliberate difference: the `call` carries the typed
 * {@link CandidateGenRequest} directly (not a generic `op` + `args[]`), because
 * there is exactly one operation.
 *
 * CRITICAL: the transport is the structured-clone `postMessage` algorithm,
 * NEVER JSON. The request's `queryVector` is a `Float32Array` and the result's
 * scores carry `Infinity`/`NaN` (min-max normalisation) while usearch keys are
 * `bigint`. `JSON.stringify` maps `Infinity`/`NaN`→`null` and throws on
 * `bigint`, so a JSON transport would silently corrupt rankings — the
 * transport-fidelity test guards this.
 */

import type { CandidateGenRequest, CandidateGenResult } from "../search/candidate-gen.js";
import type { WorkerLogMessage } from "./protocol.js";

export type SearchInit = {
  type: "init";
  /** Path to the on-disk `index.db` the worker opens read-only. */
  indexDbPath: string;
  /** Hex encryption key for `index.db` under storage encryption (omitted when off). */
  indexDbKeyHex?: string;
  /** Page-cache budget in bytes for the read handle (defaults to 64 MiB). */
  cacheSizeBytes?: number;
  /** Config dir — the {@link UsearchReadRegistry} resolves usearch files under it. */
  configDir: string;
  heartbeatIntervalMs: number;
  /** OS nice for this compute thread (resolved on the main thread). */
  backgroundWorkerNice: number;
};

export type SearchCall = {
  type: "call";
  id: number;
  /** The fully structured-clone-safe candidate-gen request (never JSON-encoded). */
  request: CandidateGenRequest;
  /**
   * Wall-clock ms (Date.now()) when the pool called postMessage. The worker
   * subtracts its own dequeue time to compute the queue wait — the search
   * analogue of the io/writer fairness signal.
   */
  enqueueMs: number;
};

export type MainToSearch = SearchInit | SearchCall | { type: "shutdown" };

export type SearchResult =
  | {
      type: "result";
      id: number;
      ok: true;
      value: CandidateGenResult;
      /** Time (ms) the call sat in the worker's FIFO before running. */
      queueMs: number;
      /** Time (ms) the worker actually spent inside `runCandidateGen`. */
      execMs: number;
      /** CPU time (µs) the op consumed in user-space JS. */
      cpuUserUs: number;
      /** CPU time (µs) the op consumed in kernel syscalls. */
      cpuSystemUs: number;
    }
  | {
      type: "result";
      id: number;
      ok: false;
      error: string;
      queueMs: number;
      execMs: number;
      cpuUserUs: number;
      cpuSystemUs: number;
    };

export type SearchToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | { type: "heartbeat"; ts: number }
  | WorkerLogMessage
  | SearchResult
  | { type: "shutdownComplete" };
