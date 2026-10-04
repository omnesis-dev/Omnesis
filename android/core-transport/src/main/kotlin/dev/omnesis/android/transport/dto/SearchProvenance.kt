// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder

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

/**
 * Reads a search hit's optional `provenance`, decoding a block this build cannot
 * read as null for that hit so one malformed block never fails the whole search
 * response. Mirrors the iOS `SearchResultItem` decoder.
 */
object LenientSearchProvenanceSerializer : KSerializer<SearchProvenance?> {
    private val delegate = SearchProvenance.serializer().nullable

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): SearchProvenance? {
        val input = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        val element = input.decodeJsonElement()
        return try {
            input.json.decodeFromJsonElement(delegate, element)
        } catch (_: IllegalArgumentException) {
            // SerializationException is an IllegalArgumentException.
            null
        }
    }

    override fun serialize(encoder: Encoder, value: SearchProvenance?) = delegate.serialize(encoder, value)
}

@Serializable
data class SearchReadiness(val graphContextAvailable: Boolean = false)
