// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import java.time.LocalDate
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Plain-JUnit tests for [AppUsageNormalizer] — no Robolectric, no `android.*`
 * import anywhere in this file. Fixture app names/packages below are entirely
 * invented (privacy rule) — never real installed apps.
 */
class AppUsageNormalizerTest {

    private val dayStart = 1_772_582_400_000L // 2026-03-04T00:00:00Z
    private val dayEnd = dayStart + 24 * 60 * 60 * 1000

    private fun fg(pkg: String, t: Long) = RawUsageEvent(pkg, t, UsageEventKind.FOREGROUND)
    private fun bg(pkg: String, t: Long) = RawUsageEvent(pkg, t, UsageEventKind.BACKGROUND)
    private fun screenOn(t: Long) = RawUsageEvent("android", t, UsageEventKind.SCREEN_INTERACTIVE)
    private fun unlock(t: Long) = RawUsageEvent("android", t, UsageEventKind.KEYGUARD_HIDDEN)

    @Test
    fun `a contiguous foreground-background pair becomes one closed session`() {
        val events = listOf(fg("com.example.notes", dayStart + 1_000), bg("com.example.notes", dayStart + 61_000))
        val sessions = AppUsageNormalizer.mergeSessions(events, dayStart, dayEnd)
        assertEquals(1, sessions.size)
        assertEquals("com.example.notes", sessions[0].packageName)
        assertEquals(60, sessions[0].durationSeconds)
    }

    @Test
    fun `multiple apps interleave into independent sessions`() {
        val events = listOf(
            fg("com.example.notes", dayStart + 1_000),
            fg("com.example.chat", dayStart + 5_000),
            bg("com.example.notes", dayStart + 10_000),
            bg("com.example.chat", dayStart + 20_000),
        )
        val sessions = AppUsageNormalizer.mergeSessions(events, dayStart, dayEnd)
        assertEquals(2, sessions.size)
        assertEquals(setOf("com.example.notes", "com.example.chat"), sessions.map { it.packageName }.toSet())
    }

    @Test
    fun `a background event with no matching foreground is clamped to the day start`() {
        // The real foreground event landed the previous day, out of this
        // day's query window — the session is attributed to this day only
        // from its start.
        val events = listOf(bg("com.example.notes", dayStart + 30_000))
        val sessions = AppUsageNormalizer.mergeSessions(events, dayStart, dayEnd)
        assertEquals(1, sessions.size)
        assertEquals(dayStart, sessions[0].startMillis)
        assertEquals(dayStart + 30_000, sessions[0].endMillis)
    }

    @Test
    fun `a foreground event left open at day end is closed at the day boundary`() {
        val events = listOf(fg("com.example.notes", dayEnd - 5_000))
        val sessions = AppUsageNormalizer.mergeSessions(events, dayStart, dayEnd)
        assertEquals(1, sessions.size)
        assertEquals(dayEnd, sessions[0].endMillis)
    }

    @Test
    fun `a foreground with a later foreground for a different app does not confuse sessions`() {
        val events = listOf(
            fg("com.example.notes", dayStart + 1_000),
            fg("com.example.chat", dayStart + 2_000),
            bg("com.example.chat", dayStart + 3_000),
            bg("com.example.notes", dayStart + 4_000),
        )
        val sessions = AppUsageNormalizer.mergeSessions(events, dayStart, dayEnd).sortedBy { it.startMillis }
        assertEquals(2, sessions.size)
        assertEquals("com.example.notes", sessions[0].packageName)
        assertEquals("com.example.chat", sessions[1].packageName)
    }

    @Test
    fun `pickupCount counts only screen-interactive events`() {
        val events = listOf(screenOn(dayStart + 1_000), screenOn(dayStart + 2_000), unlock(dayStart + 1_500))
        assertEquals(2, AppUsageNormalizer.pickupCount(events))
    }

