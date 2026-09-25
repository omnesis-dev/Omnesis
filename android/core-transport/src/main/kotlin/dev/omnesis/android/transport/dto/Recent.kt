// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * `GET /sources/:id/recent` — a tagged union keyed on `kind`. Mirrors the iOS
 * `RecentItemsResponse`. An unknown kind decodes to [Empty] (forward-compatible).
 * Every arm carries the envelope's gateway-internal flag (absent on older
 * gateways → false) so screens prefer it over the separately-fetched sources
 * list when choosing the delete prompt.
 */
@Serializable(with = RecentItemsResponseSerializer::class)
sealed interface RecentItemsResponse {
    val isInternal: Boolean

    @Serializable
    data class Documents(
        val documents: List<RecentDocument> = emptyList(),
        override val pageInfo: PageInfo = PageInfo(limit = documents.size),
        @SerialName("internal") override val isInternal: Boolean = false,
    ) : RecentItemsResponse

    @Serializable
    data class Analytics(
        val table: String,
        val displayName: String = "",
        val columns: List<String> = emptyList(),
        val rows: List<List<JsonElement>> = emptyList(),
        override val pageInfo: PageInfo = PageInfo(limit = rows.size),
        @SerialName("internal") override val isInternal: Boolean = false,
    ) : RecentItemsResponse

    @Serializable
    data class Empty(
        @SerialName("internal") override val isInternal: Boolean = false,
        override val pageInfo: PageInfo = PageInfo(),
    ) : RecentItemsResponse

    val pageInfo: PageInfo
}

object RecentItemsResponseSerializer :
    JsonContentPolymorphicSerializer<RecentItemsResponse>(RecentItemsResponse::class) {
    override fun selectDeserializer(
        element: JsonElement,
    ): DeserializationStrategy<RecentItemsResponse> =
        when (element.jsonObject["kind"]?.jsonPrimitive?.contentOrNull) {
            "documents" -> RecentItemsResponse.Documents.serializer()
            "analytics" -> RecentItemsResponse.Analytics.serializer()
            else -> RecentItemsResponse.Empty.serializer()
        }
}

@Serializable
data class RecentDocument(
    val id: String,
    val sourceId: String,
    val externalId: String = "",
    val title: String,
    val contentPreview: String? = null,
    val documentType: String? = null,
    val relevanceScore: Double? = null,
    val sourceCreatedAt: String,
    val sourceUpdatedAt: String? = null,
)
