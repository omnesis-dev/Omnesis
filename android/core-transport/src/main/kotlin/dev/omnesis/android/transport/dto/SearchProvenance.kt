// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** Optional graph evidence from `searchProvenanceSchema` in @omnesis/core. */
@Serializable
data class SearchProvenance(
    val copies: List<SearchGraphDocument> = emptyList(),
    val paths: List<SearchGraphPath> = emptyList(),
    val truncated: Boolean = false,
    val stopReasons: List<String> = emptyList(),
    val modelContext: SearchGraphModelContext? = null,
)

@Serializable
data class SearchGraphDocument(
    val documentId: String,
    val sourceId: String = "",
    val title: String? = null,
    val deviceName: String? = null,
    val path: String? = null,
)

@Serializable
data class SearchGraphPath(
    val documentIds: List<String> = emptyList(),
    val edges: List<String> = emptyList(),
    val relations: List<String>? = null,
)

@Serializable
data class SearchGraphModelContext(
    val documents: List<SearchGraphDocument> = emptyList(),
)

@Serializable
data class SearchReadiness(val graphContextAvailable: Boolean = false)
