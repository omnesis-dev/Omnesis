// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** `GET /status`. Mirrors the iOS `StatusSnapshot`. */
@Serializable
data class StatusSnapshot(
    val documents: Documents = Documents(),
    /** The main database file alone. Kept for gateways that predate [diskUsage]. */
    val dbSizeBytes: Long? = null,
    /**
     * Everything the gateway keeps on disk. Absent from a gateway that predates the
     * field, and null before its first measurement finishes.
     */
    val diskUsage: DiskUsage? = null,
    val latestActivityBySource: Map<String, LatestActivity>? = null,
    /**
     * Whether the gateway runs in experimental mode (`OMNESIS_EXPERIMENTAL=1`
     * or synthetic mode). Gates discovery of experimental surfaces. Defaults
     * to `false` so an older gateway that omits the field keeps experimental
     * features hidden.
     */
    val experimental: Boolean = false,
    /**
     * Whether the gateway runs in developer mode (`OMNESIS_DEV_MODE=1`).
     * Reveals the developer-annotation capture affordance
     * (shake-to-annotate). Defaults to `false` until `/status` has been
     * fetched, and for any gateway that omits the field — so the affordance
     * stays hidden by default. Mirrors the iOS `StatusSnapshot.developer`.
     */
    val developer: Boolean = false,
    /**
     * The Omnesis Briefs feature gate. Absent on a gateway that predates the field, which
     * reads as "no feature" rather than as a fault.
     */
    val briefs: BriefsStatusDto? = null,
) {
    /**
     * What the "on disk" stat shows: the gateway's whole footprint, or the main
     * database alone from a gateway that does not report one.
     */
    val onDiskBytes: Long?
        get() = diskUsage?.totalBytes ?: dbSizeBytes

    /** The total of `GET /status`'s `diskUsage`; the per-store breakdown is not rendered here. */
    @Serializable
    data class DiskUsage(val totalBytes: Long)

    @Serializable
    data class Documents(
        val total: Int = 0,
        val bySource: Map<String, Int> = emptyMap(),
        val unitCountBySource: Map<String, Int?>? = null,
    )

    @Serializable
    data class LatestActivity(
        val kind: String = "document",
        val docId: String? = null,
        val title: String? = null,
        val latestActivityAt: String,
        val sourceCreatedAt: String? = null,
        val ingestedAt: String? = null,
        val isNew: Boolean? = null,
        val tableName: String? = null,
        val tableDisplayName: String? = null,
    )
}

/** `GET /whoami`. */
@Serializable
data class Whoami(
    val tokenId: String,
    val deviceId: String? = null,
    val deviceName: String? = null,
    val scopes: List<String> = emptyList(),
)

/**
 * Whether the paired gateway offers Omnesis Briefs, and if not, whether the thing in the
 * way is something the operator can fix.
 *
 * [enabled] and [modelAssigned] are read as the two separate questions they answer — can
 * the feed be fetched, and is the model what stands in the way — rather than either being
 * inferred from the other.
 */
@Serializable
data class BriefsStatusDto(
    /** The operator switched Briefs on. */
    val enabled: Boolean = false,
    /** A background-agent model is assigned and its backend can actually run. */
    val modelAssigned: Boolean = false,
    /** The engine runs and the routes answer: [enabled] AND a runnable model. */
    val active: Boolean = false,
)

/** What the navigation menu shows for Briefs, derived from [BriefsStatusDto]. */
enum class BriefsMenuEntry {
    /** No entry: the feature is off, so the routes would only ever 404. */
    HIDDEN,

    /** A normal destination — the engine runs and the feed answers. */
    AVAILABLE,

    /** Switched on, but its background-agent model is unassigned or cannot run. */
    NEEDS_ATTENTION,
    ;

    companion object {
        fun from(status: BriefsStatusDto?): BriefsMenuEntry = when {
            status == null -> HIDDEN
            status.active -> AVAILABLE
            status.enabled && !status.modelAssigned -> NEEDS_ATTENTION
            else -> HIDDEN
        }
    }
}
