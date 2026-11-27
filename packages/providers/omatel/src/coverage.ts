// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { HistoryCoverage } from "@omnesis/source-sdk";

/**
 * omatel keeps every message and call until the owner deletes it, and each
 * page reads the whole store, so without a data cutoff what Omnesis holds is
 * everything the phone's apps hold. History from before omatel (another
 * phone, an import the owner never ran) was never in the store at all.
 */
export function historyCoverage(dataCutoff: string | undefined): {
  coverage: HistoryCoverage;
  detail: string;
} {
  return dataCutoff
    ? {
        coverage: "partial",
        detail: `Only history from ${dataCutoff.slice(0, 10)} on is read, as the source's data cutoff asks.`,
      }
    : {
        coverage: "complete",
        detail:
          "Everything the phone's Messages and Phone apps keep is read. History they never held, such as messages from a previous phone, is not.",
      };
}
