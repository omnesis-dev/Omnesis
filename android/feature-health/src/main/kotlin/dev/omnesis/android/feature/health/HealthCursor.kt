// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement

/**
 * Sync cursor for the Health Connect source, persisted server-side as the opaque
 * JSON blob on `/sync-state/:sourceId` (the gateway stores whatever the device
 * posts and hands it back on GET — the Android analogue of `AppleHealthCursor`).
 *
 * - [tokens] — per-type Changes-API token, keyed by [CatalogEntry.name]. A
 *   missing key means the type has never baselined (or was dropped after a
 *   permission revocation) and the next sync does a full read.
 * - [lastFullSyncAt] — ISO-8601 timestamp of the last completed sync pass, for
 *   "last synced N minutes ago" UI.
 *
 * Decoding is tolerant: malformed or missing cursor JSON falls back to the empty
 * cursor, which simply re-baselines every type (idempotent via PK upsert).
 */
@Serializable
data class HealthCursor(
    val tokens: Map<String, String> = emptyMap(),
    val lastFullSyncAt: String? = null,
) {
    fun tokenFor(name: String): String? = tokens[name]

    /** Returns a copy with [name]'s token replaced; a null [token] removes the key. */
    fun withToken(name: String, token: String?): HealthCursor =
        copy(tokens = if (token == null) tokens - name else tokens + (name to token))

    fun toJsonElement(): JsonElement = OmnesisJson.encodeToJsonElement(this)

    companion object {
        fun fromJsonElement(element: JsonElement?): HealthCursor {
            if (element == null) return HealthCursor()
            return try {
                OmnesisJson.decodeFromJsonElement(serializer(), element)
            } catch (e: SerializationException) {
                HealthCursor()
            } catch (e: IllegalArgumentException) {
                HealthCursor()
            }
        }
    }
}
