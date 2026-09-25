// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ingest nudge. Without it a document arriving into an empty queue waits
 * out each drip's idle backoff before the stage even looks at it, which is the
 * dominant term in how long the readiness barrier holds an agent run.
 */

import { describe, expect, test, vi } from "vitest";
import { DERIVATION_STAGES } from "../../domain/DocumentDerivation.js";
import { subscribeDerivationNudge } from "./derivation-nudge.js";
import type { EventBus } from "../../events.js";

/** Minimal bus stand-in that records the subscription and can fire it. */
function fakeBus(): { bus: Pick<EventBus, "on">; emit: () => void } {
  const handlers: Array<() => void> = [];
  return {
    bus: { on: ((_event: string, fn: () => void) => handlers.push(fn)) as never },
    emit: () => handlers.forEach((fn) => fn()),
  };
}

describe("derivation nudge", () => {
  test("wakes every active stage's drip when a document arrives", () => {
    const kickPeriodic = vi.fn();
    const { bus, emit } = fakeBus();
    subscribeDerivationNudge({
      eventBus: bus,
      scheduler: { kickPeriodic },
      activeStages: () => DERIVATION_STAGES,
    });

    emit();

    expect(kickPeriodic.mock.calls.map((c) => c[0])).toEqual(
      DERIVATION_STAGES.map((s) => s.taskName),
    );
  });

  test("never wakes a stage whose producer is switched off", () => {
    // Kicking a task the scheduler never registered logs a warning on every
    // call — once per ingested document, which would drown the log.
    const kickPeriodic = vi.fn();
    const { bus, emit } = fakeBus();
    const active = DERIVATION_STAGES.filter((s) => s.id !== "dates");
    subscribeDerivationNudge({
      eventBus: bus,
      scheduler: { kickPeriodic },
      activeStages: () => active,
    });

    emit();

    const kicked = kickPeriodic.mock.calls.map((c) => c[0]);
    expect(kicked).not.toContain(DERIVATION_STAGES.find((s) => s.id === "dates")!.taskName);
    expect(kicked).toHaveLength(active.length);
  });

  test("re-reads which stages are active on every arrival", () => {
    // The gate is a live config read, so flipping a stage on must take effect
    // without a restart.
    const kickPeriodic = vi.fn();
    const { bus, emit } = fakeBus();
    let active: readonly (typeof DERIVATION_STAGES)[number][] = [];
    subscribeDerivationNudge({
      eventBus: bus,
      scheduler: { kickPeriodic },
      activeStages: () => active,
    });

    emit();
    expect(kickPeriodic).not.toHaveBeenCalled();

    active = DERIVATION_STAGES;
    emit();
    expect(kickPeriodic).toHaveBeenCalledTimes(DERIVATION_STAGES.length);
  });

  test("every registered stage names the task that fills its column", () => {
    // A stage with no task name would be silently un-nudgeable, which is the
    // drift the registry exists to prevent.
    for (const stage of DERIVATION_STAGES) {
      expect(stage.taskName).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });
});
