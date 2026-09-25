// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The deepseek scorecard lane — the model-in-the-loop half of
 * `npm run briefs:scorecard`.
 *
 * Every part of this lane is inert by default and deliberately hostile
 * to accidental spend:
 *
 *  - **CI hard-refusal**: the lane throws before doing anything else when
 *    `CI` is set to ANY value (even `"false"`, which some runners use).
 *    No workflow or hook may reference the lane; every priced run is a
 *    deliberate Phase Two iteration step.
 *  - **Key handling**: the backend is resolved from the
 *    `OMNESIS_BRIEFS_DEEPSEEK_URL` / `OMNESIS_BRIEFS_DEEPSEEK_KEY` env
 *    overrides, falling back to `inference.backends.deepseek.{url,apiKey}`
 *    in the operator config. The key is injected into the spawned harness
 *    gateway only — never committed, logged, echoed, or written into any
 *    artifact (`describeDeepseekBackend` is the one printable projection).
 *  - **Reserve-then-run**: every priced run goes through the spend
 *    meter's `reserve()` (worst-case projection from the committed
 *    `budget.json` knob) before it executes, and `settle()`s to actual
 *    usage after — cache hits (the `cacheReadTokens` subset of prompt
 *    tokens recorded in `usage_json`) settle at the cache-hit rate;
 *    everything else, misses and cache writes alike, settles at the
 *    cache-miss rate (over-counts, never under-counts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line no-restricted-imports -- evals tooling reaches into the collector e2e kit; evals/briefs is not a workspace package, so there is no package-name path to it
import type { ScorecardRunGuard } from "../../../packages/collector/src/e2e/briefs-scorecard.js";
import type { SpendMeter, WorstCaseUsage } from "./spend-meter.js";

export class DeepseekLaneRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepseekLaneRefusedError";
  }
}

/**
 * Refuse the lane outright in any CI-like environment. Checked FIRST —
 * before config files are read, before anything network-shaped exists.
 */
export function assertDeepseekLaneAllowed(env: NodeJS.ProcessEnv): void {
  if (env.CI !== undefined && env.CI !== "") {
    throw new DeepseekLaneRefusedError(
      "the deepseek scorecard lane hard-refuses to run when CI is set — " +
        "priced runs are deliberate Phase Two iteration steps, never automation",
    );
  }
}

export function defaultOperatorConfigPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.OMNESIS_CONFIG_DIR ?? join(homedir(), ".config", "omnesis");
  return join(configDir, "omnesis.json");
}

export interface DeepseekBackendConfig {
  url: string;
  apiKey: string;
  source: "env" | "config";
}

/**
 * Resolve the deepseek backend: env overrides first, then the operator
 * config's `inference.backends.deepseek.{url,apiKey}`. Reading that
 * config field is sanctioned by the epic spec and is not corpus access.
 */
export function resolveDeepseekBackend(opts: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}): DeepseekBackendConfig {
  const envUrl = opts.env.OMNESIS_BRIEFS_DEEPSEEK_URL;
  const envKey = opts.env.OMNESIS_BRIEFS_DEEPSEEK_KEY;
  if (envUrl && envKey) return { url: envUrl, apiKey: envKey, source: "env" };
  if (envUrl || envKey) {
    throw new Error(
      "OMNESIS_BRIEFS_DEEPSEEK_URL and OMNESIS_BRIEFS_DEEPSEEK_KEY must be set together",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(opts.configPath, "utf8");
  } catch {
    throw new Error(
      `no deepseek backend: set OMNESIS_BRIEFS_DEEPSEEK_URL/_KEY or configure ` +
        `inference.backends.deepseek in ${opts.configPath}`,
    );
  }
  const config = JSON.parse(raw) as {
    inference?: { backends?: Record<string, { url?: unknown; apiKey?: unknown }> };
  };
  const backend = config.inference?.backends?.deepseek;
  const url = typeof backend?.url === "string" ? backend.url : null;
  const apiKey = typeof backend?.apiKey === "string" ? backend.apiKey : null;
  if (!url || !apiKey) {
    throw new Error(
      `no deepseek backend: inference.backends.deepseek.{url,apiKey} missing in ${opts.configPath}`,
    );
  }
  return { url, apiKey, source: "config" };
}

/** The one printable projection of a resolved backend — never the key. */
export function describeDeepseekBackend(config: DeepseekBackendConfig): string {
  return `deepseek backend at ${config.url} (from ${config.source}, apiKey <redacted>)`;
}

/**
 * The worst-case per-run projection the meter reserves before each priced
 * run, from the committed `budget.json`. Deliberately conservative: prompt
 * tokens are CUMULATIVE across a run's tool rounds, so this is sized for a
 * deep multi-round research run, not a median one.
 */
export function loadWorstCasePerRun(budgetPath: string): WorstCaseUsage {
  const raw = JSON.parse(readFileSync(budgetPath, "utf8")) as {
    worstCasePerRun?: { promptTokens?: unknown; completionTokens?: unknown };
  };
  const worstCase = raw.worstCasePerRun;
  const promptTokens = worstCase?.promptTokens;
  const completionTokens = worstCase?.completionTokens;
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    promptTokens <= 0 ||
    typeof completionTokens !== "number" ||
    !Number.isFinite(completionTokens) ||
    completionTokens <= 0
  ) {
    throw new Error(
      `${budgetPath}: worstCasePerRun.{promptTokens,completionTokens} must be positive numbers`,
    );
  }
  return { promptTokens, completionTokens };
}

/**
 * The reserve-then-run guard the scorecard delivery threads around every
 * priced run. `invocationId` namespaces this scorecard invocation's
 * receipts in the (append-only, cross-invocation) ledgers.
 */
export function createMeteredRunGuard(
  meter: SpendMeter,
  invocationId: string,
  worstCase: WorstCaseUsage,
): ScorecardRunGuard {
  return {
    reserve(datumKey) {
      meter.reserve(`${invocationId}:${datumKey}`, worstCase);
    },
    settle(datumKey, usage) {
      // usage_json carries the cache split (cacheReadTokens is the cached
      // subset of promptTokens); price hits at the hit rate and everything
      // else — misses and cache writes alike — at the miss rate, which can
      // only over-count.
      const hit = Math.min(usage.cacheReadTokens, usage.promptTokens);
      meter.settle(`${invocationId}:${datumKey}`, {
        promptCacheHitTokens: hit,
        promptCacheMissTokens: usage.promptTokens - hit,
        completionTokens: usage.completionTokens,
      });
    },
  };
}

/**
 * The durable out-of-repo spend ledger. Pairs with the committed in-repo
 * spend-receipt journal (`evals/briefs/spend-ledger.jsonl`); cumulative
 * spend is the max of the two, so an eviction, a rebase, or an unpushed
 * worktree can only over-count. Distinct from `evals/briefs/ledger.jsonl`,
 * which is the committed iteration-history (scorecard rows), not a spend
 * journal.
 */
export function defaultDurableLedgerPath(env: NodeJS.ProcessEnv): string {
  return (
    env.OMNESIS_BRIEFS_SPEND_LEDGER ??
    join(homedir(), ".config", "omnesis-epic", "briefs-spend.jsonl")
  );
}
