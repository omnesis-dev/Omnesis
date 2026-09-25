// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** Request body for `POST /search`. Mirrors the iOS `SearchClient.Body`. */
@Serializable
data class SearchBody(
    val text: String,
    val limit: Int? = null,
    val verbose: Boolean? = null,
)

/** `POST /search` response. Mirrors the iOS `SearchResponse`. */
@Serializable
data class SearchResponse(
    val results: List<SearchResultItem> = emptyList(),
    val models: SearchModels? = null,
    val query: SearchQueryReport? = null,
    val timing: SearchTiming? = null,
    val stages: SearchStages? = null,
    val debug: SearchDebugInfo? = null,
)

@Serializable
data class SearchModels(
    val embedding: String? = null,
)

@Serializable
data class SearchQueryReport(
    val original: String? = null,
    val effectiveText: String? = null,
)

@Serializable
data class SearchTiming(
    val totalMs: Double? = null,
    val bm25Ms: Double? = null,
    val vectorMs: Double? = null,
    val bm25Candidates: Int? = null,
    val vectorCandidates: Int? = null,
)

@Serializable
data class SearchStageReport(
    val status: String? = null,
    val reason: String? = null,
    val durationMs: Double? = null,
    val candidates: Int? = null,
    val method: String? = null,
    val rrfK: Int? = null,
    val bm25Weight: Double? = null,
    val vectorWeight: Double? = null,
    val resultCount: Int? = null,
    val quantization: String? = null,
    val rescore: Boolean? = null,
    val effectiveK: Int? = null,
    val embedMs: Double? = null,
    val sqlMs: Double? = null,
)

@Serializable
data class SearchStages(
    val bm25: SearchStageReport? = null,
    val vector: SearchStageReport? = null,
    val fusion: SearchStageReport? = null,
    val boost: SearchStageReport? = null,
    val refCount: SearchStageReport? = null,
)

@Serializable
data class SearchDebugInfo(
    val modelState: ModelState? = null,
    val query: QueryLengths? = null,
) {
    @Serializable
    data class ModelState(
        val vector: String? = null,
    )

    @Serializable
    data class QueryLengths(
        val inputLength: Int? = null,
    )
}

/** One hit in a [SearchResponse]. Mirrors the iOS `SearchResultItem`. */
@Serializable
data class SearchResultItem(
    val documentId: String,
    val sourceId: String,
    val documentType: String,
    val title: String,
    val sourceUrl: String? = null,
    val appUrl: String? = null,
    val sourceCreatedAt: String,
    val author: String? = null,
    val chunkText: String,
    val score: Double,
    val refCount: Int? = null,
    val scoreBreakdown: SearchScoreBreakdown? = null,
)

@Serializable
data class SearchScoreBreakdown(
    val bm25Rank: Int? = null,
    val vectorRank: Int? = null,
    val rrfScore: Double? = null,
    val rankBonus: Double? = null,
    val typeBoost: Double? = null,
    val relevanceBoost: Double? = null,
    val sourcePrior: Double? = null,
    val finalScore: Double? = null,
)
