// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Production glue for the near-duplicate edge type. Pure algorithm
 * primitives live in `@omnesis/near-dupes`; this module owns the
 * gateway-side state, scheduler hooks, and HTTP read surface.
 *
 * **What's in this barrel.** Only the surface that the gateway's
 * route layer + boot wiring + write-gate adapters legitimately
 * consume:
 *
 *   - `resolveNearDupConfig` / `DEFAULT_NEAR_DUP_CONFIG` /
 *     `ResolvedNearDupConfig` — config flow from `omnesis.json` into
 *     the periodic tasks and the writer/compute handlers.
 *   - `subscribeNearDupInbox` — the event-bus wiring for boot.
 *   - `getNearDupEdges` + cursor encoder/decoder + DTOs — the
 *     HTTP read surface (`GET /documents/:id/near-dupes`).
 *
 * **What's NOT in this barrel.** Everything else is internal to the
 * scheduler dispatch (compute / writer handlers) or directly imported
 * by tests via deep paths:
 *
 *   - `applyNearDupBatch`, `applyNearDupDfFromStaging`, `bumpNearDupAlgo`,
 *     `algoSweepStep` — invoked only by `scheduler/writer-handlers.ts`
 *     via direct file imports.
 *   - `computeNearDupBatch`, `computeNearDupDfSnapshot`,
 *     `buildInMemoryDfFromTable` — invoked only by
 *     `scheduler/io-handlers.ts` via direct file imports.
 *   - `inbox.ts`, `meta.ts`, `eligibility.ts` low-level helpers — the
 *     above services + tests reach into them as needed.
 *
 * The shrunken barrel matches the pattern set by `domain/MergeService.ts`,
 * `domain/LinkGraphService.ts`, etc. — only the cross-module callable
 * surface is exported.
 */

export {
  DEFAULT_NEAR_DUP_CONFIG,
  resolveNearDupConfig,
  type ResolvedNearDupConfig,
  type ResolvedGateConfig,
  type ResolvedSchedulerConfig,
} from "./config.js";
export { subscribeNearDupInbox, type NearDupEventHandlerOpts } from "./event-handler.js";
export { getNearDupEdges, type GetNearDupesOptions } from "./NearDupGraphService.js";
export type { NearDupEdgeDto, NearDupEdgesResponse } from "./types.js";
