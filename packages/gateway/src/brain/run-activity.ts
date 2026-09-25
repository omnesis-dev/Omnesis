// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory registry of the Cognition Steward runs executing RIGHT NOW.
 *
 * The queue keeps no `running` status on disk (an in-flight row stays
 * `pending` with a bumped `attempts` so a crash is naturally re-claimed),
 * which means the rows alone cannot distinguish "executing this instant"
 * from "claimed once, awaiting soft-retry". The drainer — the only thing
 * that executes runs — marks each run here around `driver.execute`, and
 * the operator surface (`/admin/brain/runs`) reads it to annotate run
 * DTOs with a truthful `running` flag. Process-local by design: a run can
 * only execute inside this gateway process.
 */
export class CognitionRunActivity {
  /** Run id → unix-ms start of the in-flight attempt. */
  private readonly running = new Map<string, number>();

  start(id: string, at: number): void {
    this.running.set(id, at);
  }

  settle(id: string): void {
    this.running.delete(id);
  }

  /** Start time (unix ms) of the run's in-flight attempt; null when not executing. */
  startedAtMs(id: string): number | null {
    return this.running.get(id) ?? null;
  }

  /** Snapshot the ids currently executing for the lightweight admin pulse. */
  runningIds(): string[] {
    return [...this.running.keys()];
  }

  get count(): number {
    return this.running.size;
  }
}
