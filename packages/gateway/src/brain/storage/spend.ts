// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable token-spend accounting for the cognitive mechanisms, keyed
 * (day, mechanism, model_id) so every mechanism's cost is attributable
 * per model. Tracking only — no cap, no enforcement, anywhere. Rows
 * accumulate and survive run-row pruning (this table is the durable
 * accounting record the operator surfaces read).
 */

import type Database from "better-sqlite3";
import type { CognitionSpendRow, CognitionRunUsage, CognitionDayTotalRow } from "./types.js";

type Db = Database.Database;

/**
 * `YYYY-MM-DD` in the machine's LOCAL time for a unix-ms instant — the
 * same "gateway machine local time" basis the daily rhythm uses.
 */
export function cognitionSpendDay(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Fold one run's usage into its (day, mechanism, model) bucket
 * (upsert-increment). `promptTokens` stays the input-side TOTAL (fresh
 * input + cache reads + cache creation) with the cache fields as subsets
 * of it — see {@link CognitionRunUsage}. `modelId` is the resolved
 * backend's model id; `""` when it could not be determined.
 * `countRun: false` folds tokens without bumping the `runs` counter —
 * used for failed attempts, whose tokens were spent but which are not
 * completed runs.
 */
export function recordCognitionSpend(
  db: Db,
  day: string,
  mechanism: string,
  modelId: string,
  usage: CognitionRunUsage,
  opts: { countRun?: boolean } = {},
): void {
  const runIncrement = (opts.countRun ?? true) ? 1 : 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  db.prepare<
    [
      string,
      string,
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
  >(
    `INSERT INTO cognition_spend (day, mechanism, model_id, runs, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, mechanism, model_id) DO UPDATE SET
       runs = runs + ?,
       prompt_tokens = prompt_tokens + ?,
       completion_tokens = completion_tokens + ?,
       cache_read_tokens = cache_read_tokens + ?,
       cache_creation_tokens = cache_creation_tokens + ?`,
  ).run(
    day,
    mechanism,
    modelId,
    runIncrement,
    usage.promptTokens,
    usage.completionTokens,
    cacheRead,
    cacheCreation,
    runIncrement,
    usage.promptTokens,
    usage.completionTokens,
    cacheRead,
    cacheCreation,
  );
}

interface CognitionSpendDbRow {
  day: string;
  mechanism: string;
  model_id: string;
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

function toCognitionSpendRow(r: CognitionSpendDbRow): CognitionSpendRow {
  return {
    day: r.day,
    mechanism: r.mechanism,
    modelId: r.model_id,
    runs: r.runs,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
  };
}

/**
 * Per-(day, mechanism, model) rows for the most recent `days` distinct
 * days (default 30), newest day first; mechanism/model order is stable
 * within a day.
 */
export function listCognitionSpend(db: Db, opts: { days?: number } = {}): CognitionSpendRow[] {
  return db
    .prepare<[number], CognitionSpendDbRow>(
      `SELECT * FROM cognition_spend
       WHERE day IN (SELECT DISTINCT day FROM cognition_spend ORDER BY day DESC LIMIT ?)
       ORDER BY day DESC, mechanism, model_id`,
    )
    .all(opts.days ?? 30)
    .map(toCognitionSpendRow);
}

type SpendDayTotalDbRow = Omit<CognitionSpendDbRow, "mechanism" | "model_id">;

function toSpendDayTotal(r: SpendDayTotalDbRow): CognitionDayTotalRow {
  return {
    day: r.day,
    runs: r.runs,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
  };
}

/**
 * Most-recent-first day totals aggregated across all mechanisms and
 * models — the legacy one-row-per-day shape `/admin/brain/spend` serves.
 */
export function listCognitionSpendDayTotals(
  db: Db,
  opts: { limit?: number } = {},
): CognitionDayTotalRow[] {
  return db
    .prepare<[number], SpendDayTotalDbRow>(
      `SELECT day,
              SUM(runs) AS runs,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens
         FROM cognition_spend
        GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(opts.limit ?? 90)
    .map(toSpendDayTotal);
}

/** One day's totals aggregated across all mechanisms and models; null when nothing was recorded. */
export function getCognitionSpendDayTotal(db: Db, day: string): CognitionDayTotalRow | null {
  const row = db
    .prepare<[string], SpendDayTotalDbRow & { day: string | null }>(
      `SELECT day,
              SUM(runs) AS runs,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens
         FROM cognition_spend WHERE day = ?`,
    )
    .get(day);
  // An aggregate over zero rows yields one all-NULL row; `day` is the marker.
  if (!row || row.day === null) return null;
  return toSpendDayTotal(row as SpendDayTotalDbRow);
}
