// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cooperative event-loop yield. `await yieldToEventLoop()` returns control to
 * the Node event loop for one turn, letting queued I/O callbacks (incoming HTTP
 * requests and their handlers — the interactive read path) run before the
 * caller resumes.
 *
 * Used to bound the main-thread stall of long synchronous CPU/read loops (e.g.
 * the ingest before-state capture and event emission over a large batch): the
 * loop processes a sub-batch, yields, and repeats, so a heavy ingest can no
 * longer freeze the whole gateway for seconds at a stretch. `setImmediate`
 * (not `Promise.resolve()` / `queueMicrotask`) is deliberate — a microtask
 * yield drains before I/O and would not let a pending request run.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Default sub-batch size between event-loop yields when walking a large ingest
 * batch. It's a latency/throughput pacing tradeoff, not a correctness bound:
 * smaller keeps interactive reads more responsive under heavy ingest at the
 * cost of more yield hops; larger reduces overhead at the cost of a longer
 * per-sub-batch stall. The right value is machine-dependent (dominated by the
 * per-row SELECT + metadata-parse cost on the encrypted store), so it's
 * exposed as the `gateway.ingestYieldBatch` config knob; this is the default.
 */
export const DEFAULT_INGEST_YIELD_BATCH = 250;