    @Test
    fun `firstUnlockMillis is the earliest keyguard-hidden event, null when there are none`() {
        val events = listOf(unlock(dayStart + 5_000), unlock(dayStart + 1_000))
        assertEquals(dayStart + 1_000, AppUsageNormalizer.firstUnlockMillis(events))
        assertNull(AppUsageNormalizer.firstUnlockMillis(emptyList()))
    }

    @Test
    fun `lastUseMillis is the latest event of any kind`() {
        val events = listOf(unlock(dayStart + 1_000), screenOn(dayStart + 9_000), unlock(dayStart + 3_000))
        assertEquals(dayStart + 9_000, AppUsageNormalizer.lastUseMillis(events))
    }

    @Test
    fun `formatDuration renders hours, minutes, and seconds`() {
        assertEquals("4h 12m", AppUsageNormalizer.formatDuration(4 * 3600 + 12 * 60))
        assertEquals("48m", AppUsageNormalizer.formatDuration(48 * 60))
        assertEquals("2h", AppUsageNormalizer.formatDuration(2 * 3600))
        assertEquals("12s", AppUsageNormalizer.formatDuration(12))
    }

    @Test
    fun `sessionRow and dailyRows carry the resolved app label`() {
        val session = RawSession("com.example.notes", dayStart + 1_000, dayStart + 61_000)
        val row = AppUsageNormalizer.sessionRow(session, "Example Notes")
        assertEquals("Example Notes", row["app_name"]?.jsonPrimitive?.content)
        assertEquals("com.example.notes:${dayStart + 1_000}", row["id"]?.jsonPrimitive?.content)

        val daily = AppUsageNormalizer.dailyRows(listOf(session), LocalDate.parse("2026-03-04")) { "Example Notes" }
        assertEquals(1, daily.size)
        assertEquals(60, daily[0]["total_seconds"]?.jsonPrimitive?.content?.toInt())
        assertEquals(1, daily[0]["session_count"]?.jsonPrimitive?.content?.toInt())
    }

    @Test
    fun `buildDayDocument surfaces total time, top apps, pickups, and unlock times`() {
        val sessions = listOf(
            RawSession("com.example.notes", dayStart, dayStart + 4_800_000), // 80 min
            RawSession("com.example.chat", dayStart, dayStart + 2_880_000), // 48 min
        )
        val doc = AppUsageNormalizer.buildDayDocument(
            sessions = sessions,
            pickups = 87,
            firstUnlockMillis = dayStart + 26_040_000, // 07:14 UTC
            lastUseMillis = dayStart + 85_920_000, // 23:52 UTC
            date = LocalDate.parse("2026-03-04"),
            providerId = "android",
            sourceId = "android-app-usage:local",
            labelResolver = { pkg -> if (pkg == "com.example.notes") "Example Notes" else "Example Chat" },
        )

        assertEquals("attention-timeline:2026-03-04", doc.externalId)
        assertEquals("attention-timeline", doc.metadata.documentType)
        assertEquals(true, doc.metadata.rollingAggregate)
        assertTrue(doc.content.contains("1h 20m"))
        assertTrue(doc.content.contains("Example Notes"))
        assertTrue(doc.content.contains("87 pickups"))
        assertTrue(doc.content.contains("First unlock: 07:14"))
    }

    @Test
    fun `buildDayDocument is deterministic (idempotent re-sync contract)`() {
        val sessions = listOf(RawSession("com.example.notes", dayStart, dayStart + 60_000))
        val date = LocalDate.parse("2026-01-15")
        fun build() = AppUsageNormalizer.buildDayDocument(
            sessions = sessions,
            pickups = 3,
            firstUnlockMillis = null,
            lastUseMillis = null,
            date = date,
            providerId = "android",
            sourceId = "android-app-usage:local",
            labelResolver = { "Example Notes" },
        )
        assertEquals(build().contentHash, build().contentHash)
    }
}
