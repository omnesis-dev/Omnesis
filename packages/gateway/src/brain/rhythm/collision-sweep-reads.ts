// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  findAnnotationContradictionCandidates,
  findCollisionCandidates,
  findTemporalAnnotationCollisionCandidates,
} from "../reconcile/collision-candidates.js";
import type { ReadPort } from "../../scheduler/read-port.js";

/**
 * The collision sweep's candidate selection, declared as a read port
 * (`scheduler/read-port.ts`) so each arm's read is one `io.<name>` op. Each
 * read groups a whole ledger — every open loop with its people and documents,
 * the temporal annotations in the forward window, every live annotation by
 * subject and claim type — and returns only the few candidates the sweep
 * enqueues, so the gateway runs them on a read worker rather than the main
 * event loop. The sweep only folds completed verdicts into its choice, which
 * its own enqueues never are, so a read's snapshot taken after the previous
 * arm's enqueues committed chooses exactly what the main handle would.
 */
export const COLLISION_SWEEP_READS = {
  /** Open loops sharing a person, document or deadline day; see `findCollisionCandidates`. */
  collisionLoopCandidates: findCollisionCandidates,
  /** Temporal annotations overlapping in the forward window; see `findTemporalAnnotationCollisionCandidates`. */
  collisionTemporalCandidates: findTemporalAnnotationCollisionCandidates,
  /** Disagreeing annotations on one subject; see `findAnnotationContradictionCandidates`. */
  collisionAnnotationContradictions: findAnnotationContradictionCandidates,
};

export type CollisionSweepReads = ReadPort<typeof COLLISION_SWEEP_READS>;
