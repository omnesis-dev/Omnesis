// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AppForegroundStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private var now = 10_000_000L
    private lateinit var store: AppForegroundStore

    @Before
    fun setUp() {
        preferences().edit().clear().commit()
        store = AppForegroundStore(context) { now }
    }

    @After
    fun tearDown() {
        preferences().edit().clear().commit()
    }

    @Test
    fun `store preserves exact conversation with injected clock`() {
        store.save(AppForegroundSurface.Conversation("conversation-example"))
        now += 3_599_000

        assertEquals(
            AppForegroundDestination.Conversation("conversation-example"),
            store.destination(),
        )
    }

    @Test
    fun `store distinguishes a recent non-agent route from a fresh composer`() {
        store.save(AppForegroundSurface.OutsideAgent)
        now += 30_000
        assertEquals(AppForegroundDestination.PreserveCurrent, store.destination())

        store.save(AppForegroundSurface.FreshConversation)
        now += 30_000
        assertEquals(AppForegroundDestination.FreshConversation, store.destination())
    }

    private fun preferences() =
        context.getSharedPreferences("omnesis_app_foreground", Context.MODE_PRIVATE)
}
