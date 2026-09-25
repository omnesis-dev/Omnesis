// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.AnalyticsIngestBody
import dev.omnesis.android.transport.dto.AnalyticsIngestResponse
import dev.omnesis.android.transport.dto.SyncStateBody
import dev.omnesis.android.transport.dto.SyncStateResponse
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.getJson
import dev.omnesis.android.transport.http.postJson
import kotlinx.serialization.json.JsonElement

/**
 * The structured-source push surface: analytics ingest plus the opaque sync-state
 * cursor. This is the generic gateway capability a device-hosted source (Health
 * Connect on Android, Apple Health on iOS) drains its pages through — the Android
 * port of the iOS `GatewayClient.ingestAnalyticsRecords` / `get`/`setSyncState`.
 *
 * Requires a token carrying a `write:*` scope for ingest and `admin` for
 * sync-state (the android device kind's default grant has both).
 */
class AnalyticsClient(private val http: GatewayHttp) {

    /** `POST /analytics/ingest` — upsert one page of one table, applying any tombstones. */
    suspend fun ingest(body: AnalyticsIngestBody): AnalyticsIngestResponse =
        http.postJson("analytics/ingest", body)

    /** `GET /sync-state/:sourceId` — the persisted cursor, or null before the first sync. */
    suspend fun getSyncState(sourceId: String): SyncStateResponse? = try {
        http.getJson<SyncStateResponse>("sync-state/$sourceId")
    } catch (_: GatewayException.NotFound) {
        null
    }

    /** `POST /sync-state/:sourceId` — persist the cursor (+ optional display label/icon). */
    suspend fun setSyncState(sourceId: String, body: SyncStateBody) {
        // Response shape isn't load-bearing; decode as a bare element and discard.
        http.postJson<SyncStateBody, JsonElement>("sync-state/$sourceId", body)
    }
}
