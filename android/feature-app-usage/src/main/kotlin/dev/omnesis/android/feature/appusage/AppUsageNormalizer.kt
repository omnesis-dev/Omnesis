// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import dev.omnesis.android.transport.dto.DocumentInputDto
import dev.omnesis.android.transport.dto.DocumentMetadataDto
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The subset of `UsageEvents.Event` types this feature cares about, translated
 * out of Android's raw `eventType` int by [AppUsageSource] so this whole file
 * stays free of any `android.*` import and is unit-testable as plain JVM code
 * (no Robolectric needed for the merge/aggregation logic below).
 */
enum class UsageEventKind {
    /** App came to the foreground (`MOVE_TO_FOREGROUND`). */
    FOREGROUND,

    /** App went to the background (`MOVE_TO_BACKGROUND`). */
    BACKGROUND,

    /** Screen turned on (`SCREEN_INTERACTIVE`) — the "phone pickup" signal. */
    SCREEN_INTERACTIVE,

    /** Screen turned off (`SCREEN_NON_INTERACTIVE`). */
    SCREEN_NON_INTERACTIVE,

    /** Keyguard dismissed (`KEYGUARD_HIDDEN`) — the "device unlocked" signal. */
    KEYGUARD_HIDDEN,
}

/** One `UsageEvents.Event` translated to a kind this feature understands. */
data class RawUsageEvent(
    val packageName: String,
    val timestampMillis: Long,
    val kind: UsageEventKind,
)

/**
 * One reconstructed foreground session for a single app, closed (has both a
 * start and an end) — either by a matching `MOVE_TO_BACKGROUND` event, or by
 * truncation at a day boundary when the day's query window closed while the
 * app was still in the foreground.
 */
data class RawSession(
    val packageName: String,
    val startMillis: Long,
    val endMillis: Long,
) {
    val durationSeconds: Long get() = maxOf(0L, (endMillis - startMillis) / 1000)
}

/**
 * Pure normalization for Android's `UsageStatsManager` event stream — the
 * analogue of `CallLogNormalizer`, but for foreground-session reconstruction
 * instead of a 1:1 call-row mapping. [AppUsageSource] re-queries a whole
 * affected UTC day at a time (mirroring `CallLogSource`'s day-rebuild
 * pattern), so every function here operates on one day's worth of events —
 * there is no cross-day cursor stitching to get wrong.
 */
object AppUsageNormalizer {

