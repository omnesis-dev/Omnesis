// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `CpuOps` — Task definitions for pure-compute work.
 *
 * Mirror of `compute-ops.ts` but for the CPU pool runner. Each entry
 * maps a worker op name (matching the dispatch table in
 * `workers/cpu-worker.ts`) to a Task whose runner is "cpu".
 *
 * `cpuGateFromScheduler(scheduler)` returns a typed `CpuGate` so
 * callers can write `cpuGate.echo(42)` instead of constructing the
 * raw enqueue.
 *
 * All CPU ops default to `background` priority — they're the compute
 * halves of background work. Override via `runWithPriority` if needed.
 */

import type { Scheduler } from "./scheduler.js";
import type { Priority, Task } from "./types.js";
import type { CpuOpName } from "./cpu-handlers.js";
import type {
  NearDupDocForSigning,
  SignedDoc,
  VerifyPairInput,
  VerifiedPair,
} from "../near-dupes/cpu-signing.js";
import type { NearDupeConfig } from "@omnesis/near-dupes";
import type { MergeCandidatesFetchData, MergeCandidatesCpuOpts } from "../merge-candidates-cpu.js";
import type { MergeCandidateProposal } from "../domain/MergeCandidateDetector.js";
import type { LinkExtractionDocRow } from "../domain/LinkExtraction-cpu.js";
import type { ExtractedLinkBatchEntry } from "../domain/LinkExtraction.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";
import type { DfChunkInput, DfChunkResult } from "../near-dupes/NearDupDfCpu.js";
import type {
  DateExtractionDocRow,
  DateExtractionResult,
  DateExtractionOptions,
} from "../enrichment/dates/extractor.js";
import type {
  MergeEquivalencesIoData,
  AutoDetectIoData,
  AutoDetectedRule,
  MergeEquivalenceSnapshot,
} from "../domain/merge/types.js";

export interface CpuGate {
  echo<T>(value: T): Promise<T>;
  nearDupSignBatch(
    docs: NearDupDocForSigning[],
    algoConfig: NearDupeConfig,
    dfSab: SharedArrayBuffer,
    eligibleDocTypes: string[],
  ): Promise<SignedDoc[]>;
  nearDupVerifyBatch(
    pairs: VerifyPairInput[],
    dfSab: SharedArrayBuffer,
    gateConfig: {
      recordThreshold: number;
      maxIdfWeight: number;
      emailJaccardMin: number;
      emailPairUniqueDf2Min: number;
      fileLikeJaccardMin: number;
      fileLikePairUniqueDf2Min: number;
      fileLikeContainmentMin: number;
      automatedSenderPrefixes: string[];
    },
  ): Promise<VerifiedPair[]>;
  scoreMergeCandidates(
    data: MergeCandidatesFetchData,
    opts?: MergeCandidatesCpuOpts,
  ): Promise<MergeCandidateProposal[]>;
  extractLinksFromDocs(
    docs: LinkExtractionDocRow[],
    canonicalizers?: readonly UrlCanonicalizerSpec[],
  ): Promise<ExtractedLinkBatchEntry[]>;
  extractDfChunk(input: DfChunkInput): Promise<DfChunkResult>;
  /**
   * Extract resolved dates from each document's text, anchored to its
   * emission date. Pure regex/compute — the date-enrichment signal's compute
   * half. Runs on the cpu pool so it never touches the main event loop, the
   * writer, or a user-serving read handle.
   */
  extractDatesFromDocs(
    rows: DateExtractionDocRow[],
    opts?: DateExtractionOptions,
  ): Promise<DateExtractionResult[]>;
  computeMergeEquivalences(data: MergeEquivalencesIoData): Promise<MergeEquivalenceSnapshot>;
  computeAutoDetectedRules(data: AutoDetectIoData): Promise<AutoDetectedRule[]>;
}

interface CpuOpDef {
  readonly name: CpuOpName;
  readonly priority: Priority;
  readonly latencyBudgetMs?: number;
}

const DEFAULT_BUDGET_MS = 200;

const HEAVY_BUDGET_MS = 2_000;

const CPU_OP_DEFS: readonly CpuOpDef[] = [
  { name: "cpu.echo", priority: "background" },
  { name: "cpu.nearDupSignBatch", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "cpu.nearDupVerifyBatch", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "cpu.scoreMergeCandidates", priority: "background", latencyBudgetMs: 5_000 },
  { name: "cpu.extractLinksFromDocs", priority: "background", latencyBudgetMs: 5_000 },
  { name: "cpu.extractDfChunk", priority: "background", latencyBudgetMs: 30_000 },
  // Worst case = docs-per-op × the per-document scan budget (8 × 3s), plus
  // one chunk overshoot each — 30s keeps the over-budget metric meaningful.
  { name: "cpu.extractDatesFromDocs", priority: "background", latencyBudgetMs: 30_000 },
  {
    name: "cpu.computeMergeEquivalences",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "cpu.computeAutoDetectedRules", priority: "background" },
];

export const CpuOps: ReadonlyMap<string, Task<unknown[], unknown>> = (() => {
  const map = new Map<string, Task<unknown[], unknown>>();
  for (const def of CPU_OP_DEFS) {
    map.set(def.name, {
      name: def.name,
      runner: "cpu",
      priority: def.priority,
      latencyBudgetMs: def.latencyBudgetMs ?? DEFAULT_BUDGET_MS,
      async run(): Promise<never> {
        throw new Error(`${def.name} executes on the cpu worker, not main`);
      },
    });
  }
  return map;
})();

export function cpuGateFromScheduler(scheduler: Scheduler): CpuGate {
  const call = <T>(op: string, args: unknown[]): Promise<T> => {
    const task = CpuOps.get(op);
    if (!task) {
      return Promise.reject(new Error(`unknown cpu op: ${op}`));
    }
    return scheduler.enqueue(task, args) as Promise<T>;
  };
  return {
    echo: (value) => call("cpu.echo", [value]),
    nearDupSignBatch: (docs, algoConfig, dfData, eligibleDocTypes) =>
      call("cpu.nearDupSignBatch", [docs, algoConfig, dfData, eligibleDocTypes]),
    nearDupVerifyBatch: (pairs, dfData, gateConfig) =>
      call("cpu.nearDupVerifyBatch", [pairs, dfData, gateConfig]),
    scoreMergeCandidates: (data, opts) => call("cpu.scoreMergeCandidates", [data, opts ?? {}]),
    extractLinksFromDocs: (docs, canonicalizers) =>
      call("cpu.extractLinksFromDocs", [docs, canonicalizers]),
    extractDfChunk: (input) => call("cpu.extractDfChunk", [input]),
    extractDatesFromDocs: (rows, opts) => call("cpu.extractDatesFromDocs", [rows, opts ?? {}]),
    computeMergeEquivalences: (data) => call("cpu.computeMergeEquivalences", [data]),
    computeAutoDetectedRules: (data) => call("cpu.computeAutoDetectedRules", [data]),
  };
}
