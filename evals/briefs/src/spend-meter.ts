// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The spend meter — the hard brake on model-in-the-loop scorecard spend.
 *
 * It prices every priced run from the committed price sheet
 * (`evals/briefs/deepseek-prices.json`, cache-hit / cache-miss / output rates
 * priced separately from the API usage object's cache breakdown) and enforces
 * the budget cap (`evals/briefs/budget.json`) with reserve-then-run
 * integrity:
 *
 *  - `reserve()` MUST be called before executing a run. It refuses (throws
 *    `SpendCapError`) when the run's worst-case projected cost would take
 *    recorded spend past `refusalFraction * capUsd`, and otherwise appends a
 *    reservation receipt to EVERY configured ledger before returning — so a
 *    crash mid-run can never lose the spend record.
 *  - `settle()` replaces the worst-case projection with the run's actual
 *    priced usage once it completes.
 *  - Cumulative spend is the MAX of the per-ledger totals (committed ledger
 *    vs. the durable out-of-repo ledger), so an eviction, a rebase, or an
 *    unpushed worktree can only ever over-count, never under-count.
 *
 * Ledger files are JSONL and shared with other record kinds (scorecard
 * iteration rows); the meter only reads/writes `spend-reserve` and
 * `spend-settle` records. This is a test-harness guard, not a product
 * feature — the shipped product tracks spend but never caps it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PriceSheet {
  model: string;
  currency: "USD";
  per1MTokensUsd: {
    inputCacheHit: number;
    inputCacheMiss: number;
    output: number;
  };
  sourceUrl: string;
  retrievedAt: string;
}

export interface Budget {
  capUsd: number;
  refusalFraction: number;
}

/** Actual usage of a completed run, from the API usage object's cache breakdown. */
export interface RunUsage {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
}

/** Worst-case projection for a run about to execute (all prompt tokens priced as cache misses). */
export interface WorstCaseUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface SpendReserveRecord {
  kind: "spend-reserve";
  runId: string;
  at: string;
  model: string;
  worstCase: WorstCaseUsage;
  projectedUsd: number;
}

export interface SpendSettleRecord {
  kind: "spend-settle";
  runId: string;
  at: string;
  model: string;
  usage: RunUsage;
  usd: number;
}

export class SpendCapError extends Error {
  constructor(
    readonly projectedUsd: number,
    readonly cumulativeUsd: number,
    readonly capUsd: number,
    readonly refusalFraction: number,
  ) {
    const limit = refusalFraction * capUsd;
    super(
      `Spend cap: refusing run — recorded spend $${cumulativeUsd.toFixed(4)} + worst-case ` +
        `$${projectedUsd.toFixed(4)} would pass ${refusalFraction * 100}% of the ` +
        `$${capUsd} cap ($${limit.toFixed(4)})`,
    );
    this.name = "SpendCapError";
  }
}

function assertFiniteNonNegative(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${what} must be a finite non-negative number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Load + validate the committed price sheet. Throws on any structural problem. */
export function loadPriceSheet(path: string): PriceSheet {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const model = raw.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`${path}: "model" must be a non-empty string`);
  }
  if (raw.currency !== "USD") {
    throw new Error(`${path}: "currency" must be "USD"`);
  }
  const rates = raw.per1MTokensUsd as Record<string, unknown> | undefined;
  if (rates === undefined || typeof rates !== "object") {
    throw new Error(`${path}: missing "per1MTokensUsd" object`);
  }
  const sheet: PriceSheet = {
    model,
    currency: "USD",
    per1MTokensUsd: {
      inputCacheHit: assertFiniteNonNegative(
        rates.inputCacheHit,
        `${path}: per1MTokensUsd.inputCacheHit`,
      ),
      inputCacheMiss: assertFiniteNonNegative(
        rates.inputCacheMiss,
        `${path}: per1MTokensUsd.inputCacheMiss`,
      ),
      output: assertFiniteNonNegative(rates.output, `${path}: per1MTokensUsd.output`),
    },
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
    retrievedAt: typeof raw.retrievedAt === "string" ? raw.retrievedAt : "",
  };
  if (sheet.sourceUrl.length === 0 || sheet.retrievedAt.length === 0) {
    throw new Error(`${path}: "sourceUrl" and "retrievedAt" must be non-empty strings`);
  }
  return sheet;
}

/** Load + validate the committed budget cap. Throws on any structural problem. */
export function loadBudget(path: string): Budget {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const capUsd = assertFiniteNonNegative(raw.capUsd, `${path}: capUsd`);
  if (capUsd === 0) throw new Error(`${path}: capUsd must be positive`);
  const refusalFraction = assertFiniteNonNegative(raw.refusalFraction, `${path}: refusalFraction`);
  if (refusalFraction === 0 || refusalFraction > 1) {
    throw new Error(`${path}: refusalFraction must be in (0, 1]`);
  }
  return { capUsd, refusalFraction };
}

/** Price actual usage: cache-hit, cache-miss, and output tokens at their separate rates. */
export function priceUsageUsd(usage: RunUsage, prices: PriceSheet): number {
  const r = prices.per1MTokensUsd;
  return (
    (usage.promptCacheHitTokens * r.inputCacheHit +
      usage.promptCacheMissTokens * r.inputCacheMiss +
      usage.completionTokens * r.output) /
    1_000_000
  );
}

