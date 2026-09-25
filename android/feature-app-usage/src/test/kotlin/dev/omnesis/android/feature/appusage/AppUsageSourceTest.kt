// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import android.app.Application
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowUsageStatsManager

/**
 * Exercises [AppUsageSource] against Robolectric's built-in
 * [ShadowUsageStatsManager] — no hand-rolled fake needed here (unlike Call
 * Log's `CallLogProvider`, which Robolectric doesn't shadow): the shadow
 * itself is a real, order-preserving in-memory event log that
 * `UsageStatsManager.queryEvents` reads from directly. All package names
 * below are invented (privacy rule) — never real installed apps.
 */
@Suppress("DEPRECATION") // MOVE_TO_FOREGROUND/MOVE_TO_BACKGROUND — see AppUsageSource.kindFor.
@RunWith(RobolectricTestRunner::class)
class AppUsageSourceTest {

    private lateinit var usageStatsManager: UsageStatsManager
    private lateinit var shadow: ShadowUsageStatsManager
    private var nowMillis = 0L

    private val labels = mapOf(
        "com.example.notes" to "Example Notes",
        "com.example.chat" to "Example Chat",
    )

    private fun newSource() = AppUsageSource(
        usageStatsManager = usageStatsManager,
        labelResolver = { pkg -> labels[pkg] ?: pkg },
        clock = { nowMillis },
    )

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        shadow = shadowOf(usageStatsManager)
    }

    private fun addEvent(pkg: String, t: Long, type: Int) = shadow.addEvent(pkg, t, type)
    private fun fg(pkg: String, t: Long) = addEvent(pkg, t, UsageEvents.Event.MOVE_TO_FOREGROUND)
    private fun bg(pkg: String, t: Long) = addEvent(pkg, t, UsageEvents.Event.MOVE_TO_BACKGROUND)
    private fun screenOn(t: Long) = addEvent("android", t, UsageEvents.Event.SCREEN_INTERACTIVE)
    private fun unlock(t: Long) = addEvent("android", t, UsageEvents.Event.KEYGUARD_HIDDEN)

    // 2026-03-04T00:00:00Z and 2026-03-05T00:00:00Z in epoch millis.
    private val day1Start = 1_772_582_400_000L
    private val day2Start = day1Start + 24 * 60 * 60 * 1000

    @Test
    fun `bootstrap sync produces sessions, daily rows, and one document per day`() = runTest {
        fg("com.example.notes", day1Start + 1_000)
        bg("com.example.notes", day1Start + 61_000)
        fg("com.example.chat", day2Start + 1_000)
        bg("com.example.chat", day2Start + 31_000)
        nowMillis = day2Start + 60_000

        val result = newSource().sync(AppUsageCursor())

        assertEquals(2, result.sessionRows.size)
        assertEquals(2, result.dailyRows.size)
        assertEquals(2, result.documents.size)
        assertEquals(setOf("attention-timeline:2026-03-04", "attention-timeline:2026-03-05"), result.documents.map { it.externalId }.toSet())
        assertEquals(nowMillis, result.cursor.lastQueriedThroughMillis)
    }

    @Test
    fun `incremental sync only rebuilds days with new events`() = runTest {
        fg("com.example.notes", day1Start + 1_000)
        bg("com.example.notes", day1Start + 61_000)
        nowMillis = day1Start + 90_000
        val first = newSource().sync(AppUsageCursor())
        assertEquals(1, first.documents.size)

        fg("com.example.chat", day2Start + 1_000)
        bg("com.example.chat", day2Start + 21_000)
        nowMillis = day2Start + 30_000
        val second = newSource().sync(first.cursor)

        assertEquals(1, second.documents.size)
        assertEquals("attention-timeline:2026-03-05", second.documents.single().externalId)
    }

    @Test
    fun `a day revised by a later-arriving event rebuilds with the full day's sessions, not just the new slice`() = runTest {
        fg("com.example.notes", day1Start + 1_000)
        bg("com.example.notes", day1Start + 61_000)
        nowMillis = day1Start + 90_000
        val first = newSource().sync(AppUsageCursor())
        assertTrue(first.documents.single().content.contains("1m"))

        fg("com.example.chat", day1Start + 100_000)
        bg("com.example.chat", day1Start + 160_000)
        nowMillis = day1Start + 200_000
        val second = newSource().sync(first.cursor)

        assertEquals(1, second.documents.size)
        val doc = second.documents.single()
        assertTrue(doc.content.contains("Example Notes"))
        assertTrue(doc.content.contains("Example Chat"))
        assertEquals(2, second.sessionRows.size)
        assertEquals(2, second.dailyRows.size)
    }

    @Test
    fun `pickups and first-unlock land on the day document`() = runTest {
        unlock(day1Start + 26_040_000) // 07:14 UTC
        screenOn(day1Start + 26_040_000)
        screenOn(day1Start + 30_000_000)
        nowMillis = day1Start + 40_000_000

        val result = newSource().sync(AppUsageCursor())

        val doc = result.documents.single()
        assertTrue(doc.content.contains("2 pickups"))
        assertTrue(doc.content.contains("First unlock: 07:14"))
    }

    @Test
    fun `an app still foregrounded when the sync window closes gets a provisional session, corrected on the next pass`() = runTest {
        fg("com.example.notes", day1Start + 1_000)
        nowMillis = day1Start + 10_000
        val first = newSource().sync(AppUsageCursor())
        val firstSession = first.documents.single()
        assertTrue(firstSession.content.contains("9s"))

        bg("com.example.notes", day1Start + 61_000)
        nowMillis = day1Start + 70_000
        val second = newSource().sync(first.cursor)

        val secondDoc = second.documents.single()
        assertTrue(secondDoc.content.contains("1m"))
    }

    @Test
    fun `no new events yields an empty result and an advanced cursor`() = runTest {
        nowMillis = day1Start + 1_000
        val result = newSource().sync(AppUsageCursor())
        assertEquals(0, result.sessionRows.size)
        assertEquals(0, result.dailyRows.size)
        assertEquals(0, result.documents.size)
        assertEquals(nowMillis, result.cursor.lastQueriedThroughMillis)
    }
}
