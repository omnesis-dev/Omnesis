// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowContentResolver

/**
 * A provider that hands back no cursor at all.
 *
 * This is a normal Android outcome and is distinct from the exception a
 * revoked permission throws: the provider may be disabled, still starting, or
 * belong to a profile this process cannot see. `query` is typed nullable
 * precisely because of it.
 */
class NullCursorCallLogProvider : ContentProvider() {
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

/**
 * A call log that cannot be read is not a call log that has been emptied.
 *
 * The snapshot is an instruction to delete everything absent from it, so an
 * empty one asserts that every day document the gateway holds is gone. Built
 * from a query that returned no cursor, that assertion is unfounded — and
 * acted on immediately, because the source has no way to say it is unsure.
 */
@RunWith(RobolectricTestRunner::class)
class CallLogUnreadableTest {

    private lateinit var source: CallLogSource

    @Before
    fun setUp() {
        val provider = Robolectric.buildContentProvider(NullCursorCallLogProvider::class.java)
            .create("call_log")
            .get()
        ShadowContentResolver.registerProviderInternal("call_log", provider)
        source = CallLogSource(
            ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
        )
    }

    @Test
    fun `an unreadable call log withholds the snapshot instead of claiming everything is gone`() = runTest {
        val result = source.sync(CallLogCursor())

        // Not an empty list — that would be a claim. Null is the absence of one.
        assertNull(result.presentExternalIds)
    }
}
