// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Wire shape of a `sync.status` WS event payload, mirroring what the desktop collector
 * (and the iOS `forwardLifecycle`) emits. Optional everywhere — different lifecycle
 * phases populate different subsets of fields. Ports the iOS `SyncStatusBroadcast`.
 */
@Serializable
data class SyncStatusBroadcast(
    val sourceId: String? = null,
    val deviceId: String? = null,
    val state: String? = null,
    val unitName: String? = null,
    val startedAt: Long? = null,
    val completedAt: Long? = null,
    val lastUpdated: Long? = null,
    val errorMessage: String? = null,
    val progress: BroadcastProgress? = null,
    /**
     * Forward-looking consent deadline (#927) — carried verbatim when the gateway
     * includes it on a `sync.status` broadcast. Mirrors the iOS `SyncStatusBroadcast`.
     */
    val consentExpiresAt: String? = null,
    val staleHint: String? = null,
) {
    @Serializable
    data class BroadcastProgress(
        val phase: String? = null,
        val total: Int? = null,
        val processed: Int? = null,
        val percentComplete: Double? = null,
        val message: String? = null,
    )

    /** Map the legacy state string ("completed") onto the canonical UI form ("synced"). */
    val canonicalState: String
        get() = when (state) {
            "completed" -> "synced"
            null -> "idle"
            else -> state
        }

    companion object {
        fun decode(payload: JsonElement): SyncStatusBroadcast? =
            runCatching { OmnesisJson.decodeFromJsonElement(serializer(), payload) }.getOrNull()
    }
}

/**
 * Pure merge of an incoming WS broadcast into the prior [SourceSyncStatus]. Top-level
 * function so it's trivially testable in isolation. Ports the iOS `AdminCoordinator.merge`.
 */
fun mergeSyncStatus(
    existing: SourceSyncStatus?,
    broadcast: SyncStatusBroadcast,
    sourceId: String,
    now: Instant = Instant.now(),
): SourceSyncStatus {
    // A broadcast relays the COLLECTOR's raw lifecycle state, which has no way to
    // express a state the gateway derives on top of a healthy sync — `auth-expiring`
    // and `stale` are computed server-side from stored data, not reported by the
    // collector. Letting a routine "completed" overwrite one would blank the warning
    // on every sync interval, which for a stalled source is exactly when it keeps
    // arriving. Hold the derived overlay until a full /admin/sync/status fetch, which
    // re-derives it and is the only thing that can legitimately clear it.
    val derivedOverlays = setOf("auth-expiring", "stale")
    val reported = if (
        broadcast.canonicalState == "synced" && existing?.state in derivedOverlays
    ) {
        existing!!.state
    } else {
        broadcast.canonicalState
    }

    // Per-device rows survive the broadcast — they hold each device's notices. The
    // broadcasting device's row takes the same lifecycle merge as a single-device status.
    val members = existing?.members?.map { member ->
        if (broadcast.deviceId != null && member.deviceId == broadcast.deviceId) {
            mergeSyncStatus(member, broadcast, sourceId, now)
        } else {
            member
        }
    }
    // A shared source's state follows the gateway's rule: syncing while any member
    // syncs, otherwise the latest report.
    val canonical = if (members?.any { it.state == "syncing" } == true) "syncing" else reported

    // lastSyncAt: prefer a fresh "completed" timestamp; otherwise carry forward what we
    // already have so a "syncing"/"progress" event doesn't blank out the column.
    val lastSyncAt = broadcast.completedAt
        ?.let { ISO.format(Instant.ofEpochMilli(it)) }
        ?: existing?.lastSyncAt

    // erroredAt: stamp on transition to error; clear on success.
    val erroredAt = when (broadcast.state) {
        "error" -> ISO.format(now)
        "completed" -> null
        else -> existing?.erroredAt
    }

    // Progress is only meaningful while syncing. Carry forward the last-known progress if
    // the new event is a syncing/progress one without an explicit progress payload.
    val progress: SourceSyncStatus.Progress? = if (canonical == "syncing") {
        broadcast.progress?.let { p ->
            SourceSyncStatus.Progress(
                phase = p.phase,
                total = p.total,
                processed = p.processed,
                percentComplete = p.percentComplete,
                message = p.message,
            )
        } ?: existing?.progress
    } else {
        null
    }

    return SourceSyncStatus(
        sourceId = sourceId,
        deviceId = broadcast.deviceId ?: existing?.deviceId,
        state = canonical,
        unitName = broadcast.unitName ?: existing?.unitName,
        progress = progress,
        startedAt = broadcast.startedAt ?: existing?.startedAt,
        lastSyncAt = lastSyncAt,
        errorMessage = broadcast.errorMessage,
        erroredAt = erroredAt,
        lastUpdated = broadcast.lastUpdated ?: existing?.lastUpdated,
        // Carry the consent deadline forward when a broadcast omits it so a plain
        // "syncing"/"progress" event doesn't blank out a known forward-looking
        // expiry (#927) — mirrors lastSyncAt/progress carry-forward and the iOS merge.
        consentExpiresAt = broadcast.consentExpiresAt ?: existing?.consentExpiresAt,
        // Same reasoning as consentExpiresAt: the remediation sentence belongs to a
        // derived state the broadcast cannot carry, so a sparse event must not blank it.
        staleHint = broadcast.staleHint ?: existing?.staleHint,
        notices = carriedNotices(existing, broadcast, canonical),
        members = members,
    )
}

/**
 * A broadcast carries no notices — the gateway composes them on a fetch — so the last
 * fetched ones stand while they still describe this status. Once the state moves, or
 * a different device reports for a single-device status, they are dropped and
 * [SourceSyncStatus.displayNotices] derives them from the new state until the re-fetch
 * that the move triggers lands. An aggregate with members keeps its own (none).
 */
private fun carriedNotices(
    existing: SourceSyncStatus?,
    broadcast: SyncStatusBroadcast,
    state: String,
): List<SourceNotice>? {
    if (existing == null) return null
    if (existing.members != null) return existing.notices
    val otherDevice = broadcast.deviceId != null && existing.deviceId != null && broadcast.deviceId != existing.deviceId
    return if (existing.state != state || otherDevice) null else existing.notices
}

private val ISO: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT
