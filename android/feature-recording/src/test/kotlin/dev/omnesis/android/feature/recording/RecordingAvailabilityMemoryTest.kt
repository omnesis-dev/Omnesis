// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.feature.recording.ui.RecordingAvailability.Availability
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The gateway's last answer about recordings, kept for the pairing it came from. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingAvailabilityMemoryTest {

    private val prefs = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences("test.recording.availability", Context.MODE_PRIVATE)
        .also { it.edit().clear().commit() }

    private fun memory() = RecordingAvailabilityMemory(prefs)

    @Test
    fun a_pairing_never_asked_is_unavailable() {
        assertEquals(Availability.UNAVAILABLE, memory().lastKnown("pairing-a"))
    }

    @Test
    fun the_last_answer_outlives_the_process() {
        memory().remember("pairing-a", Availability.AVAILABLE)

        assertEquals(Availability.AVAILABLE, memory().lastKnown("pairing-a"))
    }

    @Test
    fun a_later_answer_replaces_an_earlier_one() {
        val memory = memory()
        memory.remember("pairing-a", Availability.AVAILABLE)
        memory.remember("pairing-a", Availability.TRANSCRIPTION_OFF)

        assertEquals(Availability.TRANSCRIPTION_OFF, memory.lastKnown("pairing-a"))
    }

    @Test
    fun another_pairing_does_not_inherit_the_answer() {
        val memory = memory()
        memory.remember("pairing-a", Availability.AVAILABLE)

        assertEquals(Availability.UNAVAILABLE, memory.lastKnown("pairing-b"))
    }

    @Test
    fun forgetting_on_unpair_leaves_nothing() {
        val memory = memory()
        memory.remember("pairing-a", Availability.AVAILABLE)

        memory.forget()

        assertEquals(Availability.UNAVAILABLE, memory.lastKnown("pairing-a"))
    }

    @Test
    fun an_unreadable_value_is_unavailable() {
        prefs.edit().putString("pairing", "pairing-a").putString("availability", "SOMETHING_NEW").commit()

        assertEquals(Availability.UNAVAILABLE, memory().lastKnown("pairing-a"))
    }
}
