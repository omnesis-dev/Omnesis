// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-run tracker of the annotation PRIORS a steward run has actually
 * SEEN — the "consumed" half of consumption provenance. Fed from every
 * surface that puts a prior in front of the model:
 *
 *  - `annotation_search` results (the tool notes each returned id);
 *  - priors inlined into the run prompt (the prompt builder notes what the
 *    synthesis delta-prime, verification and contradiction prompts list);
 *  - the injected self-memory (noted at toolset build).
 *
 * Each brief/loop create/update explicitly names the surfaced priors that
 * materially informed that mutation. The tool layer validates that selection
 * against this tracker and records only those prior→dependent edges
 * (`storage/consumption-edges.ts`). One tracker per run — created by the
 * runtime per claimed run and never shared across runs.
 */

import type { ConsumptionPriorStore } from "../storage/consumption-edges.js";

/** One consumed prior reference. */
export interface ConsumedAnnotationRef {
  store: ConsumptionPriorStore;
  annotationId: string;
}

/** Mutable per-run consumed-prior set (insertion-ordered, deduped). */
export class RunConsumptionTracker {
  private readonly refs = new Map<string, ConsumedAnnotationRef>();

  /** Note that `ids` from `store` were surfaced to the model this run. */
  note(store: ConsumptionPriorStore, ids: readonly string[]): void {
    for (const annotationId of ids) {
      const key = `${store}:${annotationId}`;
      if (!this.refs.has(key)) this.refs.set(key, { store, annotationId });
    }
  }

  /** Resolve an output's declared dependencies, rejecting unseen priors. */
  select(
    refs: readonly ConsumedAnnotationRef[],
  ): { ok: true; refs: ConsumedAnnotationRef[] } | { ok: false; unseen: ConsumedAnnotationRef[] } {
    const selected = new Map<string, ConsumedAnnotationRef>();
    const unseen = new Map<string, ConsumedAnnotationRef>();
    for (const ref of refs) {
      const key = `${ref.store}:${ref.annotationId}`;
      if (this.refs.has(key)) selected.set(key, ref);
      else unseen.set(key, ref);
    }
    return unseen.size === 0
      ? { ok: true, refs: [...selected.values()] }
      : { ok: false, unseen: [...unseen.values()] };
  }
}
