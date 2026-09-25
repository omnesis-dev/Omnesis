// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Single source of truth for every CPU op the worker can dispatch.
 *
 * Mirror of `compute-handlers.ts` for the CPU pool runner. Handlers
 * have NO database parameter — they receive pre-fetched data via
 * postMessage and return pure-compute results.
 *
 * Consumed by:
 *  - `workers/cpu-worker.ts` — spreads this map as its dispatch table
 *  - `cpu-ops.ts`            — types `CPU_OP_DEFS[].name` as
 *                              `CpuOpName` so misspellings fail to
 *                              compile and every Task def matches a
 *                              real handler
 */

import { signDocBatch, verifyPairBatch } from "../near-dupes/cpu-signing.js";
import { scoreMergeCandidates } from "../merge-candidates-cpu.js";
import { extractLinksFromDocs } from "../domain/LinkExtraction-cpu.js";
import { extractDfChunk } from "../near-dupes/NearDupDfCpu.js";
import { extractDatesForDocs } from "../enrichment/dates/extractor.js";
import {
  computeMergeEquivalencesFromData,
  computeAutoDetectedRulesFromData,
} from "../domain/MergeService.js";

export const cpuHandlers = {
  "cpu.echo": <T>(value: T): T => value,
  "cpu.nearDupSignBatch": signDocBatch,
  "cpu.nearDupVerifyBatch": verifyPairBatch,
  "cpu.scoreMergeCandidates": scoreMergeCandidates,
  "cpu.extractLinksFromDocs": extractLinksFromDocs,
  "cpu.extractDfChunk": extractDfChunk,
  "cpu.extractDatesFromDocs": extractDatesForDocs,
  "cpu.computeMergeEquivalences": computeMergeEquivalencesFromData,
  "cpu.computeAutoDetectedRules": computeAutoDetectedRulesFromData,
} as const;

export type CpuHandlers = typeof cpuHandlers;
export type CpuOpName = keyof CpuHandlers;

export type CpuArgs<K extends CpuOpName> = CpuHandlers[K] extends (...args: infer A) => unknown
  ? A
  : never;

export type CpuReturn<K extends CpuOpName> = CpuHandlers[K] extends (...args: never) => infer R
  ? R
  : never;
