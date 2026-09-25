// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class VoiceAskContinuityStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    @After
    fun clear() {
        context.getSharedPreferences(VoiceAskContinuityStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun resumes_inside_the_five_minute_window() {
        val store = VoiceAskContinuityStore(context)
        store.record("session-a")
        assertEquals("session-a", store.conversationToResume())
    }

    @Test
    fun rejects_expired_and_future_timestamps() {
        val store = VoiceAskContinuityStore(context)
        val prefs = context.getSharedPreferences(VoiceAskContinuityStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(VoiceAskContinuityStore.KEY_CONVERSATION_ID, "session-a")
            .putLong(VoiceAskContinuityStore.KEY_ASKED_AT, System.currentTimeMillis() - 301_000)
            .commit()
        assertNull(store.conversationToResume())

        prefs.edit()
            .putLong(VoiceAskContinuityStore.KEY_ASKED_AT, System.currentTimeMillis() + 1_000)
            .commit()
        assertNull(store.conversationToResume())
    }
}
