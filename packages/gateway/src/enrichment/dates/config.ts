// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Runtime resolution of the date-enrichment config block. Mirrors the display
 * defaults in `@omnesis/config`'s CONFIG_DEFAULTS (a cross-check keeps them
 * honest). Read live via a getter closure over the config store so `enabled` /
 * `batchSize` / `maxCharsPerDoc` take effect without a restart; cadence
 * (`periodMs` / `idlePeriodMs`) is read once when the task is constructed.
 */

import { DEFAULT_MAX_CHARS, DEFAULT_SCAN_BUDGET_MS } from "./extractor.js";
import type { EnrichmentSettings } from "@omnesis/config";

export interface ResolvedDateEnrichmentSettings {
  enabled: boolean;
  batchSize: number;
  maxCharsPerDoc: number;
  scanBudgetMs: number;
  periodMs: number;
  idlePeriodMs: number;
}

export const DATE_ENRICHMENT_DEFAULTS: ResolvedDateEnrichmentSettings = {
  enabled: true,
  batchSize: 50,
  maxCharsPerDoc: DEFAULT_MAX_CHARS,
  scanBudgetMs: DEFAULT_SCAN_BUDGET_MS,
  periodMs: 1_500,
  idlePeriodMs: 300_000,
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
  };
}
