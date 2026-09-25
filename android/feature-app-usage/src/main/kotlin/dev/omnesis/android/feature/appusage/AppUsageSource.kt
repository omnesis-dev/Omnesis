// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.util.Log
import dev.omnesis.android.transport.dto.DocumentInputDto
import java.time.ZoneOffset
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement

private const val TAG = "Omnesis:appusage"

/** One sync pass' output: table-specific analytics rows, rebuilt day documents, and the advanced cursor. */
data class AppUsageSyncResult(
    val sessionRows: List<Map<String, JsonElement>>,
    val dailyRows: List<Map<String, JsonElement>>,
    val documents: List<DocumentInputDto>,
    val cursor: AppUsageCursor,
)

/**
 * Reads Android's `UsageStatsManager` event stream and produces one
 * "Attention Timeline" document per affected calendar day (UTC), alongside
 * `android_app_usage_sessions` / `android_app_usage_daily` analytics rows —
 * the Android analogue of `CallLogSource`, but reconstructing sessions from a
 * raw event stream instead of reading a table with a stable per-row id.
 *
 * `UsageEvents.Event` carries only a wall-clock `timeStamp`, no id — and a
 * day's picture can be revised as more events land for it later that same
 * day (an app still in the foreground when one pass' query window closes
 * gets provisionally closed there, then corrected once its real
 * `MOVE_TO_BACKGROUND` event lands). So, mirroring `CallLogSource`'s
 * day-rebuild pattern: each pass first queries `[cursor, now)` only to find
 * which UTC days have new events, then re-derives every affected day from a
 * *fresh full-day* query. Every row/document below is keyed so that re-upsert
 * is idempotent — a rebuilt day simply overwrites the previous rows for the
 * same ids. There is no deletion-reconciliation step: unlike a call log entry,
 * a day of usage history is never deleted by the user short of clearing app
 * data or a factory reset, so there is nothing analogous to `CallLogSource`'s
 * distinct-dates deletion snapshot to compute.
 */
class AppUsageSource(
    private val usageStatsManager: UsageStatsManager,
    private val labelResolver: (String) -> String,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val SOURCE_TYPE = "android-app-usage"
        const val ACCOUNT_ID_LOCAL = "local"
        const val PROVIDER_ID = "android"
    }

    suspend fun sync(cursor: AppUsageCursor): AppUsageSyncResult = withContext(Dispatchers.IO) {
        val now = clock()
        if (cursor.lastQueriedThroughMillis >= now) {
            return@withContext AppUsageSyncResult(emptyList(), emptyList(), emptyList(), AppUsageCursor(now))
        }

        val newEvents = queryEvents(cursor.lastQueriedThroughMillis, now)
        val affectedDates = newEvents.map { AppUsageNormalizer.epochMillisToUtcDate(it.timestampMillis) }.toSet()

        val sessionRows = mutableListOf<Map<String, JsonElement>>()
        val dailyRows = mutableListOf<Map<String, JsonElement>>()
        val documents = mutableListOf<DocumentInputDto>()
        for (date in affectedDates.sorted()) {
            val dayStart = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
            val dayEnd = minOf(date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(), now)
            val dayEvents = queryEvents(dayStart, dayEnd)
            val sessions = AppUsageNormalizer.mergeSessions(dayEvents, dayStart, dayEnd)

            sessionRows += sessions.map { AppUsageNormalizer.sessionRow(it, labelResolver(it.packageName)) }
            dailyRows += AppUsageNormalizer.dailyRows(sessions, date, labelResolver)
            documents += AppUsageNormalizer.buildDayDocument(
                sessions = sessions,
                pickups = AppUsageNormalizer.pickupCount(dayEvents),
                firstUnlockMillis = AppUsageNormalizer.firstUnlockMillis(dayEvents),
                lastUseMillis = AppUsageNormalizer.lastUseMillis(dayEvents),
                date = date,
                providerId = PROVIDER_ID,
                sourceId = "$SOURCE_TYPE:$ACCOUNT_ID_LOCAL",
                labelResolver = labelResolver,
            )
        }
        if (documents.isNotEmpty()) {
            Log.i(TAG, "Rebuilt ${documents.size} attention-timeline day document(s): ${affectedDates.sorted().joinToString(", ")}")
        }

        AppUsageSyncResult(
            sessionRows = sessionRows,
            dailyRows = dailyRows,
            documents = documents,
            cursor = AppUsageCursor(now),
        )
    }

    private fun queryEvents(startMillis: Long, endMillis: Long): List<RawUsageEvent> {
        val events = mutableListOf<RawUsageEvent>()
        val usageEvents = usageStatsManager.queryEvents(startMillis, endMillis)
        val event = UsageEvents.Event()
        while (usageEvents.hasNextEvent()) {
            usageEvents.getNextEvent(event)
            val kind = kindFor(event.eventType) ?: continue
            val packageName = event.packageName ?: continue
            events += RawUsageEvent(packageName, event.timeStamp, kind)
        }
        return events
    }

    // MOVE_TO_FOREGROUND/MOVE_TO_BACKGROUND are deprecated (API 29+) in favor of
    // ACTIVITY_RESUMED/ACTIVITY_PAUSED, which fire per-Activity (including
    // within the same app) rather than per-app — finer-grained than the
    // app-level foreground session this feature reconstructs. The deprecated
    // pair still fires on every OS version back to this module's minSdk 26 and
    // matches the desired app-level granularity directly, so it stays the
    // right choice here rather than adding an SDK-branch for no behavioral gain.
    @Suppress("DEPRECATION")
    private fun kindFor(eventType: Int): UsageEventKind? = when (eventType) {
        UsageEvents.Event.MOVE_TO_FOREGROUND -> UsageEventKind.FOREGROUND
        UsageEvents.Event.MOVE_TO_BACKGROUND -> UsageEventKind.BACKGROUND
        UsageEvents.Event.SCREEN_INTERACTIVE -> UsageEventKind.SCREEN_INTERACTIVE
        UsageEvents.Event.SCREEN_NON_INTERACTIVE -> UsageEventKind.SCREEN_NON_INTERACTIVE
        UsageEvents.Event.KEYGUARD_HIDDEN -> UsageEventKind.KEYGUARD_HIDDEN
        else -> null
    }
}
