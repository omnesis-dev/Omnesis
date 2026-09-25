// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `WriterQueueInspector` — live writer-runner queue introspection used
 * by the gateway's metrics heartbeat (`MetricsRegistry.recordWriterQueueDepth`)
 * and the /portal/debug dashboard. Scoped to the writer runner since
 * that's where queue pressure becomes user-visible; other runners
 * surface via the metrics snapshot.
 *
 * Pulled out of the original 878-line `Scheduler` class.
 */

import { PRIORITIES } from "./internals.js";
import type { Priority, RunnerKind } from "./types.js";
import type { RunnerState } from "./internals.js";

export class WriterQueueInspector {
  constructor(private readonly runners: Map<RunnerKind, RunnerState>) {}

  /** Total queued + in-flight across all priorities on the writer runner. */
  pendingCount(): number {
    const w = this.runners.get("writer");
    if (!w) return 0;
    return (
      w.queues.user.length + w.queues.realtime.length + w.queues.background.length + w.inflight.size
    );
  }

  /** Per-priority queue depth on the writer runner (queued, not in-flight). */
  queueDepthByPriority(): { user: number; realtime: number; background: number } {
    const w = this.runners.get("writer");
    if (!w) return { user: 0, realtime: 0, background: 0 };
    return {
      user: w.queues.user.length,
      realtime: w.queues.realtime.length,
      background: w.queues.background.length,
    };
  }

  /**
   * Current pending writer-runner queue grouped by op name. Returned
   * sorted by count desc so the top-of-queue offenders show first in
   * the debug panel.
   */
  queueDepthByOp(): Array<{ op: string; count: number; priority: Priority }> {
    const w = this.runners.get("writer");
    if (!w) return [];
    const counts = new Map<string, { count: number; priority: Priority }>();
    for (const prio of PRIORITIES) {
      for (const p of w.queues[prio]) {
        const key = p.task.name;
        const e = counts.get(key);
        if (e) {
          e.count += 1;
        } else {
          counts.set(key, { count: 1, priority: prio });
        }
      }
    }
    return Array.from(counts.entries())
      .map(([op, { count, priority }]) => ({ op, count, priority }))
      .sort((a, b) => b.count - a.count);
  }
}
