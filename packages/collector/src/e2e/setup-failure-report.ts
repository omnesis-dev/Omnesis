// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Logger } from "@omnesis/core";
import type { SourceSetupFailure } from "../source-instantiator.js";

/**
 * Report the sources a harness device could not instantiate.
 *
 * A source the universe declares in its seed list is part of the corpus the
 * test expects: when it fails, the corpus is short and the test fails far from
 * the cause, so the failure is an ERROR that names it. A source the universe
 * does not declare is one a synthetic twin discovered on its own — every twin
 * answers `discover()` in every universe, while a focused universe ships the
 * fixtures of its own sources only — so its failure is expected and stays at
 * debug, where it cannot bury a declared source's ERROR.
 */
export function reportSetupFailures(
  failures: readonly SourceSetupFailure[],
  declared: { has(sourceId: string): boolean },
  universe: string,
  log: Pick<Logger, "error" | "debug">,
): void {
  for (const failure of failures) {
    if (declared.has(failure.key)) {
      log.error(`Universe source ${failure.key} did not instantiate: ${failure.error}`);
    } else {
      log.debug(
        `Undeclared source ${failure.key} did not instantiate in universe '${universe}': ${failure.error}`,
      );
    }
  }
}
