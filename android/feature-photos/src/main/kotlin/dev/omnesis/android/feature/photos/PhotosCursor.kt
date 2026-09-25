// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Persisted sync-state cursor for [PhotosSource]. A phased, mutually
 * exclusive-partition backfill (screenshots -> recent -> backfill ->
 * steady), mirroring the priority order the iOS Photos source ships
 * (`ios/Sources/Omnesis/Photos/PhotosCursor.swift`) — each phase's query
 * is walked to exhaustion before advancing, so the backfill converges
 * rather than looping forever.
 *
 * `MediaStore.MediaColumns.DATE_ADDED`/`DATE_MODIFIED` are epoch SECONDS —
 * unlike `CallLog.Calls.DATE` (millis) elsewhere in this codebase. Because
 * they're plain Longs with no lossy string-round-trip risk (unlike iOS's
 * Date<->String cursor comparison, which needed a shared-formatter
 * workaround), the watermark compares raw `Long`s directly, paired with an
 * `_ID` tie-break for same-timestamp bursts.
 */
enum class PhotosPhase {
    SCREENSHOTS,
    RECENT,
    BACKFILL,
    STEADY,
    ;

    /** The phase after this one drains — SCREENSHOTS -> RECENT -> BACKFILL -> STEADY -> STEADY. */
    val next: PhotosPhase
        get() = when (this) {
            SCREENSHOTS -> RECENT
            RECENT -> BACKFILL
            BACKFILL -> STEADY
            STEADY -> STEADY
        }
}

data class PhotosCursor(
    /** Access epoch; increments when a restricted library expands to FULL. */
    val accessGeneration: Long = 0,
    /**
     * A restored FULL grant is a safety re-baseline over documents that may
     * already contain NEW-tier analysis. Keep this durable across pages and
     * relaunches so the re-baseline never replaces richer gateway content
     * with the cheaper ordinary-backfill representation.
     */
    val preserveRichAnalysis: Boolean = false,
    val phase: PhotosPhase = PhotosPhase.SCREENSHOTS,
    /** Resume point within the current phase — null at the start of a phase. */
    val lastAssetId: String? = null,
    val lastAssetDateAddedSec: Long? = null,
    /**
     * The RECENT/BACKFILL boundary, fixed the first time the RECENT phase
     * runs (`now - 30 days` at that moment) rather than recomputed on every
     * call — a moving "last 30 days" would either re-visit assets RECENT
     * already covered, or leave a gap, once BACKFILL is reached at a later
     * wall-clock time.
     */
    val recentCutoffSec: Long? = null,
    /**
     * The highest `(DATE_ADDED, _ID)` seen across EVERY backfill phase, not
     * just the current one. Screenshots/recent/backfill are walked as
     * separate, differently-filtered queries, so the current phase's own
     * last-seen asset is not necessarily the newest asset overall (e.g. a
     * screenshot taken yesterday can be newer than the most recent
     * plain-backfill asset processed so far). Once BACKFILL drains, THIS
     * becomes STEADY's starting watermark — seeding STEADY from a null/reset
     * watermark instead would make it re-discover every already-backfilled
     * asset as a "new arrival".
     */
    val maxSeenDateAddedSec: Long? = null,
    val maxSeenId: String? = null,
    /** Stamped once the BACKFILL phase drains and the cursor reaches STEADY. */
    val backfillCompletedAt: String? = null,
) {
    fun toJsonElement(): JsonElement = buildJsonObject {
        put("accessGeneration", JsonPrimitive(accessGeneration))
        if (preserveRichAnalysis) put("preserveRichAnalysis", JsonPrimitive(true))
        put("phase", JsonPrimitive(phase.name))
        lastAssetId?.let { put("lastAssetId", JsonPrimitive(it)) }
        lastAssetDateAddedSec?.let { put("lastAssetDateAddedSec", JsonPrimitive(it)) }
        recentCutoffSec?.let { put("recentCutoffSec", JsonPrimitive(it)) }
        maxSeenDateAddedSec?.let { put("maxSeenDateAddedSec", JsonPrimitive(it)) }
        maxSeenId?.let { put("maxSeenId", JsonPrimitive(it)) }
        backfillCompletedAt?.let { put("backfillCompletedAt", JsonPrimitive(it)) }
    }

    companion object {
        fun fromJsonElement(element: JsonElement?): PhotosCursor {
            if (element == null) return PhotosCursor()
            return runCatching {
                val obj = element as? JsonObject ?: return PhotosCursor()
                val phase = obj["phase"]?.jsonPrimitive?.content
                    ?.let { name -> PhotosPhase.entries.firstOrNull { it.name == name } }
                    ?: PhotosPhase.SCREENSHOTS
                PhotosCursor(
                    accessGeneration = obj["accessGeneration"]?.jsonPrimitive?.longOrNull ?: 0,
                    preserveRichAnalysis = obj["preserveRichAnalysis"]?.jsonPrimitive?.content == "true",
                    phase = phase,
                    lastAssetId = obj["lastAssetId"]?.jsonPrimitive?.content,
                    lastAssetDateAddedSec = obj["lastAssetDateAddedSec"]?.jsonPrimitive?.longOrNull,
                    recentCutoffSec = obj["recentCutoffSec"]?.jsonPrimitive?.longOrNull,
                    maxSeenDateAddedSec = obj["maxSeenDateAddedSec"]?.jsonPrimitive?.longOrNull,
                    maxSeenId = obj["maxSeenId"]?.jsonPrimitive?.content,
                    backfillCompletedAt = obj["backfillCompletedAt"]?.jsonPrimitive?.content,
                )
            }.getOrDefault(PhotosCursor())
        }
    }
}
