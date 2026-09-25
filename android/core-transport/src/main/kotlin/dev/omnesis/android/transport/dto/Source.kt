// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * `GET /admin/sources`. Mirrors the iOS `SourceRecord`. [members] lists every
 * device hosting the source, owner first; a gateway that predates membership
 * omits it, in which case [deviceId] is the sole host.
 */
@Serializable
data class SourceRecord(
    val id: String,
    val type: String,
    val accountId: String = "",
    val deviceId: String = "",
    val config: Map<String, JsonElement> = emptyMap(),
    val enabled: Boolean = true,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val members: List<String> = emptyList(),
    /** How the source type shares its row across devices (`exclusive`, `handoff`, `replicated`, `partitioned`). */
    val multiDeviceMode: String? = null,
) {
    /** Whether [deviceId] contributes to this source, on gateways with and without membership. */
    fun hosts(deviceId: String): Boolean = deviceId == this.deviceId || deviceId in members

    /** Every host, owner first, with compatibility for gateways that omit [members]. */
    fun hostDeviceIds(): List<String> = (if (members.isEmpty()) listOf(deviceId) else members).distinct().filter(String::isNotBlank)
}

/**
 * One entry of `internalSources` on `GET /admin/sources` — a dataset the
 * gateway hosts itself with no collector, no sync engine and no
 * `sources`-table row. Only the id travels on the wire; a blank id means a
 * malformed entry the caller must drop (never fail the whole list fetch).
 */
@Serializable
data class InternalSource(val id: String = "")

/** Durable removal entries remain separate from active source memberships. */
@Serializable
data class PendingSourceRemoval(
    val id: String,
    val type: String,
    val accountId: String = "",
    val removedAt: Long = 0,
    val state: String = "removing",
)

@Serializable
data class SourceInventory(
    val items: List<SourceRecord> = emptyList(),
    val internalSources: List<InternalSource> = emptyList(),
    val pendingRemovals: List<PendingSourceRemoval> = emptyList(),
    val removedSourceIds: List<String> = emptyList(),
)

/** Request body for `POST /admin/sources/:id/members` — the device joining the source. */
@Serializable
data class SourceMemberBody(val deviceId: String)

/** `{ source, members }` returned by the member join and detach routes. */
@Serializable
data class SourceMembershipResponse(val source: SourceRecord, val members: List<String> = emptyList())

/**
 * Request body for `PATCH /admin/sources/:id` — toggle enabled and/or patch config.
 * `null` fields are dropped by `OmnesisJson` (`explicitNulls = false`), so the
 * gateway only sees the fields the caller set. Mirrors the iOS `patchSource` body.
 */
@Serializable
data class PatchSourceBody(
    val enabled: Boolean? = null,
    val config: Map<String, JsonElement>? = null,
    val deviceId: String? = null,
    val multiDeviceMode: String? = null,
)

/** Wrapper around `{ source: SourceRecord }` returned by `POST`/`PATCH /admin/sources`. */
@Serializable
data class SourceResponse(val source: SourceRecord)

/**
 * `POST /documents/delete-all/source/:sourceId`. Mirrors the iOS `DeleteAllResponse` —
 * doc rows removed plus any analytics tables dropped. Phase one of the Resync flow.
 */
@Serializable
data class DeleteAllResponse(
    val deleted: Int = 0,
    val analyticsDropped: List<String> = emptyList(),
)

/** `GET /admin/sync/status`. Mirrors the iOS `SourceSyncStatus`. */
@Serializable
data class SourceSyncStatus(
    val sourceId: String,
    val deviceId: String? = null,
    /** Per-device rows when several phones contribute to this source. */
    val members: List<SourceSyncStatus>? = null,
    val state: String = "idle",
    val unitName: String? = null,
    val progress: Progress? = null,
    val startedAt: Long? = null,
    val lastSyncAt: String? = null,
    val errorMessage: String? = null,
    val erroredAt: String? = null,
    val lastUpdated: Long? = null,
    /**
     * Forward-looking consent / authorization deadline (ISO 8601) the source last
     * reported, when known. Mirrors `DisplaySyncStatus.consentExpiresAt` in
     * packages/gateway/src/sync-status.ts and the iOS `SourceSyncStatus`. Present
     * whenever a deadline is stored — independent of `state`, so a healthy `synced`
     * source can still carry one. When `state == "auth-expiring"` it is the deadline
     * driving the non-terminal warning. `null` means no known deadline.
     */
    val consentExpiresAt: String? = null,
    /**
     * The source's own remediation sentence when `state == "stale"` — its local data
     * feed has stopped delivering, typically because the app that maintains the file
     * isn't running. Authored by the provider package that knows what actually feeds
     * the source and rendered verbatim, so no shared UI code maps sources to programs.
     * Mirrors `DisplaySyncStatus.staleHint` in packages/gateway/src/sync-status.ts and
     * the iOS `SourceSyncStatus`. `null` in every other state.
     */
    val staleHint: String? = null,
    /**
     * What to tell the operator about this status, most severe first, worded by the
     * gateway. When [members] is present each member carries its own and the aggregate
     * carries none. `null` from a gateway that predates the field — read through
     * [displayNotices], which covers that case.
     */
    @Serializable(with = LenientNoticeListSerializer::class)
    val notices: List<SourceNotice>? = null,
) {
    /**
     * The notices to show for this status (not its members). An aggregate with
     * [members] shows none of its own — each member carries its device's. When the
     * field is absent (a gateway that predates it, or a status a live broadcast has
     * just moved) they are derived from the state by [fallbackNotices].
     */
    val displayNotices: List<SourceNotice>
        get() {
            notices?.let { return it }
            if (members != null) return emptyList()
            return fallbackNotices(this)
        }

    @Serializable
    data class Progress(
        val phase: String? = null,
        val total: Int? = null,
        val processed: Int? = null,
        val percentComplete: Double? = null,
        val message: String? = null,
    )

    /** Select this phone's row without mistaking a sibling aggregate for local state. */
    fun forDevice(deviceId: String): SourceSyncStatus? =
        members?.firstOrNull { it.deviceId == deviceId }
            ?: if (members == null && (this.deviceId == null || this.deviceId == deviceId)) this else null
}
