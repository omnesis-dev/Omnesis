// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { IndexerWorkerProxy } from "../workers/indexer-worker-proxy.js";

/**
 * Indexer worker lifecycle — tracks whether the embedding model is
 * actually attached to the search pipeline. Used by the portal so a
 * deep search initiated during the ~15s model-load window gets a
 * "warming up" banner instead of silently degrading to BM25-only.
 */
export type IndexerReadiness =
  | { status: "spawning"; message?: string }
  | {
      status: "loading-model";
      message?: string;
      stage?: string;
      progress?: number;
    }
  | { status: "ready" }
  | { status: "failed"; reason: string }
  | { status: "disabled"; reason: string };

/**
 * Holds the user-facing embedder/indexer-worker {@link IndexerReadiness}
 * signal. Pure reporting state: the indexer lifecycle writes it through the
 * setter as the worker spawns / loads / fails, and the HTTP layer + model
 * manager read it. `getReadiness` overlays the worker's live boot progress
 * while the model is loading so the portal banner ticks up.
 */
export class IndexerStatusReporter {
  private readiness: IndexerReadiness = { status: "spawning" };
  private activeIndexerProxy: IndexerWorkerProxy | null = null;

  setReadiness(s: IndexerReadiness, proxy?: IndexerWorkerProxy): void {
    this.readiness = s;
    this.activeIndexerProxy = proxy ?? null;
  }

  getReadiness(): IndexerReadiness {
    if (this.readiness.status === "loading-model" && this.activeIndexerProxy) {
      const bp = this.activeIndexerProxy.bootProgress;
      if (bp) {
        return { ...this.readiness, stage: bp.stage, progress: bp.progress };
      }
    }
    return this.readiness;
  }
}