    private val UTC_DATE: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC)

    fun epochMillisToUtcDate(epochMillis: Long): LocalDate =
        Instant.ofEpochMilli(epochMillis).atZone(ZoneOffset.UTC).toLocalDate()

    /**
     * Pairs each `FOREGROUND` event with the next `BACKGROUND` event for the
     * same package into a closed [RawSession]. A `BACKGROUND` with no open
     * `FOREGROUND` (the session actually started before [dayStartMillis], out
     * of this day's query window) is clamped to start at [dayStartMillis]. A
     * `FOREGROUND` left open when the day's window closes (the app was still
     * foregrounded at [dayEndMillis]) is closed there instead of dropped —
     * the next day's rebuild will independently re-derive whatever session
     * continues past midnight as its own, day-local session.
     */
    fun mergeSessions(events: List<RawUsageEvent>, dayStartMillis: Long, dayEndMillis: Long): List<RawSession> {
        val sorted = events
            .filter { it.kind == UsageEventKind.FOREGROUND || it.kind == UsageEventKind.BACKGROUND }
            .sortedBy { it.timestampMillis }
        val open = mutableMapOf<String, Long>()
        val sessions = mutableListOf<RawSession>()
        for (event in sorted) {
            when (event.kind) {
                UsageEventKind.FOREGROUND -> open[event.packageName] = event.timestampMillis
                UsageEventKind.BACKGROUND -> {
                    val start = open.remove(event.packageName) ?: dayStartMillis
                    if (event.timestampMillis > start) {
                        sessions += RawSession(event.packageName, start, event.timestampMillis)
                    }
                }
                else -> Unit
            }
        }
        for ((packageName, start) in open) {
            if (dayEndMillis > start) sessions += RawSession(packageName, start, dayEndMillis)
        }
        return sessions
    }

    /** "Phone pickups" for the day — every time the screen turned on. */
    fun pickupCount(events: List<RawUsageEvent>): Int =
        events.count { it.kind == UsageEventKind.SCREEN_INTERACTIVE }

    /** Earliest device-unlock instant for the day, or null if none landed. */
    fun firstUnlockMillis(events: List<RawUsageEvent>): Long? =
        events.filter { it.kind == UsageEventKind.KEYGUARD_HIDDEN }.minOfOrNull { it.timestampMillis }

    /** Latest event of any kind for the day — a proxy for "last use". */
    fun lastUseMillis(events: List<RawUsageEvent>): Long? = events.maxOfOrNull { it.timestampMillis }

    /** One `android_app_usage_sessions` row per reconstructed session. */
    fun sessionRow(session: RawSession, appName: String): Map<String, JsonElement> = buildMap {
        put("id", JsonPrimitive("${session.packageName}:${session.startMillis}"))
        put("package_name", JsonPrimitive(session.packageName))
        put("app_name", JsonPrimitive(appName))
        put("start_time", JsonPrimitive(Instant.ofEpochMilli(session.startMillis).toString()))
        put("end_time", JsonPrimitive(Instant.ofEpochMilli(session.endMillis).toString()))
        put("duration_seconds", JsonPrimitive(session.durationSeconds))
        put("date", JsonPrimitive(UTC_DATE.format(Instant.ofEpochMilli(session.startMillis))))
    }

    /** One `android_app_usage_daily` row per app that had at least one session on [date]. */
    fun dailyRows(sessions: List<RawSession>, date: LocalDate, labelResolver: (String) -> String): List<Map<String, JsonElement>> =
        sessions.groupBy { it.packageName }.map { (packageName, appSessions) ->
            buildMap {
                put("id", JsonPrimitive("$packageName:$date"))
                put("package_name", JsonPrimitive(packageName))
                put("app_name", JsonPrimitive(labelResolver(packageName)))
                put("date", JsonPrimitive(date.format(DateTimeFormatter.ISO_LOCAL_DATE)))
                put("total_seconds", JsonPrimitive(appSessions.sumOf { it.durationSeconds }))
                put("session_count", JsonPrimitive(appSessions.size))
            }
        }

    /** Format a duration in seconds as a short human string ("4h 12m", "48m", "12s"). */
    fun formatDuration(seconds: Long): String {
        val total = seconds.coerceAtLeast(0)
        val h = total / 3600
        val m = (total % 3600) / 60
        return when {
            h > 0 && m > 0 -> "${h}h ${m}m"
            h > 0 -> "${h}h"
            m > 0 -> "${m}m"
            else -> "${total}s"
        }
    }

    /** Format an epoch-millis instant as a short UTC "HH:mm" clock time. */
    fun formatTime(epochMillis: Long): String =
        Instant.ofEpochMilli(epochMillis).atZone(ZoneOffset.UTC).toLocalTime().toString().take(5)

    /**
     * Build the day-aggregate "Attention Timeline" document for [date]: total
     * screen time, the top apps by foreground time, pickup count, and
     * first-unlock / last-use times. Many analytics rows (across both
     * `android_app_usage_sessions` and `android_app_usage_daily`) roll up
     * into this one document — there is no natural 1:1 row-to-document
     * binding the way a single call maps to `call-log`'s day document, so
     * the two analytics tables carry no document-binding declaration.
     */
    fun buildDayDocument(
        sessions: List<RawSession>,
        pickups: Int,
        firstUnlockMillis: Long?,
        lastUseMillis: Long?,
        date: LocalDate,
        providerId: String,
        sourceId: String,
        labelResolver: (String) -> String,
        topN: Int = 5,
    ): DocumentInputDto {
        val dateStr = date.format(DateTimeFormatter.ISO_LOCAL_DATE)
        val totalSeconds = sessions.sumOf { it.durationSeconds }
        val byApp = sessions.groupBy { it.packageName }
            .map { (packageName, appSessions) ->
                Triple(packageName, labelResolver(packageName), appSessions.sumOf { it.durationSeconds }) to appSessions.size
            }
            .sortedByDescending { (triple, _) -> triple.third }

        val lines = mutableListOf("# Attention Timeline — $dateStr", "")
        lines += "**Total:** ${formatDuration(totalSeconds)} screen time, $pickups pickup${if (pickups == 1) "" else "s"}"
        lines += ""
        for ((triple, sessionCount) in byApp.take(topN)) {
            val (_, appName, secs) = triple
            lines += "- $appName — ${formatDuration(secs)} ($sessionCount session${if (sessionCount == 1) "" else "s"})"
        }
        if (firstUnlockMillis != null || lastUseMillis != null) {
            lines += ""
            val parts = mutableListOf<String>()
            firstUnlockMillis?.let { parts += "First unlock: ${formatTime(it)}" }
            lastUseMillis?.let { parts += "Last use: ${formatTime(it)}" }
            lines += parts.joinToString(" · ")
        }
        val content = lines.joinToString("\n")

        return DocumentInputDto(
            providerId = providerId,
            sourceId = sourceId,
            externalId = "attention-timeline:$dateStr",
            title = "Attention Timeline — $dateStr",
            content = content,
            contentHash = sha256Hex(content),
            metadata = DocumentMetadataDto(
                documentType = "attention-timeline",
                // Rewritten every time new events land for this date — route
                // to the daily batch instead of waking the real-time agent.
                rollingAggregate = true,
                tags = emptyList(),
                extra = buildJsonObject {
                    put("date", dateStr)
                    put("totalSeconds", totalSeconds)
                    put("pickups", pickups)
                    firstUnlockMillis?.let { put("firstUnlock", Instant.ofEpochMilli(it).toString()) }
                    lastUseMillis?.let { put("lastUse", Instant.ofEpochMilli(it).toString()) }
                    put(
                        "apps",
                        buildJsonArray {
                            byApp.forEach { (triple, sessionCount) ->
                                val (packageName, appName, secs) = triple
                                add(
                                    buildJsonObject {
                                        put("packageName", packageName)
                                        put("appName", appName)
                                        put("totalSeconds", secs)
                                        put("sessionCount", sessionCount)
                                    },
                                )
                            }
                        },
                    )
                },
            ),
            sourceCreatedAt = "${dateStr}T00:00:00.000Z",
            sourceUpdatedAt = "${dateStr}T23:59:59.999Z",
        )
    }

    private fun sha256Hex(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
