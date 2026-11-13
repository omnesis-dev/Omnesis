// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

@Serializable
data class LabFlags(val brain: Boolean = false, val tasks: Boolean = false, val watches: Boolean = false)

@Serializable
data class LabFeature(val id: String, val name: String, val description: String, val enabled: Boolean, val iconSvg: String = "")

@Serializable
data class LabSnapshot(val experimental: Boolean = false, val features: List<LabFeature> = emptyList())

@Serializable
data class SetLabFeatureBody(val enabled: Boolean)

/** Missing status.lab keeps its null default; explicitly invalid values disable every feature. */
object StatusLabFlagsSerializer : KSerializer<LabFlags?> {
    override val descriptor = LabFlags.serializer().descriptor.nullable

    override fun deserialize(decoder: Decoder): LabFlags {
        val input = decoder as JsonDecoder
        val value = input.decodeJsonElement()
        if (value !is JsonObject) return LabFlags()
        return try {
            input.json.decodeFromJsonElement(LabFlags.serializer(), value)
        } catch (_: SerializationException) {
            LabFlags()
        }
    }

    override fun serialize(encoder: Encoder, value: LabFlags?) {
        val output = encoder as JsonEncoder
        output.encodeJsonElement(value?.let { output.json.encodeToJsonElement(LabFlags.serializer(), it) } ?: JsonNull)
    }
}
