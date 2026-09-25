// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.WatchDetailDto
import dev.omnesis.android.transport.dto.WatchDisclosureDto
import dev.omnesis.android.transport.dto.WatchFiringsDto
import dev.omnesis.android.transport.dto.WatchListDto
import dev.omnesis.android.transport.dto.WatchRecordDto
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.getJson
import dev.omnesis.android.transport.http.getPrivateJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject

/**
 * The watch runtime's read surface. Mirrors the iOS `WatchesClient`.
 *
 * Admin-scoped: a watch's definition and its firings are the operator's own
 * view of what their index is being asked, which is not something a paired
 * integration is granted.
 *
 * Reads only. A watch is created by asking for one in conversation or from the
 * CLI, and removed the same way; a phone that could delete one from a list
 * would be the easiest place to do it by accident.
 */
class WatchesClient(private val http: GatewayHttp) {

    /** `GET /admin/watch/watches` — every watch the runtime is running. */
    suspend fun list(): List<WatchRecordDto> =
        http.getJson<WatchListDto>("admin/watch/watches").watches

    /**
     * `GET /admin/watch/watches/:id/firings` — what one watch has said.
     *
     * Oldest first, as the runtime recorded them; the screen sorts. `limit`
     * bounds the read because every firing carries a decoded payload and a
     * watch that has run for a week has a great many.
     */
    suspend fun firings(watchId: String, limit: Int = 50): WatchFiringsDto = http.getPrivateJson(
        listOf("admin", "watch", "watches", watchId, "firings"),
        mapOf("limit" to limit.toString()),
    )

    /**
     * `GET /admin/watch/watches/:id` — the spec the runtime is actually
     * running, pretty-printed.
     *
     * Only the `dsl` is returned. The surrounding record is the same status, note and
     * disclosure the screen already shows in its own words, and printing it again as raw JSON
     * buries the definition the reader opened this for.
     *
     * Rendered as text rather than parsed: the DSL is the runtime's contract,
     * not the app's, and a phone that decoded it into a typed shape would have
     * to be upgraded in step with every change to the language.
     */
    suspend fun definition(watchId: String): String {
        val dsl = readWatch(watchId).watch.jsonObject["dsl"]
            ?: throw IllegalStateException("the watch came back without its definition")
        return PRETTY.encodeToString(JsonElement.serializer(), dsl)
    }

    /**
     * The record of what this watch may tell an integration, from the same single-watch read.
     *
     * Null when the watch discloses nothing — the operator asked for it themselves and nothing
     * outside Omnesis hears when it fires.
     */
    suspend fun disclosure(watchId: String): WatchDisclosureDto? {
        val disclosure = readWatch(watchId).watch.jsonObject["disclosure"] ?: return null
        if (disclosure is JsonNull) return null
        return LENIENT.decodeFromJsonElement(WatchDisclosureDto.serializer(), disclosure)
    }

    private suspend fun readWatch(watchId: String): WatchDetailDto =
        http.getPrivateJson(listOf("admin", "watch", "watches", watchId))

    private companion object {
        val PRETTY = Json { prettyPrint = true }
        val LENIENT = Json { ignoreUnknownKeys = true }
    }
}
