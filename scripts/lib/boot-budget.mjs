// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one boot budget, for JavaScript and TypeScript callers.
 *
 * The number and the reasoning for it live in `gateway-boot-budget.json`
 * beside this file; shell callers read the same file through `boot_budget`.
 * Read it here rather than restating it — four independently chosen budgets is
 * what produced four different false reds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Seconds to wait for a spawned gateway to serve `/health`. */
export function gatewayBootBudgetSeconds() {
  const file = join(import.meta.dirname, "gateway-boot-budget.json");
  const { seconds } = JSON.parse(readFileSync(file, "utf8"));
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${file} does not carry a usable boot budget (got ${String(seconds)})`);
  }
  return seconds;
}

/** The same budget in milliseconds, for the callers that count that way. */
export function gatewayBootBudgetMs() {
  return gatewayBootBudgetSeconds() * 1000;
}
