// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wake the derivation drips when a document arrives, instead of letting it
 * wait out their idle backoff.
 *
 * Each derivation stage runs as a drip that polls for unprocessed documents
 * and, finding none, backs off to a long idle period. That is right for a
 * background sweep and wrong for anything waiting on the result: into an empty
 * queue, a freshly-ingested document is not looked at until the next idle tick,
 * so the time to derive it is dominated by poll cadence rather than by the work
 * itself. The cognition readiness barrier holds a document's agent run until
 * derivation finishes, which turns that dormancy into latency an operator can
 * feel.
 *
 * `kickPeriodic` reuses each task's own timer chain, so a kick can neither
 * overlap a running tick nor stack up: a burst of arrivals coalesces into one
 * trailing tick per task. That makes it safe to call per document without
 * debouncing here.
 *
 * Nudging is an optimisation, never a correctness requirement — the drips'
 * ordinary cadence still finds everything if no nudge ever arrives.
 */

import type { DerivationStage } from "../../domain/DocumentDerivation.js";
import type { EventBus } from "../../events.js";

export interface DerivationNudgeDeps {
  eventBus: Pick<EventBus, "on">;
  /** The scheduler seam — narrowed to the one method this needs. */
  scheduler: { kickPeriodic(taskName: string): void };
  /**
   * The stages whose drips are actually registered, re-read per event. Kicking
   * a task that was never scheduled logs a warning on every call, so a stage
   * whose producer is switched off must not be nudged — the same active-stage
   * question the readiness barrier asks, answered from the same place.
   */
  activeStages: () => readonly DerivationStage[];
}

/**
 * Subscribe the derivation drips to document arrivals. The subscription lives
 * as long as the gateway does, so there is nothing to unsubscribe.
 */
export function subscribeDerivationNudge(deps: DerivationNudgeDeps): void {
  deps.eventBus.on("document.upserted", () => {
    for (const stage of deps.activeStages()) {
      deps.scheduler.kickPeriodic(stage.taskName);
    }
  });
}
