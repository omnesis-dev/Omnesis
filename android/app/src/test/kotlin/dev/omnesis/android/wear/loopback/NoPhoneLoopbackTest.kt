// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.OutboxPolicy
import kotlin.time.Duration.Companion.seconds
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A watch with no phone running the phone app: not paired with one, or the
 * phone app not installed. What it takes waits in its outbox, handed to
 * nothing, until a phone app appears, and is then delivered with the watch
 * app closed: nobody opens it again after recording.
 */
class NoPhoneLoopbackTest {
    private val text = "Renew the library card"

    /** No phone runs the phone app from here on. */
    private fun Loopback.losePhone() {
        layer.phoneApp = false
        layer.disconnect()
        pass(1.seconds)
    }

    /** The person leaves the watch app, which is not opened again. */
    private fun Loopback.closeWatchApp() {
        watch.onScreen = false
        watch.core.enteredBackground()
        settle()
    }

    private fun Loopback.nextWatchPass(): Long? = watch.retries.lastOrNull()

    @Test
    fun a_note_typed_with_no_phone_is_held_back_with_a_pass_scheduled() = loopback {
        losePhone()

        typeNote(text)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
        closeWatchApp()

        assertEquals(listOf(ref(1)), outbox())
        assertTrue("nothing is handed to a Data Layer no phone app reads", layer.leftovers().isEmpty())
        assertEquals(0, watch.core.store.entries().single().failures)
        val scheduled = checkNotNull(nextWatchPass()) { "a waiting note must have a pass scheduled" }
        assertTrue(scheduled > now && scheduled <= now + OutboxPolicy.UNCARRIED_RECHECK.inWholeMilliseconds)
    }

    @Test
    fun a_note_typed_with_no_phone_is_delivered_when_a_phone_app_appears() = loopback {
        losePhone()
        typeNote(text)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
        closeWatchApp()

        // A phone running the phone app comes into reach; the watch's listener is started for it.
        layer.phoneApp = true
        layer.connect()
        pass()

        assertEquals(text, notes.saved.single().text)
        assertEquals(ref(1), notes.saved.single().ref)
        assertNothingLeft()
        assertNull("an empty outbox keeps no pass scheduled", nextWatchPass())
    }

    @Test
    fun a_note_typed_with_no_phone_is_delivered_by_the_scheduled_pass_when_nothing_announces_the_phone_app() =
        loopback {
            losePhone()
            typeNote(text)
            pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
            closeWatchApp()

            layer.phoneApp = true
            layer.connect(announced = false)
            pass()
            assertTrue("nothing has told the watch", notes.saved.isEmpty())
            assertEquals(listOf(ref(1)), outbox())

            runWatchRetry()

            assertEquals(text, notes.saved.single().text)
            assertNothingLeft()
        }

    @Test
    fun every_scheduled_pass_with_still_no_phone_schedules_another() = loopback {
        losePhone()
        typeNote(text)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
        closeWatchApp()

        repeat(3) {
            runWatchRetry()
            assertEquals(listOf(ref(1)), outbox())
            assertTrue(layer.leftovers().isEmpty())
            assertTrue(checkNotNull(nextWatchPass()) > now)
        }
    }

    @Test
    fun a_recording_made_after_the_phone_app_went_away_is_delivered_when_it_returns() = loopback {
        // The watch knows from an earlier time with the phone that the gateway transcribes voice notes.
        publishGate(dictationMaxAudioBytes = 4_000_000)
        backend.gatewayDictation = true
        losePhone()

        record(CaptureRoute.NOTE)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
        closeWatchApp()
        assertEquals(listOf(ref(1)), outbox())
        assertTrue(layer.leftovers().isEmpty())
        assertTrue(checkNotNull(nextWatchPass()) > now)

        layer.phoneApp = true
        layer.connect()
        pass()

        assertArrayEquals(byteArrayOf(1, 2, 3), notes.saved.single().audio)
        assertNothingLeft()
    }

    @Test
    fun a_recording_made_after_the_phone_app_went_away_is_delivered_by_the_scheduled_pass() = loopback {
        publishGate(dictationMaxAudioBytes = 4_000_000)
        backend.gatewayDictation = true
        losePhone()
        record(CaptureRoute.NOTE)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
        closeWatchApp()

        layer.phoneApp = true
        layer.connect(announced = false)
        pass()
        assertTrue(notes.saved.isEmpty())

        runWatchRetry()

        assertEquals(1, notes.saved.size)
        assertNothingLeft()
    }
}
