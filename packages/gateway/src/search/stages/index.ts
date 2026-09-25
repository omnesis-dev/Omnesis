// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type { SearchStage, SearchStageContext, SearchStageDeps } from "./stage.js";
// The only main-thread stage the pipeline still orchestrates directly:
// ref-count, an `omnesis.db` enrichment that runs after candidate generation.
export { RefCountStage } from "./ref-count-stage.js";
// BM25, vector, fusion, boost, and diversity moved into the synchronous
// candidate-generation core (`../candidate-gen.ts`). `BoostStage` /
// `DiversityStage` remain as thin wrappers over the shared pure functions
// (`applyBoostPass`, `diversityReorder`) for their unit tests.
export { BoostStage } from "./boost-stage.js";
export { DiversityStage } from "./diversity-stage.js";
// PersonFilterStage was removed — the filter is now
// pushed into the BM25 + vector candidate SQL via the docId list on
// `SearchStageContext.allowedDocumentIds`.
