// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** `GET /index/stats` — embedding-indexer progress. Mirrors the iOS `IndexStats`. */
@Serializable
data class IndexStats(
    val enabled: Boolean = false,
    val state: String? = null,
    val totalIndexed: Int? = null,
    /** Docs the indexer terminally errored; folded into completion so a
     *  fully-attempted corpus reads 100%. */
    val totalIndexErrors: Int? = null,
    val totalChunks: Int? = null,
    val watermark: String? = null,
    val model: Model? = null,
    val bySource: Map<String, BySource>? = null,
) {
    @Serializable
    data class Model(
        val name: String? = null,
        val path: String? = null,
        val present: Boolean? = null,
    )

    @Serializable
    data class BySource(
        val indexedDocs: Int? = null,
        val gatewayDocs: Int? = null,
        val chunks: Int? = null,
        val percentIndexed: Double? = null,
        val indexErrors: Int? = null,
        val earliestIndexedDate: String? = null,
        val latestIndexedDate: String? = null,
    )
}
