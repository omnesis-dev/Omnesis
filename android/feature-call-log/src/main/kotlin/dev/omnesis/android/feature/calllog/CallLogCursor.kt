// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Persisted sync-state cursor for [CallLogSource]. Mirrors `apple-call-log`'s
 * `(lastModifiedTimestamp, lastModifiedRowId)` watermark plus an insertion
 * high-water mark used as a rebuild guard, but without an intra-cycle page
 * position — a `ContentResolver` query is iterated fully in one local pass,
 * unlike the HTTP-paginated Health Connect Changes API.
 */
data class CallLogCursor(
    val lastDateMillis: Long = 0,
    val lastId: Long = 0,
    val insertIdHighWater: Long = 0,
) {
    fun toJsonElement(): JsonElement = buildJsonObject {
        put("lastDateMillis", JsonPrimitive(lastDateMillis))
        put("lastId", JsonPrimitive(lastId))
        put("insertIdHighWater", JsonPrimitive(insertIdHighWater))
    }

    companion object {
        fun fromJsonElement(element: JsonElement?): CallLogCursor {
            if (element == null) return CallLogCursor()
            return runCatching {
                val obj = element as? JsonObject ?: return CallLogCursor()
                CallLogCursor(
                    lastDateMillis = obj["lastDateMillis"]?.jsonPrimitive?.longOrNull ?: 0,
                    lastId = obj["lastId"]?.jsonPrimitive?.longOrNull ?: 0,
                    insertIdHighWater = obj["insertIdHighWater"]?.jsonPrimitive?.longOrNull ?: 0,
                )
            }.getOrDefault(CallLogCursor())
        }
    }
}
