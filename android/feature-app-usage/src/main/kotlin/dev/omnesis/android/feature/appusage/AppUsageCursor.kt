// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Persisted sync-state cursor for [AppUsageSource]. `UsageEvents.Event` has no
 * stable per-event id the way `CallLog.Calls._ID` does — just a wall-clock
 * `timeStamp` — so the watermark is a single "queried through" instant: each
 * sync pass reads `[lastQueriedThroughMillis, now)` to find which UTC days
 * have new events, then re-derives each affected day from a fresh full-day
 * query (mirroring `CallLogCursor`'s day-rebuild pattern, minus the
 * insertion-id high-water mark that pattern needs only because `CallLog`
 * rows can arrive out of date order).
 */
data class AppUsageCursor(
    val lastQueriedThroughMillis: Long = 0,
) {
    fun toJsonElement(): JsonElement = buildJsonObject {
        put("lastQueriedThroughMillis", JsonPrimitive(lastQueriedThroughMillis))
    }

    companion object {
        fun fromJsonElement(element: JsonElement?): AppUsageCursor {
            if (element == null) return AppUsageCursor()
            return runCatching {
                val obj = element as? JsonObject ?: return AppUsageCursor()
                AppUsageCursor(
                    lastQueriedThroughMillis = obj["lastQueriedThroughMillis"]?.jsonPrimitive?.longOrNull ?: 0,
                )
            }.getOrDefault(AppUsageCursor())
        }
    }
}
