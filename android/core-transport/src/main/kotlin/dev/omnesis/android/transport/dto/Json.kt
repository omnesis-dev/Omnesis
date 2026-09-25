// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive

/**
 * Shared JSON codec for every gateway DTO. Forward-compatible: unknown fields are
 * ignored and missing optionals fall back to defaults, so a newer gateway never
 * crashes an older client (mirrors the iOS decoders' behavior).
 */
val OmnesisJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
}

/**
 * Decodes a field that the gateway may send either as a JSON object/array OR as a
 * stringified-JSON string (e.g. `DocumentDetail.metadata`, a TEXT column). A string
 * payload is re-parsed into a [JsonElement]; anything else is taken as-is. Mirrors
 * the iOS "string-then-parse OR pre-parsed object" handling.
 */
object FlexibleJsonElementSerializer : KSerializer<JsonElement> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): JsonElement {
        val input = decoder as? JsonDecoder
            ?: error("FlexibleJsonElementSerializer requires a JSON decoder")
        val element = input.decodeJsonElement()
        if (element is JsonPrimitive && element.isString) {
            return runCatching { input.json.parseToJsonElement(element.content) }
                .getOrDefault(element)
        }
        return element
    }

    override fun serialize(encoder: Encoder, value: JsonElement) {
        (encoder as JsonEncoder).encodeJsonElement(value)
    }
}