/** Price a worst-case projection: every prompt token at the cache-miss rate. */
export function priceWorstCaseUsd(worstCase: WorstCaseUsage, prices: PriceSheet): number {
  const r = prices.per1MTokensUsd;
  return (
    (worstCase.promptTokens * r.inputCacheMiss + worstCase.completionTokens * r.output) / 1_000_000
  );
}

type SpendRecord = SpendReserveRecord | SpendSettleRecord;

function isSpendRecord(value: unknown): value is SpendRecord {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "spend-reserve" || kind === "spend-settle";
}

/**
 * Read the spend records out of a JSONL ledger. A missing file is an empty
 * ledger; a malformed line is a hard error (silently skipping a line could
 * under-count money). Records of other kinds are ignored.
 */
export function readSpendRecords(path: string): SpendRecord[] {
  if (!existsSync(path)) return [];
  const records: SpendRecord[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${i + 1}: malformed ledger line (not JSON)`);
    }
    if (isSpendRecord(parsed)) records.push(parsed);
  }
  return records;
}

/**
 * A ledger's total: each settled run at its actual cost, each unsettled
 * reservation at its worst-case projection, and any orphan settle (its
 * reservation lost to ledger divergence) at its actual cost. Duplicate
 * reservations or settlements for one run id are corruption — fail loud.
 */
export function ledgerTotalUsd(records: readonly SpendRecord[], path: string): number {
  const reserves = new Map<string, SpendReserveRecord>();
  const settles = new Map<string, SpendSettleRecord>();
  for (const record of records) {
    if (record.kind === "spend-reserve") {
      if (reserves.has(record.runId)) {
        throw new Error(`${path}: duplicate spend-reserve record for run "${record.runId}"`);
      }
      reserves.set(record.runId, record);
    } else {
      if (settles.has(record.runId)) {
        throw new Error(`${path}: duplicate spend-settle record for run "${record.runId}"`);
      }
      settles.set(record.runId, record);
    }
  }
  let total = 0;
  for (const [runId, reserve] of reserves) {
    const settle = settles.get(runId);
    total += settle !== undefined ? settle.usd : reserve.projectedUsd;
  }
  for (const [runId, settle] of settles) {
    if (!reserves.has(runId)) total += settle.usd;
  }
  return total;
}

export interface SpendMeterOptions {
  budget: Budget;
  /**
   * Every ledger the meter appends receipts to and reads spend back from —
   * at least the committed ledger plus the durable out-of-repo ledger.
   * Cumulative spend is the max of the per-ledger totals.
   */
  ledgerPaths: readonly string[];
  now?: () => Date;
}

export class SpendMeter {
  private readonly now: () => Date;

  constructor(
    private readonly prices: PriceSheet,
    private readonly options: SpendMeterOptions,
  ) {
    if (options.ledgerPaths.length === 0) {
      throw new Error("SpendMeter requires at least one ledger path");
    }
    this.now = options.now ?? (() => new Date());
  }

  /** Recorded spend so far: the max of the per-ledger totals (never under-counts). */
  cumulativeSpendUsd(): number {
    let max = 0;
    for (const path of this.options.ledgerPaths) {
      max = Math.max(max, ledgerTotalUsd(readSpendRecords(path), path));
    }
    return max;
  }

  /**
   * Reserve budget for a run about to execute. Refuses (throws
   * `SpendCapError`) when the worst-case projected cost would take recorded
   * spend past `refusalFraction * capUsd`; otherwise appends the reservation
   * receipt to every ledger BEFORE returning, so the caller may only start
   * the run once the spend record is durable.
   */
  reserve(runId: string, worstCase: WorstCaseUsage): SpendReserveRecord {
    for (const path of this.options.ledgerPaths) {
      for (const record of readSpendRecords(path)) {
        if (record.kind === "spend-reserve" && record.runId === runId) {
          throw new Error(`${path}: run "${runId}" already has a reservation`);
        }
      }
    }
    const projectedUsd = priceWorstCaseUsd(worstCase, this.prices);
    const cumulativeUsd = this.cumulativeSpendUsd();
    const { capUsd, refusalFraction } = this.options.budget;
    if (cumulativeUsd + projectedUsd > refusalFraction * capUsd) {
      throw new SpendCapError(projectedUsd, cumulativeUsd, capUsd, refusalFraction);
    }
    const record: SpendReserveRecord = {
      kind: "spend-reserve",
      runId,
      at: this.now().toISOString(),
      model: this.prices.model,
      worstCase,
      projectedUsd,
    };
    this.append(record);
    return record;
  }

  /** Settle a completed run: replace its worst-case projection with the actual priced usage. */
  settle(runId: string, usage: RunUsage): SpendSettleRecord {
    let reserved = false;
    for (const path of this.options.ledgerPaths) {
      for (const record of readSpendRecords(path)) {
        if (record.kind === "spend-settle" && record.runId === runId) {
          throw new Error(`${path}: run "${runId}" is already settled`);
        }
        if (record.kind === "spend-reserve" && record.runId === runId) reserved = true;
      }
    }
    if (!reserved) {
      throw new Error(`cannot settle run "${runId}": no reservation found in any ledger`);
    }
    const record: SpendSettleRecord = {
      kind: "spend-settle",
      runId,
      at: this.now().toISOString(),
      model: this.prices.model,
      usage,
      usd: priceUsageUsd(usage, this.prices),
    };
    this.append(record);
    return record;
  }

  private append(record: SpendRecord): void {
    for (const path of this.options.ledgerPaths) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    }
  }
}
