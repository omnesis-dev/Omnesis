// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * A spawned E2E gateway exercises the production worker paths, but its tiny
 * synthetic corpus does not need production-sized pools. Keeping the pools
 * small lowers both the per-file memory floor and the cost of booting several
 * independent E2E files at once.
 *
 * Explicit non-feature caller values win so concurrency/soak tests can opt
 * back into a larger pool when the pool size itself is under test. Feature
 * gates are removed below and must be reintroduced deliberately by a harness.
 */
const E2E_GATEWAY_DEFAULTS: Readonly<NodeJS.ProcessEnv> = {
  OMNESIS_IO_CONCURRENCY: "2",
  OMNESIS_CPU_CONCURRENCY: "2",
  OMNESIS_SEARCH_WORKER_CONCURRENCY: "1",
  OMNESIS_USEARCH_BACKFILL_THREADS: "1",
};

const E2E_INTERNAL_DEFAULTS: Readonly<NodeJS.ProcessEnv> = {
  // Spawned gateways must never turn a test run into a release-network probe.
  OMNESIS_E2E_DISABLE_RELEASE_CHECK: "1",
};

const require = createRequire(import.meta.url);
const TSX_ENTRY = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

export function e2eGatewayEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const inherited = { ...base };
  delete inherited.OMNESIS_SYNTHETIC;
  delete inherited.OMNESIS_EXPERIMENTAL;
  return { ...E2E_GATEWAY_DEFAULTS, ...inherited, ...E2E_INTERNAL_DEFAULTS };
}

/** Avoid the extra `npx → tsx` wrapper processes around every test gateway. */
export function e2eTsxCommand(entry: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [TSX_ENTRY, entry] };
}

/**
 * How long a spawned Gateway or external harness host may take to become ready.
 *
 * Read from `scripts/lib/gateway-boot-budget.json` rather than stated here.
 * Everything that spawns a gateway waits the same amount of time, because
 * independently chosen budgets are what made a loaded machine look like a
 * broken feature: a suite that dies in its hook reports as a failed file with
 * no failing test. The `why` field in that file carries the reasoning.
 */
export function gatewayBootBudgetMs(): number {
  const file = join(import.meta.dirname, "../../../..", "scripts/lib/gateway-boot-budget.json");
  const { seconds } = JSON.parse(readFileSync(file, "utf8")) as { seconds: number };
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${file} does not carry a usable boot budget (got ${String(seconds)})`);
  }
  return seconds * 1000;
}
