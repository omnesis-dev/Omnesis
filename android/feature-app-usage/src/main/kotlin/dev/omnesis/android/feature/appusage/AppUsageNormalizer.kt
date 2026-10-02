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
    /** One of the app's activities resumed (`MOVE_TO_FOREGROUND`, the same value as `ACTIVITY_RESUMED`). */
    FOREGROUND,

    /** One of the app's activities paused (`MOVE_TO_BACKGROUND`, the same value as `ACTIVITY_PAUSED`). */
    BACKGROUND,

    /** Screen turned on (`SCREEN_INTERACTIVE`) — the "phone pickup" signal. */
    SCREEN_INTERACTIVE,

    /** Screen turned off (`SCREEN_NON_INTERACTIVE`). */
    SCREEN_NON_INTERACTIVE,

    /** Keyguard dismissed (`KEYGUARD_HIDDEN`) — the "device unlocked" signal. */
    KEYGUARD_HIDDEN,
}

/**
 * One `UsageEvents.Event` translated to a kind this feature understands.
 * [className] names the activity a `FOREGROUND`/`BACKGROUND` event belongs
 * to; Android reports those per activity, so one app with several activities
 * emits several overlapping resume/pause pairs.
 */
data class RawUsageEvent(
    val packageName: String,
    val timestampMillis: Long,
    val kind: UsageEventKind,
    val className: String? = null,
)

/**
 * One reconstructed on-screen session for a single app, closed (has both a
 * start and an end) — by the app's last open activity pausing, by the screen
 * turning off, or by truncation at the day's query window when the app was
 * still on screen. A package's sessions for one day never overlap.
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
 * analogue of `CallLogNormalizer`, but for on-screen session reconstruction
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
     * Two sessions of one app separated by no more than this are one stretch
     * of use. Moving between an app's screens pauses the old activity a few
     * milliseconds before resuming the new one, which would otherwise split
     * every screen change into its own session.
     */
    private const val SAME_APP_GAP_MILLIS = 2_000L

    /**
     * Reconstructs each app's on-screen sessions for one day. An app is on
     * screen while at least one of its activities is resumed and the screen
     * is interactive, so:
     *
     * - activities are tracked individually by [RawUsageEvent.className]: an
     *   app whose second activity resumes before its first one pauses stays
     *   one continuous session rather than two overlapping ones. Two
     *   instances of one activity class (or events with no class name) share
     *   one slot, so the first of their pauses ends the session;
     * - when an app's first event of the day is a pause, that activity was
     *   resumed before [dayStartMillis], out of this day's query window, and
     *   is treated as open from the day start. Any other pause with no
     *   matching resume is ignored: once the app has been seen today, a stray
     *   pause says nothing about how long it was on screen;
     * - the screen turning off closes every session and forgets every
     *   resumed activity, since Android pauses the visible activity when the
     *   device sleeps and resumes it afresh when the user returns. A pause
     *   that never arrives therefore costs at most one screen-on stretch. The
     *   screen counts as on at the day start unless the day's first screen
     *   event turns it on, in which case an app carried over from the
     *   previous day opens when it does;
     * - a session still open when the window closes ends at [dayEndMillis].
     *   The next day's rebuild independently re-derives whatever continues
     *   past midnight as its own, day-local session;
     * - sessions of one app no more than [SAME_APP_GAP_MILLIS] apart merge.
     *
     * Every session therefore lies inside the window and a package's
     * sessions never overlap, so an app's daily total cannot exceed the
     * window's length. The result is ordered by start time.
     */
    fun mergeSessions(events: List<RawUsageEvent>, dayStartMillis: Long, dayEndMillis: Long): List<RawSession> {
        val sorted = events.sortedBy { it.timestampMillis }
        val activityEvents = sorted.filter { it.kind == UsageEventKind.FOREGROUND || it.kind == UsageEventKind.BACKGROUND }

        val resumed = mutableMapOf<String, MutableSet<String>>()
        for (first in activityEvents.distinctBy { it.packageName }) {
            if (first.kind == UsageEventKind.BACKGROUND) resumed[first.packageName] = mutableSetOf(first.className.orEmpty())
        }
        var screenOn = sorted.firstOrNull {
            it.kind == UsageEventKind.SCREEN_INTERACTIVE || it.kind == UsageEventKind.SCREEN_NON_INTERACTIVE
        }?.kind != UsageEventKind.SCREEN_INTERACTIVE

        val openSince = mutableMapOf<String, Long>()
        val sessions = mutableListOf<RawSession>()
        fun settle(packageName: String, at: Long) {
            val onScreen = screenOn && resumed[packageName].orEmpty().isNotEmpty()
            val start = openSince[packageName]
            if (onScreen && start == null) {
                openSince[packageName] = at
            } else if (!onScreen && start != null) {
                openSince.remove(packageName)
                if (at > start) sessions += RawSession(packageName, start, at)
            }
        }

        resumed.keys.forEach { settle(it, dayStartMillis) }
        for (event in sorted) {
            val at = event.timestampMillis.coerceIn(dayStartMillis, dayEndMillis)
            when (event.kind) {
                UsageEventKind.FOREGROUND -> {
                    resumed.getOrPut(event.packageName) { mutableSetOf() } += event.className.orEmpty()
                    settle(event.packageName, at)
                }
                UsageEventKind.BACKGROUND -> {
                    resumed[event.packageName]?.remove(event.className.orEmpty())
                    settle(event.packageName, at)
                }
                UsageEventKind.SCREEN_INTERACTIVE -> {
                    screenOn = true
                    resumed.keys.forEach { settle(it, at) }
                }
                UsageEventKind.SCREEN_NON_INTERACTIVE -> {
                    screenOn = false
                    resumed.keys.forEach { settle(it, at) }
                    resumed.clear()
                }
                UsageEventKind.KEYGUARD_HIDDEN -> Unit
            }
        }
        screenOn = false
        resumed.keys.forEach { settle(it, dayEndMillis) }
        return joinShortGaps(sessions)
    }

    private fun joinShortGaps(sessions: List<RawSession>): List<RawSession> =
        sessions.groupBy { it.packageName }.values.flatMap { appSessions ->
            appSessions.sortedBy { it.startMillis }.fold(mutableListOf<RawSession>()) { joined, next ->
                val last = joined.lastOrNull()
                if (last != null && next.startMillis - last.endMillis <= SAME_APP_GAP_MILLIS) {
                    joined[joined.lastIndex] = last.copy(endMillis = next.endMillis)
                } else {
                    joined += next
                }
                joined
            }
        }.sortedBy { it.startMillis }

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
     * screen time, the top apps by on-screen time, pickup count, and
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
