// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Runtime resolution of the date-enrichment config block. Mirrors the display
 * defaults in `@omnesis/config`'s CONFIG_DEFAULTS (a cross-check keeps them
 * honest). Read live via a getter closure over the config store so `enabled` /
 * `batchSize` / `maxCharsPerDoc` take effect without a restart; cadence
 * (`periodMs` / `idlePeriodMs`) is read once when the task is constructed.
 */

import { hostTimeZone } from "@omnesis/core";
import { DEFAULT_MAX_CHARS, DEFAULT_SCAN_BUDGET_MS } from "./extractor.js";
import type { NumericDateOrder } from "./language-route.js";
import type { EnrichmentSettings } from "@omnesis/config";

export type NumericDateOrderSetting = NumericDateOrder | "auto";

/** Spend mechanism the mention worth gate's decision-model tokens are recorded under. */
export const MENTION_WORTH_GATE_SPEND_MECHANISM = "mention-worth-gate";

export interface ResolvedDateEnrichmentSettings {
  enabled: boolean;
  batchSize: number;
  maxCharsPerDoc: number;
  scanBudgetMs: number;
  periodMs: number;
  idlePeriodMs: number;
  numericDateOrder: NumericDateOrderSetting;
  /** Hide mentions from email the decision model judges not worth recording. */
  worthGate: boolean;
}

export const DATE_ENRICHMENT_DEFAULTS: ResolvedDateEnrichmentSettings = {
  enabled: true,
  batchSize: 50,
  maxCharsPerDoc: DEFAULT_MAX_CHARS,
  scanBudgetMs: DEFAULT_SCAN_BUDGET_MS,
  periodMs: 1_500,
  idlePeriodMs: 300_000,
  numericDateOrder: "auto",
  worthGate: false,
};

export function resolveDateEnrichmentSettings(
  raw: EnrichmentSettings | undefined,
): ResolvedDateEnrichmentSettings {
  const d = raw?.dates;
  return {
    enabled: d?.enabled ?? DATE_ENRICHMENT_DEFAULTS.enabled,
    batchSize: d?.batchSize ?? DATE_ENRICHMENT_DEFAULTS.batchSize,
    maxCharsPerDoc: d?.maxCharsPerDoc ?? DATE_ENRICHMENT_DEFAULTS.maxCharsPerDoc,
    scanBudgetMs: d?.scanBudgetMs ?? DATE_ENRICHMENT_DEFAULTS.scanBudgetMs,
    periodMs: d?.periodMs ?? DATE_ENRICHMENT_DEFAULTS.periodMs,
    idlePeriodMs: d?.idlePeriodMs ?? DATE_ENRICHMENT_DEFAULTS.idlePeriodMs,
    numericDateOrder: d?.numericDateOrder ?? DATE_ENRICHMENT_DEFAULTS.numericDateOrder,
    worthGate: d?.worthGate ?? DATE_ENRICHMENT_DEFAULTS.worthGate,
  };
}

/**
 * Time zones where English numeric dates are written month-first: the United
 * States and its territories, and the Philippines. Everywhere else — the rest
 * of the Americas included — writes them day-first.
 */
const MONTH_FIRST_ZONE_PREFIXES = [
  "US/",
  "America/Indiana/",
  "America/Kentucky/",
  "America/North_Dakota/",
];
const MONTH_FIRST_ZONES: ReadonlySet<string> = new Set([
  "America/New_York",
  "America/Detroit",
  "America/Chicago",
  "America/Menominee",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "America/Puerto_Rico",
  "Pacific/Honolulu",
  "Pacific/Guam",
  "Pacific/Saipan",
  "Pacific/Pago_Pago",
  "Asia/Manila",
]);

/**
 * The order an all-numeric English date reads in. `auto` follows where the
 * gateway runs: month-first where that is the common writing, day-first
 * elsewhere.
 */
export function resolveNumericDateOrder(
  setting: NumericDateOrderSetting,
  timeZone: string = hostTimeZone(),
): NumericDateOrder {
  if (setting !== "auto") return setting;
  const monthFirst =
    MONTH_FIRST_ZONES.has(timeZone) ||
    MONTH_FIRST_ZONE_PREFIXES.some((prefix) => timeZone.startsWith(prefix));
  return monthFirst ? "month-first" : "day-first";
}
