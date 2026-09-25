// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.ContentValues
import android.provider.CallLog
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowContentResolver

/**
 * Exercises [CallLogSource] against [FakeCallLogProvider] — a real,
 * SQLite-backed fake of the `content://call_log/calls` provider (Android's
 * actual `CallLogProvider` isn't shadowed by Robolectric out of the box) —
 * the same "real dependency, no mocking" philosophy the TS-side sources use
 * against real SQLite fixtures.
 */
@RunWith(RobolectricTestRunner::class)
class CallLogSourceTest {

    private lateinit var source: CallLogSource

    @Before
    fun setUp() {
        val provider = Robolectric.buildContentProvider(FakeCallLogProvider::class.java).create("call_log").get()
        ShadowContentResolver.registerProviderInternal("call_log", provider)
        source = CallLogSource(ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver)
    }

    private fun insertCall(
        number: String,
        dateMillis: Long,
        type: Int = CallLog.Calls.INCOMING_TYPE,
        durationSeconds: Long = 0,
        name: String? = null,
        numberPresentation: Int = CallLog.Calls.PRESENTATION_ALLOWED,
    ) {
        val values = ContentValues().apply {
            put(CallLog.Calls.NUMBER, number)
            put(CallLog.Calls.DATE, dateMillis)
            put(CallLog.Calls.DURATION, durationSeconds)
            put(CallLog.Calls.TYPE, type)
            put(CallLog.Calls.COUNTRY_ISO, "US")
            put(CallLog.Calls.NUMBER_PRESENTATION, numberPresentation)
            if (name != null) put(CallLog.Calls.CACHED_NAME, name)
        }
        val resolver = ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
        resolver.insert(CallLog.Calls.CONTENT_URI, values)
    }

    // 2026-03-04T10:00:00Z and 2026-03-05T10:00:00Z in epoch millis.
    private val day1 = 1772618400000L
    private val day2 = 1772704800000L

    @Test
    fun `bootstrap sync produces one analytics row per call and one document per day`() = runTest {
        insertCall("+14155552671", day1, type = CallLog.Calls.INCOMING_TYPE, durationSeconds = 90)
        insertCall("+442071234567", day1, type = CallLog.Calls.MISSED_TYPE)
        insertCall("+14155552671", day2, type = CallLog.Calls.OUTGOING_TYPE, durationSeconds = 30)

        val result = source.sync(CallLogCursor())

        assertEquals(3, result.analyticsRows.size)
        assertEquals(2, result.documents.size)
        assertEquals(setOf("call-log:2026-03-04", "call-log:2026-03-05"), result.presentExternalIds!!.toSet())
    }

    @Test
    fun `incremental sync only returns calls landed after the watermark`() = runTest {
        insertCall("+14155552671", day1)
        val first = source.sync(CallLogCursor())
        assertEquals(1, first.analyticsRows.size)

        insertCall("+442071234567", day2)
        val second = source.sync(first.cursor)

        assertEquals(1, second.analyticsRows.size)
        assertEquals("call-log:2026-03-05", second.documents.single().externalId)
        // The snapshot always reflects the FULL current call log, not just this cycle's delta.
        assertEquals(setOf("call-log:2026-03-04", "call-log:2026-03-05"), second.presentExternalIds!!.toSet())
    }

    @Test
    fun `a day spanning two sync cycles rebuilds with every call, not just the latest cycle's slice`() = runTest {
        insertCall("+14155552671", day1, durationSeconds = 10)
        val first = source.sync(CallLogCursor())
        val firstCallCount = (first.documents.single().metadata.extra as kotlinx.serialization.json.JsonObject)["callCount"]
        assertEquals(1, firstCallCount?.jsonPrimitive?.content?.toInt())

        insertCall("+442071234567", day1 + 60_000, durationSeconds = 20)
        val second = source.sync(first.cursor)

        val extra = second.documents.single().metadata.extra as kotlinx.serialization.json.JsonObject
        assertEquals(2, extra["callCount"]?.jsonPrimitive?.content?.toInt())
    }

