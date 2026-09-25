// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
class PhotosSourceTest {

    private val analyzeCalls = mutableListOf<Pair<PhotoAssetRef, AnalysisTier>>()
    private lateinit var source: PhotosSource
    private lateinit var provider: FakePhotosProvider

    @Before
    fun setUp() {
        provider = Robolectric.buildContentProvider(FakePhotosProvider::class.java).create("media").get()
        ShadowContentResolver.registerProviderInternal("media", provider)
        analyzeCalls.clear()
        source = PhotosSource(
            resolver = ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
            analyze = { asset, tier ->
                analyzeCalls += asset to tier
                PhotoAnalysisFragment(textLines = listOf("text-${asset.id}"))
            },
        )
    }

    private fun insertImage(dateAddedSec: Long, relativePath: String? = "DCIM/Camera/", dateModifiedSec: Long = dateAddedSec) {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DATE_ADDED, dateAddedSec)
            put(MediaStore.Images.Media.DATE_MODIFIED, dateModifiedSec)
            if (relativePath != null) put(MediaStore.Images.Media.RELATIVE_PATH, relativePath)
        }
        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
    }

    private val fixedInstant: Instant = Instant.parse("2026-07-05T12:00:00Z")
    private val fixedClock: () -> Instant = { fixedInstant }
    private val recentDateAddedSec = fixedInstant.minusSeconds(10 * 86_400).epochSecond // 10 days ago

    @Test
    fun `bootstrap walks screenshots then recent then backfill then steady, in order`() = runTest {
        insertImage(1_000, relativePath = "Pictures/Screenshots/") // screenshot
        insertImage(recentDateAddedSec, relativePath = "DCIM/Camera/") // recent (within 30 days of the fixed clock)
        insertImage(1_000_000, relativePath = "DCIM/Camera/") // old — backfill

        val screenshotsPass = source.sync(PhotosCursor(), clock = fixedClock)
        assertEquals(1, screenshotsPass.documents.size)
        assertEquals(PhotosPhase.RECENT, screenshotsPass.cursor.phase)

        val recentPass = source.sync(screenshotsPass.cursor, clock = fixedClock)
        assertEquals(1, recentPass.documents.size)
        assertEquals(PhotosPhase.BACKFILL, recentPass.cursor.phase)

        val backfillPass = source.sync(recentPass.cursor, clock = fixedClock)
        assertEquals(1, backfillPass.documents.size)
        assertEquals(PhotosPhase.STEADY, backfillPass.cursor.phase)
        assertTrue(backfillPass.cursor.backfillCompletedAt != null)
    }

    @Test
    fun `backfill tier is used for all three historical phases, new tier only once steady`() = runTest {
        insertImage(1_000, relativePath = "Pictures/Screenshots/")
        var cursor = PhotosCursor()
        cursor = source.sync(cursor, clock = fixedClock).cursor // screenshots -> recent
        cursor = source.sync(cursor, clock = fixedClock).cursor // recent -> backfill
        cursor = source.sync(cursor, clock = fixedClock).cursor // backfill -> steady
        assertEquals(PhotosPhase.STEADY, cursor.phase)

        assertTrue(analyzeCalls.all { it.second == AnalysisTier.BACKFILL })

        insertImage(2_000_000_000L, relativePath = "DCIM/Camera/")
        source.sync(cursor, clock = fixedClock)

        assertEquals(AnalysisTier.NEW, analyzeCalls.last().second)
    }

    @Test
    fun `pages within a phase before advancing`() = runTest {
        insertImage(100, relativePath = "Pictures/Screenshots/")
        insertImage(200, relativePath = "Pictures/Screenshots/")
        insertImage(300, relativePath = "Pictures/Screenshots/")

        val first = source.sync(PhotosCursor(), pageLimit = 2, clock = fixedClock)
        assertEquals(2, first.documents.size)
        assertEquals("phase must not advance mid-page", PhotosPhase.SCREENSHOTS, first.cursor.phase)
        assertEquals("resumes after the last asset actually processed", 200L, first.cursor.lastAssetDateAddedSec)

        val second = source.sync(first.cursor, pageLimit = 2, clock = fixedClock)
        assertEquals(1, second.documents.size)
        assertEquals("the short final page advances the phase", PhotosPhase.RECENT, second.cursor.phase)
    }

    @Test
    fun `kill and resume backfill has no duplicates or skips`() = runTest {
        for (i in 1..5) insertImage(1000L + i, relativePath = "Pictures/Screenshots/")

        var cursor = PhotosCursor()
        val seenIds = mutableListOf<String>()
        // Simulate a kill-and-resume: fetch tiny pages repeatedly, as if each
        // call were a fresh process picking the persisted cursor back up.
        var guard = 0
        while (cursor.phase == PhotosPhase.SCREENSHOTS && guard < 20) {
            val result = source.sync(cursor, pageLimit = 2, clock = fixedClock)
            seenIds += result.documents.map { it.externalId }
            cursor = result.cursor
            guard++
        }

        assertEquals(5, seenIds.size)
        assertEquals("no asset processed twice", seenIds.toSet().size, seenIds.size)
    }

    @Test
    fun `steady phase detects a new arrival via the DATE_ADDED watermark`() = runTest {
        var cursor = PhotosCursor()
        cursor = source.sync(cursor, clock = fixedClock).cursor
        cursor = source.sync(cursor, clock = fixedClock).cursor
        cursor = source.sync(cursor, clock = fixedClock).cursor
        assertEquals(PhotosPhase.STEADY, cursor.phase)

        insertImage(2_000_000_000L, relativePath = "DCIM/Camera/")
        val result = source.sync(cursor, clock = fixedClock)

        assertEquals(1, result.documents.size)
    }

    @Test
    fun `steady phase does not re-detect an already-synced arrival`() = runTest {
        var cursor = PhotosCursor()
        cursor = source.sync(cursor, clock = fixedClock).cursor
        cursor = source.sync(cursor, clock = fixedClock).cursor
        cursor = source.sync(cursor, clock = fixedClock).cursor

        insertImage(2_000_000_000L, relativePath = "DCIM/Camera/")
        val first = source.sync(cursor, clock = fixedClock)
        assertEquals(1, first.documents.size)

        val second = source.sync(first.cursor, clock = fixedClock)
        assertEquals(0, second.documents.size)
    }

    @Test
    fun `screenshot detection matches both the AOSP and common OEM paths, case-insensitively`() = runTest {
        insertImage(100, relativePath = "Pictures/Screenshots/")
        insertImage(200, relativePath = "DCIM/Screenshots/")
        insertImage(300, relativePath = "dcim/screenshots/")
        insertImage(400, relativePath = "DCIM/Camera/")

        val result = source.sync(PhotosCursor(), clock = fixedClock)

        assertEquals(3, result.documents.size)
    }

    @Test
    fun `fetchAllExternalIds returns every current asset id`() = runTest {
        insertImage(100)
        insertImage(200)
        insertImage(300)

        val ids = source.fetchAllExternalIds()

        assertEquals(3, ids!!.size)
    }

    @Test
    fun `a library that cannot be enumerated answers null, not an empty snapshot`() = runTest {
        // The snapshot is the only deletion mechanism Photos has, so an empty
        // one asserts the whole library is gone. A provider handing back no
        // cursor is a normal Android outcome — a restart, a profile this
        // process cannot see — and is not evidence of anything.
        val provider = Robolectric.buildContentProvider(NullCursorMediaProvider::class.java)
            .create(MediaStore.AUTHORITY)
            .get()
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, provider)
        val blind = PhotosSource(
            resolver = ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
            // Never reached: enumerating the library is what fails here, so no
            // asset ever gets as far as being analyzed.
            analyze = { _, _ -> PhotoAnalysisFragment() },
        )

        assertNull(blind.fetchAllExternalIds())
    }

    @Test
    fun `a resumed screenshot page cannot ingest later camera photos`() = runTest {
        insertImage(100, "Pictures/Screenshots/")
        insertImage(200, "DCIM/Camera/")
        insertImage(300, "Pictures/Screenshots/")
        val first = source.sync(PhotosCursor(), pageLimit = 1, clock = fixedClock)
        val next = source.sync(first.cursor, pageLimit = 10, clock = fixedClock)
        assertEquals(listOf("3"), next.documents.map { it.externalId })
    }

    @Test
    fun `a resumed recent page cannot ingest later screenshots`() = runTest {
        insertImage(recentDateAddedSec, "DCIM/Camera/")
        insertImage(recentDateAddedSec + 1, "Pictures/Screenshots/")
        insertImage(recentDateAddedSec + 2, "DCIM/Camera/")
        val first = source.sync(PhotosCursor(phase = PhotosPhase.RECENT), pageLimit = 1, clock = fixedClock)
        val next = source.sync(first.cursor, pageLimit = 10, clock = fixedClock)
        assertEquals(listOf("3"), next.documents.map { it.externalId })
    }

    @Test
    fun `a resumed backfill page retains both date and screenshot filters`() = runTest {
        insertImage(100, "DCIM/Camera/")
        insertImage(200, "Pictures/Screenshots/")
        insertImage(300, "DCIM/Camera/")
        insertImage(recentDateAddedSec, "DCIM/Camera/")
        val first = source.sync(PhotosCursor(phase = PhotosPhase.BACKFILL), pageLimit = 1, clock = fixedClock)
        val next = source.sync(first.cursor, pageLimit = 10, clock = fixedClock)
        assertEquals(listOf("3"), next.documents.map { it.externalId })
    }

    @Test
    fun `an unavailable page query cannot advance backfill`() = runTest {
        provider.failPageQuery = true
        var failed = false
        try { source.sync(PhotosCursor(), clock = fixedClock) } catch (_: IllegalStateException) { failed = true }
        assertTrue("an unavailable provider must never exhaust a phase", failed)
    }
}

/** A media provider that returns no cursor at all. */
class NullCursorMediaProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