    @Test
    fun `presentExternalIds omits a day whose only call was deleted`() = runTest {
        insertCall("+14155552671", day1)
        val first = source.sync(CallLogCursor())
        assertEquals(1, first.presentExternalIds!!.size)

        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .delete(CallLog.Calls.CONTENT_URI, null, null)
        insertCall("+442071234567", day2)
        val second = source.sync(first.cursor)

        assertEquals(listOf("call-log:2026-03-05"), second.presentExternalIds)
    }

    @Test
    fun `deleting the single most-recent call does not trigger a spurious full re-sync`() = runTest {
        insertCall("+14155552671", day1)
        insertCall("+442071234567", day2)
        val first = source.sync(CallLogCursor())
        assertEquals(2, first.analyticsRows.size)

        // Deleting only the highest-_ID row is an everyday action (e.g. you
        // just placed a call to the wrong number and remove it) — it must
        // not re-derive every already-synced call as "new" on the next pass.
        // (AUTOINCREMENT means the deleted id is never reused, so the max
        // observed _ID visibly drops without the log having been cleared.)
        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .delete(CallLog.Calls.CONTENT_URI, "${CallLog.Calls.DATE} = ?", arrayOf(day2.toString()))

        val second = source.sync(first.cursor)
        assertEquals(0, second.analyticsRows.size)
        assertEquals(0, second.documents.size)
        // The deletion is still correctly reflected in the snapshot.
        assertEquals(listOf("call-log:2026-03-04"), second.presentExternalIds)
    }

    @Test
    fun `a call landing with an older DATE than the watermark but a newer _ID is still synced`() = runTest {
        // Backfilled/imported history can land with a timestamp that predates
        // calls already synced (e.g. a delayed multi-device merge) — its
        // higher _ID must still cross the watermark even though its DATE
        // does not.
        insertCall("+14155552671", day2)
        val first = source.sync(CallLogCursor())
        assertEquals(1, first.analyticsRows.size)

        insertCall("+442071234567", day1)
        val second = source.sync(first.cursor)

        assertEquals(1, second.analyticsRows.size)
        assertEquals("call-log:2026-03-04", second.documents.single().externalId)
    }

    @Test
    fun `missing country ISO does not crash normalization`() = runTest {
        val values = ContentValues().apply {
            put(CallLog.Calls.NUMBER, "+14155552671")
            put(CallLog.Calls.DATE, day1)
            put(CallLog.Calls.DURATION, 0)
            put(CallLog.Calls.TYPE, CallLog.Calls.INCOMING_TYPE)
        }
        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .insert(CallLog.Calls.CONTENT_URI, values)

        val result = source.sync(CallLogCursor())
        assertEquals(1, result.analyticsRows.size)
        assertEquals("+14155552671", result.analyticsRows.single()["counterparty"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a withheld-number call gets no person mention but still counts toward the day total`() = runTest {
        insertCall(
            "-1",
            day1,
            type = CallLog.Calls.MISSED_TYPE,
            numberPresentation = CallLog.Calls.PRESENTATION_RESTRICTED,
        )
        insertCall("+14155552671", day1, durationSeconds = 60)

        val result = source.sync(CallLogCursor())

        assertEquals(2, result.analyticsRows.size)
        val withheldRow = result.analyticsRows.first { it["direction"]?.jsonPrimitive?.content == "incoming" }
        assertEquals("Private number", withheldRow["counterparty"]?.jsonPrimitive?.content)

        val doc = result.documents.single()
        val people = doc.metadata.people!!
        // Self plus exactly one real peer — the withheld caller contributes no
        // person mention (there's no identity to attach one to).
        assertEquals(2, people.size)
        assertEquals(1, people.count { it.isSelf != true })
    }
}
